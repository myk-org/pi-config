/**
 * Git status line, container indicator, desktop notifications, git poller.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hyperlink } from "@earendil-works/pi-tui";
import {
  getCurrentBranch,
  getOpenPr,
  refreshOpenPr,
  runGit,
} from "./git-helpers.js";
import { ICON_SEP, ICON_CONTAINER, ICON_GIT_CLEAN, ICON_GIT_DIRTY } from "./icons.js";
import { clockHHMM } from "./utils.js";

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
    ctx.ui.setStatus("4-git", text);
    // Clear legacy status keys to avoid duplicates
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
      let gitPart =
        changes.length > 0 ? `${icon} ${changes.join(" ")}` : icon;

      // Sync cache only — never block the status path on `gh`.
      const pr = getOpenPr(ctx.cwd, b);
      if (pr) {
        const prLabel = ctx.ui.theme.fg(
          "accent",
          hyperlink(`#${pr.number}`, pr.url),
        );
        gitPart = `${gitPart} ${prLabel}`;
      }

      buildStatus(ctx, gitPart);

      // Per-key coalesce lives in refreshOpenPr — no global pending gate.
      const refreshKey = `${ctx.cwd || ""}:${b}`;
      const shownKey = pr ? `${pr.number}\0${pr.url}` : "";
      void refreshOpenPr(ctx.cwd, b).then((fresh) => {
        if (!lastCtx) return;
        const curB = getCurrentBranch(lastCtx.cwd);
        if (!curB || `${lastCtx.cwd || ""}:${curB}` !== refreshKey) return;
        const freshKey = fresh ? `${fresh.number}\0${fresh.url}` : "";
        if (freshKey === shownKey) return;
        try {
          updateBranch(null, lastCtx);
        } catch (e: any) {
          console.debug(
            "[status-line] open-PR refresh update failed:",
            e?.message || e,
          );
        }
      });
    } catch (e: any) { console.debug("[status-line] git status update failed:", e?.message || e); }
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
    if (!lastCtx) return;
    try {
      lastCtx.ui.theme; // probe for stale ctx
      updateBranch(null, lastCtx);
    } catch (e: any) {
      console.debug("[status-line] git poller error, pausing until next session_start:", e?.message || e);
      lastCtx = null;
    }
  }, 5000);
  if (gitPoller.unref) gitPoller.unref();

  // ── Last-activity timestamp ────────────────────────────────────────────

  let lastActivityTime: Date | null = null;



  const ago = (since: Date): string => {
    const diffMs = Date.now() - since.getTime();
    if (diffMs < 0) return "now";
    const mins = Math.floor(diffMs / 60_000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  };

  const updateTimestamp = (ctx: any) => {
    if (!lastActivityTime) return;
    const text = ctx.ui.theme.fg("dim", `⏱ ${clockHHMM(lastActivityTime)} (${ago(lastActivityTime)})`);
    ctx.ui.setStatus("0-time", text);
  };

  const touchActivity = (_event: any, ctx: any) => {
    lastActivityTime = new Date();
    updateTimestamp(ctx);
  };

  pi.on("session_start", touchActivity);
  pi.on("turn_end", touchActivity);
  pi.on("agent_end", touchActivity);
  pi.on("tool_execution_end", touchActivity);

  const timePoller = setInterval(() => {
    if (!lastCtx || !lastActivityTime) return;
    try {
      lastCtx.ui.theme; // probe for stale ctx
      updateTimestamp(lastCtx);
    } catch (e: any) {
      console.debug("[status-line] time poller error, pausing until next session_start:", e?.message || e);
      lastCtx = null;
    }
  }, 30_000);
  if (timePoller.unref) timePoller.unref();

  pi.on("session_shutdown", (_event) => {
    clearInterval(gitPoller);
    clearInterval(timePoller);
  });

  // ── Desktop notifications — notify when pi is truly idle ─────────────

  pi.on("agent_settled", async () => {
    terminalNotify("pi", "Task completed");
  });

}
