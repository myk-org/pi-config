/**
 * Enforcement handler — blocks forbidden commands (python/pip, git protection,
 * remote script execution, memory writes, dangerous) + memory-based enforcement rules.
 * Worktree-aware: resolves file edits to the correct worktree root for per-worktree
 * review state tracking and gitignore checks.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadEnforcedEntries, matchToolCall, matchBashCommand, executeAction } from "./enforcement-rules.js";
import { readFileSync, writeFileSync } from "node:fs";
import path, { join, resolve, dirname } from "node:path";
import { getSetting } from "./project-settings.js";
import { getProjectTmpDir, resolveWorktreeRoot } from "./utils.js";
import {
  DANGEROUS,
  getCurrentBranch,
  getMainBranch,
  getProtectedBranches,
  getPrMergeStatus,
  hasGitSub,
  isBranchAhead,
  isBranchMerged,
  isGitRepo,
  runGit,
} from "./git-helpers.js";
import { spawnSync } from "node:child_process";
import { markNeedsReview, isReviewClean, readReviewState, statePath, markTestsPassed, markTestsFailed } from "./pi-config-review-state.js";
import {
  checkPythonPipBlock,
  checkRemoteExecBlock,
  checkTempFileEnforcement,
  hasGitAddBulk,
  isReadOnlyStatement,
  isRmInProjectTmp,
  normalizeForRepeatCheck,
  resolveEffectiveCwd,
  stripHeredocBodies,
  escapeForDoubleQuote,
  escapeForSingleQuote,
  isTestRunnerCommand,
} from "./enforcement-helpers.js";

type EnforcementResult = { block: true; reason: string } | undefined;

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
  } catch (e: any) { console.debug("[enforcement] write repeat state failed:", e?.message || e); }
}



/** Inject commit trailer into command (Assisted-by, Co-authored-by, etc.) */
async function handleCommitTrailer(command: string, event: any, ctx: any, gitCwd: string): Promise<EnforcementResult> {
  const trailerSetting = getSetting(gitCwd, "commit_trailer");
  if (typeof trailerSetting !== "string") return undefined;

  const modelId = (ctx as any).model?.id;
  if (!modelId) return undefined;

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

  // Raw trailer line for duplicate detection (what the commit message should contain)
  const rawTrailerLine = `${trailerName}: ${piIdentity}`;
  if (command.includes(rawTrailerLine)) return undefined;

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
    if (hasGitSub(command, "checkout") && !/\bgit\b.*\bcheckout\b.*\s--\s/.test(command)) {
      return { block: true, reason: `⛔ git checkout blocked — use_worktrees is enabled. ${hint}` };
    }
    if (hasGitSub(command, "switch")) {
      return { block: true, reason: `⛔ git switch blocked — use_worktrees is enabled. ${hint}` };
    }
  }

  // Block git add . / git add -A
  if (
    hasGitSub(command, "add") &&
    hasGitAddBulk(command)
  ) {
    return {
      block: true,
      reason:
        "⛔ 'git add .' / 'git add -A' forbidden. Stage specific files.",
    };
  }

  // Block git add --force / -f (including combined short options like -fn) — bypasses .gitignore
  if (hasGitSub(command, "add") && (/\bgit\b.*\badd\b.*(?:\s-\S*f|\s--force\b)/.test(command))) {
    return {
      block: true,
      reason: "⛔ 'git add -f/--force' forbidden. It bypasses .gitignore and stages ignored files.",
    };
  }

  // Block staging gitignored files
  if (hasGitSub(command, "add") && !hasGitAddBulk(command)) {
    // Extract file paths from git add command
    const addMatch = command.match(/\bgit\b.*\badd\b\s+(.+)/);
    if (addMatch) {
      const files = addMatch[1].split(/\s+/).filter((f) => !f.startsWith("-"));
      for (const file of files) {
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
  if (hasGitSub(command, "commit") && command.includes("--no-verify")) {
    return {
      block: true,
      reason: "⛔ --no-verify forbidden. Pre-commit hooks must run.",
    };
  }

  const branch = getCurrentBranch(gitCwd);
  const mainBranch = getMainBranch(gitCwd);
  const protectedBranches = getProtectedBranches(gitCwd);

  // Block commits to protected branches (unless allow_push_to_protected is set)
  if (hasGitSub(command, "commit")) {
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

    // DCO enforcement — inject --signoff when dco setting is enabled
    if (getSetting(gitCwd, "dco") && !/(?:^|\s)--signoff(?:\s|$)/.test(command) && !/(?:^|\s)-s(?:\s|$)/.test(command)) {
      event.input.command = event.input.command.replace(
        /\bgit\b((?:\s+(?:-[a-zA-Z]\s+\S+|-\S+))*\s+)commit\b/,
        "git$1commit --signoff",
      );
    }
  }

  // Block pushes to protected branches
  if (hasGitSub(command, "push")) {
    // Block if currently on a protected branch
    if (!getSetting(gitCwd, "allow_push_to_protected_branches")) {
      if (branch && protectedBranches.has(branch))
        return {
          block: true,
          reason: `⛔ Cannot push to '${branch}' (protected). Create a feature branch.\nHint: If you're combining git checkout + git push in one bash call, split them into SEPARATE bash calls. Branch is checked before execution.`,
        };
      // Block explicit push to any protected branch (e.g., git push origin v2.10)
      for (const pb of protectedBranches) {
        if (new RegExp(`\\bgit\\b.*\\bpush\\b.*\\b${pb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(command))
          return {
            block: true,
            reason: `⛔ Cannot push to '${pb}' (protected). Create a feature branch.`,
          };
      }
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



/** Dangerous command confirmation with UI prompt */
async function checkDangerousCommands(command: string, cwd: string, ctx: any): Promise<EnforcementResult> {
  // Strip heredoc content — heredoc text is not executable
  const cmdForDangerCheck = stripHeredocBodies(command);
  // Collapse bash line continuations (backslash-newline) before splitting
  const normalized = cmdForDangerCheck.replace(/\\\r?\n/g, " ");
  // Split on statement separators AND pipes to isolate individual commands.
  // NOTE: || must appear before | in the regex so the engine matches || greedily first.
  // NOTE: Pipe split does not respect shell quoting (e.g., echo "a|b" splits incorrectly).
  // This biases toward false positives (extra prompts), which is acceptable for security.
  // Do NOT add quoting awareness here — it would flip the bias toward false negatives.
  const statements = normalized.split(/\n|;|&&|\|\||\|/).map(s => s.trim()).filter(Boolean);
  const hasDangerous = statements.some((stmt) => {
    // Skip read-only commands with no dangerous subshells
    if (isReadOnlyStatement(stmt)) return false;
    return DANGEROUS.some((p) => p.test(stmt));
  });
  if (hasDangerous) {
    // Allow rm -rf targeting only .pi/tmp/ paths without confirmation
    const allRmInTmp = statements
      .filter((stmt) => DANGEROUS.some((p) => p.test(stmt)) && !isReadOnlyStatement(stmt))
      .every((stmt) => isRmInProjectTmp(stmt, cwd));
    if (allRmInTmp) return undefined;

    if (!ctx.hasUI)
      return {
        block: true,
        reason: "Dangerous command blocked (no UI for confirmation). Do NOT retry with an equivalent command (e.g., find -delete, perl, python os.remove). Stop and report this block to the user.",
      };

    const ok = await ctx.ui.select(
      `⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`,
      ["Yes", "No"],
    );
    if (ok !== "Yes") return { block: true, reason: "Blocked by user. Do NOT retry with an equivalent command (e.g., find -delete, perl, python os.remove). Stop and report this block to the user." };
  }

  return undefined;
}

export function registerEnforcement(pi: ExtensionAPI, inContainer?: boolean): void {

  pi.on("session_start", (_event, ctx) => {
    cachedTrailerSelection = null;
    // Set comment signature env var for CLI tools to read
    if (getSetting(ctx.cwd, "comment_signature")) {
      const modelId = (ctx as any).model?.id || "unknown";
      process.env.PI_COMMENT_SIGNATURE = `Assisted-by: PI (${modelId})`;
    } else {
      delete process.env.PI_COMMENT_SIGNATURE;
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    // Memory-based enforcement — block rules checked before execution (all tool types)
    try {
      const entries = loadEnforcedEntries(ctx.cwd);
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
          return { block: true, reason: `⛔ ENFORCEMENT [${rule.entry.class}]: ${rule.text}` };
        }
      }
    } catch { /* enforcement should never break normal flow */ }

    // Block direct manipulation of review state file — prevents LLM from bypassing review loop
    if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
      const filePath: string | undefined = (event as any).input?.path;
      if (filePath && resolve(ctx.cwd, filePath) === statePath(ctx.cwd)) {
        return {
          block: true,
          reason: "\u26d4 Direct modification of pi-config-review-state.json blocked. The review state is managed by the enforcement system.",
        };
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
        reason: "\u26d4 Bash command targeting pi-config-review-state blocked. The review state is managed by the enforcement system.",
      };
    }

    // Block repeated identical commands (polling-by-spam) — orchestrator only
    if (process.env.PI_SUBAGENT_CHILD !== "1") {
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

    const pythonCheck = checkPythonPipBlock(cmdLower);
    if (pythonCheck) return pythonCheck;

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

    // Block sleep inside loops — force async subagent for polling
    const hasLoop = /\b(while|for|until)\b/.test(command);
    const sleepMatch = command.match(/\bsleep\s+(\d+)/);
    if (hasLoop && sleepMatch && parseInt(sleepMatch[1], 10) > 5) {
      return {
        block: true,
        reason: `⚠️ Polling loop with sleep ${sleepMatch[1]}s blocked. Use subagent with async: true for polling/monitoring tasks instead of blocking the session.`,
      };
    }

    // Block standalone sleep > 30s — use async subagent instead of blocking
    if (!hasLoop && sleepMatch && parseInt(sleepMatch[1], 10) > 30) {
      return {
        block: true,
        reason: `⚠️ sleep ${sleepMatch[1]}s blocked — too long. Use subagent with async: true instead of blocking the session.`,
      };
    }

    const remoteCheck = checkRemoteExecBlock(cmdLower);
    if (remoteCheck) return remoteCheck;

    // Enforce git commit/push only via git-expert agent
    if (process.env.PI_AGENT_NAME !== "git-expert") {
      if (hasGitSub(command, "commit") || hasGitSub(command, "push")) {
        return {
          block: true,
          reason: "⛔ git commit/push blocked. Use git-expert agent for commit and push operations.",
        };
      }
    }

    // Enforce review loop — block commit unless review state is clean
    // Use resolveEffectiveCwd to detect the worktree from cd commands (e.g., cd .worktrees/issue-622 && git commit)
    if (process.env.PI_AGENT_NAME === "git-expert" && hasGitSub(command, "commit")) {
      const commitCwd = resolveEffectiveCwd(command, ctx.cwd);
      if (getSetting(ctx.cwd, "review_loop_enforcement") && !isReviewClean(commitCwd)) {
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
      entries = loadEnforcedEntries(ctx.cwd);
    } catch (e: any) {
      console.debug("[enforcement] loadEnforcedEntries failed:", e?.message?.slice(0, 100));
      return;
    }
    if (entries.length === 0) return;



    let matches = matchToolCall(entries, toolName, input);

    // For subagent results, extract actual bash commands from the subagent's
    // tool call messages (structured data only — no prose text fallback).
    if (toolName === "subagent") {
      const details = (event as any).details;
      const results = Array.isArray(details?.results) ? details.results : [];
      if (!Array.isArray(details?.results) && details?.results) {
        console.debug(`[enforcement] subagent details.results is ${typeof details.results} (expected array), skipping bash extraction`);
      }
      const nonBlockEntries = entries.filter(e => e.action !== "block");
      const seen = new Set<string>();
      const bashCommands: string[] = [];
      for (const r of results) {
        const msgs = Array.isArray(r?.messages) ? r.messages : [];
        for (const msg of msgs) {
          if (msg?.role !== "assistant") continue;
          const parts = Array.isArray(msg?.content) ? msg.content : [];
          for (const part of parts) {
            if (part?.type !== "toolCall") continue;
            // Check both field naming conventions (name/arguments and toolName/args)
            const partToolName = part?.name || part?.toolName;
            const partToolArgs = part?.arguments || part?.args;
            if (partToolName === "bash" && partToolArgs?.command) {
              bashCommands.push(partToolArgs.command);
            }
            // Also check non-bash tool calls against tool_name/file_modified triggers
            if (partToolName && partToolName !== "bash") {
              const toolMatches = matchToolCall(
                nonBlockEntries,
                partToolName,
                partToolArgs || {},
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
    // Uses effectiveCwd so each worktree gets its own pi-config-review-state.json.
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
  // When a test command exits successfully, marks tests_passed=true in pi-config-review-state.json.
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
