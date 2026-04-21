/**
 * Git status line, container indicator, desktop notifications, git poller.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getCurrentBranch, runGit } from "./git-helpers.js";
import { ICON_SEP, ICON_CONTAINER, ICON_GIT_CLEAN, ICON_GIT_DIRTY } from "./icons.js";

export function registerStatusLine(
  pi: ExtensionAPI,
  IN_CONTAINER: boolean,
  terminalNotify: (title: string, body: string) => void,
): void {
  // ── Combined status line builder ───────────────────────────────────────

  let lastStatusText = "";
  const buildStatus = (ctx: any, gitPart: string) => {
    const parts: string[] = [];

    if (IN_CONTAINER) parts.push(ICON_CONTAINER);
    parts.push(gitPart);

    const text = parts.join(ctx.ui.theme.fg("dim", ICON_SEP));
    if (text === lastStatusText) return; // Skip redundant re-renders
    lastStatusText = text;
    ctx.ui.setStatus("combined", text);
    // Clear individual statuses to avoid duplicates
    ctx.ui.setStatus("container", undefined);
    ctx.ui.setStatus("git", undefined);
  };

  // ── Git branch status line ─────────────────────────────────────────────

  let lastCtx: any = null;

  const updateBranch = (_event: any, ctx: any) => {
    lastCtx = ctx;
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
      if (modified > 0)
        changes.push(ctx.ui.theme.fg("warning", `~${modified}`));
      if (added > 0) changes.push(ctx.ui.theme.fg("success", `+${added}`));
      if (deleted > 0) changes.push(ctx.ui.theme.fg("error", `-${deleted}`));
      if (untracked > 0) changes.push(ctx.ui.theme.fg("dim", `?${untracked}`));
      const icon =
        changes.length > 0
          ? ctx.ui.theme.fg("error", ICON_GIT_DIRTY)
          : ctx.ui.theme.fg("success", ICON_GIT_CLEAN);
      const gitPart =
        changes.length > 0 ? `${icon} ${changes.join(" ")}` : icon;

      buildStatus(ctx, gitPart);
    } catch {}
  };

  pi.on("session_start", updateBranch);
  pi.on("agent_end", updateBranch);
  pi.on("turn_end", updateBranch);
  pi.on("tool_result", updateBranch);
  pi.on("tool_execution_end", updateBranch);

  // Poll git status every 5s for updates during long-running operations
  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
  });
  const gitPoller = setInterval(() => {
    if (lastCtx) updateBranch(null, lastCtx);
  }, 5000);
  if (gitPoller.unref) gitPoller.unref();
  pi.on("session_shutdown", () => {
    clearInterval(gitPoller);
  });

  // ── Desktop notifications — notify when user attention is needed ─────

  pi.on("agent_end", async () => {
    terminalNotify("pi", "Task completed");
  });

}
