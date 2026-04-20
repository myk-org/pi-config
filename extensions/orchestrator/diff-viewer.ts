/**
 * Difit auto-start — launches difit diff viewer.
 *
 * Works both in container and native — requires difit to be installed.
 * See: https://github.com/yoshiko-pg/difit
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as http from "node:http";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DIFIT_START_PORT = 4966;
const DIFIT_MAX_PORT = 5066;
const DIFIT_PORT_TIMEOUT_MS = 5000;
const KILL_SETTLE_MS = 500;
const DIFIT_READY_TIMEOUT_MS = 5000;
const DIFIT_READY_POLL_MS = 200;

const ICON_DIFF = "";

function findAvailablePort(): Promise<number | null> {
  const start = Date.now();
  return new Promise((resolve) => {
    let port = DIFIT_START_PORT;
    function tryNext() {
      if (port > DIFIT_MAX_PORT || Date.now() - start > DIFIT_PORT_TIMEOUT_MS) {
        resolve(null);
        return;
      }
      const srv = net.createServer();
      srv.once("error", () => { port++; tryNext(); });
      srv.listen(port, "127.0.0.1", () => {
        srv.close(() => resolve(port));
      });
    }
    tryNext();
  });
}

function waitForPort(port: number, timeoutMs: number = DIFIT_READY_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    function check() {
      if (Date.now() > deadline) { resolve(false); return; }
      const req = http.request(
        { hostname: "127.0.0.1", port, path: "/", timeout: 500 },
        (res) => {
          res.resume();
          resolve(true);
        },
      );
      req.on("error", () => {
        setTimeout(check, DIFIT_READY_POLL_MS);
      });
      req.on("timeout", () => {
        req.destroy();
        setTimeout(check, DIFIT_READY_POLL_MS);
      });
      req.end();
    }
    check();
  });
}

function hasDifit(): boolean {
  try {
    execFileSync("which", ["difit"], { stdio: "ignore" });
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
      if (!/\bdifit\s+.*--port\b/.test(line)) continue;
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
    if (difitProc || starting) return; // Already running or starting

    // Skip if not in a git repo
    try {
      execFileSync("git", ["rev-parse", "--git-dir"], { cwd: ctx.cwd, stdio: "ignore" });
    } catch {
      return;
    }

    starting = true;

    try {
      killExistingDifit(ctx.cwd);
      // Brief delay to let killed processes release their ports
      await new Promise((r) => setTimeout(r, KILL_SETTLE_MS));

      const port = await findAvailablePort();
      if (!port) return;

      difitProc = spawn("difit", [
        "--no-open",
        "--keep-alive",
        "--host", "127.0.0.1",
        "--port", String(port),
      ], {
        cwd: ctx.cwd,
        stdio: "ignore",
      });

      // Wait for difit to be ready before showing the URL
      const isUp = await waitForPort(port);
      if (!isUp) {
        killProcess(difitProc);
        difitProc = null;
        return;
      }

      // Show link in status line
      const statusText = ctx.ui.theme.fg("accent", `${ICON_DIFF} http://localhost:${port}`);
      ctx.ui.setStatus("diff-viewer", statusText);
      // Notify pidash of the diff viewer port
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
