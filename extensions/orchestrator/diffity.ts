/**
 * Diffity auto-start — launches diffity diff viewer.
 * Shows a status line link so the user can check code changes in real-time.
 * Works both in container and native — requires diffity to be installed.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import * as net from "node:net";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ICON_DIFF } from "./icons.js";

const DIFFITY_START_PORT = 8090;
const DIFFITY_MAX_PORT_TRIES = 10;

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(): Promise<number | null> {
  for (let i = 0; i < DIFFITY_MAX_PORT_TRIES; i++) {
    const port = DIFFITY_START_PORT + i;
    if (await isPortAvailable(port)) return port;
  }
  return null;
}

function hasDiffity(): boolean {
  try {
    execSync("which diffity", { stdio: "ignore" });
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

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (diffityProc) return; // Already running

    const port = await findAvailablePort();
    if (!port) return;

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
      // diffity failed to start, ignore silently
    }
  });

  pi.on("session_shutdown", () => {
    if (diffityProc) {
      killProcessTree(diffityProc);
      diffityProc = null;
    }
  });
}
