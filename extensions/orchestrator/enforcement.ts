/**
 * Enforcement handler — blocks forbidden commands (python/pip, git protection,
 * remote script execution, memory writes, dangerous) + memory-based enforcement rules.
 * Worktree-aware: resolves file edits to the correct worktree root for per-worktree
 * review state tracking and gitignore checks.
 */

import { createLogger } from "../shared/logger.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadEnforcedEntries, matchToolCall, matchBashCommand, executeAction } from "./enforcement-rules.js";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import path, { basename, join, resolve, dirname } from "node:path";
import { supportsAsyncLlm } from "./async-capability.js";
import { getGlobalSettingsPath, getSetting, getSettingsPath } from "./project-settings.js";
import { SETTINGS_FILENAMES } from "./settings-source.js";
import { getProjectTmpDir, resolveWorktreeRoot } from "./utils.js";
import {
  conflictCandidateDirs,
  pushTargetsProtectedBranch,
  fixUnexpandedCommitTrailer,
  maskQuotedRegions,
  isStdinFedShellStatement,
} from "./enforcement-helpers.js";
import {
  DANGEROUS,
  dangerousPatternLabel,
  getCurrentBranch,
  isInsideGitWorkTree,
  getMainBranch,
  getProtectedBranches,
  getPrMergeStatus,
  isBranchAhead,
  isBranchMerged,
  createsAndResolvesConflict,
  isConflictResolutionCommand,
  isGitRepo,
  listUnmergedFiles,
  runGit,
} from "./git-helpers.js";
import { spawnSync } from "node:child_process";
import { markNeedsReview, isCommitAllowed, readReviewState, statePath, markTestsPassed, markTestsFailed } from "./pi-config-review-state.js";
import {
  checkPythonPipBlock,
  checkRemoteExecBlock,
  checkTempFileEnforcement,
  gitAddPathspecs,
  gitSubArgRegions,
  hasGitAddBulk,
  hasGitAddForce,
  injectSignoff,
  injectGhBodySignature,
  isReadOnlyStatement,
  isRealGitCommitOrPush,
  isRmInProjectTmp,
  relativeRecursiveRmTarget,
  normalizeForRepeatCheck,
  realGitSub,
  resolveEffectiveCwd,
  addDangerousAllowlistEntry,
  dangerousCommandHash,
  loadDangerousAllowlists,
  matchDangerousAllowlist,
  projectSettingsTrust,
  normalizeDangerousStatement,
  splitBashStatements,
  stripHeredocBodies,
  stripQuotedSpans,
  escapeForDoubleQuote,
  escapeForSingleQuote,
  commandHasTrailerByName,
  isTestRunnerCommand,
  isBumpVersionBranch,
  getCachedBranch,
  failedFileEditSkipMessage,
} from "./enforcement-helpers.js";

const log = createLogger("enforcement");

export { isBumpVersionBranch, getCachedBranch };

type EnforcementResult = { block: true; reason: string } | { autofix: true; modifiedCommand: string; reason: string } | undefined;

// Repeat detection via temp file — immune to module reload / closure issues
// Repeat detection file — set to project dir on first use
let REPEAT_FILE = "";

/** Cached trailer selection for comma-separated commit_trailer values (reset on session_start) */
let cachedTrailerSelection: string | null = null;

function ensureRepeatFile(cwd: string): void {
  if (!REPEAT_FILE) {
    REPEAT_FILE = join(getProjectTmpDir(cwd), `.repeat-${process.pid}.json`);
  }
}

function readRepeatState(): { lastCmd: string; count: number } {
  if (!REPEAT_FILE) return { lastCmd: "", count: 0 };
  try {
    return JSON.parse(readFileSync(REPEAT_FILE, "utf-8"));
  } catch {
    return { lastCmd: "", count: 0 };
  }
}

function writeRepeatState(state: { lastCmd: string; count: number }): void {
  if (!REPEAT_FILE) return;
  try {
    writeFileSync(REPEAT_FILE, JSON.stringify(state));
  } catch (e: any) { log.debug("enforcement: write repeat state failed:", e?.message || e); }
}



/** Resolve the model id used in commit/PR trailers (env first, then ctx). */
function commitTrailerModelId(ctx: any): string {
  return (process.env.PI_PRIMARY_MODEL || process.env.PI_MODEL || (ctx as any).model?.id || "unknown").replace(/[^a-zA-Z0-9._:@/ -]/g, "").trim() || "unknown";
}

/** Inject commit trailer into command (Assisted-by, Co-authored-by, etc.) */
async function handleCommitTrailer(command: string, event: any, ctx: any, gitCwd: string): Promise<EnforcementResult> {
  // #932: rewrite a literal `$PI_MODEL` in the trailer identity — an agent
  // following the git-expert trailer instruction may write the placeholder
  // verbatim (quoted heredocs and single-quoted -m strings never expand it).
  // This runs BEFORE the setting check and pattern matching so heredoc/-F
  // commits — which the injection patterns below do not cover — still get a
  // correct trailer, and the dedup check below sees the already-fixed name.
  const literalModelId = commitTrailerModelId(ctx);
  const fixedCommand = fixUnexpandedCommitTrailer(command, literalModelId);
  if (fixedCommand !== null) {
    log.info("commit_trailer: replaced unexpanded $PI_MODEL literal with model id", literalModelId);
    command = fixedCommand;
    event.input.command = fixedCommand;
  }

  const trailerSetting = getSetting(gitCwd, "commit_trailer");
  if (typeof trailerSetting !== "string") return undefined;

  const modelId = commitTrailerModelId(ctx);

  const piIdentity = `PI (${modelId}) <noreply@pi.dev>`;
  let trailerName: string;

  if (trailerSetting.includes(",")) {
    // Multiple trailer name options — ask user directly
    const options = trailerSetting.split(",").map(s => s.trim()).filter(Boolean);
    if (options.length === 0) {
      return {
        block: true,
        reason: `⛔ Malformed commit_trailer setting: "${trailerSetting.replace(/[\x00-\x1f\x7f-\x9f]/g, "")}" — no valid trailer names found. Fix the setting in .pi/pi-config-settings.json or PI_COMMIT_TRAILER env var.`,
      };
    }
    if (options.length === 1) {
      trailerName = options[0];
    } else if (cachedTrailerSelection && options.includes(cachedTrailerSelection)) {
      trailerName = cachedTrailerSelection;
    } else if (!ctx.hasUI) {
      // No UI available — default to first option
      trailerName = options[0];
    } else {
      const selected = await ctx.ui.select(
        "Select commit trailer:",
        options,
      );
      if (!selected || !options.includes(selected)) {
        return {
          block: true,
          reason: "Commit trailer selection cancelled by user.",
        };
      }
      trailerName = selected;
      cachedTrailerSelection = selected;
    }
  } else {
    // Single trailer name
    trailerName = trailerSetting;
  }

  // Pattern A: echo "..." | git commit -F -
  const pipeIdx = command.lastIndexOf("|");
  if (pipeIdx !== -1 && /git\s+commit\s+.*-F\s*-/.test(command.slice(pipeIdx))) {
    const echoPart = command.slice(0, pipeIdx);
    const gitPart = command.slice(pipeIdx);
    const lastDoubleQuote = echoPart.lastIndexOf('"');
    const lastSingleQuote = echoPart.lastIndexOf("'");
    const lastQuoteIdx = Math.max(lastDoubleQuote, lastSingleQuote);
    if (lastQuoteIdx > 0) {
      // Determine quote context for correct escaping
      const quoteChar = echoPart[lastQuoteIdx];
      // Scope dedup to the echo/message-construction portion (before the pipe), which
      // excludes the git args. Do NOT attempt to slice out the exact quoted substring
      // by backward-scanning for a quote — escaped quotes (\") inside the message would
      // misparse the boundary and cause a missed trailer -> duplicate injection.
      if (commandHasTrailerByName(echoPart, trailerName)) {
        log.debug("commit_trailer already present in echo message (by name) — skipping injection", trailerName);
        return undefined;
      }
      const escaped = quoteChar === "'"
        ? `${escapeForSingleQuote(trailerName)}: ${piIdentity}`
        : `${escapeForDoubleQuote(trailerName)}: ${piIdentity}`;
      event.input.command =
        echoPart.slice(0, lastQuoteIdx) + `\\n\\n${escaped.replace(/\n/g, "\\n")}` + echoPart.slice(lastQuoteIdx) + gitPart;
    }
  }
  // Pattern B: git commit -m "..." or git commit -m '...'
  else {
    const mFlagMatch = command.match(/git\s+commit\s+.*-m\s+(["'])([\s\S]*?)\1/);
    if (mFlagMatch) {
      const quoteChar = mFlagMatch[1];
      // Scope duplicate-by-name detection to the -m message payload only
      // (mFlagMatch[2]) — not the whole command — so an unrelated arg/env var
      // containing the trailer token does not wrongly skip injection.
      const payload = mFlagMatch[2];
      if (commandHasTrailerByName(payload, trailerName)) {
        log.debug("commit_trailer already present in message (by name) — skipping injection", trailerName);
        return undefined;
      }
      const escaped = quoteChar === "'"
        ? `${escapeForSingleQuote(trailerName)}: ${piIdentity}`
        : `${escapeForDoubleQuote(trailerName)}: ${piIdentity}`;
      const fullMatch = mFlagMatch[0];
      const insertPos = command.indexOf(fullMatch) + fullMatch.length - 1;
      event.input.command =
        command.slice(0, insertPos) + `\n\n${escaped}` + command.slice(insertPos);
    }
  }

  return undefined;
}

/** Git protection: worktrees, add ., gitignored files, hooks, protected branches, trailers, DCO */
async function checkGitProtection(command: string, event: any, ctx: any, gitCwd: string): Promise<EnforcementResult> {
  if (!isGitRepo(gitCwd)) return undefined;

  // Block branch creation AND switching when use_worktrees is enabled
  if (getSetting(gitCwd, "use_worktrees")) {
    const mb = getMainBranch(gitCwd) || "main";
    const hint = `Use: git worktree add .worktrees/<name> -b <branch> ${mb}`;
    if (realGitSub(command, "checkout") && !/\bgit\b.*\bcheckout\b.*\s--\s/.test(command)) {
      return { block: true, reason: `⛔ git checkout blocked — use_worktrees is enabled. ${hint}` };
    }
    if (realGitSub(command, "switch")) {
      return { block: true, reason: `⛔ git switch blocked — use_worktrees is enabled. ${hint}` };
    }
  }

  // Block git add . / git add -A
  if (hasGitAddBulk(command)) {
    return {
      block: true,
      reason:
        "⛔ 'git add .' / 'git add -A' forbidden. Stage specific files.",
    };
  }

  // Block git add --force / -f (including combined short options like -fn) — bypasses .gitignore
  if (hasGitAddForce(command)) {
    return {
      block: true,
      reason: "⛔ 'git add -f/--force' forbidden. It bypasses .gitignore and stages ignored files.",
    };
  }

  // Block staging gitignored files — pathspecs come from the REAL git add
  // invocation(s) only, statement-scoped and quote-aware. The old loose
  // extraction captured across statements (`git add f.ts && bash .dev/x.sh`
  // blocked on .dev/x.sh) and into -m message text (a commit message
  // mentioning an ignored path blocked the commit).
  {
    const staged = gitAddPathspecs(command);
    if (staged && staged.length > 0) {
      for (const file of staged) {
        const checkIgnored = runGit(["check-ignore", "-q", file], gitCwd);
        if (checkIgnored.code === 0) {
          return {
            block: true,
            reason: `⛔ '${file}' is in .gitignore. Do not stage ignored files.`,
          };
        }
      }
    }
  }

  // Block hooks bypass
  if (command.includes("core.hooksPath=/dev/null") || command.includes("core.hooksPath=\"/dev/null\"")) {
    return {
      block: true,
      reason: "⛔ Bypassing git hooks via core.hooksPath=/dev/null is forbidden.",
    };
  }
  // --no-verify must appear in the commit invocation's ARGUMENTS — a
  // message that merely mentions --no-verify is not a hooks bypass.
  if (
    realGitSub(command, "commit") &&
    gitSubArgRegions(command, "commit").some((r) => /(?:^|\s)--no-verify\b/.test(stripQuotedSpans(r)))
  ) {
    return {
      block: true,
      reason: "⛔ --no-verify forbidden. Pre-commit hooks must run.",
    };
  }

  const branch = getCurrentBranch(gitCwd);
  const mainBranch = getMainBranch(gitCwd);
  const protectedBranches = getProtectedBranches(gitCwd);

  // Block commits to protected branches (unless allow_push_to_protected is set)
  if (realGitSub(command, "commit")) {
    if (!branch)
      return {
        block: true,
        reason:
          "⛔ Detached HEAD. Create a branch first: git checkout -b my-branch",
      };
    if (protectedBranches.has(branch) && !getSetting(gitCwd, "allow_push_to_protected_branches"))
      return {
        block: true,
        reason: `⛔ Cannot commit to '${branch}' (protected). Create a feature branch.\nHint: If you're combining git checkout + git commit in one bash call, split them into SEPARATE bash calls. Branch is checked before execution.`,
      };

    const pr = getPrMergeStatus(branch, gitCwd);
    if (pr.merged)
      return {
        block: true,
        reason: `⛔ PR #${pr.info} for '${branch}' already merged. Create a new branch from ${mainBranch || "main"}.`,
      };

    if (command.includes("--amend") && isBranchAhead(gitCwd))
      return undefined;

    if (mainBranch && isBranchMerged(branch, mainBranch, gitCwd))
      return {
        block: true,
        reason: `⛔ Branch '${branch}' already merged into '${mainBranch}'. Create a new branch.`,
      };

    // Commit trailer injection
    const trailerResult = await handleCommitTrailer(command, event, ctx, gitCwd);
    if (trailerResult) return trailerResult;

    // DCO enforcement — inject --signoff into the REAL git commit invocation only.
    // injectSignoff scopes to the actual invocation (after the last pipe for
    // `echo ... | git commit -F -`, or the command-position-anchored `git commit`),
    // so a `git commit` mention inside the echo/message body is never corrupted.
    // The already-signed (--signoff/-s) guards live inside injectSignoff.
    if (getSetting(gitCwd, "dco")) {
      const signed = injectSignoff(event.input.command);
      if (signed !== event.input.command) {
        log.debug("DCO: injected --signoff into real git commit invocation");
        event.input.command = signed;
      }
    }
  }

  // Block pushes to protected branches
  if (realGitSub(command, "push")) {
    // Block if currently on a protected branch
    if (!getSetting(gitCwd, "allow_push_to_protected_branches")) {
      if (branch && protectedBranches.has(branch))
        return {
          block: true,
          reason: `⛔ Cannot push to '${branch}' (protected). Create a feature branch.\nHint: If you're combining git checkout + git push in one bash call, split them into SEPARATE bash calls. Branch is checked before execution.`,
        };
      // Block explicit push to any protected branch (e.g., git push origin main).
      // Destination-ref aware (Qodo #5, PR #916): HEAD:main, feature:main,
      // +main, refs/heads/main, and quoted "main" all count — the SOURCE
      // side and remote names do not.
      const pb = pushTargetsProtectedBranch(command, protectedBranches);
      if (pb)
        return {
          block: true,
          reason: `⛔ Cannot push to '${pb}' (protected). Create a feature branch.`,
        };
    }
    if (branch) {
      const pr = getPrMergeStatus(branch, gitCwd);
      if (pr.merged)
        return {
          block: true,
          reason: `⛔ PR #${pr.info} for '${branch}' already merged. Create a new branch.`,
        };
      if (mainBranch && isBranchMerged(branch, mainBranch, gitCwd))
        return {
          block: true,
          reason: `⛔ Branch '${branch}' already merged into '${mainBranch}'. Create a new branch.`,
        };
    }
  }

  return undefined;
}



/** Honest failure notice for a failed approval write — names the ACTUAL
 * reason instead of a generic "settings unreadable" (Qodo PR #950 R8). */
function approvalFailureMessage(reason: "corrupt" | "write_failed" | "trust_unknown" | "project_untrusted"): string {
  switch (reason) {
    case "corrupt":
      return "⚠️ Approval could not be saved — the settings file is unreadable/corrupt (nothing was overwritten). This approval is one-time; repair the file to persist approvals.";
    case "write_failed":
      return "⚠️ Approval could not be saved — writing the settings file failed (permissions/disk?). This approval is one-time; check the enforcement log for details.";
    case "trust_unknown":
      return "⚠️ Approval could not be saved — the project settings file's trust could not be verified (git check failed). This approval is one-time; retry once git is available so it can be stored safely.";
    case "project_untrusted":
      return "⚠️ Approval could not be saved to the project — its settings file is not trustable (git-tracked or symlinked). Choose \"everywhere\" to store the approval globally, or run once.";
  }
}

/** Post-save notices for the allow-all path: failures get their reason.
 * A global-scope store needs no notice anymore — the user CHOSE "everywhere"
 * explicitly in the prompt (PR #950 R8; the old silent-fallback notice is
 * gone along with the fallback itself). */
async function notifyApprovalResults(
  saved: number,
  failed: number,
  _scopes: string[],
  ui?: { notify: (msg: string, level: "info" | "warning" | "error") => Promise<void> | void },
): Promise<void> {
  void _scopes;
  if (failed > 0) {
    await ui?.notify(
      `⚠️ ${failed} approval${failed > 1 ? "s" : ""} could not be saved — treated as run-once (see the enforcement log for the reason).`,
      "warning",
    );
  }
}

/** Dangerous command confirmation with UI prompt */
async function checkDangerousCommands(command: string, cwd: string, ctx: any): Promise<EnforcementResult> {
  // Split on statement separators AND pipes (incl. single `&` — background
  // operator) via the shared, tested splitter (Qodo PR #948).
  const statements = splitBashStatements(command);
  const hasDangerous = statements.some((stmt) => {
    // Skip read-only commands with no dangerous subshells
    if (isReadOnlyStatement(stmt)) return false;
    return DANGEROUS.some((p) => p.test(stmt));
  });
  if (hasDangerous) {
    // Absolute-path requirement for recursive rm (issue #963): a persistent
    // "always allow" stores the statement TEXT, so a relative target would
    // approve the identical text in ANY directory. Force the agent to spell
    // out the full path — the approval then binds to exactly one folder the
    // user knows. Blocks in every mode (headless included): this is a
    // rewrite rule, not a confirmation.
    const relativeRm = statements
      .map((stmt) => ({
        stmt,
        target: isReadOnlyStatement(stmt) ? null : relativeRecursiveRmTarget(stmt),
      }))
      .find((r) => r.target !== null);
    if (relativeRm && relativeRm.target !== null) {
      log.warn("recursive_rm_relative_path_blocked", { target: relativeRm.target });
      return {
        block: true,
        reason:
          `Blocked: recursive rm must use ABSOLUTE paths — "${relativeRm.stmt.trim()}" targets ` +
          `"${relativeRm.target}", which is relative. A persistent "always allow" stores the ` +
          `statement text, so a relative target would approve the same text in ANY directory. ` +
          `Rewrite as rm -rf ${resolve(resolveEffectiveCwd(command, cwd), relativeRm.target)} (full path) and re-run. ` +
          `Do NOT bypass with an equivalent command (find -delete, git clean, perl, python ` +
          `os.remove). Stop and report this block to the user if a rewrite is not possible.`,
      };
    }

    // Allow rm -rf targeting only .pi/tmp/ paths without confirmation
    const allRmInTmp = statements
      .filter((stmt) => DANGEROUS.some((p) => p.test(stmt)) && !isReadOnlyStatement(stmt))
      .every((stmt) => isRmInProjectTmp(stmt, cwd));
    if (allRmInTmp) return undefined;

    // User-approved allowlist (issue #949): the gate identifies the DANGEROUS
    // STATEMENTS (split out of the chain, benign plumbing tails — descriptor
    // duplication and /dev/null redirects — stripped) and each must be
    // approved. A chain where every dangerous statement matches an allowlist
    // entry runs silently, but never invisibly: every hit is logged.
    // "always allow" stores the dangerous STATEMENTS — the minimal reusable
    // approval — so `bash .dev/deploy-all.sh` approved once covers any chain
    // that contains exactly that statement (user request, PR #950).
    //
    // EXCEPT stdin-fed shells (Qodo PR #950 R6): a bare `bash`/`sh` carries
    // none of the script it will run (`x | bash`, `bash <<EOF`, `base64 -d |
    // bash` all reduce to it), so it is NEVER allowlist-matchable and never
    // offered a persistent approval — run-once only, every time.
    const dangerousStmts = [
      ...new Set(
        statements
          .filter((stmt) => DANGEROUS.some((p) => p.test(stmt)) && !isReadOnlyStatement(stmt))
          .map((stmt) => normalizeDangerousStatement(stmt)),
      ),
    ];
    const unapproved: string[] = [];
    // ONE trust check + ONE settings read per command (Qodo PR #950 R8
    // perf): the per-statement findDangerousAllowlistEntry ran a synchronous
    // git exec per statement — batch the load and match in memory.
    const allowlists = loadDangerousAllowlists(cwd);
    for (const stmt of dangerousStmts) {
      if (isStdinFedShellStatement(stmt)) {
        unapproved.push(stmt);
        continue;
      }
      const allowMatch = matchDangerousAllowlist(allowlists, stmt);
      if (!allowMatch) {
        unapproved.push(stmt);
        continue;
      }
      // No command/entry text in logs (Qodo PR #950): an approved statement
      // may contain inline credentials — global log files must not copy it
      // out of the project. The matched pattern + entry hash prefix
      // identify the hit; the entry itself lives in the settings file.
      log.warn("dangerous_command_allowlisted", {
        dangerousPattern: String(DANGEROUS.find((p) => p.test(stmt)) ?? "unknown"),
        entryHashPrefix: dangerousCommandHash(allowMatch.entry).slice(0, 12),
        source: allowMatch.source,
      });
    }
    if (unapproved.length === 0) return undefined;

    if (!ctx.hasUI)
      return {
        block: true,
        reason: "Dangerous command blocked (no UI for confirmation). Do NOT retry with an equivalent command (e.g., find -delete, perl, python os.remove). Stop and report this block to the user.",
      };

    // Interactive decision loop (user request, PR #950): every dangerous
    // statement gets its own "Always allow" option in BOTH scopes — "this
    // project" and "everywhere" (user request, R8: the user chooses where a
    // persistent approval lives; global is never a silent fallback) — plus
    // run-once, allow-all (both scopes), and No. Choosing one statement
    // persists just that entry and re-prompts for the remainder until
    // nothing dangerous is left.
    const projectTrustable = projectSettingsTrust(cwd) === "untracked";
    const decide = async (remaining: string[]): Promise<EnforcementResult | undefined> => {
      const list = remaining
        .map((stmt) => {
          const label = dangerousPatternLabel(DANGEROUS.find((p) => p.test(stmt)) ?? /./);
          const stdinFed = isStdinFedShellStatement(stmt)
            ? "\n    ↳ reads its script from stdin — run-once only, never persistently approvable"
            : "";
          return `  ${stmt}\n    ↳ ${label}${stdinFed}`;
        })
        .join("\n");
      const scopeNote = projectTrustable
        ? ""
        : "\n\nℹ️ The project settings file is not trustable for approvals (git-tracked or\nsymlinked) — persistent approvals can only be stored globally.";
      // Only statements that carry their own script are persistently
      // approvable (Qodo PR #950 R6) — stdin-fed shells are run-once only.
      const persistable = remaining.filter((stmt) => !isStdinFedShellStatement(stmt));
      // Option labels are truncated for the menu; keep them unique.
      // Computed ONCE — the choice handler looks up by the same objects.
      const seen = new Map<string, number>();
      const labelFor = (stmt: string): string => {
        const base = stmt.length > 60 ? `${stmt.slice(0, 57)}…` : stmt;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        return n === 1 ? base : `${base} (#${n})`;
      };
      const labeled = persistable.map((stmt) => ({ stmt, label: labelFor(stmt) }));
      const options = [
        "Yes — run once",
        ...labeled.flatMap(({ label }) => [
          ...(projectTrustable ? [`Always allow (this project): ${label}`] : []),
          `Always allow (everywhere): ${label}`,
        ]),
        ...(persistable.length > 1
          ? [
              ...(projectTrustable ? ["Always allow all of the above (this project)"] : []),
              "Always allow all of the above (everywhere)",
            ]
          : []),
        "No",
      ];
      const ok = await ctx.ui.select(
        `⚠️ Dangerous statement${remaining.length > 1 ? "s" : ""} (of the full command):\n\n${list}${scopeNote}\n\nAllow?`,
        options,
      );
      if (ok === "No" || ok === undefined)
        return { block: true, reason: "Blocked by user. Do NOT retry with an equivalent command (e.g., find -delete, perl, python os.remove). Stop and report this block to the user." };
      if (ok === "Yes — run once" || ok.startsWith("Always allow all of the above")) {
        if (ok.startsWith("Always allow all of the above")) {
          // Persist only the persistable statements — stdin-fed shells are
          // run-once by design and must never land in the settings file.
          // The scope comes from the CHOSEN option — never a silent fallback.
          // Report the REAL outcome: a failed write is a one-time approval,
          // not a stored one (Qodo PR #950 R7 — the audit trail must not
          // claim a save that did not happen).
          const scope = ok.endsWith("(everywhere)") ? "global" : "project";
          const results = persistable.map((stmt) => addDangerousAllowlistEntry(cwd, stmt, scope));
          const saved = results.filter((r) => r.ok);
          const failed = results.length - saved.length;
          const scopes = [...new Set(saved.map((r) => (r.ok ? r.scope : "")))];
          log.info("dangerous_command_allowlist_entry_added", {
            count: saved.length,
            failed,
            storedIn: scopes.length === 1 ? `${scopes[0]} settings (dangerous_command_allowlist)` : scopes.join("+"),
          });
          await notifyApprovalResults(saved.length, failed, scopes, ctx.ui);
        }
        return undefined;
      }
      if (ok.startsWith("Always allow (this project): ") || ok.startsWith("Always allow (everywhere): ")) {
        const scope = ok.startsWith("Always allow (everywhere): ") ? "global" : "project";
        const chosen = labeled.find(({ label }) => ok === `Always allow (${scope === "global" ? "everywhere" : "this project"}): ${label}`)?.stmt;
        if (chosen !== undefined) {
          const result = addDangerousAllowlistEntry(cwd, chosen, scope);
          if (result.ok) {
            log.info("dangerous_command_allowlist_entry_added", {
              dangerousPattern: dangerousPatternLabel(DANGEROUS.find((p) => p.test(chosen)) ?? /./),
              hashPrefix: dangerousCommandHash(chosen).slice(0, 12),
              storedIn: `${result.scope} settings (dangerous_command_allowlist)`,
            });
          } else {
            log.warn("dangerous_allowlist_entry_add_failed", {
              reason: result.reason,
              hashPrefix: dangerousCommandHash(chosen).slice(0, 12),
            });
            await ctx.ui.notify(approvalFailureMessage(result.reason), "warning");
          }
          const still = remaining.filter((s) => s !== chosen);
          if (still.length === 0) return undefined;
          return decide(still);
        }
      }
      return undefined;
    };
    return decide(unapproved);
  }

  return undefined;
}

export function registerEnforcement(pi: ExtensionAPI, inContainer?: boolean): void {

  pi.on("session_start", (_event, ctx) => {
    cachedTrailerSelection = null;
    // Set comment signature env var for CLI tools to read
    if (getSetting(ctx.cwd, "comment_signature")) {
      const modelId = ((ctx as any).model?.id || process.env.PI_MODEL || process.env.PI_PRIMARY_MODEL || "unknown").replace(/[^a-zA-Z0-9._:@/ -]/g, "").trim() || "unknown";
      process.env.PI_COMMENT_SIGNATURE = `Assisted-by: PI (${modelId})`;
    } else {
      delete process.env.PI_COMMENT_SIGNATURE;
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    // Memory-based enforcement — block rules checked before execution (all tool types)
    try {
      const entries = loadEnforcedEntries(ctx.cwd, (ctx as any).sessionManager?.getSessionId?.());
      const blockEntries = entries.filter(e => e.action === "block");
      if (blockEntries.length > 0) {
        const toolName = isToolCallEventType("bash", event) ? "bash"
          : isToolCallEventType("write", event) ? "write"
          : isToolCallEventType("edit", event) ? "edit"
          : isToolCallEventType("read", event) ? "read"
          : (event as any).toolName || "";
        const input = (event as any).input || {};
        const matches = matchToolCall(blockEntries, toolName, input);
        if (matches.length > 0) {
          const rule = matches[0].rule;
          log.info("enforcement_block", toolName, rule.text);
          return { block: true, reason: `⛔ ENFORCEMENT [${rule.entry.class}]: ${rule.text}` };
        }
      }
    } catch { /* enforcement should never break normal flow */ }

    // Block orchestrator from using edit/write directly — must delegate to subagents.
    // Subagents (PI_SUBAGENT_CHILD=1) are allowed.
    if (process.env.PI_SUBAGENT_CHILD !== "1" && getSetting(ctx.cwd, "orchestrator_edit_write_block")) {
      if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
        const toolUsed = isToolCallEventType("edit", event) ? "edit" : "write";
        return {
          block: true,
          reason: `⛔ Orchestrator cannot use ${toolUsed} directly. Delegate to the appropriate specialist subagent via the subagent tool.`,
        };
      }
    }

    // Block direct manipulation of review state file — prevents LLM from bypassing review loop
    if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
      const filePath: string | undefined = (event as any).input?.path;
      if (filePath && resolve(ctx.cwd, filePath) === statePath(ctx.cwd)) {
        return {
          block: true,
          reason: "\u26d4 Direct modification of pi-config-review-state.jsonl blocked. The review state is managed by the enforcement system.",
        };
      }
    }

    // Block direct manipulation of the settings files (issue #949 / Qodo
    // PR #950): the dangerous-command allowlist now lives in
    // dangerous_command_allowlist in the settings files, so an agent
    // editing them could self-approve dangerous commands (a `*` entry
    // would allow everything, headless included). Settings changes flow
    // through the /pi-config-settings command or the user's own editor —
    // never agent tools. Applies to every agent, subagents included.
    if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
      const filePath: string | undefined = (event as any).input?.path;
      if (filePath) {
        // resolve() does not follow symlinks — a symlinked alias of .pi (or
        // of the file itself) must not slip past the comparison (Qodo PR
        // #950 R3). Compare BOTH the lexical resolve and the realpath (of the
        // target and of each protected path, best-effort — the file may not
        // exist yet).
        const toReal = (p: string): string => {
          try {
            return realpathSync(p);
          } catch {
            // The file may not exist yet — resolve the nearest existing
            // ancestor (a symlinked DIRECTORY alias still resolves) and
            // rejoin the remainder.
            const parent = dirname(p);
            if (parent === p) return p;
            try {
              return join(realpathSync(parent), basename(p));
            } catch {
              return p;
            }
          }
        };
        const resolved = resolve(ctx.cwd, filePath);
        // Both filename variants (.jsonc first, .json) in both scopes, PLUS
        // the resolved global path itself — its basename may differ from the
        // standard filenames (e.g. the test-runner sandbox), and the global
        // file carries the machine-wide allowlist either way.
        const settingsTargets = new Set<string>();
        for (const base of [dirname(getSettingsPath(ctx.cwd)), dirname(getGlobalSettingsPath())]) {
          for (const name of SETTINGS_FILENAMES) {
            settingsTargets.add(join(base, name));
            settingsTargets.add(toReal(join(base, name)));
          }
        }
        settingsTargets.add(getGlobalSettingsPath());
        settingsTargets.add(toReal(getGlobalSettingsPath()));
        if (settingsTargets.has(resolved) || settingsTargets.has(toReal(resolved))) {
          return {
            block: true,
            reason:
              "\u26d4 Direct modification of pi-config-settings blocked — it carries the dangerous-command allowlist. Change settings via the /pi-config-settings command or your own editor, never agent tools.",
          };
        }
      }
    }

    if (!isToolCallEventType("bash", event)) return undefined;
    const command = event.input.command;
    const cmdLower = command.trim().toLowerCase();

    // Block ALL bash commands targeting pi-config-review-state — no exceptions.
    // The review state is managed exclusively by the enforcement system.
    // If you need to inspect it, do it outside of pi.
    if (getSetting(ctx.cwd, "review_loop_enforcement") && cmdLower.includes("pi-config-review-state")) {
      return {
        block: true,
        reason: "\u26d4 Bash command targeting pi-config-review-state blocked. The review state is managed exclusively by the enforcement system.",
      };
    }

    // Block bash WRITES targeting the settings files (issue #949 / Qodo
    // PR #950) — same rationale as the edit/write block above: the
    // dangerous-command allowlist lives there. Deliberately NARROW (user
    // decision, R3): only a redirect INTO the file (>, >>, >|) or tee/sponge
    // taking the path as an argument blocks. Broad write-verb/interpreter
    // co-occurrence was tried and rejected — it taxed legitimate work on
    // this repo (heredocs editing source/docs that mention the filename)
    // while a determined agent bypasses any text guard anyway (variables,
    // concatenation). The tripwire catches the lazy one-liner; the tool
    // guard and the tracked-file guard carry the real protection.
    // Quoted regions carry PROSE, not structure — mask their content before
    // the redirect/tee tripwire (Qodo PR #950 R5: a PR body mentioning
    // "settings => pi-config-settings.json" must not be blocked).
    const maskedCmd = maskQuotedRegions(command);
    if (
      cmdLower.includes("pi-config-settings") &&
      (/>+\|?\s*\S*pi-config-settings/i.test(maskedCmd) ||
        /(?:^|[\s;&|(])(?:tee|sponge)\s+\S*pi-config-settings/i.test(maskedCmd) ||
        // Quoted redirect/tee TARGETS are invisible in the masked text —
        // catch them on the raw command (Qodo PR #950 R5).
        />+\s*["'][^"']*pi-config-settings/i.test(command) ||
        /(?:^|[\s;&|(])(?:tee|sponge)\s+["'][^"']*pi-config-settings/i.test(command))
    ) {
      return {
        block: true,
        reason:
          "\u26d4 Bash command writing pi-config-settings blocked — it carries the dangerous-command allowlist. Change settings via the /pi-config-settings command or your own editor.",
      };
    }

    // Block repeated identical commands (polling-by-spam) — orchestrator only.
    // Skip on acpx: async LLM agents are unavailable; foreground polls are expected.
    const parentSupportsAsyncLlm = supportsAsyncLlm(
      (ctx as any).model?.provider,
      ctx.cwd,
    );
    if (parentSupportsAsyncLlm && process.env.PI_SUBAGENT_CHILD !== "1") {
      ensureRepeatFile(ctx.cwd);
      const normalized = normalizeForRepeatCheck(command);
      const rs = readRepeatState();
      if (normalized === rs.lastCmd) {
        rs.count++;
        writeRepeatState(rs);
        if (rs.count >= 3) {
          return {
            block: true,
            reason: `⛔ Same command executed ${rs.count} times in a row. Use a subagent with async: true for polling/monitoring instead of repeating the command.`,
          };
        }
      } else {
        writeRepeatState({ lastCmd: normalized, count: 1 });
      }
    }

    // Strip timeout on long-running poll commands — these can take 30+ minutes
    // (rate limit waits). The LLM keeps setting timeouts despite prompt instructions.
    // Instead of blocking (which causes infinite retry loops), silently remove the timeout.
    if (/\bmyk-pi-tools\b[\s\S]*\breviews\s+poll\b/.test(command) && event.input.timeout) {
      delete event.input.timeout;
    }

    const pythonCheck = checkPythonPipBlock(command, cmdLower);
    if (pythonCheck) {
      if ("autofix" in pythonCheck) {
        event.input.command = pythonCheck.modifiedCommand;
        // Don't block — continue with the modified command
      } else {
        return pythonCheck;
      }
    }

    // Block memory writes from specialist agents — only orchestrator can write
    if (process.env.PI_SUBAGENT_CHILD === "1" && /\bmyk-pi-tools\b.*\bmemory\s+(add|delete)\b/.test(command)) {
      return {
        block: true,
        reason: "Memory writes are restricted to the orchestrator. Specialists can only search/list memories.",
      };
    }

    // Block direct docker/podman CLI in container — force docker-safe wrapper
    if (inContainer && /(?:^|[|;&]\s*)(?:docker|podman)\s/.test(cmdLower) && !cmdLower.includes("docker-safe")) {
      return {
        block: true,
        reason: "Direct docker/podman forbidden. Use docker-safe for read-only container inspection (ps, logs, inspect, top, stats).",
      };
    }

    // Block sleep inside loops / long sleeps — force async on native providers only.
    // On acpx, do not push async (unsupported); foreground waits are allowed.
    const hasLoop = /\b(while|for|until)\b/.test(command);
    const sleepMatch = command.match(/\bsleep\s+(\d+)/);
    if (parentSupportsAsyncLlm && hasLoop && sleepMatch && parseInt(sleepMatch[1], 10) > getSetting(ctx.cwd, "enforcement_loop_sleep_threshold_s")) {
      return {
        block: true,
        reason: `⚠️ Polling loop with sleep ${sleepMatch[1]}s blocked. Use subagent with async: true for polling/monitoring tasks instead of blocking the session.`,
      };
    }

    if (parentSupportsAsyncLlm && !hasLoop && sleepMatch && parseInt(sleepMatch[1], 10) > getSetting(ctx.cwd, "enforcement_sleep_threshold_s")) {
      return {
        block: true,
        reason: `⚠️ sleep ${sleepMatch[1]}s blocked — too long. Use subagent with async: true instead of blocking the session.`,
      };
    }

    const remoteCheck = checkRemoteExecBlock(cmdLower);
    if (remoteCheck) return remoteCheck;

    // comment_signature: inject Assisted-by footer into gh pr/issue create|comment|edit bodies
    if (getSetting(ctx.cwd, "comment_signature")) {
      const modelId = (
        (ctx as any).model?.id ||
        process.env.PI_MODEL ||
        process.env.PI_PRIMARY_MODEL ||
        "unknown"
      ).replace(/[^a-zA-Z0-9._:@/ -]/g, "").trim() || "unknown";
      const signature = `Assisted-by: PI (${modelId})`;
      const injected = injectGhBodySignature(event.input.command, signature);
      if (injected !== event.input.command) {
        log.info("comment_signature injected into gh body command", signature);
        event.input.command = injected;
      }
    }

    // Enforce git commit/push only via git-expert agent.
    // Use isRealGitCommitOrPush (heredoc-stripped + command-position aware) so that
    // file CONTENT / string args / paths that merely MENTION "git commit" do not trip
    // the guard (BUG #3). Only genuine git commit/push invocations are blocked.
    if (process.env.PI_AGENT_NAME !== "git-expert") {
      if (isRealGitCommitOrPush(command)) {
        return {
          block: true,
          reason: "⛔ git commit/push blocked. Use git-expert agent for commit and push operations.",
        };
      }
    }

    // Conflict resolution belongs to conflict-resolver. git-expert is routinely
    // pinned to a small model, which cannot judge intent on both sides of a
    // conflict, so the handoff is enforced here rather than left to the prompt.
    // Reads (git status/diff) and `--abort` stay allowed.
    if (process.env.PI_AGENT_NAME === "git-expert" && createsAndResolvesConflict(command)) {
      // The index below is read *before* the command runs, so a command that
      // starts a merge and then stages a side would pass the check and resolve
      // the conflict it just created.
      // error, not warn: the command was refused, not recovered from.
      log.error("conflict_created_and_resolved", "agent", process.env.PI_AGENT_NAME ?? "unknown");
      return {
        block: true,
        reason:
          "\u26d4 This command starts a merge/rebase/cherry-pick and then stages a resolution of it. " +
          "The conflict does not exist yet, so it cannot be checked. Delegate to the conflict-resolver " +
          'agent (subagent(agent="conflict-resolver")), and let git-expert commit the staged result.',
      };
    }
    if (process.env.PI_AGENT_NAME === "git-expert" && isConflictResolutionCommand(command)) {
      // Which directory does git run in? A conditional branch, a completed
      // subshell, or several invocations in one command have no single answer,
      // and guessing wrong lets a resolution through. So ask every directory the
      // command could reach: block if any is conflicted. Over-blocking costs a
      // message; under-blocking costs the guard.
      const { all, envOverride, dynamicPath } = conflictCandidateDirs(command, ctx.cwd);
      if (dynamicPath) {
        // The shell expands this path at run time, so there is nothing to check.
        return {
          block: true,
          reason:
            `⛔ ${dynamicPath} is expanded by the shell, so the repository it selects cannot be verified. ` +
            "Do not resolve conflicts in git-expert — abort and delegate to the " +
            `conflict-resolver agent (subagent(agent="conflict-resolver")).`,
        };
      }
      if (envOverride) {
        // GIT_DIR/GIT_WORK_TREE can point the index anywhere. Rather than
        // guess which repository it selects, refuse.
        return {
          block: true,
          reason:
            `⛔ ${envOverride} selects the Git repository or index for this command, so the conflict state ` +
            "cannot be verified. Do not resolve conflicts in git-expert — abort and delegate to the " +
            `conflict-resolver agent (subagent(agent="conflict-resolver")).`,
        };
      }
      const conflicted: string[] = [];
      let readable = 0;
      const unreadable: string[] = [];
      for (const dir of all) {
        const lookup = listUnmergedFiles(dir);
        if (!lookup.ok) {
          // An unreadable repository is unknown, not clean — but a directory that
          // is not a repository has no index to be unknown about.
          if (isInsideGitWorkTree(dir)) unreadable.push(dir);
          continue;
        }
        readable++;
        // Paths are repo-relative; the directory names the repository checked.
        for (const file of lookup.files) conflicted.push(dir === ctx.cwd ? file : `${dir} → ${file}`);
      }
      // Any unreadable repository means the command may be staging into a state
      // nobody checked, so it is refused — not excused because another candidate
      // happened to answer.
      if (conflicted.length === 0 && unreadable.length > 0) {
        // A repository whose index will not answer: the conflict state there is
        // unknown, so it is refused. A directory that is not a repository at all
        // has no index to be unknown about and is never in this list.
        // error, not warn: the check that gates this block failed.
        log.error("conflict_lookup_failed", unreadable.join(", "));
        return {
          block: true,
          reason:
            `⛔ Could not read the unmerged index in ${unreadable.join(", ")}, so the conflict state is ` +
            "unknown. Refusing to run a resolution command blind: run `git status` to see where you are, " +
            `or delegate to the conflict-resolver agent (subagent(agent="conflict-resolver")).`,
        };
      }
      if (conflicted.length > 0) {
        log.error("conflict_resolution_blocked", conflicted.join(", "));
        return {
          block: true,
          reason:
            `⛔ Unresolved conflicts in ${conflicted.join(", ")}. Do not resolve them in git-expert — ` +
            `stop, report this message to the caller, and have it delegate to the conflict-resolver ` +
            `agent (subagent(agent="conflict-resolver")). To back out instead: ` +
            `git merge --abort / git rebase --abort / git cherry-pick --abort.`,
        };
      }
    }

    // Enforce review loop — block commit unless review state is clean
    // Use resolveEffectiveCwd to detect the worktree from cd commands (e.g., cd .worktrees/issue-622 && git commit)
    if (process.env.PI_AGENT_NAME === "git-expert" && realGitSub(command, "commit")) {
      const commitCwd = resolveEffectiveCwd(command, ctx.cwd);
      // Skip review enforcement on version bump branches (release workflow only)
      const commitBranch = getCurrentBranch(commitCwd);
      if (!isBumpVersionBranch(commitBranch) && getSetting(commitCwd, "review_loop_enforcement") && !isCommitAllowed(commitCwd)) {
        const state = readReviewState(commitCwd);
        const testInfo = state.status === "clean" && !state.tests_passed ? " Tests have not passed yet — run tests before committing." : "";
        const reviewAdvice = state.status !== "clean" ? " Fix findings and re-run all reviewers until 0 comments." : "";
        return {
          block: true,
          reason: `\u26d4 Review loop incomplete (status: ${state.status}, cycle ${state.cycle}, ${state.findings_count} findings, ${state.reviewers_pending.length} reviewers pending, tests_passed: ${state.tests_passed}).${testInfo}${reviewAdvice}`,
        };
      }
    }

    // Git protection
    const gitCwd = resolveEffectiveCwd(command, ctx.cwd);
    const gitCheck = await checkGitProtection(command, event, ctx, gitCwd);
    if (gitCheck) return gitCheck;

    const tmpCheck = checkTempFileEnforcement(command, ctx.cwd);
    if (tmpCheck) return tmpCheck;

    const dangerCheck = await checkDangerousCommands(command, ctx.cwd, ctx);
    if (dangerCheck) return dangerCheck;

    return undefined;
  });

  // ── Memory-based enforcement (tool_result hook) ───────────────────
  // After a tool completes, check if any enforced memory entry's trigger
  // matches. Executes block/run_after/warn actions.
  pi.on("tool_result", async (event, ctx) => {
    if (process.env.PI_SUBAGENT_CHILD === "1") return;

    const toolName = (event as any).toolName as string;
    const input = (event as any).input || {};

    let entries: ReturnType<typeof loadEnforcedEntries>;
    try {
      entries = loadEnforcedEntries(ctx.cwd, (ctx as any).sessionManager?.getSessionId?.());
    } catch (e: any) {
      log.debug("enforcement: loadEnforcedEntries failed:", e?.message?.slice(0, 100));
      return;
    }
    log.info("enforcement_loaded", entries.length);
    if (entries.length === 0) return;



    // Failed edit/write calls skip file_modified matching (#940) — log the
    // decision so silent trigger skips are diagnosable (Qodo 2addbfc4).
    const isToolCallError = (event as any).isError === true;
    if (isToolCallError && (toolName === "edit" || toolName === "write") && input?.path) {
      failedFileEditSkipMessage(toolName, input.path);
    }
    let matches = matchToolCall(entries, toolName, input, isToolCallError);

    // For subagent results, extract actual bash commands from the subagent's
    // tool call messages (structured data only — no prose text fallback).
    if (toolName === "subagent") {
      const details = (event as any).details;
      const results = Array.isArray(details?.results) ? details.results : [];
      if (!Array.isArray(details?.results) && details?.results) {
        log.debug(`enforcement: subagent details.results is ${typeof details.results} (expected array), skipping bash extraction`);
      }
      const nonBlockEntries = entries.filter(e => e.action !== "block");
      const seen = new Set<string>();
      const bashCommands: string[] = [];
      for (const r of results) {
        const msgs = Array.isArray(r?.messages) ? r.messages : [];
        // Error state per tool call (#940, Qodo 1f528064): a subagent's
        // FAILED edit/write modified nothing, so its file_modified triggers
        // must be skipped exactly like a failed top-level call. The result
        // messages carry role "toolResult" entries with toolCallId/isError.
        // A call with NO result at all (Qodo 2d02b5d5) — the child exited
        // after emitting the call but before its result — has an UNKNOWN
        // outcome, so it must not count as a successful modification
        // either: file_modified warnings fire only for calls that
        // explicitly succeeded.
        const erroredCalls = new Set<string>();
        const resolvedCalls = new Set<string>();
        for (const msg of msgs) {
          if (msg?.role !== "toolResult") continue;
          if (typeof (msg as any).toolCallId === "string") {
            resolvedCalls.add((msg as any).toolCallId);
          }
          if ((msg as any).isError === true && typeof (msg as any).toolCallId === "string") {
            erroredCalls.add((msg as any).toolCallId);
          }
        }
        for (const msg of msgs) {
          if (msg?.role !== "assistant") continue;
          const parts = Array.isArray(msg?.content) ? msg.content : [];
          for (const part of parts) {
            if (part?.type !== "toolCall") continue;
            // Check both field naming conventions (name/arguments and toolName/args)
            const partToolName = part?.name || part?.toolName;
            const partToolArgs = part?.arguments || part?.args;
            const partCallId = part?.id ?? part?.toolCallId;
            const partIsError = partCallId !== undefined && erroredCalls.has(partCallId);
            const partUnresolved = partCallId !== undefined && !resolvedCalls.has(partCallId);
            if (partToolName === "bash" && partToolArgs?.command) {
              bashCommands.push(partToolArgs.command);
            }
            // Also check non-bash tool calls against tool_name/file_modified triggers
            if (partToolName && partToolName !== "bash") {
              // Failed child edit/write calls skip file_modified matching
              // like top-level ones (#940) — leave the same diagnostic
              // naming the tool and path (Qodo b00dc05f).
              if (
                partIsError &&
                (partToolName === "edit" || partToolName === "write") &&
                partToolArgs?.path
              ) {
                failedFileEditSkipMessage(partToolName, partToolArgs.path);
              }
              const toolMatches = matchToolCall(
                nonBlockEntries,
                partToolName,
                partToolArgs || {},
                partIsError || partUnresolved,
              );
              for (const m of toolMatches) {
                if (!seen.has(m.rule.hash)) {
                  seen.add(m.rule.hash);
                  matches.push(m);
                }
              }
            }
          }
        }
      }
      if (bashCommands.length > 0) {
        // Match against ALL structured bash commands
        for (const cmd of bashCommands) {
          const cmdMatches = matchBashCommand(nonBlockEntries, cmd);
          for (const m of cmdMatches) {
            if (!seen.has(m.rule.hash)) {
              seen.add(m.rule.hash);
              matches.push(m);
            }
          }
        }
      }
      // No fallback to prose text — only structured tool calls are reliable.
      // Prose matching causes false positives (e.g., "git status" in a sentence).
    }

    if (matches.length === 0) return;

    const currentContent = (event as any).content || [];
    const appendMessages: Array<{ type: string; text: string }> = [];

    for (const { rule } of matches) {
      if (rule.action === "block") {
        // Block is handled in tool_call hook (before execution)
        // tool_result only handles run_after and warn
        continue;
      }

      if (rule.action === "run_after" && rule.actionCommand && !(event as any).isError) {
        const result = executeAction(rule.actionCommand, ctx.cwd);
        if (result.success) {
          appendMessages.push({
            type: "text",
            text: `\n✅ Auto-enforced: ${rule.actionCommand}\n${result.output}`,
          });
        } else {
          appendMessages.push({
            type: "text",
            text: `\n❌ Enforcement failed: ${rule.actionCommand}\n${result.output}`,
          });
        }
      }

      if (rule.action === "warn") {
        log.warn("enforcement_warn", toolName, rule.text);
        appendMessages.push({
          type: "text",
          text: `\n⚠️ ENFORCEMENT WARNING: ${rule.text}`,
        });
      }
    }

    if (appendMessages.length > 0) {
      return {
        content: [...currentContent, ...appendMessages],
      };
    }
  });

  // ── Review state tracking (edit/write detection) ────────────────────
  // Runs in ALL processes (orchestrator + subagents) to catch edits from any specialist.
  pi.on("tool_result", async (event, ctx) => {
    if (!getSetting(ctx.cwd, "review_loop_enforcement")) return;

    const toolName = (event as any).toolName as string;
    if (toolName !== "edit" && toolName !== "write") return;

    const input = (event as any).input || {};
    const filePath: string | undefined = input.path;
    if (!filePath) return;

    // Skip failed edits — only successful changes need review
    const isError = (event as any).isError === true;
    if (isError) return;

    // Resolve the worktree root from the file's location.
    // This handles files in any worktree (not just .worktrees/) by asking git
    // which worktree the file belongs to via --show-toplevel.
    const absPath = resolve(ctx.cwd, filePath);
    const fileDir = dirname(absPath);
    let effectiveCwd: string;
    try {
      effectiveCwd = resolveWorktreeRoot(fileDir);
    } catch {
      effectiveCwd = ctx.cwd; // fallback to session cwd
    }
    // Skip review tracking on version bump branches (release workflow only)
    if (isBumpVersionBranch(getCachedBranch(effectiveCwd))) return;
    const relativePath = path.relative(effectiveCwd, absPath);

    // Skip gitignored files (build artifacts, .pi/tmp/, node_modules, etc.)
    // Run from the worktree root so files in worktrees are checked correctly
    // (from the main repo, .worktrees/ itself is gitignored — false positive).
    try {
      const result = spawnSync("git", ["check-ignore", "-q", relativePath], {
        cwd: effectiveCwd,
        timeout: 3000,
        stdio: "ignore",
      });
      if (result.status === 0) return; // gitignored — skip
    } catch {
      // git not available or error — proceed with marking (safe default)
    }

    // Retry markNeedsReview on lock failure — missing this would leave state
    // as 'clean' and allow commits to slip through enforcement.
    // Uses effectiveCwd so each worktree gets its own pi-config-review-state.jsonl.
    for (let attempt = 0; attempt < 3; attempt++) {
      try { markNeedsReview(effectiveCwd); break; } catch {
        if (attempt === 2) {
          // Last resort: log but don't crash the extension
          console.error("[enforcement] markNeedsReview failed after 3 attempts — review state may be stale");
        }
      }
    }
  });

  // ── Test command detection (auto-mark tests_passed in review state) ──
  // Runs in ALL processes (orchestrator + subagents) to catch test runs from any agent.
  // When a test command exits successfully, marks tests_passed=true in pi-config-review-state.jsonl.
  // When it fails, marks tests_passed=false. Any subsequent file edit resets tests_passed
  // via markNeedsReview(), so stale results are impossible.
  // NOTE: Code reviewers are excluded — they may run tests to verify behavior but their
  // test runs should not mark the project's test state. Only intentional test runs count.
  pi.on("tool_result", async (event, ctx) => {
    const toolName = (event as any).toolName as string;
    if (toolName !== "bash") return;

    // Skip test detection for code reviewers — their test runs are verification, not validation
    const agentName = process.env.PI_AGENT_NAME || "";
    if (agentName.startsWith("code-reviewer-")) return;

    const command: string = (event as any).input?.command || "";
    if (!command) return;

    const isTestCommand = isTestRunnerCommand(command);
    if (!isTestCommand) return;

    // Resolve the effective cwd BEFORE checking settings — the command may target
    // a different repo (cd <dir> or git -C <dir>), so we need that repo's settings.
    const effectiveCwd = resolveEffectiveCwd(command, ctx.cwd);
    if (!getSetting(effectiveCwd, "review_loop_enforcement")) return;

    const isError = (event as any).isError === true;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (isError) {
          markTestsFailed(effectiveCwd);
        } else {
          markTestsPassed(effectiveCwd);
        }
        break;
      } catch {
        if (attempt === 2) {
          console.error("[enforcement] markTests(Passed|Failed) failed after 3 attempts");
        }
      }
    }
  });

  // ── /review-status command — read-only access to review state ──────
  // Usage: /review-status [worktree-path]
  // Without args: shows main repo state. With path: shows that worktree's state.
  // Autocomplete for /review-status is provided by extended-autocomplete.ts
  // via the registerCommand wrapper (lists active worktrees).
  pi.registerCommand("review-status", {
    description: "Show current review loop enforcement state. Pass a worktree path to check its state.",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const worktreePath = args?.trim() || "";
      const targetCwd = worktreePath ? resolve(ctx.cwd, worktreePath) : ctx.cwd;
      const state = readReviewState(targetCwd);
      const enabled = getSetting(ctx.cwd, "review_loop_enforcement");
      const worktreeLabel = worktreePath ? ` (worktree: ${worktreePath})` : "";
      const lines = [
        `Review Loop Enforcement: ${enabled ? "enabled" : "disabled"}${worktreeLabel}`,
        `Status: ${state.status}`,
        `Cycle: ${state.cycle}`,
        `Findings: ${state.findings_count}`,
        `Reviewers pending: ${state.reviewers_pending.length}/${state.reviewers_total}${state.reviewers_pending.length > 0 ? " (" + state.reviewers_pending.join(", ") + ")" : ""}`,
        `Edited during cycle: ${state.edited_during_cycle}`,
        `Tests passed: ${state.tests_passed}`,
        `Last edit: ${state.last_edit_at || "none"}`,
        `Last clean: ${state.last_clean_at || "none"}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── review_status tool — LLM-callable read-only access to review state ──
  pi.registerTool({
    name: "review_status",
    label: "Review Status",
    description: "Get current review loop enforcement state. Use to check if review is needed, in progress, clean, or has findings before committing. Pass worktree_path to check a specific worktree's state.",
    parameters: Type.Object({
      worktree_path: Type.Optional(Type.String({ description: "Path to a worktree directory to check its review state instead of the main repo" })),
    }),
    async execute(_callId, params, _signal, _onUpdate, ctx) {
      const targetCwd = params.worktree_path ? resolve(ctx.cwd, params.worktree_path) : ctx.cwd;
      const state = readReviewState(targetCwd);
      const enabled = getSetting(ctx.cwd, "review_loop_enforcement");
      const prefix = params.worktree_path ? `worktree: ${params.worktree_path}\n` : "";
      const summary = [
        `${prefix}enforcement: ${enabled ? "enabled" : "disabled"}`,
        `status: ${state.status}`,
        `cycle: ${state.cycle}`,
        `findings: ${state.findings_count}`,
        `pending: ${state.reviewers_pending.length}/${state.reviewers_total}${state.reviewers_pending.length > 0 ? " (" + state.reviewers_pending.join(", ") + ")" : ""}`,
        `edited_during_cycle: ${state.edited_during_cycle}`,
        `tests_passed: ${state.tests_passed}`,
        `last_edit: ${state.last_edit_at || "none"}`,
        `last_clean: ${state.last_clean_at || "none"}`,
      ].join("\n");
      return {
        content: [{ type: "text" as const, text: summary }],
        details: { state, enabled, worktree_path: params.worktree_path || null },
      };
    },
  });
}

// trigger re-scan
