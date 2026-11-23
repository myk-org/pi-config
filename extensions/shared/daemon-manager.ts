/**
 * Shared daemon client & lifecycle manager — reusable infrastructure for spawning,
 * health-checking, connecting to, keeping alive, reconnecting, shutting down, and
 * managing `/start|stop|restart|status` commands for long-lived server daemons
 * (pidash, pidiff).
 *
 * Absorbs WebSocket heartbeat/reconnect wiring (formerly `ws-client.ts`) behind
 * `createDaemonClient`, keeping `pidash.ts` and `pidiff.ts` as thin adapters.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger, type Logger } from "./logger.js";
import { findJitiPath } from "./find-jiti.js";
import { isLiveExtensionCtx } from "./live-ctx.js";
import { buildUiDist } from "../../scripts/serve-ui.ts";

const log = createLogger("daemon-manager");

const HEALTH_CHECK_TIMEOUT_MS = 2000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_RECONNECT_DELAY_MS = 5_000;
const DEFAULT_HEARTBEAT_DEAD_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_RESTART_WAIT_MS = 1_000;

let cachedWsCtor: any = null;
function defaultCreateWebSocket(url: string): any {
  if (!cachedWsCtor) {
    cachedWsCtor = createRequire(import.meta.url)("ws");
  }
  return new cachedWsCtor(url);
}

// ── Health check ────────────────────────────────────────────────────

/** Statuses that mean "a daemon is listening here".
 *
 *  `degraded` is one of them: the server bound its port but a startup hook failed (the Discord bot
 *  could not be created). Treating it as "not running" made callers spawn a SECOND daemon, which
 *  then lost the occupied port and waited on a health check that never passed. */
export const DAEMON_UP_STATUSES = new Set(["ok", "degraded"]);

/** Parse a /api/health body into the daemon's state. */
export function parseHealth(body: string): { running: boolean; degraded: boolean; startupError: string | null } {
  try {
    const data = JSON.parse(body);
    const status = typeof data?.status === "string" ? data.status : "";
    const startupError = typeof data?.startupError === "string" ? data.startupError : null;
    return { running: DAEMON_UP_STATUSES.has(status), degraded: status === "degraded" || Boolean(startupError), startupError };
  } catch {
    return { running: false, degraded: false, startupError: null };
  }
}

export function checkHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/api/health", timeout: HEALTH_CHECK_TIMEOUT_MS },
      (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => resolve(parseHealth(body).running));
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ── UI build ────────────────────────────────────────────────────────

export function ensureUiBuilt(callerUrl: string, uiDirName: string, onLog: (msg: string) => void): void {
  const uiDir = path.resolve(
    path.dirname(fileURLToPath(callerUrl)),
    uiDirName,
  );
  if (fs.existsSync(path.join(uiDir, "dist"))) return;
  buildUiDist(uiDir, uiDirName, onLog);
}

export { findJitiPath, findJitiUnder } from "./find-jiti.js";

// ── Spawn / kill / wait daemon ──────────────────────────────────────

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
  /** Override jiti lookup (tests). Default: findJitiPath(). */
  resolveJiti?: () => string | undefined;
}

export function spawnDaemon(opts: SpawnOptions): void {
  const serverPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..", "..", "scripts", opts.serverScript,
  );

  const jitiPath = (opts.resolveJiti ?? findJitiPath)();
  opts.log(`jiti path: ${jitiPath || "NOT FOUND"}`);
  if (!jitiPath) {
    const msg =
      "jiti-cli.mjs not found — refusing to run .ts under node_modules (Node type-stripping is disabled there)";
    log.error("%s server=%s", msg, serverPath);
    log.debug("spawnDaemon refused — jiti missing server=%s", serverPath);
    opts.log(msg);
    return;
  }

  const nodeCmd = process.execPath;
  const serverArgs = `"${jitiPath}" "${serverPath}"${opts.extraArgs ? ` ${opts.extraArgs}` : ""}`;
  const cmd = `nohup "${nodeCmd}" ${serverArgs} > "${opts.logFile}" 2>&1 &`;
  opts.log(`spawning daemon: ${cmd}`);
  log.info("spawning daemon script=%s jiti=%s", opts.serverScript, jitiPath);

  try {
    execSync(cmd, {
      stdio: "ignore",
      env: { ...process.env, ...(opts.env || {}) },
    });
  } catch (e: any) {
    log.error("spawn error: %s", e.message);
    opts.log(`spawn error: ${e.message}`);
  }
}

export function killDaemon(pattern: string, onLog: (msg: string) => void): void {
  try {
    execSync(`pkill -f "${pattern}"`, { stdio: "ignore" });
    log.info("killed_daemon_pattern", { pattern });
    onLog(`killed processes matching: ${pattern}`);
  } catch {}
}

const FAST_POLL_INTERVAL_MS = 200;
const FAST_POLL_WINDOW_MS = 2000;
const SLOW_POLL_INTERVAL_MS = 1000;

export async function waitForDaemon(
  port: number,
  maxWaitSeconds: number,
  onLog: (msg: string) => void,
  probe: (port: number) => Promise<boolean> = checkHealth,
): Promise<boolean> {
  const budgetMs = Math.max(0, maxWaitSeconds * 1000);
  const start = Date.now();
  let elapsed = 0;
  while (elapsed < budgetMs) {
    const interval = elapsed < FAST_POLL_WINDOW_MS ? FAST_POLL_INTERVAL_MS : SLOW_POLL_INTERVAL_MS;
    const waitMs = Math.min(interval, budgetMs - elapsed);
    if (waitMs <= 0) break;
    await new Promise((r) => setTimeout(r, waitMs));
    if (await probe(port)) {
      onLog(`daemon ready after ${((Date.now() - start) / 1000).toFixed(1)}s`);
      return true;
    }
    elapsed = Date.now() - start;
  }
  onLog(`daemon failed to start after ${maxWaitSeconds}s`);
  return false;
}

// ── Extension helpers ───────────────────────────────────────────────

/** Return the current checked-out git branch for cwd, or "" on error / detached HEAD. */
export function getGitBranch(cwd: string): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return ""; }
}

/** Register `/<name> start|stop|restart|status` for a daemon extension (enabled or disabled). */
export function registerDaemonCommand(
  pi: ExtensionAPI,
  name: string,
  enabled: boolean,
  settingKey: string,
  handler?: (args: string, ctx: any) => Promise<void> | void,
): void {
  const envKey = `PI_${settingKey.toUpperCase()}`;
  pi.registerCommand(name, {
    description: `Manage ${name} server — /${name} start|stop|restart|status`,
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "start", label: "start", description: `Start ${name} server` },
        { value: "stop", label: "stop", description: `Stop ${name} server` },
        { value: "restart", label: "restart", description: `Restart ${name} server` },
        { value: "status", label: "status", description: `Show ${name} status` },
      ];
      return items.filter((i) => i.value.startsWith(prefix.toLowerCase()));
    },
    handler: enabled && handler
      ? async (args, ctx) => { await handler(args, ctx); }
      : async (_args, ctx) => {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `${name} is disabled (${settingKey}=false in pi-config-settings.json or ${envKey}=false).`,
              "info",
            );
          }
        },
  });
}

// ── WebSocket heartbeat ─────────────────────────────────────────────

export interface WsHeartbeatOptions {
  /** The WebSocket client instance */
  ws: any;
  /** Interval in ms (default 30000) */
  intervalMs?: number;
  /** Called when connection is detected dead (no pong) */
  onDead: () => void;
  /** Logger function */
  log: (msg: string) => void;
}

/** Set up ping/pong keepalive + dead connection detection on a WebSocket client.
 *  Returns a cleanup function that clears the heartbeat interval. */
export function setupHeartbeat(opts: WsHeartbeatOptions): () => void {
  const { ws, intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS, onDead, log: onLog } = opts;

  ws.on("ping", () => { try { ws.pong(); } catch {} });

  let pongReceived = true;
  ws.on("pong", () => { pongReceived = true; });

  const heartbeat = setInterval(() => {
    if (ws.readyState !== 1) { // Not OPEN
      clearInterval(heartbeat);
      return;
    }
    if (!pongReceived) {
      onLog("heartbeat: no pong received — connection dead, forcing reconnect");
      clearInterval(heartbeat);
      try { ws.terminate(); } catch {}
      onDead();
      return;
    }
    pongReceived = false;
    try { ws.ping(); } catch {}
  }, intervalMs);
  if (typeof (heartbeat as any).unref === "function") (heartbeat as any).unref();

  return () => clearInterval(heartbeat);
}

// ── Deep shared daemon client ───────────────────────────────────────

export interface EnsureDaemonResult {
  /** Port to connect to, or null to abort this connect attempt. */
  port: number | null;
  /** Optional retry delay in ms when another spawner held the lock and connect should retry. */
  retryAfterMs?: number;
}

export interface DaemonClientAdapter<TConnectData = void> {
  /** Extension/daemon name (e.g. "pidash", "pidiff"). */
  name: string;
  /** Setting key controlling whether the daemon is enabled (e.g. "pidash_enable"). */
  settingKey: string;
  /** Status bar slot key cleared on `/<name> stop` (e.g. "9-pidash", "8-diff"). */
  statusKey: string;
  /** Structured logger (`createLogger(...)`). */
  log: Logger;

  /** Ensure a daemon is running and return the port to connect to. */
  ensureRunning: (ctx: any) => Promise<EnsureDaemonResult>;
  /** Optional async preparation right before opening the WebSocket (return `{ abort: true }` to cancel). */
  beforeOpen?: (ctx: any, port: number) => Promise<{ abort?: boolean; data?: TConnectData }>;
  /** Called once the WebSocket opens and the client is marked connected. */
  onOpen: (ws: any, ctx: any, port: number, data: TConnectData | undefined) => void;
  /** Called for every inbound WebSocket message. */
  onMessage: (data: Buffer, ws: any) => void | Promise<void>;
  /** Optional hook called whenever the active WebSocket disconnects (close or dead heartbeat). */
  onDisconnect?: () => void;
  /** Optional hook called at the start of `session_shutdown` BEFORE closing the WebSocket. */
  onBeforeShutdown?: (event: any, ws: any | null, connected: boolean) => void;

  /** Optional pre-command guard/hook for `/<name> ...`. Return `false` to abort execution. */
  beforeCommand?: (args: string, ctx: any) => boolean | void;
  /** Optional hook before `stopDaemon` during `/<name> restart` to capture a preferred port. */
  prepareRestart?: (ctx: any) => number | null;
  /** Stop the daemon process (and clean lockfiles if applicable). */
  stopDaemon: (ctx: any) => Promise<void> | void;
  /** Return the port of an already-running daemon for `/<name> start`, or null if stopped. */
  findRunningPort: (ctx: any) => Promise<number | null>;
  /** Port to probe and display for `/<name> status` (0/null if none known). */
  getStatusPort: (ctx: any) => number | null;
  /** Spawn the daemon for `/<name> start` or `restart` and return the port to wait on. */
  spawnForCommand: (ctx: any, mode: "start" | "restart", preferredPort?: number | null) => Promise<number>;
  /** Optional hook invoked when `/<name> start|restart` resolves a live port before connecting. */
  onCommandReady?: (port: number) => void;
  /** Startup health-check wait budget in seconds for `/<name> start|restart`. */
  getStartupTimeoutSeconds: (ctx: any) => number;
  /** Optional hint appended to start/restart failure notifications. */
  startFailureHint?: string;
  /** If true, unknown `/<name> <arg>` shows usage instead of falling through to status. */
  strictCommandUsage?: boolean;

  // ── Tuning & test injection seams ────────────────────────────────
  reconnectDelayMs?: number;
  heartbeatDeadReconnectDelayMs?: number;
  reconnectPollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  restartWaitMs?: number;
  createWebSocket?: (url: string) => any;
  probeHealth?: (port: number) => Promise<boolean>;
  waitReady?: (port: number, maxWaitSeconds: number, onLog: (msg: string) => void) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

export interface DaemonClient {
  /** Active open WebSocket, or null when disconnected. */
  readonly ws: any;
  /** True while the WebSocket is open and connected. */
  readonly connected: boolean;
  /** True while a connect attempt is in flight. */
  readonly connecting: boolean;
  /** True after `shutdown()` has run. */
  readonly shuttingDown: boolean;
  /** Most recent live ExtensionContext, or null. */
  readonly lastCtx: any;
  /** Update the stored `lastCtx` (e.g. from `session_start`, `agent_end`, event forwarding). */
  setLastCtx: (ctx: any) => void;
  /** Send a raw string or JSON-serializable payload if connected. Returns true if sent. */
  send: (payload: string | object) => boolean;
  /** Ensure the daemon is running and open the `/ws/pi` WebSocket. */
  connect: (ctx: any) => Promise<void>;
  /** Handle `/<name> start|stop|restart|status` (already registered on `pi`). */
  handleCommand: (args: string, ctx: any) => Promise<void>;
  /** Permanently tear down timers, heartbeat, reconnect poller, and WebSocket. */
  shutdown: (event?: any) => void;
}

/**
 * Create a managed daemon client for a pi extension.
 *
 * Owns WebSocket connection state, ping/pong heartbeat, `tool_result` + periodic
 * reconnect, `/<name> start|stop|restart|status` command dispatch, and
 * `session_shutdown` teardown.
 */
export function createDaemonClient<TConnectData = void>(
  pi: ExtensionAPI,
  adapter: DaemonClientAdapter<TConnectData>,
): DaemonClient {
  const debugLog = (msg: string) => adapter.log.debug(msg);
  const reconnectDelayMs = adapter.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const heartbeatDeadReconnectDelayMs =
    adapter.heartbeatDeadReconnectDelayMs ?? DEFAULT_HEARTBEAT_DEAD_RECONNECT_DELAY_MS;
  const reconnectPollIntervalMs = adapter.reconnectPollIntervalMs ?? DEFAULT_RECONNECT_POLL_INTERVAL_MS;
  const restartWaitMs = adapter.restartWaitMs ?? DEFAULT_RESTART_WAIT_MS;
  const createWs = adapter.createWebSocket ?? defaultCreateWebSocket;
  const probeHealth = adapter.probeHealth ?? checkHealth;
  const waitReady = adapter.waitReady ?? waitForDaemon;
  const sleep = adapter.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let activeSocket: any = null;
  let ws: any = null;
  let connected = false;
  let connecting = false;
  let shuttingDown = false;
  let connectGen = 0;
  let lastCtx: any = null;
  let cleanupHeartbeat: (() => void) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function clearHeartbeat(): void {
    if (cleanupHeartbeat) {
      cleanupHeartbeat();
      cleanupHeartbeat = null;
    }
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(delayMs: number): void {
    if (shuttingDown) return;
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (lastCtx && !shuttingDown) void connect(lastCtx);
    }, delayMs);
    if (typeof (reconnectTimer as any).unref === "function") (reconnectTimer as any).unref();
  }

  /** Intentionally drop any active/pending socket and invalidate in-flight connect attempts. */
  function disconnect(): void {
    connectGen++;
    clearReconnectTimer();
    clearHeartbeat();
    const prev = activeSocket;
    activeSocket = null;
    ws = null;
    connected = false;
    connecting = false;
    if (prev) {
      try { prev.close(); } catch {}
    }
  }

  function send(payload: string | object): boolean {
    if (!ws || !connected) return false;
    try {
      const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
      ws.send(raw);
      return true;
    } catch (e: any) {
      adapter.log.debug("ws_send_error", { error: e?.message ?? String(e) });
      return false;
    }
  }

  async function connect(ctx: any): Promise<void> {
    if (connected || connecting || shuttingDown) return;
    if (!isLiveExtensionCtx(ctx)) {
      adapter.log.debug("connect() skipped — stale ctx");
      return;
    }
    adapter.log.debug(
      `connect() called, connected=${connected}, connecting=${connecting}, shuttingDown=${shuttingDown}`,
    );
    connecting = true;
    lastCtx = ctx;
    const myGen = ++connectGen;

    try {
      const ensured = await adapter.ensureRunning(ctx);
      if (shuttingDown || myGen !== connectGen || !isLiveExtensionCtx(ctx)) {
        if (myGen === connectGen) connecting = false;
        return;
      }
      if (ensured.port === null) {
        connecting = false;
        if (ensured.retryAfterMs !== undefined && !shuttingDown) {
          scheduleReconnect(ensured.retryAfterMs);
        }
        return;
      }
      const port = ensured.port;

      let connectData: TConnectData | undefined;
      if (adapter.beforeOpen) {
        const prep = await adapter.beforeOpen(ctx, port);
        if (prep?.abort || shuttingDown || myGen !== connectGen || !isLiveExtensionCtx(ctx)) {
          if (myGen === connectGen) connecting = false;
          return;
        }
        connectData = prep?.data;
      }

      adapter.log.debug(`connecting WebSocket to port ${port}...`);
      const wsClient = createWs(`ws://127.0.0.1:${port}/ws/pi`);
      activeSocket = wsClient;

      wsClient.on("open", () => {
        if (shuttingDown || activeSocket !== wsClient) {
          try { wsClient.close(); } catch {}
          return;
        }
        adapter.log.debug("WebSocket connected");
        ws = wsClient;
        connected = true;
        connecting = false;

        try {
          adapter.onOpen(wsClient, ctx, port, connectData);
        } catch (err: any) {
          adapter.log.debug(`onOpen error (likely stale ctx): ${err?.message ?? err}`);
        }

        clearHeartbeat();
        cleanupHeartbeat = setupHeartbeat({
          ws: wsClient,
          intervalMs: adapter.heartbeatIntervalMs,
          log: debugLog,
          onDead: () => {
            if (activeSocket !== wsClient) return;
            activeSocket = null;
            ws = null;
            connected = false;
            connecting = false;
            clearHeartbeat();
            adapter.onDisconnect?.();
            if (!shuttingDown) {
              scheduleReconnect(heartbeatDeadReconnectDelayMs);
            }
          },
        });
      });

      wsClient.on("message", (data: Buffer) => {
        try {
          const result = adapter.onMessage(data, wsClient);
          if (result && typeof (result as Promise<void>).catch === "function") {
            (result as Promise<void>).catch((e: any) => {
              adapter.log.debug(`message handler error: ${e?.message ?? e}`);
            });
          }
        } catch (e: any) {
          adapter.log.debug(`message handler error: ${e?.message ?? e}`);
        }
      });

      wsClient.on("close", (code?: number, reason?: Buffer) => {
        adapter.log.debug(
          `WebSocket closed: code=${code ?? "none"} reason=${reason?.toString() || "none"}`,
        );
        if (activeSocket !== wsClient) return;
        activeSocket = null;
        ws = null;
        connected = false;
        connecting = false;
        clearHeartbeat();
        adapter.onDisconnect?.();
        if (!shuttingDown) {
          scheduleReconnect(reconnectDelayMs);
        }
      });

      wsClient.on("error", (e: Error) => {
        adapter.log.debug(`WebSocket error: ${e?.message ?? e}`);
      });
    } catch (e: any) {
      adapter.log.debug(`connect error: ${e?.message ?? e}`);
      if (myGen === connectGen) {
        activeSocket = null;
        connecting = false;
      }
    }
  }

  async function handleCommand(args: string, ctx: any): Promise<void> {
    if (adapter.beforeCommand?.(args, ctx) === false) return;

    const cmd = (args || "").trim().toLowerCase();
    const hint = adapter.startFailureHint ?? "";

    if (cmd === "stop") {
      disconnect();
      await adapter.stopDaemon(ctx);
      if (ctx?.hasUI) {
        ctx.ui.setStatus(adapter.statusKey, undefined);
        ctx.ui.notify(`${adapter.name} server stopped`, "info");
      }
      return;
    }

    if (cmd === "start") {
      const livePort = await adapter.findRunningPort(ctx);
      if (livePort !== null) {
        adapter.onCommandReady?.(livePort);
        if (ctx?.hasUI) ctx.ui.notify(`${adapter.name} already running at http://localhost:${livePort}`, "info");
        if (!connected) void connect(ctx);
        return;
      }
      const port = await adapter.spawnForCommand(ctx, "start", null);
      if (ctx?.hasUI) ctx.ui.notify(`Starting ${adapter.name} server...`, "info");
      if (await waitReady(port, adapter.getStartupTimeoutSeconds(ctx), debugLog)) {
        adapter.onCommandReady?.(port);
        void connect(ctx);
        if (ctx?.hasUI) ctx.ui.notify(`${adapter.name} started at http://localhost:${port}`, "info");
      } else {
        if (ctx?.hasUI) ctx.ui.notify(`${adapter.name} failed to start${hint}`, "warning");
      }
      return;
    }

    if (cmd === "restart") {
      disconnect();
      const preferredPort = adapter.prepareRestart?.(ctx) ?? null;
      await adapter.stopDaemon(ctx);
      await sleep(restartWaitMs);
      const port = await adapter.spawnForCommand(ctx, "restart", preferredPort);
      if (ctx?.hasUI) ctx.ui.notify(`Restarting ${adapter.name} server...`, "info");
      if (await waitReady(port, adapter.getStartupTimeoutSeconds(ctx), debugLog)) {
        adapter.onCommandReady?.(port);
        void connect(ctx);
        if (ctx?.hasUI) ctx.ui.notify(`${adapter.name} restarted at http://localhost:${port}`, "info");
      } else {
        if (ctx?.hasUI) ctx.ui.notify(`${adapter.name} failed to restart${hint}`, "warning");
      }
      return;
    }

    if (cmd === "status" || cmd === "" || !adapter.strictCommandUsage) {
      const statusPort = adapter.getStatusPort(ctx);
      const running = statusPort ? await probeHealth(statusPort) : false;
      let msg = `Server: ${running ? "running" : "stopped"}\nPort: ${statusPort || "(none)"}\n`;
      msg += `Extension: ${connected ? "connected" : "disconnected"}`;
      if (statusPort) msg += `\nURL: http://localhost:${statusPort}`;
      if (ctx?.hasUI) ctx.ui.notify(msg, "info");
      return;
    }

    if (ctx?.hasUI) ctx.ui.notify(`Usage: /${adapter.name} start|stop|restart|status`, "info");
  }

  registerDaemonCommand(pi, adapter.name, true, adapter.settingKey, handleCommand);

  // Reconnect fallback on tool_result (/reload recovery)
  pi.on("tool_result", (_event, ctx) => {
    if (!connected && !shuttingDown && isLiveExtensionCtx(ctx) && ctx.mode === "tui") {
      void connect(ctx);
    }
  });

  // Periodic reconnect poller
  const reconnectPoller = setInterval(() => {
    if (connected || connecting || shuttingDown) return;
    if (!isLiveExtensionCtx(lastCtx)) {
      if (lastCtx) {
        adapter.log.debug("reconnect poller skipped — stale ctx");
        lastCtx = null;
      }
      return;
    }
    if (lastCtx.mode === "tui") void connect(lastCtx);
  }, reconnectPollIntervalMs);
  if (typeof reconnectPoller.unref === "function") reconnectPoller.unref();

  function shutdown(event?: any): void {
    if (shuttingDown) return;
    try {
      adapter.onBeforeShutdown?.(event, ws, connected);
    } catch (e: any) {
      adapter.log.debug("onBeforeShutdown error", { error: e?.message ?? String(e) });
    }
    shuttingDown = true;
    clearInterval(reconnectPoller);
    disconnect();
  }

  pi.on("session_shutdown", (event) => { shutdown(event); });

  return {
    get ws() { return ws; },
    get connected() { return connected; },
    get connecting() { return connecting; },
    get shuttingDown() { return shuttingDown; },
    get lastCtx() { return lastCtx; },
    setLastCtx(ctx: any) { lastCtx = ctx; },
    send,
    connect,
    handleCommand,
    shutdown,
  };
}
