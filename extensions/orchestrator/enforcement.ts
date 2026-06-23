/**
 * Enforcement handler — blocks forbidden commands (python/pip, git protection,
 * remote script execution, memory writes, dangerous).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { join } from "node:path";
import { getSetting } from "./project-settings.js";
import { getProjectTmpDir } from "./utils.js";
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

/** Normalize command for repeat detection: strip cd prefixes, trim whitespace */
function normalizeForRepeatCheck(command: string): string {
  return command
    .replace(/^\s*cd\s+\S+\s*&&\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Repeat detection via temp file — immune to module reload / closure issues
// Repeat detection file — set to project dir on first use
let REPEAT_FILE = "";

/** Cached trailer selection for comma-separated commit_trailer values (reset on session_start) */
let cachedTrailerSelection: string | null = null;

/** Escape a string for safe inclusion in double-quoted shell strings */
function escapeForDoubleQuote(s: string): string {
  return s.replace(/[\\"`$!]/g, "\\$&");
}

/** Escape a string for safe inclusion in single-quoted shell strings */
function escapeForSingleQuote(s: string): string {
  return s.replace(/'/g, "'\\''");
}

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

/** Parse bash command for cd target to resolve the effective working directory (worktree support) */
function resolveEffectiveCwd(command: string, sessionCwd: string): string {
  // Match: cd /path/to/dir && ..., cd /path/to/dir; ...
  const cdMatch = command.match(/^\s*cd\s+([^\s;&|]+)/);
  if (cdMatch) {
    const target = cdMatch[1].replace(/['"]/g, "");
    if (target.startsWith("/")) return target;
    return join(sessionCwd, target);
  }
  // Match: git -C /path/to/dir ...
  const gitCMatch = command.match(/\bgit\s+-C\s+([^\s]+)/);
  if (gitCMatch) {
    const target = gitCMatch[1].replace(/['"]/g, "");
    if (target.startsWith("/")) return target;
    return join(sessionCwd, target);
  }
  return sessionCwd;
}

export function registerEnforcement(pi: ExtensionAPI, inContainer?: boolean): void {

  pi.on("session_start", () => {
    cachedTrailerSelection = null;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    const command = event.input.command;
    const cmdLower = command.trim().toLowerCase();

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

    // Block direct python/pip — check at start or after pipe/semicolon/&& operators
    if (!cmdLower.startsWith("uv ") && !cmdLower.startsWith("uvx ")) {
      if (/(?:^|[|;&]\s*)(?:python3?|pip3?)\b/.test(cmdLower)) {
        return {
          block: true,
          reason:
            "Direct python/pip forbidden. Use: uv run python3 / uv run script.py / uvx tool / uv add pkg",
        };
      }
    }

    // Block direct pre-commit
    if (cmdLower.startsWith("pre-commit "))
      return {
        block: true,
        reason: "Direct pre-commit forbidden. Use: prek run --all-files",
      };

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

    // Strip heredoc content before remote-exec checks — heredoc text
    // (e.g., `cat << 'EOF'\n...curl|bash in docs...\nEOF`) is not executable.
    const cmdForExecCheck = cmdLower.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*/m, "");

    // Block remote script execution — download first, audit, then run
    const remoteExecReason = "⛔ Remote script execution is forbidden. Download the script first, audit it with security-auditor, then run if safe.";
    // Pipe to shell or interpreter: curl ... | sh, curl ... | /bin/bash, curl ... | sudo python3
    if (/\b(curl|wget)\b.*\|(?!\|)\s*(?:sudo\s+(?:-\S+\s+)*|env\s+(?:-\S+\s+)*)*(?:\/\S+\/)*(ba|c|da|[akz]|fi|tc)?sh\b/.test(cmdForExecCheck) ||
        /\b(curl|wget)\b.*\|(?!\|)\s*(?:sudo\s+(?:-\S+\s+)*|env\s+(?:-\S+\s+)*)*(python[23]?|perl|ruby|node|deno|bun)\b/.test(cmdForExecCheck)) {
      return { block: true, reason: remoteExecReason };
    }
    // Process substitution: bash <(curl ...), source <(curl ...), . <(curl ...)
    if (/\b(ba|c|da|[akz]|fi|tc)?sh\b.*<\(\s*\b(curl|wget)\b/.test(cmdForExecCheck) ||
        /\bsource\s+<\(\s*\b(curl|wget)\b/.test(cmdForExecCheck) ||
        /(?:^|[\s;&|])\.\s+<\(\s*\b(curl|wget)\b/.test(cmdForExecCheck)) {
      return { block: true, reason: remoteExecReason };
    }
    // Command substitution / eval: sh -c "$(curl ...)", eval $(curl ...), `curl ...`
    if (/\$\(\s*\b(curl|wget)\b/.test(cmdForExecCheck) || /`\s*(curl|wget)\b/.test(cmdForExecCheck) ||
        /\beval\b.*\b(curl|wget)\b/.test(cmdForExecCheck)) {
      return { block: true, reason: remoteExecReason };
    }

    // Enforce git commit/push only via git-expert agent
    if (process.env.PI_AGENT_NAME !== "git-expert") {
      if (hasGitSub(command, "commit") || hasGitSub(command, "push")) {
        return {
          block: true,
          reason: "⛔ git commit/push blocked. Use git-expert agent for commit and push operations.",
        };
      }
    }

    // Git protection
    const gitCwd = resolveEffectiveCwd(command, ctx.cwd);
    if (isGitRepo(gitCwd)) {
      // Block branch creation AND switching when use_worktrees is enabled
      if (getSetting(ctx.cwd, "use_worktrees")) {
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
        /\bgit\b.*\badd\b\s+(\.|--all|-A)\b/.test(command)
      ) {
        return {
          block: true,
          reason:
            "⛔ 'git add .' / 'git add -A' forbidden. Stage specific files.",
        };
      }

      // Block staging gitignored files
      if (hasGitSub(command, "add") && !/\bgit\b.*\badd\b\s+(\.|--all|-A)\b/.test(command)) {
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

        // Commit trailer injection — setting value is the trailer name (e.g., "Assisted-by")
        const trailerSetting = getSetting(gitCwd, "commit_trailer");
        if (typeof trailerSetting === "string") {
          const modelId = (ctx as any).model?.id;
          if (modelId) {
            const piIdentity = `PI (${modelId}) <noreply@pi.dev>`;
            let trailerName: string;

            if (trailerSetting.includes(",")) {
              // Multiple trailer name options — ask user directly
              const options = trailerSetting.split(",").map(s => s.trim()).filter(Boolean);
              if (options.length === 0) return undefined;  // malformed setting, skip trailer
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
          }
        }

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
    }

    // Enforce temp files go to .pi/tmp/ — not bare /tmp/
    // Catches: mktemp /tmp/foo, > /tmp/foo, tee /tmp/foo, cat > /tmp/foo
    if (/(?:^|[;&|$( \t])mktemp\b/.test(command)) {
      const expectedTmpDir = path.join(ctx.cwd, ".pi", "tmp");
      const usesEnvVar = /\$\{?PROJECT_TMP_DIR\}?/.test(command);
      const usesExpectedPath = command.includes(expectedTmpDir);
      const usesRelativePath = /\.pi\/tmp(?:\/|[\s"']|$)/.test(command);
      if (!usesEnvVar && !usesExpectedPath && !usesRelativePath) {
        return {
          block: true,
          reason: `⛔ mktemp must use project temp dir. Use: mktemp \${PROJECT_TMP_DIR}/XXXXXX (resolves to ${expectedTmpDir}/)`,
        };
      }
    }

    // Dangerous command confirmation
    // Collapse bash line continuations (backslash-newline) before splitting
    const normalized = command.replace(/\\\r?\n/g, " ");
    // Split on statement separators to avoid matching across unrelated statements
    const statements = normalized.split(/\n|;|&&|\|\|/).map(s => s.trim()).filter(Boolean);
    if (statements.some((stmt) => DANGEROUS.some((p) => p.test(stmt)))) {
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
  });
}

// trigger re-scan
