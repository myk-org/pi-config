/**
 * Shared daemon manager — reusable infrastructure for spawning, health-checking,
 * connecting to, and managing long-lived server daemons (pidash, pidiff, etc.).
 *
 * Used by pidash.ts and pidiff.ts to avoid duplicating the spawn/connect/reconnect logic.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as path from "node:path";

const HEALTH_CHECK_TIMEOUT_MS = 2000;

// ── Logging ─────────────────────────────────────────────────────────

export function createLogger(logPath: string, prefix: string) {
  return (msg: string) => {
    try { fs.appendFileSync(logPath, `${new Date().toISOString()} [${prefix}] ${msg}\n`); } catch {}
  };
}

// ── Health check ────────────────────────────────────────────────────

export function checkHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/api/health", timeout: HEALTH_CHECK_TIMEOUT_MS },
      (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => {
          try { resolve(JSON.parse(body).status === "ok"); } catch { resolve(false); }
        });
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ── UI build ────────────────────────────────────────────────────────

export function ensureUiBuilt(uiDirName: string, log: (msg: string) => void): void {
  const uiDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    uiDirName,
  );
  const distDir = path.join(uiDir, "dist");
  if (fs.existsSync(distDir)) return;
  if (!fs.existsSync(path.join(uiDir, "package.json"))) return;

  log(`${uiDirName} dist/ not found, building...`);
  try {
    const { execSync: ex } = require("node:child_process");
    ex("npm install --production=false && npm run build", {
      cwd: uiDir,
      stdio: "ignore",
      timeout: 60000,
    });
    log(`${uiDirName} build complete`);
  } catch (e: any) {
    log(`${uiDirName} build failed: ${e.message}`);
  }
}

// ── Find jiti ───────────────────────────────────────────────────────

export function findJitiPath(): string | undefined {
  let jitiPath: string | undefined;
  try {
    let dir = path.dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 10; i++) {
      const candidate = path.join(dir, "node_modules", "@mariozechner", "jiti", "lib", "jiti-cli.mjs");
      if (fs.existsSync(candidate)) { jitiPath = candidate; break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!jitiPath) {
      const globalCandidate = path.join(
        path.dirname(process.execPath), "..", "lib", "node_modules",
        "@mariozechner", "pi-coding-agent", "node_modules",
        "@mariozechner", "jiti", "lib", "jiti-cli.mjs",
      );
      if (fs.existsSync(globalCandidate)) jitiPath = globalCandidate;
    }
  } catch {}
  return jitiPath;
}

// ── Spawn daemon ────────────────────────────────────────────────────

export interface SpawnOptions {
  /** Path to the server .ts file (relative to scripts/) */
  serverScript: string;
  /** Log file path */
  logFile: string;
  /** Extra CLI args for the server */
  extraArgs?: string;
  /** Extra env vars */
  env?: Record<string, string>;
  /** Logger function */
  log: (msg: string) => void;
}

export function spawnDaemon(opts: SpawnOptions): void {
  const serverPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..", "..", "scripts", opts.serverScript,
  );

  const jitiPath = findJitiPath();
  opts.log(`jiti path: ${jitiPath || "NOT FOUND"}`);

  const nodeCmd = process.execPath;
  const serverArgs = jitiPath
    ? `"${jitiPath}" "${serverPath}"${opts.extraArgs ? ` ${opts.extraArgs}` : ""}`
    : `"${serverPath}"${opts.extraArgs ? ` ${opts.extraArgs}` : ""}`;
  const cmd = `nohup "${nodeCmd}" ${serverArgs} > "${opts.logFile}" 2>&1 &`;
  opts.log(`spawning daemon: ${cmd}`);

  try {
    const { execSync } = require("node:child_process");
    execSync(cmd, {
      stdio: "ignore",
      env: { ...process.env, ...(opts.env || {}) },
    });
  } catch (e: any) {
    opts.log(`spawn error: ${e.message}`);
  }
}

// ── Kill daemon ─────────────────────────────────────────────────────

export function killDaemon(pattern: string, log: (msg: string) => void): void {
  try {
    const { execSync } = require("node:child_process");
    execSync(`pkill -f "${pattern}"`, { stdio: "ignore" });
    log(`killed processes matching: ${pattern}`);
  } catch {}
}

// ── Wait for daemon ─────────────────────────────────────────────────

export async function waitForDaemon(
  port: number,
  maxWaitSeconds: number,
  log: (msg: string) => void,
): Promise<boolean> {
  for (let i = 0; i < maxWaitSeconds; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await checkHealth(port)) {
      log(`daemon ready after ${i + 1}s`);
      return true;
    }
  }
  log(`daemon failed to start after ${maxWaitSeconds}s`);
  return false;
}

// ── WebSocket connect with heartbeat + reconnect ────────────────────

export interface WsConnectOptions {
  port: number;
  wsPath: string;
  log: (msg: string) => void;
  onMessage: (parsed: any) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  reconnectMs?: number;
}

export interface WsConnection {
  send: (data: any) => void;
  close: () => void;
  isConnected: () => boolean;
}

export function connectWebSocket(
  opts: WsConnectOptions,
  shouldReconnect: () => boolean,
): WsConnection {
  let ws: any = null;
  let connected = false;

  function doConnect() {
    try {
      const _require = createRequire(import.meta.url);
      const WebSocket = _require("ws");
      const wsClient = new WebSocket(`ws://127.0.0.1:${opts.port}${opts.wsPath}`);

      wsClient.on("open", () => {
        opts.log("WebSocket connected");
        ws = wsClient;
        connected = true;
        opts.onConnected?.();

        wsClient.on("ping", () => { try { wsClient.pong(); } catch {} });

        let pongReceived = true;
        wsClient.on("pong", () => { pongReceived = true; });
        const heartbeat = setInterval(() => {
          if (wsClient.readyState !== 1) { clearInterval(heartbeat); return; }
          if (!pongReceived) {
            opts.log("heartbeat: no pong — forcing reconnect");
            clearInterval(heartbeat);
            try { wsClient.terminate(); } catch {}
            connected = false;
            ws = null;
            opts.onDisconnected?.();
            if (shouldReconnect()) setTimeout(doConnect, 1000);
            return;
          }
          pongReceived = false;
          try { wsClient.ping(); } catch {}
        }, 30000);
        if ((heartbeat as any).unref) (heartbeat as any).unref();
      });

      wsClient.on("message", (data: Buffer) => {
        try { opts.onMessage(JSON.parse(data.toString())); } catch {}
      });

      wsClient.on("close", () => {
        opts.log("WebSocket closed");
        connected = false;
        ws = null;
        opts.onDisconnected?.();
        if (shouldReconnect()) {
          setTimeout(doConnect, opts.reconnectMs || 5000);
        }
      });

      wsClient.on("error", (e: Error) => {
        opts.log(`WebSocket error: ${e.message}`);
      });
    } catch (e: any) {
      opts.log(`connect error: ${e.message}`);
    }
  }

  doConnect();

  return {
    send: (data: any) => {
      if (ws && connected) {
        try { ws.send(typeof data === "string" ? data : JSON.stringify(data)); } catch {}
      }
    },
    close: () => {
      if (ws) { try { ws.close(); } catch {} ws = null; }
      connected = false;
    },
    isConnected: () => connected,
  };
}

// ── Register a /command (start|stop|restart|status) ─────────────────

export interface DaemonCommandOptions {
  name: string;
  port: number;
  processName: string;
  log: (msg: string) => void;
  spawn: (cwd: string) => void;
  onConnected?: () => void;
  connect: (ctx: any) => void;
  getConnected: () => boolean;
  close: () => void;
  clearStatus: (ctx: any) => void;
}

export function registerDaemonCommand(
  pi: any,
  opts: DaemonCommandOptions,
): void {
  pi.registerCommand(opts.name, {
    description: `Manage ${opts.name} server — /${opts.name} start|stop|restart|status`,
    handler: async (args: string, ctx: any) => {
      const cmd = (args || "").trim().toLowerCase();

      if (cmd === "stop") {
        opts.close();
        killDaemon(opts.processName, opts.log);
        opts.clearStatus(ctx);
        if (ctx.hasUI) ctx.ui.notify(`${opts.name} server stopped`, "info");
        return;
      }

      if (cmd === "start") {
        if (await checkHealth(opts.port)) {
          if (ctx.hasUI) ctx.ui.notify(`${opts.name} already running at http://localhost:${opts.port}`, "info");
          if (!opts.getConnected()) opts.connect(ctx);
          return;
        }
        opts.spawn(ctx.cwd);
        if (ctx.hasUI) ctx.ui.notify(`Starting ${opts.name} server...`, "info");
        if (await waitForDaemon(opts.port, 60, opts.log)) {
          opts.connect(ctx);
          if (ctx.hasUI) ctx.ui.notify(`${opts.name} server started at http://localhost:${opts.port}`, "info");
        } else {
          if (ctx.hasUI) ctx.ui.notify(`${opts.name} server failed to start`, "warning");
        }
        return;
      }

      if (cmd === "restart") {
        opts.close();
        killDaemon(opts.processName, opts.log);
        opts.clearStatus(ctx);
        await new Promise(r => setTimeout(r, 1000));
        opts.spawn(ctx.cwd);
        if (ctx.hasUI) ctx.ui.notify(`Restarting ${opts.name} server...`, "info");
        if (await waitForDaemon(opts.port, 60, opts.log)) {
          opts.connect(ctx);
          if (ctx.hasUI) ctx.ui.notify(`${opts.name} server restarted at http://localhost:${opts.port}`, "info");
        } else {
          if (ctx.hasUI) ctx.ui.notify(`${opts.name} server failed to restart`, "warning");
        }
        return;
      }

      // Default: status
      const running = await checkHealth(opts.port);
      let msg = `Server: ${running ? "running" : "stopped"}\n`;
      msg += `Port: ${opts.port}\n`;
      msg += `Extension: ${opts.getConnected() ? "connected" : "disconnected"}\n`;
      msg += `URL: http://localhost:${opts.port}`;
      if (ctx.hasUI) ctx.ui.notify(msg, "info");
    },
  });
}
