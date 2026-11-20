/**
 * Git status line, container indicator, desktop notifications, git poller.
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hyperlink } from "@earendil-works/pi-tui";
import {
  getOpenPr,
  scheduleOpenPrStatusRefresh,
} from "./git-helpers.js";
import { ICON_SEP, ICON_CONTAINER, ICON_GIT_CLEAN, ICON_GIT_DIRTY } from "./icons.js";
import { setSlot } from "./status-bar.js";
import { clockHHMM } from "./utils.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("status-line");

export interface StatusLineDeps {
  runGitAsync?: (args: string[], cwd?: string) => Promise<{ stdout: string; code: number }>;
  debounceMs?: number;
}

export function registerStatusLine(
  pi: ExtensionAPI,
  IN_CONTAINER: boolean,
  terminalNotify: (title: string, body: string) => void,
  deps?: StatusLineDeps,
): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  const debounceMs = deps?.debounceMs ?? 350;
  const execGitAsync = deps?.runGitAsync ?? ((args: string[], cwd?: string) =>
    new Promise<{ stdout: string; code: number }>((resolve) => {
      execFile(
        "git",
        ["--no-optional-locks", ...args],
        {
          cwd,
          timeout: 5000,
          encoding: "utf-8",
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GCM_INTERACTIVE: "Never",
          },
        },
        (err, stdout) => {
          const out = (typeof stdout === "string" ? stdout : "").trimEnd();
          if (err) {
            const exitCode = typeof (err as any).code === "number" ? (err as any).code : 1;
            resolve({ stdout: out, code: exitCode });
          } else {
            resolve({ stdout: out, code: 0 });
          }
        },
      );
    }));

  const githubRepoCache = new Map<string, boolean>();
  const getBranchAsync = async (cwd?: string): Promise<string | null> => {
    const r = await execGitAsync(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    if (r.code === 0 && r.stdout && r.stdout !== "HEAD") return r.stdout;
    const s = await execGitAsync(["symbolic-ref", "HEAD"], cwd);
    if (s.code === 0 && s.stdout.startsWith("refs/heads/"))
      return s.stdout.slice("refs/heads/".length);
    return null;
  };
  const isGithubRepoAsync = async (cwd?: string): Promise<boolean> => {
    const key = cwd || "";
    const cached = githubRepoCache.get(key);
    if (cached !== undefined) return cached;
    const r = await execGitAsync(["remote", "get-url", "origin"], cwd);
    const result = r.code === 0 && r.stdout.toLowerCase().includes("github.com");
    githubRepoCache.set(key, result);
    return result;
  };
  // ── Combined status line builder ───────────────────────────────────────

  let lastStatusText = "";
  const buildStatus = (ctx: any, gitPart: string) => {
    const parts: string[] = [];

    if (IN_CONTAINER) parts.push(ICON_CONTAINER);
    parts.push(gitPart);

    const text = parts.join(ctx.ui.theme.fg("dim", ICON_SEP));
    if (text === lastStatusText) return; // Skip redundant re-renders
    lastStatusText = text;
    setSlot("git", text, ctx);
    // Clear legacy status keys to avoid duplicates
    ctx.ui.setStatus("container", undefined);
    ctx.ui.setStatus("git", undefined);
  };

  // ── Git branch status line ─────────────────────────────────────────────

  let lastCtx: any = null;
  let lastBranch: string | null = null;
  let shutDown = false;
  let branchUpdateSeq = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const clearDebounce = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const updateBranch = async (_event: any, ctx: any): Promise<void> => {
    if (shutDown || !ctx?.hasUI) return;
    lastCtx = ctx;
    const seq = ++branchUpdateSeq;
    try {
      const [b, status, isGh] = await Promise.all([
        getBranchAsync(ctx.cwd),
        execGitAsync(["status", "--porcelain"], ctx.cwd),
        isGithubRepoAsync(ctx.cwd),
      ]);
      if (shutDown || seq !== branchUpdateSeq) return;
      if (!b) {
        lastBranch = null;
        return;
      }
      lastBranch = b;

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
      const pr = isGh ? getOpenPr(ctx.cwd, b, { assumeGithub: true }) : null;
      if (pr) {
        const prLabel = ctx.ui.theme.fg(
          "accent",
          hyperlink(`#${pr.number}`, pr.url),
        );
        gitPart = `${gitPart} ${prLabel}`;
      }

      buildStatus(ctx, gitPart);

      // Per-key coalesce lives in refreshOpenPr — no global pending gate.
      if (isGh) {
        scheduleOpenPrStatusRefresh({
          cwd: ctx.cwd,
          branch: b,
          shownPr: pr,
          getState: () => ({ lastCtx, lastBranch }),
          onRerender: (c) => void updateBranch(null, c),
          assumeGithub: true,
        });
      }
    } catch (e: any) {
      log.debug("git status update failed", { error: e?.message || String(e) });
    }
  };

  pi.on("session_start", (event, ctx) => {
    clearDebounce();
    void updateBranch(event, ctx);
  });
  pi.on("agent_end", (event, ctx) => {
    clearDebounce();
    void updateBranch(event, ctx);
  });
  pi.on("tool_execution_end", (_event, ctx) => {
    if (shutDown || !ctx?.hasUI) return;
    lastCtx = ctx;
    clearDebounce();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!shutDown) void updateBranch(null, ctx);
    }, debounceMs);
    if (debounceTimer.unref) debounceTimer.unref();
  });

  // Poll git status every 5s for updates during long-running operations
  const gitPoller = setInterval(() => {
    if (!lastCtx) return;
    try {
      lastCtx.ui.theme; // probe for stale ctx
      void updateBranch(null, lastCtx);
    } catch (e: any) {
      log.debug("git poller error, pausing until next session_start", { error: e?.message || String(e) });
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
    setSlot("time", text, ctx);
  };

  const touchActivity = (_event: any, ctx: any) => {
    if (shutDown || !ctx?.hasUI) return;
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
      log.debug("time poller error, pausing until next session_start", { error: e?.message || String(e) });
      lastCtx = null;
    }
  }, 30_000);
  if (timePoller.unref) timePoller.unref();

  pi.on("session_shutdown", (_event) => {
    shutDown = true;
    branchUpdateSeq++;
    lastCtx = null;
    clearDebounce();
    clearInterval(gitPoller);
    clearInterval(timePoller);
  });

  // ── Desktop notifications — notify when pi is truly idle ─────────────

  pi.on("agent_settled", async () => {
    terminalNotify("pi", "Task completed");
  });

}
