/**
 * Diffity auto-start — launches diffity diff viewer.
 * Shows a status line link so the user can check code changes in real-time.
 * Works both in container and native — requires diffity to be installed.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ICON_DIFF } from "./icons.js";

const DIFFITY_START_PORT = 8090;
const DIFFITY_MAX_PORT = 8190;
const DIFFITY_PORT_TIMEOUT_MS = 5000;
const PORT_CHECK_TIMEOUT_MS = 1000;
const DIFFITY_READY_TIMEOUT_MS = 3000;
const DIFFITY_READY_POLL_MS = 100;
const SOCKET_CONNECT_TIMEOUT_MS = 1000;
const KILL_SETTLE_MS = 500;

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const timeout = setTimeout(() => { server.close(); resolve(false); }, PORT_CHECK_TIMEOUT_MS);
    server.once("error", () => { clearTimeout(timeout); resolve(false); });
    server.once("listening", () => {
      clearTimeout(timeout);
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(): Promise<number | null> {
  const start = Date.now();
  let port = DIFFITY_START_PORT;
  while (port <= DIFFITY_MAX_PORT && Date.now() - start < DIFFITY_PORT_TIMEOUT_MS) {
    if (await isPortAvailable(port)) return port;
    port++;
  }
  return null;
}

function waitForPort(port: number, timeoutMs: number = DIFFITY_READY_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };
    const start = Date.now();
    const check = () => {
      if (resolved) return;
      const socket = new net.Socket();
      socket.setTimeout(SOCKET_CONNECT_TIMEOUT_MS);
      socket.once("connect", () => {
        socket.destroy();
        done(true);
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - start >= timeoutMs) {
          done(false);
        } else {
          setTimeout(check, DIFFITY_READY_POLL_MS);
        }
      });
      socket.once("timeout", () => {
        socket.destroy();
        if (Date.now() - start >= timeoutMs) {
          done(false);
        } else {
          setTimeout(check, DIFFITY_READY_POLL_MS);
        }
      });
      socket.connect(port, "127.0.0.1");
    };
    check();
  });
}

function hasDiffity(): boolean {
  try {
    execFileSync("which", ["diffity"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function killProcess(proc: ChildProcess): void {
  try { proc.kill("SIGTERM"); } catch {}
}

// Linux-only: uses /proc to resolve process working directories
function killExistingDiffity(cwd: string): void {
  try {
    const resolvedCwd = execFileSync("readlink", ["-f", cwd], { encoding: "utf-8" }).trim();
    const result = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf-8" });
    for (const line of result.split("\n")) {
      if (!/\bdiffity\s+.*--port\b/.test(line)) continue;
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

export function registerDiffity(pi: ExtensionAPI): void {
  if (!hasDiffity()) return;

  let diffityProc: ChildProcess | null = null;
  let starting = false;

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (diffityProc || starting) return; // Already running or starting
    starting = true;

    try {
      killExistingDiffity(ctx.cwd);
      // Brief delay to let killed processes release their ports
      await new Promise((r) => setTimeout(r, KILL_SETTLE_MS));

      const port = await findAvailablePort();
      if (!port) return;

      diffityProc = spawn("diffity", [
        "--dark",
        "--no-open",
        "--quiet",
        "--port", String(port),
      ], {
        cwd: ctx.cwd,
        stdio: "ignore",
      });

      // Wait for diffity to be ready before showing the URL
      const isUp = await waitForPort(port);
      if (!isUp) {
        killProcess(diffityProc);
        diffityProc = null;
        return;
      }

      // Show link in status line
      const statusText = ctx.ui.theme.fg("accent", `${ICON_DIFF} http://localhost:${port}?theme=dark`);
      ctx.ui.setStatus("diffity", statusText);
    } catch {
      if (diffityProc) {
        killProcess(diffityProc);
      }
      diffityProc = null;
    } finally {
      starting = false;
    }
  });

  pi.on("session_shutdown", () => {
    starting = false;
    if (diffityProc) {
      killProcess(diffityProc);
      diffityProc = null;
    }
  });
}
