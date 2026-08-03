/**
 * pidiff — diff viewer extension (per-project server mode).
 *
 * Uses daemon-manager for spawn/connect/reconnect.
 * Each project gets its own server on a dynamically allocated port,
 * tracked via lockfiles in <cwd>/.pi/tmp/.
 * Receives published review comments and injects into pi session.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hyperlink } from "@earendil-works/pi-tui";
import {
  createLogger,
  checkHealth,
  ensureUiBuilt,
  spawnDaemon,
  killDaemonByPid,
  waitForDaemon,
  findFreePort,
  writeLockfile,
  readLockfile,
  removeLockfile,
} from "../shared/daemon-manager.js";
import { setupHeartbeat, setupReconnectPoller } from "../shared/ws-client.js";
import { getSetting } from "../orchestrator/project-settings.js";

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

  const projectCwd = process.cwd();
  const pidiffDisabled = !getSetting(projectCwd, "pidiff_enable");
  if (pidiffDisabled) {
    pi.registerCommand("pidiff", {
      description: "Manage pidiff server — /pidiff start|stop|restart|status",
      getArgumentCompletions: (prefix: string) => {
        const items = [
          { value: "start", label: "start", description: "Start pidiff server" },
          { value: "stop", label: "stop", description: "Stop pidiff server" },
          { value: "restart", label: "restart", description: "Restart pidiff server" },
          { value: "status", label: "status", description: "Show pidiff status" },
        ];
        return items.filter(i => i.value.startsWith(prefix.toLowerCase()));
      },
      handler: async (_args, ctx) => {
        if (ctx.hasUI) ctx.ui.notify("pidiff is disabled (pidiff_enable=false in pi-config-settings.json or PI_PIDIFF_ENABLE=false).", "info");
      },
    });
    return;
  }

  let ws: any = null;
  let connected = false;
  let connecting = false;
  let shuttingDown = false;
  let spawning = false;
  let lastCtx: any = null;
  let cleanupHeartbeat: (() => void) | null = null;
  let lockDir = ""; // Set on session_start from ctx.cwd
  let activePort = 0;

  function setStatus(ctx: any): void {
    try {
      if (ctx?.hasUI && activePort) {
        const link = hyperlink("pi-diff", `http://localhost:${activePort}`);
        const label = ICON_DIFF ? `${ICON_DIFF} ${link}` : link;
        ctx.ui.setStatus("8-diff", ctx.ui.theme.fg("accent", label));
      }
    } catch {
      // ctx may be stale if session was replaced during WebSocket connect
    }
    if (activePort) pi.events?.emit("diff-viewer:port", activePort);
  }

  function doSpawn(port: number, cwd: string): void {
    ensureUiBuilt(import.meta.url, "pidiff-ui", log);
    spawnDaemon({
      serverScript: "pidiff-server.ts",
      logFile: path.join(process.env.HOME || "/tmp", ".pi", "pidiff-server.log"),
      env: { PI_PIDIFF_PORT: String(port), PI_PIDIFF_CWD: cwd },
      log,
    });
  }

  async function connect(ctx: any) {
    log(`connect() called, connected=${connected}, connecting=${connecting}`);
    if (connected || connecting || shuttingDown) return;
    connecting = true;
    lastCtx = ctx;
    if (!lockDir) { log("connect: lockDir not set (session_start not fired yet)"); connecting = false; return; }

    // Try to discover port from lockfile
    let port = activePort;
    if (!port) {
      const lock = readLockfile(lockDir);
      if (lock) port = lock.port;
    }

    // Check if existing port is healthy
    let running = false;
    if (port) {
      running = await checkHealth(port);
      log(`lockfile port=${port}, healthy=${running}`);
    }

    if (!running) {
      if (spawning) {
        log("daemon already spawning, waiting...");
        connecting = false;
        return;
      }

      // Atomic spawn guard — prevent two sessions from racing to spawn
      const spawnLock = path.join(lockDir, "pidiff.spawning");
      try {
        fs.writeFileSync(spawnLock, String(process.pid), { flag: "wx" });
      } catch {
        // Another session is already spawning — wait for lockfile to appear
        log("another session is spawning pidiff, waiting for lockfile...");
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const lock = readLockfile(lockDir);
          if (lock && await checkHealth(lock.port)) {
            port = lock.port;
            activePort = port;
            break;
          }
        }
        connecting = false;
        if (port) setTimeout(() => connect(ctx), 1000);
        return;
      }

      spawning = true;
      try {
        log("spawning daemon...");
        // Reuse lockfile port if available — keeps URL stable across reload/restart
        if (!port) {
          port = await findFreePort();
          log(`allocated new port: ${port}`);
        } else {
          log(`reusing lockfile port: ${port}`);
        }
        doSpawn(port, ctx.cwd);
        writeLockfile(lockDir, port, null, log);
        const ready = await waitForDaemon(port, 60, log);
        if (!ready) { connecting = false; return; }
      } finally {
        spawning = false;
        try { fs.unlinkSync(spawnLock); } catch {}
      }
    }

    activePort = port;

    try {
      const _require = createRequire(import.meta.url);
      const WebSocket = _require("ws");
      log(`connecting WebSocket to port ${activePort}...`);
      const wsClient = new WebSocket(`ws://127.0.0.1:${activePort}/ws/pi`);

      wsClient.on("open", () => {
        log("WebSocket connected");
        ws = wsClient;
        connected = true;
        connecting = false;

        try {
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
        } catch {
          // ctx may be stale if session was replaced during WebSocket connect
          log("skipped registration — ctx is stale");
        }

        // Keepalive + dead connection detection
        if (cleanupHeartbeat) cleanupHeartbeat();
        cleanupHeartbeat = setupHeartbeat({
          ws: wsClient,
          log,
          onDead: () => {
            connected = false; ws = null;
            if (!shuttingDown && lastCtx) setTimeout(() => connect(lastCtx), 1000);
          },
        });
      });

      wsClient.on("message", (data: Buffer) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === "publish-review" && parsed.comments?.length > 0) {
            log(`review received: ${parsed.comments.length} comments`);
            const review = {
              source: "pidiff",
              type: "code-review",
              comments: parsed.comments.map((c: any) => ({
                file: c.file,
                line: c.line,
                side: c.side,
                body: c.body,
                ...(c.branch ? { branch: c.branch } : {}),
                ...(c.worktreePath ? { worktreePath: c.worktreePath } : {}),
                ...(c.replies?.length ? { replies: c.replies } : {}),
                ...(c.resolved ? { resolved: true } : {}),
              })),
              ...(parsed.summary ? { summary: parsed.summary } : {}),
            };
            const message = `## pidiff: Code Review Comments\n\n\`\`\`json\n${JSON.stringify(review, null, 2)}\n\`\`\`\n\nPlease address these review comments.`;
            pi.sendUserMessage(message, { deliverAs: "followUp" });
          }
        } catch (e: any) { log(`message handler error: ${e.message}`); }
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
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "start", label: "start", description: "Start pidiff server" },
        { value: "stop", label: "stop", description: "Stop pidiff server" },
        { value: "restart", label: "restart", description: "Restart pidiff server" },
        { value: "status", label: "status", description: "Show pidiff status" },
      ];
      return items.filter(i => i.value.startsWith(prefix.toLowerCase()));
    },
    handler: async (args, ctx) => {
      lastCtx = ctx;
      const cmd = (args || "").trim().toLowerCase();

      if (cmd === "stop") {
        if (ws) { try { ws.close(); } catch {} ws = null; }
        connected = false;
        const pidFile = path.join(lockDir, "pidiff.pid");
        killDaemonByPid(pidFile, log);
        removeLockfile(lockDir, log);
        activePort = 0;
        if (ctx.hasUI) { ctx.ui.setStatus("8-diff", undefined); ctx.ui.notify("pidiff server stopped", "info"); }
        return;
      }

      if (cmd === "start") {
        const lock = readLockfile(lockDir);
        if (lock && await checkHealth(lock.port)) {
          activePort = lock.port;
          if (ctx.hasUI) ctx.ui.notify(`pidiff already running at http://localhost:${activePort}`, "info");
          if (!connected) connect(ctx);
          return;
        }
        // Reuse lockfile port to keep URL stable
        const port = lock?.port || await findFreePort();
        doSpawn(port, ctx.cwd);
        writeLockfile(lockDir, port, null, log);
        if (ctx.hasUI) ctx.ui.notify("Starting pidiff server...", "info");
        if (await waitForDaemon(port, 60, log)) {
          activePort = port;
          connect(ctx);
          if (ctx.hasUI) ctx.ui.notify(`pidiff started at http://localhost:${activePort}`, "info");
        } else {
          if (ctx.hasUI) ctx.ui.notify("pidiff failed to start", "warning");
        }
        return;
      }

      if (cmd === "restart") {
        if (ws) { try { ws.close(); } catch {} ws = null; }
        connected = false;
        const pidFile = path.join(lockDir, "pidiff.pid");
        // Reuse existing port to keep URL stable (read before removeLockfile)
        const lock = readLockfile(lockDir);
        const port = activePort || lock?.port || await findFreePort();
        killDaemonByPid(pidFile, log);
        removeLockfile(lockDir, log);
        await new Promise(r => setTimeout(r, 1000));
        doSpawn(port, ctx.cwd);
        writeLockfile(lockDir, port, null, log);
        if (ctx.hasUI) ctx.ui.notify("Restarting pidiff server...", "info");
        if (await waitForDaemon(port, 60, log)) {
          activePort = port;
          connect(ctx);
          if (ctx.hasUI) ctx.ui.notify(`pidiff restarted at http://localhost:${activePort}`, "info");
        } else {
          if (ctx.hasUI) ctx.ui.notify("pidiff failed to restart", "warning");
        }
        return;
      }

      const lock = readLockfile(lockDir);
      const statusPort = activePort || lock?.port || 0;
      const running = statusPort ? await checkHealth(statusPort) : false;
      let msg = `Server: ${running ? "running" : "stopped"}\nPort: ${statusPort || "(none)"}\n`;
      msg += `Extension: ${connected ? "connected" : "disconnected"}`;
      if (statusPort) msg += `\nURL: http://localhost:${statusPort}`;
      if (ctx.hasUI) ctx.ui.notify(msg, "info");
    },
  });

  // Session lifecycle
  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    lockDir = path.join(ctx.cwd, ".pi", "tmp");
    if (!isGitRepo(ctx.cwd)) return;
    if (!connected && ctx.mode === "tui") connect(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    lastCtx = ctx;
    if (connected) setStatus(ctx);
  });

  pi.on("tool_result", (_event, ctx) => {
    if (!connected && !shuttingDown && ctx.mode === "tui") connect(ctx);
  });

  const cleanupReconnect = setupReconnectPoller({
    isConnected: () => connected,
    isConnecting: () => connecting,
    isShuttingDown: () => shuttingDown,
    connect: () => { if (lastCtx?.mode === "tui") connect(lastCtx); },
  });

  pi.on("session_shutdown", () => {
    // Server auto-exits when last pi session disconnects (onPiClose in pidiff-server.ts).
    // No need to kill here — just disconnect and let the server decide.
    shuttingDown = true;
    cleanupReconnect();
    if (cleanupHeartbeat) { cleanupHeartbeat(); cleanupHeartbeat = null; }
    if (ws) { try { ws.close(); } catch {} ws = null; }
    connected = false;
  });
}
