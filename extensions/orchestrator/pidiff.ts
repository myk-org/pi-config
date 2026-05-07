/**
 * pidiff — diff viewer extension (single server, like pidash).
 *
 * Uses daemon-manager for spawn/connect/reconnect.
 * Connects to pidiff-server on fixed port, registers this session's cwd.
 * Receives published review comments and injects into pi session.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createLogger,
  checkHealth,
  ensureUiBuilt,
  spawnDaemon,
  killDaemon,
  waitForDaemon,
} from "./daemon-manager.js";

const DEFAULT_PORT = 19290;
const PIDIFF_PORT = parseInt(process.env.PI_PIDIFF_PORT || "", 10) || DEFAULT_PORT;
const RECONNECT_INTERVAL_MS = 5000;
const ICON_DIFF = "";

const log = createLogger(
  path.join(process.env.HOME || "/tmp", ".pi", "pidiff-debug.log"),
  "ext",
);

function isGitRepo(cwd: string): boolean {
  try { execFileSync("git", ["rev-parse", "--git-dir"], { cwd, stdio: "ignore" }); return true; } catch { return false; }
}

function getBranch(cwd: string): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return ""; }
}

export function registerPidiff(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  let ws: any = null;
  let connected = false;
  let connecting = false;
  let shuttingDown = false;
  let spawning = false;
  let lastCtx: any = null;

  function setStatus(ctx: any): void {
    if (ctx?.hasUI) {
      ctx.ui.setStatus("4-diff", ctx.ui.theme.fg("accent", `${ICON_DIFF} http://localhost:${PIDIFF_PORT}`));
    }
    pi.events?.emit("diff-viewer:port", PIDIFF_PORT);
  }

  function doSpawn(): void {
    ensureUiBuilt("pidiff-ui", log);
    spawnDaemon({
      serverScript: "pidiff-server.ts",
      logFile: path.join(process.env.HOME || "/tmp", ".pi", "pidiff-server.log"),
      env: { PI_PIDIFF_PORT: String(PIDIFF_PORT) },
      log,
    });
  }

  async function connect(ctx: any) {
    log(`connect() called, connected=${connected}, connecting=${connecting}`);
    if (connected || connecting || shuttingDown) return;
    connecting = true;
    lastCtx = ctx;

    const running = await checkHealth(PIDIFF_PORT);
    log(`daemon running: ${running}`);
    if (!running) {
      if (!spawning) {
        spawning = true;
        log("spawning daemon...");
        doSpawn();
      }
      const ready = await waitForDaemon(PIDIFF_PORT, 60, log);
      spawning = false;
      if (!ready) { connecting = false; return; }
    }

    try {
      const _require = createRequire(import.meta.url);
      const WebSocket = _require("ws");
      log("connecting WebSocket...");
      const wsClient = new WebSocket(`ws://127.0.0.1:${PIDIFF_PORT}/ws/pi`);

      wsClient.on("open", () => {
        log("WebSocket connected");
        ws = wsClient;
        connected = true;
        connecting = false;
        setStatus(ctx);

        // Register this session
        const branch = getBranch(ctx.cwd);
        wsClient.send(JSON.stringify({
          type: "register",
          pid: process.pid,
          sessionId: `${process.pid}:${ctx.cwd}`,
          cwd: ctx.cwd,
          branch,
        }));

        // Keepalive
        wsClient.on("ping", () => { try { wsClient.pong(); } catch {} });
        let pongReceived = true;
        wsClient.on("pong", () => { pongReceived = true; });
        const heartbeat = setInterval(() => {
          if (wsClient.readyState !== 1) { clearInterval(heartbeat); return; }
          if (!pongReceived) {
            log("heartbeat: no pong — reconnecting");
            clearInterval(heartbeat);
            try { wsClient.terminate(); } catch {}
            connected = false; ws = null;
            if (!shuttingDown && lastCtx) setTimeout(() => connect(lastCtx), 1000);
            return;
          }
          pongReceived = false;
          try { wsClient.ping(); } catch {}
        }, 30000);
        if ((heartbeat as any).unref) (heartbeat as any).unref();
      });

      wsClient.on("message", (data: Buffer) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === "publish-review" && parsed.comments?.length > 0) {
            log(`review received: ${parsed.comments.length} comments`);
            const lines: string[] = ["## Code Review Comments", ""];
            const byFile = new Map<string, Array<{ line: number; body: string }>>();
            for (const c of parsed.comments) {
              if (!byFile.has(c.file)) byFile.set(c.file, []);
              byFile.get(c.file)!.push(c);
            }
            for (const [file, comments] of byFile) {
              lines.push(`### ${file}`);
              for (const c of comments) {
                lines.push(c.line > 0 ? `**Line ${c.line}:** ${c.body}` : `**File comment:** ${c.body}`);
              }
              lines.push("");
            }
            if (parsed.summary) lines.push(`### Summary`, parsed.summary, "");
            lines.push("Please address these review comments.");
            pi.sendUserMessage(lines.join("\n"), { deliverAs: "followUp" });
          }
        } catch {}
      });

      wsClient.on("close", () => {
        log("WebSocket closed");
        connected = false; ws = null; connecting = false;
        if (!shuttingDown) {
          setTimeout(() => { if (lastCtx && !shuttingDown) connect(lastCtx); }, RECONNECT_INTERVAL_MS);
        }
      });

      wsClient.on("error", (e: Error) => { log(`WebSocket error: ${e.message}`); });
    } catch (e: any) {
      log(`connect error: ${e.message}`);
      connecting = false;
    }
  }

  // /pidiff command
  pi.registerCommand("pidiff", {
    description: "Manage pidiff server — /pidiff start|stop|restart|status",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      const cmd = (args || "").trim().toLowerCase();

      if (cmd === "stop") {
        if (ws) { try { ws.close(); } catch {} ws = null; }
        connected = false;
        killDaemon("pidiff-server", log);
        if (ctx.hasUI) { ctx.ui.setStatus("4-diff", undefined); ctx.ui.notify("pidiff server stopped", "info"); }
        return;
      }

      if (cmd === "start") {
        if (await checkHealth(PIDIFF_PORT)) {
          if (ctx.hasUI) ctx.ui.notify(`pidiff already running at http://localhost:${PIDIFF_PORT}`, "info");
          if (!connected) connect(ctx);
          return;
        }
        doSpawn();
        if (ctx.hasUI) ctx.ui.notify("Starting pidiff server...", "info");
        if (await waitForDaemon(PIDIFF_PORT, 60, log)) {
          connect(ctx);
          if (ctx.hasUI) ctx.ui.notify(`pidiff started at http://localhost:${PIDIFF_PORT}`, "info");
        } else {
          if (ctx.hasUI) ctx.ui.notify("pidiff failed to start", "warning");
        }
        return;
      }

      if (cmd === "restart") {
        if (ws) { try { ws.close(); } catch {} ws = null; }
        connected = false;
        killDaemon("pidiff-server", log);
        await new Promise(r => setTimeout(r, 1000));
        doSpawn();
        if (ctx.hasUI) ctx.ui.notify("Restarting pidiff server...", "info");
        if (await waitForDaemon(PIDIFF_PORT, 60, log)) {
          connect(ctx);
          if (ctx.hasUI) ctx.ui.notify(`pidiff restarted at http://localhost:${PIDIFF_PORT}`, "info");
        } else {
          if (ctx.hasUI) ctx.ui.notify("pidiff failed to restart", "warning");
        }
        return;
      }

      const running = await checkHealth(PIDIFF_PORT);
      let msg = `Server: ${running ? "running" : "stopped"}\nPort: ${PIDIFF_PORT}\n`;
      msg += `Extension: ${connected ? "connected" : "disconnected"}\nURL: http://localhost:${PIDIFF_PORT}`;
      if (ctx.hasUI) ctx.ui.notify(msg, "info");
    },
  });

  // Session lifecycle
  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    if (!isGitRepo(ctx.cwd)) return;
    if (!connected) connect(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    lastCtx = ctx;
    if (connected) setStatus(ctx);
  });

  pi.on("tool_result", (_event, ctx) => {
    if (!connected && !shuttingDown) connect(ctx);
  });

  const reconnectPoller = setInterval(() => {
    if (!connected && !connecting && !shuttingDown && lastCtx) connect(lastCtx);
  }, 15000);
  if (reconnectPoller.unref) reconnectPoller.unref();

  pi.on("session_shutdown", () => {
    shuttingDown = true;
    clearInterval(reconnectPoller);
    if (ws) { try { ws.close(); } catch {} ws = null; }
    connected = false;
  });
}
