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

function killProcessTree(proc: ChildProcess): void {
  try {
    // Kill the process group (negative PID kills the group)
    if (proc.pid) process.kill(-proc.pid, "SIGTERM");
  } catch {
    try { proc.kill("SIGTERM"); } catch {}
  }
}

export function registerDiffity(pi: ExtensionAPI, setDiffityStatus?: (text: string) => void): void {
  if (!hasDiffity()) return;

  let diffityProc: ChildProcess | null = null;
  let starting = false;

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (diffityProc || starting) return; // Already running or starting
    starting = true;

    const port = await findAvailablePort();
    if (!port) {
      starting = false;
      return;
    }

    try {
      diffityProc = spawn("diffity", [
        "--dark",
        "--no-open",
        "--quiet",
        "--port", String(port),
      ], {
        cwd: ctx.cwd,
        detached: true,
        stdio: "ignore",
      });
      diffityProc.unref();
      starting = false;

      // Wait for diffity to be ready before showing the URL
      const isUp = await waitForPort(port);
      if (!isUp) {
        killProcessTree(diffityProc);
        diffityProc = null;
        return;
      }

      // Show link in status line
      const statusText = ctx.ui.theme.fg("accent", `${ICON_DIFF} http://localhost:${port}?theme=dark`);
      if (setDiffityStatus) {
        setDiffityStatus(statusText);
        // Trigger a git status refresh to rebuild combined status
        pi.events?.emit("diffity:ready");
      } else {
        ctx.ui.setStatus("diffity", statusText);
      }
    } catch {
      if (diffityProc) {
        killProcessTree(diffityProc);
      }
      diffityProc = null;
      starting = false;
    }
  });

  pi.on("session_shutdown", () => {
    starting = false;
    if (diffityProc) {
      killProcessTree(diffityProc);
      diffityProc = null;
    }
  });
}
