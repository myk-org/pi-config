/**
 * Shared daemon client & lifecycle manager — reusable infrastructure for spawning,
 * health-checking, connecting to, keeping alive, reconnecting, shutting down, and
 * managing `/start|stop|restart|status` commands for long-lived server daemons
 * (pidash, pidiff).
 *
 * Absorbs WebSocket heartbeat/reconnect wiring (formerly `ws-client.ts`) and
 * daemon spawn/health-probe orchestration behind `createDaemonClient`, keeping
 * `pidash.ts` and `pidiff.ts` as thin adapters.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger, type Logger } from "./logger.js";
import { TOOL_NAMESPACES } from "./tool-namespaces.js";
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

export function checkHealth(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: host, port, path: "/api/health", timeout: HEALTH_CHECK_TIMEOUT_MS },
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

export type DaemonAction = "status" | "start" | "stop" | "restart";

export interface DaemonActionResult {
  ok: boolean;
  text: string;
  port?: number | null;
  running?: boolean;
  connected?: boolean;
  disabled?: boolean;
  abortedByGuard?: boolean;
}

export type DaemonActionExecutor = (
  action: DaemonAction,
  ctx: any,
  opts?: { notifyProgress?: boolean },
) => Promise<DaemonActionResult>;

const DAEMON_REGISTER_EVENT = "daemon:register-handler";
const DAEMON_REQUEST_EVENT = "daemon:request-handlers";

const localDaemonHandlers = new WeakMap<ExtensionAPI, Map<string, DaemonActionExecutor>>();

function recordLocalDaemonHandler(pi: ExtensionAPI, name: string, executor: DaemonActionExecutor): void {
  let map = localDaemonHandlers.get(pi);
  if (!map) {
    map = new Map<string, DaemonActionExecutor>();
    localDaemonHandlers.set(pi, map);
  }
  map.set(name, executor);
}

/** Register `/<name> start|stop|restart|status` for a daemon extension (enabled or disabled)
 *  and publish its action executor for the `daemon_manage` LLM tool. */
export function registerDaemonCommand(
  pi: ExtensionAPI,
  name: string,
  enabled: boolean,
  settingKey: string,
  handler?: (args: string, ctx: any) => Promise<void> | void,
  actionExecutor?: DaemonActionExecutor,
): void {
  const envKey = `PI_${settingKey.toUpperCase()}`;
  const disabledMessage = `${name} is disabled (${settingKey}=false in pi-config-settings.json or ${envKey}=false).`;

  const resolvedExecutor: DaemonActionExecutor = enabled && actionExecutor
    ? actionExecutor
    : async () => ({ ok: false, disabled: true, text: disabledMessage });

  recordLocalDaemonHandler(pi, name, resolvedExecutor);
  const publishHandler = () => {
    try {
      pi.events?.emit?.(DAEMON_REGISTER_EVENT, { name, execute: resolvedExecutor });
    } catch (e: any) {
      log.debug("daemon_handler_emit_failed", { name, error: e?.message ?? String(e) });
    }
  };
  publishHandler();
  try {
    pi.events?.on?.(DAEMON_REQUEST_EVENT, publishHandler);
  } catch (e: any) {
    log.debug("daemon_handler_subscribe_failed", { name, error: e?.message ?? String(e) });
  }

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
            ctx.ui.notify(disabledMessage, "info");
          }
        },
  });
}

/** Register the `daemon_manage` LLM tool wired to all registered daemon extensions (pidash, pidiff). */
export function registerDaemonManageTool(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  const busHandlers = new Map<string, DaemonActionExecutor>();
  try {
    pi.events?.on?.(DAEMON_REGISTER_EVENT, (data: unknown) => {
      const payload = data as { name?: unknown; execute?: unknown } | null;
      if (typeof payload?.name === "string" && typeof payload?.execute === "function") {
        busHandlers.set(payload.name, payload.execute as DaemonActionExecutor);
        log.debug("daemon_manage_handler_registered", { name: payload.name });
      }
    });
    pi.events?.emit?.(DAEMON_REQUEST_EVENT, undefined);
  } catch (e: any) {
    log.debug("daemon_manage_bus_init_failed", { error: e?.message ?? String(e) });
  }

  pi.registerTool({
    name: "daemon_manage",
    label: "Daemon Manage",
    exposure: "codemode",
    namespace: TOOL_NAMESPACES.runtime,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description:
      "Inspect or control local pi-config background daemons (pidash web dashboard or pidiff diff viewer): status, start, stop, or restart (equivalent to /pidash and /pidiff).",
    parameters: Type.Object({
      name: Type.Union([Type.Literal("pidash"), Type.Literal("pidiff")], {
        description: "Daemon name: 'pidash' (web dashboard) or 'pidiff' (diff viewer).",
      }),
      action: Type.Union(
        [Type.Literal("status"), Type.Literal("start"), Type.Literal("stop"), Type.Literal("restart")],
        { description: "Operation to perform on the daemon." },
      ),
    }),
    async execute(_callId, params, _signal, _onUpdate, ctx) {
      let executor = busHandlers.get(params.name) ?? localDaemonHandlers.get(pi)?.get(params.name);
      if (!executor) {
        try { pi.events?.emit?.(DAEMON_REQUEST_EVENT, undefined); } catch {}
        executor = busHandlers.get(params.name) ?? localDaemonHandlers.get(pi)?.get(params.name);
      }
      if (!executor) {
        log.warn("daemon_manage_unregistered", { name: params.name, action: params.action });
        return {
          content: [{ type: "text" as const, text: `Daemon "${params.name}" is not loaded in this session.` }],
          details: { ok: false, name: params.name, action: params.action },
        };
      }
      const res = await executor(params.action, ctx, { notifyProgress: false });
      log.info("daemon_manage_executed", {
        name: params.name,
        action: params.action,
        ok: res.ok,
        disabled: Boolean(res.disabled),
      });
      return {
        content: [{ type: "text" as const, text: res.text }],
        details: { name: params.name, action: params.action, ...res },
      };
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

export type SpawnLockResult =
  | { acquired: true; release: () => void }
  | { acquired: false; port?: number | null; retryAfterMs?: number };

export interface SpawnContext {
  mode: "connect" | "start" | "restart";
  preferredPort?: number | null;
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

  /**
   * Fixed daemon port (e.g. pidash). When provided, `createDaemonClient` uses it
   * for default health probing and `/<name> status` unless overridden by
   * `findRunningPort` / `getStatusPort`.
   */
  port?: number;
  /** Daemon host for HTTP health probes and WebSocket connections (default: `"127.0.0.1"`). */
  host?: string;
  /** Optional readiness guard before `connect()` runs (e.g. pidiff requires `lockDir`). */
  canConnect?: (ctx: any) => boolean;
  /**
   * Predicate deciding whether `ctx` is eligible for automatic daemon connection
   * (`tool_result` reconnect fallback and periodic `reconnectPoller`).
   * Defaults to `ctx?.mode === "tui"`.
   */
  shouldConnectCtx?: (ctx: any) => boolean;
  /**
   * Predicate deciding whether `connect()` may auto-spawn the daemon when it is
   * not already running. Defaults to `() => true`.
   */
  shouldAutoSpawn?: (ctx: any) => boolean;
  /** Probe for an already-running daemon port. Defaults to probing `adapter.port`. */
  findRunningPort?: (ctx: any) => Promise<number | null>;
  /** Port to probe and display for `/<name> status`. Defaults to `adapter.port ?? null`. */
  getStatusPort?: (ctx: any) => number | null;
  /**
   * Optional cross-process spawn lock acquired during auto-spawn in `connect()`.
   * Return `{ acquired: true, release }` to proceed with spawning, or
   * `{ acquired: false, port, retryAfterMs }` when another session holds the lock.
   */
  acquireSpawnLock?: (ctx: any) => Promise<SpawnLockResult>;
  /** Spawn the daemon process and return the port to wait on. */
  spawn: (ctx: any, opts: SpawnContext) => Promise<number> | number;
  /** Optional hook invoked whenever a live daemon port is resolved (connect/start/restart). */
  onPortResolved?: (port: number) => void;
  /** Startup health-check wait budget in seconds. */
  getStartupTimeoutSeconds: (ctx: any) => number;

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
  /** True while this client is spawning and waiting on the daemon. */
  readonly spawning: boolean;
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
  /** Drop any active/in-flight WebSocket and cancel pending reconnect timers (for rebinding). */
  disconnect: () => void;
  /** Handle `/<name> start|stop|restart|status` (already registered on `pi`). */
  handleCommand: (args: string, ctx: any) => Promise<void>;
  /** Programmatically execute a daemon action (shared by `/<name>` and `daemon_manage`). */
  executeAction: DaemonActionExecutor;
  /** Permanently tear down timers, heartbeat, reconnect poller, and WebSocket. */
  shutdown: (event?: any) => void;
}

/**
 * Create a managed daemon client for a pi extension.
 *
 * Owns daemon health probing, spawn/wait deduplication, WebSocket connection state,
 * ping/pong heartbeat, `tool_result` + periodic reconnect, `/<name> start|stop|restart|status`
 * command dispatch, and `session_shutdown` teardown.
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
  const daemonHost = (adapter.host || "").trim() || "127.0.0.1";
  const createWs = adapter.createWebSocket ?? defaultCreateWebSocket;
  const probeHealth = adapter.probeHealth ?? ((port: number) => checkHealth(port, daemonHost));
  const waitReady = adapter.waitReady ?? ((port, maxWaitSeconds, onLog) => waitForDaemon(port, maxWaitSeconds, onLog, probeHealth));
  const sleep = adapter.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const shouldConnectCtx = adapter.shouldConnectCtx ?? ((ctx: any) => ctx?.mode === "tui");
  const shouldAutoSpawn = adapter.shouldAutoSpawn ?? (() => true);

  let activeSocket: any = null;
  let ws: any = null;
  let connected = false;
  let connecting = false;
  let spawning = false;
  let inFlightSpawn: Promise<number | null> | null = null;
  let shuttingDown = false;
  let connectGen = 0;
  let lastCtx: any = null;
  let pendingConnectCtx: any = null;
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
    pendingConnectCtx = null;
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

  async function findRunningPort(ctx: any): Promise<number | null> {
    if (adapter.findRunningPort) return adapter.findRunningPort(ctx);
    if (adapter.port === undefined) return null;
    return (await probeHealth(adapter.port)) ? adapter.port : null;
  }

  function getStatusPort(ctx: any): number | null {
    if (adapter.getStatusPort) return adapter.getStatusPort(ctx);
    return adapter.port ?? null;
  }

  /**
   * Ensure the daemon is running: probe health, deduplicate concurrent in-process spawns,
   * acquire any cross-process spawn lock, spawn, and wait for `/api/health`.
   */
  async function ensureDaemonRunning(ctx: any): Promise<{ port: number | null; retryAfterMs?: number }> {
    if (adapter.canConnect && !adapter.canConnect(ctx)) {
      adapter.log.debug("connect skipped — adapter precondition not ready");
      return { port: null };
    }

    const livePort = await findRunningPort(ctx);
    adapter.log.debug(`daemon health probe: ${livePort !== null ? `running on ${livePort}` : "not running"}`);
    if (livePort !== null) {
      adapter.onPortResolved?.(livePort);
      return { port: livePort };
    }

    if (!shouldAutoSpawn(ctx)) {
      adapter.log.debug("auto-spawn skipped — adapter declined spawn for ctx", { mode: ctx?.mode });
      return { port: null };
    }

    if (inFlightSpawn) {
      adapter.log.debug("daemon already spawning, awaiting in-flight startup...");
      const port = await inFlightSpawn;
      return { port };
    }

    let lock: SpawnLockResult = { acquired: true, release: () => {} };
    if (adapter.acquireSpawnLock) {
      lock = await adapter.acquireSpawnLock(ctx);
      if (!lock.acquired) {
        if (lock.port) adapter.onPortResolved?.(lock.port);
        return { port: lock.port ?? null, retryAfterMs: lock.retryAfterMs };
      }
    }

    const spawnPromise = (async (): Promise<number | null> => {
      spawning = true;
      try {
        adapter.log.debug("spawning daemon...");
        const port = await adapter.spawn(ctx, { mode: "connect" });
        const ready = await waitReady(port, adapter.getStartupTimeoutSeconds(ctx), debugLog);
        if (!ready) return null;
        adapter.onPortResolved?.(port);
        return port;
      } finally {
        spawning = false;
        inFlightSpawn = null;
        lock.release();
      }
    })();

    inFlightSpawn = spawnPromise;
    const port = await spawnPromise;
    return { port };
  }

  function finishAbortedConnect(abortedCtx: any, myGen: number): boolean {
    if (myGen !== connectGen) return false;
    connecting = false;
    const nextCtx = pendingConnectCtx;
    pendingConnectCtx = null;
    if (nextCtx && nextCtx !== abortedCtx && !shuttingDown && !connected && isLiveExtensionCtx(nextCtx)) {
      adapter.log.debug("retrying connect with newer session ctx");
      void connect(nextCtx);
      return true;
    }
    return false;
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

  async function connect(ctx: any, knownReadyPort?: number): Promise<void> {
    if (connected || shuttingDown) return;
    if (!isLiveExtensionCtx(ctx)) {
      adapter.log.debug("connect() skipped — stale ctx");
      return;
    }
    lastCtx = ctx;
    if (connecting) {
      // Remember the newest live ctx so if the in-flight connect aborts (e.g. old ctx
      // became stale on session switch during daemon startup), we retry immediately
      // instead of waiting for the 15s reconnect poller.
      pendingConnectCtx = ctx;
      adapter.log.debug("connect() queued newer ctx while connect in flight");
      return;
    }
    adapter.log.debug(
      `connect() called, connected=${connected}, connecting=${connecting}, shuttingDown=${shuttingDown}`,
    );
    connecting = true;
    pendingConnectCtx = null;
    const myGen = ++connectGen;

    try {
      const ensured = knownReadyPort !== undefined
        ? { port: knownReadyPort }
        : await ensureDaemonRunning(ctx);
      if (shuttingDown || myGen !== connectGen || !isLiveExtensionCtx(ctx)) {
        finishAbortedConnect(ctx, myGen);
        return;
      }
      if (ensured.port === null) {
        const retried = finishAbortedConnect(ctx, myGen);
        if (!retried && ensured.retryAfterMs !== undefined && !shuttingDown) {
          if (!isLiveExtensionCtx(lastCtx) && isLiveExtensionCtx(ctx)) lastCtx = ctx;
          scheduleReconnect(ensured.retryAfterMs);
        }
        return;
      }
      const port = ensured.port;

      let connectData: TConnectData | undefined;
      if (adapter.beforeOpen) {
        const prep = await adapter.beforeOpen(ctx, port);
        if (prep?.abort || shuttingDown || myGen !== connectGen || !isLiveExtensionCtx(ctx)) {
          finishAbortedConnect(ctx, myGen);
          return;
        }
        connectData = prep?.data;
      }

      // If a newer session ctx arrived during startup/prep, switch to it right away
      // instead of opening a socket registered to the superseded ctx.
      if (pendingConnectCtx && pendingConnectCtx !== ctx && isLiveExtensionCtx(pendingConnectCtx)) {
        finishAbortedConnect(ctx, myGen);
        return;
      }

      adapter.log.debug(`connecting WebSocket to ${daemonHost}:${port}...`);
      const wsClient = createWs(`ws://${daemonHost}:${port}/ws/pi`);
      activeSocket = wsClient;

      wsClient.on("open", () => {
        if (shuttingDown || activeSocket !== wsClient) {
          try { wsClient.close(); } catch {}
          return;
        }
        const supersededByNewCtx =
          Boolean(pendingConnectCtx && pendingConnectCtx !== ctx && isLiveExtensionCtx(pendingConnectCtx));
        if (supersededByNewCtx || !isLiveExtensionCtx(ctx)) {
          adapter.log.debug("WebSocket opened for superseded or stale ctx — closing and retrying");
          activeSocket = null;
          try { wsClient.close(); } catch {}
          finishAbortedConnect(ctx, myGen);
          return;
        }
        adapter.log.debug("WebSocket connected");
        ws = wsClient;
        connected = true;
        connecting = false;
        pendingConnectCtx = null;

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
        clearHeartbeat();
        adapter.onDisconnect?.();
        const retried = finishAbortedConnect(ctx, myGen);
        if (!retried && !shuttingDown) {
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
        finishAbortedConnect(ctx, myGen);
      }
    }
  }

  async function executeAction(
    action: DaemonAction,
    ctx: any,
    opts?: { notifyProgress?: boolean },
  ): Promise<DaemonActionResult> {
    if (adapter.beforeCommand?.(action, ctx) === false) {
      return {
        ok: false,
        abortedByGuard: true,
        text: `${adapter.name} is unavailable in the current mode.`,
      };
    }

    const hint = adapter.startFailureHint ?? "";
    const notifyProgress = opts?.notifyProgress === true;

    if (action === "stop") {
      disconnect();
      await adapter.stopDaemon(ctx);
      if (ctx?.hasUI) {
        ctx.ui.setStatus(adapter.statusKey, undefined);
      }
      return { ok: true, running: false, connected: false, text: `${adapter.name} server stopped` };
    }

    if (action === "start") {
      const livePort = await findRunningPort(ctx);
      if (livePort !== null) {
        adapter.onPortResolved?.(livePort);
        if (!connected) void connect(ctx, livePort);
        return {
          ok: true,
          port: livePort,
          running: true,
          connected,
          text: `${adapter.name} already running at http://localhost:${livePort}`,
        };
      }
      const port = await adapter.spawn(ctx, { mode: "start", preferredPort: null });
      if (notifyProgress && ctx?.hasUI) ctx.ui.notify(`Starting ${adapter.name} server...`, "info");
      if (await waitReady(port, adapter.getStartupTimeoutSeconds(ctx), debugLog)) {
        adapter.onPortResolved?.(port);
        void connect(ctx, port);
        return {
          ok: true,
          port,
          running: true,
          connected,
          text: `${adapter.name} started at http://localhost:${port}`,
        };
      }
      return {
        ok: false,
        port,
        running: false,
        connected,
        text: `${adapter.name} failed to start${hint}`,
      };
    }

    if (action === "restart") {
      disconnect();
      const preferredPort = adapter.prepareRestart?.(ctx) ?? null;
      await adapter.stopDaemon(ctx);
      await sleep(restartWaitMs);
      const port = await adapter.spawn(ctx, { mode: "restart", preferredPort });
      if (notifyProgress && ctx?.hasUI) ctx.ui.notify(`Restarting ${adapter.name} server...`, "info");
      if (await waitReady(port, adapter.getStartupTimeoutSeconds(ctx), debugLog)) {
        adapter.onPortResolved?.(port);
        void connect(ctx, port);
        return {
          ok: true,
          port,
          running: true,
          connected,
          text: `${adapter.name} restarted at http://localhost:${port}`,
        };
      }
      return {
        ok: false,
        port,
        running: false,
        connected,
        text: `${adapter.name} failed to restart${hint}`,
      };
    }

    const statusPort = getStatusPort(ctx);
    const running = statusPort ? await probeHealth(statusPort) : false;
    let msg = `Server: ${running ? "running" : "stopped"}\nPort: ${statusPort || "(none)"}\n`;
    msg += `Extension: ${connected ? "connected" : "disconnected"}`;
    if (statusPort) msg += `\nURL: http://localhost:${statusPort}`;
    return { ok: true, port: statusPort, running, connected, text: msg };
  }

  async function handleCommand(args: string, ctx: any): Promise<void> {
    const cmd = (args || "").trim().toLowerCase();
    const validActions: DaemonAction[] = ["stop", "start", "restart", "status"];
    let action: DaemonAction | null = null;
    if (validActions.includes(cmd as DaemonAction)) {
      action = cmd as DaemonAction;
    } else if (cmd === "" || !adapter.strictCommandUsage) {
      action = "status";
    }

    if (!action) {
      if (adapter.beforeCommand?.(args, ctx) === false) return;
      if (ctx?.hasUI) ctx.ui.notify(`Usage: /${adapter.name} start|stop|restart|status`, "info");
      return;
    }

    const res = await executeAction(action, ctx, { notifyProgress: true });
    if (res.abortedByGuard) return;
    if (ctx?.hasUI) {
      ctx.ui.notify(res.text, res.ok ? "info" : "warning");
    }
  }

  registerDaemonCommand(pi, adapter.name, true, adapter.settingKey, handleCommand, executeAction);

  // Reconnect fallback on tool_result (/reload recovery)
  pi.on("tool_result", (_event, ctx) => {
    if (!connected && !shuttingDown && isLiveExtensionCtx(ctx) && shouldConnectCtx(ctx)) {
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
    if (shouldConnectCtx(lastCtx)) void connect(lastCtx);
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
    get spawning() { return spawning; },
    get shuttingDown() { return shuttingDown; },
    get lastCtx() { return lastCtx; },
    setLastCtx(ctx: any) { lastCtx = ctx; },
    send,
    connect,
    disconnect,
    handleCommand,
    executeAction,
    shutdown,
  };
}
