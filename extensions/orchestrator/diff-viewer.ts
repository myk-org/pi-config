/**
 * Difit auto-start — launches difit diff viewer.
 *
 * - On session start: reuse existing difit for this cwd, or start a new one.
 * - On session shutdown: only kill difit if this is the last pi session for this cwd.
 *
 * Works both in container and native — requires difit to be installed.
 * See: https://github.com/yoshiko-pg/difit
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const STARTUP_TIMEOUT_MS = 15000;

const ICON_DIFF = "";

function hasDifit(): boolean {
  try {
    execFileSync("which", ["difit"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isGitRepo(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function resolvePath(p: string): string {
  return execFileSync("readlink", ["-f", p], { encoding: "utf-8" }).trim();
}

/** Find an existing difit --keep-alive process for this cwd and return its PID, or null. */
function findExistingDifitPid(cwd: string): number | null {
  try {
    const resolvedCwd = resolvePath(cwd);
    const result = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf-8" });
    for (const line of result.split("\n")) {
      if (!/\bdifit\b/.test(line) || !/--keep-alive/.test(line)) continue;
      const match = line.trim().match(/^(\d+)/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      try {
        const pidCwd = resolvePath(`/proc/${pid}/cwd`);
        if (pidCwd === resolvedCwd) return pid;
      } catch {}
    }
  } catch {}
  return null;
}

/** Get the listening port of a process via ss. */
function getListeningPort(pid: number): number | null {
  try {
    const result = execFileSync("ss", ["-tlnp"], { encoding: "utf-8" });
    for (const line of result.split("\n")) {
      if (!line.includes(`pid=${pid}`)) continue;
      const m = line.match(/127\.0\.0\.1:(\d+)/);
      if (m) return parseInt(m[1], 10);
    }
  } catch {}
  return null;
}

/** Count active pi (node) sessions whose cwd matches. Excludes current process. */
function countOtherPiSessions(cwd: string): number {
  try {
    const resolvedCwd = resolvePath(cwd);
    const result = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf-8" });
    let count = 0;
    for (const line of result.split("\n")) {
      if (!/\bpi-coding-agent\b/.test(line) && !/\bpi\b.*\bnode\b/.test(line) && !/\bnode\b.*\bpi\b/.test(line)) continue;
      const match = line.trim().match(/^(\d+)/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      if (pid === process.pid) continue;
      try {
        const pidCwd = resolvePath(`/proc/${pid}/cwd`);
        if (pidCwd === resolvedCwd) count++;
      } catch {}
    }
    return count;
  } catch {}
  return 0;
}

export function registerDifit(pi: ExtensionAPI): void {
  if (!hasDifit()) return;

  let trackedPid: number | null = null;
  let difitPort: number | null = null;
  let weStartedIt = false;

  function setDifitStatus(ctx: any, port: number): void {
    const statusText = ctx.ui.theme.fg("accent", `${ICON_DIFF} http://localhost:${port}`);
    ctx.ui.setStatus("diff-viewer", statusText);
    pi.events?.emit("diff-viewer:port", port);
  }

  function clearDifitStatus(ctx: any): void {
    ctx.ui.setStatus("diff-viewer", undefined);
  }

  /** Start a new difit process. Returns port on success, null on failure. */
  async function startNewDifit(ctx: any): Promise<number | null> {
    const proc = spawn("difit", [
      "--no-open",
      "--keep-alive",
      "--host", "127.0.0.1",
    ], {
      cwd: ctx.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const port = await new Promise<number | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), STARTUP_TIMEOUT_MS);
      let output = "";
      proc.stdout?.on("data", (data: Buffer) => {
        output += data.toString();
        const m = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (m) {
          clearTimeout(timeout);
          resolve(parseInt(m[1], 10));
        }
      });
      proc.on("error", () => { clearTimeout(timeout); resolve(null); });
      proc.on("exit", () => { clearTimeout(timeout); resolve(null); });
    });

    if (!port) {
      try { proc.kill("SIGTERM"); } catch {}
      return null;
    }

    // Detach — let difit survive beyond this session if others need it
    proc.stdout?.destroy();
    proc.stderr?.destroy();
    proc.unref();

    trackedPid = proc.pid ?? null;
    difitPort = port;
    weStartedIt = true;

    // Monitor for unexpected exit
    proc.on("exit", () => {
      trackedPid = null;
      difitPort = null;
      clearDifitStatus(ctx);
    });

    return port;
  }

  pi.on("session_start", async (_event, ctx) => {
    if (difitPort) return; // Already set up
    if (!isGitRepo(ctx.cwd)) return;

    // Try to reuse an existing difit for this cwd
    const existingPid = findExistingDifitPid(ctx.cwd);
    if (existingPid) {
      const port = getListeningPort(existingPid);
      if (port) {
        trackedPid = existingPid;
        difitPort = port;
        weStartedIt = false;
        setDifitStatus(ctx, port);
        return;
      }
    }

    // No existing difit — start a new one
    const port = await startNewDifit(ctx);
    if (port) {
      setDifitStatus(ctx, port);
    }
  });

  // Re-set status on agent_end to ensure it survives TUI re-renders
  pi.on("agent_end", (_event, ctx) => {
    if (difitPort) {
      setDifitStatus(ctx, difitPort);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    // Only kill difit if no other pi sessions share this cwd
    if (trackedPid && countOtherPiSessions(ctx.cwd) === 0) {
      try { process.kill(trackedPid, "SIGTERM"); } catch {}
    }
    trackedPid = null;
    difitPort = null;
  });
}
