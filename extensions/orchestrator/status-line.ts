/**
 * Git status line, container indicator, desktop notifications, git poller.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getCurrentBranch, runGit } from "./git-helpers.js";

export function registerStatusLine(
  pi: ExtensionAPI,
  IN_CONTAINER: boolean,
  terminalNotify: (title: string, body: string) => void,
): void {
  // ── Git branch status line ─────────────────────────────────────────────

  const updateBranch = (_event: any, ctx: any) => {
    try {
      const b = getCurrentBranch(ctx.cwd);
      if (!b) return;

      const status = runGit(["status", "--porcelain"], ctx.cwd);
      let modified = 0,
        added = 0,
        deleted = 0,
        untracked = 0;
      if (status.code === 0 && status.stdout) {
        for (const line of status.stdout.split("\n")) {
          if (!line.trim()) continue;
          const xy = line.slice(0, 2);
          if (xy.includes("?")) untracked++;
          else if (xy.includes("D")) deleted++;
          else if (xy.includes("A")) added++;
          else if (xy.includes("M") || xy.includes("R") || xy.includes("C"))
            modified++;
        }
      }

      const changes: string[] = [];
      if (modified > 0) changes.push(ctx.ui.theme.fg("warning", `~${modified}`));
      if (added > 0) changes.push(ctx.ui.theme.fg("success", `+${added}`));
      if (deleted > 0) changes.push(ctx.ui.theme.fg("error", `-${deleted}`));
      if (untracked > 0) changes.push(ctx.ui.theme.fg("dim", `?${untracked}`));
      const icon =
        changes.length > 0
          ? ctx.ui.theme.fg("error", " ")
          : ctx.ui.theme.fg("success", " ");
      ctx.ui.setStatus(
        "git",
        changes.length > 0 ? `${icon} ${changes.join(" ")}` : icon,
      );
    } catch {}
  };
  pi.on("session_start", updateBranch);
  pi.on("agent_end", updateBranch);
  pi.on("turn_end", updateBranch);
  pi.on("tool_result", updateBranch);
  pi.on("tool_execution_end", updateBranch);

  // Poll git status every 5s for updates during long-running operations
  let gitPollCtx: any = null;
  pi.on("session_start", (_event, ctx) => {
    gitPollCtx = ctx;
  });
  const gitPoller = setInterval(() => {
    if (gitPollCtx) updateBranch(null, gitPollCtx);
  }, 5000);
  if (gitPoller.unref) gitPoller.unref();
  pi.on("session_shutdown", () => {
    clearInterval(gitPoller);
  });

  // ── Container indicator in status line ─────────────────────────────────

  if (IN_CONTAINER) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.setStatus("container", "󰡨 ");
    });
  }

  // ── Desktop notifications — notify when user attention is needed ─────

  let agentEnded = false;

  pi.on("agent_end", async () => {
    agentEnded = true;
    terminalNotify("pi", "Task completed");
  });

  pi.on("turn_end", async () => {
    if (agentEnded) {
      agentEnded = false;
      return; // agent_end already sent notification
    }
    terminalNotify("pi", "Waiting for input");
  });
}
