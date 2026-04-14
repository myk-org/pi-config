/**
 * Enforcement handler — blocks forbidden commands (python/pip, git protection, dangerous).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import {
  DANGEROUS,
  getCurrentBranch,
  getMainBranch,
  getPrMergeStatus,
  hasGitSub,
  isBranchAhead,
  isBranchMerged,
  isGitRepo,
} from "./git-helpers.js";

export function registerEnforcement(pi: ExtensionAPI, inContainer?: boolean): void {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    const command = event.input.command;
    const cmdLower = command.trim().toLowerCase();

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

      // Block --no-verify
      if (hasGitSub(command, "commit") && command.includes("--no-verify")) {
        return {
          block: true,
          reason: "⛔ --no-verify forbidden. Pre-commit hooks must run.",
        };
      }

      const branch = getCurrentBranch(ctx.cwd);
      const mainBranch = getMainBranch(ctx.cwd);

      // Block commits to protected branches
      if (hasGitSub(command, "commit")) {
        if (!branch)
          return {
            block: true,
            reason:
              "⛔ Detached HEAD. Create a branch first: git checkout -b my-branch",
          };
        if (branch === "main" || branch === "master")
          return {
            block: true,
            reason: `⛔ Cannot commit to '${branch}'. Create a feature branch.`,
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
        // Block if currently on main/master
        if (branch === "main" || branch === "master")
          return {
            block: true,
            reason: `⛔ Cannot push to '${branch}'. Create a feature branch.`,
          };
        // Block explicit push to main/master (e.g., git push origin main)
        if (/\bgit\b.*\bpush\b.*\b(main|master)\b/.test(command))
          return {
            block: true,
            reason: "⛔ Cannot push to main/master. Create a feature branch.",
          };
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
