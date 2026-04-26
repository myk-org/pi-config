/**
 * Enforcement handler — blocks forbidden commands (python/pip, git protection,
 * remote script execution, memory writes, dangerous).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
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

export function registerEnforcement(pi: ExtensionAPI, inContainer?: boolean): void {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    const command = event.input.command;
    const cmdLower = command.trim().toLowerCase();

    // Block timeout on long-running poll commands — these can take 30+ minutes
    // (rate limit waits). The LLM keeps setting timeouts despite prompt instructions.
    if (/\bmyk-pi-tools\b.*\breviews\s+poll\b/.test(command) && event.input.timeout) {
      return {
        block: true,
        reason: `⛔ reviews poll must not have a timeout (it can take 30+ min for rate limit waits). Retry without the timeout parameter.`,
      };
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

    // Git protection
    if (isGitRepo(ctx.cwd)) {
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
            const checkIgnored = runGit(["check-ignore", "-q", file], ctx.cwd);
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

      const branch = getCurrentBranch(ctx.cwd);
      const mainBranch = getMainBranch(ctx.cwd);
      const protectedBranches = getProtectedBranches(ctx.cwd);

      // Block commits to protected branches
      if (hasGitSub(command, "commit")) {
        if (!branch)
          return {
            block: true,
            reason:
              "⛔ Detached HEAD. Create a branch first: git checkout -b my-branch",
          };
        if (protectedBranches.has(branch))
          return {
            block: true,
            reason: `⛔ Cannot commit to '${branch}' (protected). Create a feature branch.\nHint: If you're combining git checkout + git commit in one bash call, split them into SEPARATE bash calls. Branch is checked before execution.`,
          };

        const pr = getPrMergeStatus(branch, ctx.cwd);
        if (pr.merged)
          return {
            block: true,
            reason: `⛔ PR #${pr.info} for '${branch}' already merged. Create a new branch from ${mainBranch || "main"}.`,
          };

        if (command.includes("--amend") && isBranchAhead(ctx.cwd))
          return undefined;

        if (mainBranch && isBranchMerged(branch, mainBranch, ctx.cwd))
          return {
            block: true,
            reason: `⛔ Branch '${branch}' already merged into '${mainBranch}'. Create a new branch.`,
          };
      }

      // Block pushes to protected branches
      if (hasGitSub(command, "push")) {
        // Block if currently on a protected branch
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
        if (branch) {
          const pr = getPrMergeStatus(branch, ctx.cwd);
          if (pr.merged)
            return {
              block: true,
              reason: `⛔ PR #${pr.info} for '${branch}' already merged. Create a new branch.`,
            };
          if (mainBranch && isBranchMerged(branch, mainBranch, ctx.cwd))
            return {
              block: true,
              reason: `⛔ Branch '${branch}' already merged into '${mainBranch}'. Create a new branch.`,
            };
        }
      }
    }

    // Dangerous command confirmation
    if (DANGEROUS.some((p) => p.test(command))) {
      if (!ctx.hasUI)
        return {
          block: true,
          reason: "Dangerous command blocked (no UI for confirmation)",
        };

      const ok = await ctx.ui.select(
        `⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`,
        ["Yes", "No"],
      );
      if (ok !== "Yes") return { block: true, reason: "Blocked by user" };
    }

    return undefined;
  });
}
