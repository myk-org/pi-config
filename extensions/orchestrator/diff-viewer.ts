/**
 * Difit auto-start — launches difit diff viewer.
 *
 * Works both in container and native — requires difit to be installed.
 * See: https://github.com/yoshiko-pg/difit
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const KILL_SETTLE_MS = 500;
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

function killProcess(proc: ChildProcess): void {
  try { proc.kill("SIGTERM"); } catch {}
}

// Linux-only: uses /proc to resolve process working directories
function killExistingDifit(cwd: string): void {
  try {
    const resolvedCwd = execFileSync("readlink", ["-f", cwd], { encoding: "utf-8" }).trim();
    const result = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf-8" });
    for (const line of result.split("\n")) {
      if (!/\bdifit\b/.test(line) || !/--keep-alive/.test(line)) continue;
      const match = line.trim().match(/^(\d+)/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      if (pid === process.pid) continue;
      try {
        const cwdLink = execFileSync("readlink", ["-f", `/proc/${pid}/cwd`], { encoding: "utf-8" }).trim();
        if (cwdLink === resolvedCwd) {
          process.kill(pid, "SIGTERM");
        }
      } catch {}
    }
  } catch {}
}

export function registerDifit(pi: ExtensionAPI): void {
  if (!hasDifit()) return;

  let difitProc: ChildProcess | null = null;
  let starting = false;

  pi.on("session_start", async (_event, ctx) => {
    if (difitProc || starting) return;
    if (!isGitRepo(ctx.cwd)) return;

    starting = true;

    try {
      killExistingDifit(ctx.cwd);
      await new Promise((r) => setTimeout(r, KILL_SETTLE_MS));

      const proc = spawn("difit", [
        "--no-open",
        "--keep-alive",
        "--host", "127.0.0.1",
      ], {
        cwd: ctx.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Capture port from difit stdout
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
        killProcess(proc);
        difitProc = null;
        return;
      }

      // Stop reading stdout/stderr — let difit run detached
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      proc.unref();

      difitProc = proc;

      const statusText = ctx.ui.theme.fg("accent", `${ICON_DIFF} http://localhost:${port}`);
      ctx.ui.setStatus("diff-viewer", statusText);
      pi.events?.emit("diff-viewer:port", port);
    } catch {
      if (difitProc) {
        killProcess(difitProc);
      }
      difitProc = null;
    } finally {
      starting = false;
    }
  });

  pi.on("session_shutdown", () => {
    starting = false;
    if (difitProc) {
      killProcess(difitProc);
      difitProc = null;
    }
  });
}
