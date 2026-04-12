/**
 * Diffity auto-start — launches diffity diff viewer in container sessions.
 * Shows a status line link so the user can check code changes in real-time.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import * as net from "node:net";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

export function registerDiffity(pi: ExtensionAPI, inContainer: boolean): void {
  if (!inContainer) return;
  if (!hasDiffity()) return;

  let diffityProc: ChildProcess | null = null;
  let diffityPort: number | null = null;

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
      diffityPort = port;

      // Show link in status line
      ctx.ui.setStatus("diffity", ctx.ui.theme.fg("accent", `📊 diff: http://localhost:${port}`));
    } catch {
      // diffity failed to start, ignore silently
    }
  });

  pi.on("session_shutdown", () => {
    if (diffityProc) {
      try { diffityProc.kill(); } catch {}
      diffityProc = null;
      diffityPort = null;
    }
  });
}
