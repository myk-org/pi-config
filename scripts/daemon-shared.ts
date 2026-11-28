/**
 * Shared daemon server infrastructure — HTTP setup, WebSocket lifecycle,
 * browser broadcast, ping intervals, and server bootstrap.
 * Used by both pidash-server.ts and pidiff-server.ts.
 */

import * as fs from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../extensions/shared/logger.ts";
import { serveUi } from "./serve-ui.ts";

const daemonLog = createLogger("daemon-shared");

export interface AsyncDebugLogWriterOptions {
  /** Minimum delay before attempting to reopen after a stream error (default: 5000ms). */
  reopenBackoffMs?: number;
  /** Injectable stream factory for testing. */
  createStream?: (logPath: string) => fs.WriteStream;
  /** Injectable clock for testing. */
  now?: () => number;
}

export interface AsyncDebugLogWriter {
  write: (line: string) => void;
  flush: (timeoutMs?: number) => Promise<void>;
  /** Exposed for observability and tests. */
  readonly droppedCount: number;
}

/**
 * Bounded, self-recovering, flushable asynchronous debug file writer.
 *
 * - Bounded memory: when `stream.write()` signals backpressure (`false`), drops
 *   subsequent lines and records a count until `drain`, emitting a single
 *   summary line once drained.
 * - Error recovery: on a stream error, destroys the broken stream and retries
 *   opening after `reopenBackoffMs` on a later `write()` call.
 * - Graceful shutdown: `flush()` ends the stream and resolves when finished or
 *   when `timeoutMs` elapses.
 */
export function createAsyncDebugLogWriter(
  logPath: string,
  onWarn: (msg: string, err?: unknown) => void,
  opts: AsyncDebugLogWriterOptions = {},
): AsyncDebugLogWriter {
  const reopenBackoffMs = opts.reopenBackoffMs ?? 5000;
  const now = opts.now ?? Date.now;
  const makeStream = opts.createStream ?? ((p: string) => fs.createWriteStream(p, { flags: "a" }));

  let stream: fs.WriteStream | null = null;
  let backpressured = false;
  let droppedCount = 0;
  let nextReopenAt = 0;
  let closing = false;

  function openStream(): fs.WriteStream | null {
    if (closing) return null;
    if (stream && !stream.destroyed) return stream;
    if (now() < nextReopenAt) return null;
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      const created = makeStream(logPath);
      stream = created;
      backpressured = false;
      created.on("error", (error) => {
        onWarn("debug log stream error", error);
        if (stream === created) {
          stream = null;
          backpressured = false;
          nextReopenAt = now() + reopenBackoffMs;
        }
        try { created.destroy(); } catch {}
      });
      return created;
    } catch (error) {
      onWarn("could not open debug log stream", error);
      stream = null;
      backpressured = false;
      nextReopenAt = now() + reopenBackoffMs;
      return null;
    }
  }

  function armDrain(target: fs.WriteStream): void {
    backpressured = true;
    target.once("drain", () => {
      if (stream !== target) return;
      backpressured = false;
      if (droppedCount > 0 && !closing && !target.destroyed) {
        const count = droppedCount;
        droppedCount = 0;
        try {
          const ok = target.write(`${new Date(now()).toISOString()} [srv] debug log backpressure: dropped ${count} line(s)\n`);
          if (!ok) armDrain(target);
        } catch (error) {
          onWarn("could not write backpressure summary", error);
        }
      }
    });
  }

  // Eagerly open on startup so early messages write immediately
  openStream();

  return {
    get droppedCount() {
      return droppedCount;
    },
    write(line: string) {
      if (closing) return;
      const target = openStream();
      if (!target) return;
      if (backpressured) {
        droppedCount++;
        return;
      }
      try {
        const ok = target.write(line);
        if (!ok) armDrain(target);
      } catch (error) {
        onWarn("could not write debug log", error);
        stream = null;
        backpressured = false;
        nextReopenAt = now() + reopenBackoffMs;
        try { target.destroy(); } catch {}
      }
    },
    flush(timeoutMs = 1500): Promise<void> {
      closing = true;
      const target = stream;
      stream = null;
      backpressured = false;
      if (!target || target.destroyed || target.writableEnded) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, timeoutMs));
        if (timer.unref) timer.unref();
        target.once("finish", done);
        target.once("close", done);
        target.once("error", done);
        try {
          target.end();
        } catch {
          done();
        }
      });
    },
  };
}

export function resolveUiDir(programPath: string | undefined, moduleUrl: string, ...segments: string[]): string {
  const resolved = path.join(path.dirname(programPath || fileURLToPath(moduleUrl)), ...segments);
  daemonLog.debug("resolved UI directory", { programPath: programPath || "(module URL)", resolved });
  return resolved;
}

const _require = createRequire(import.meta.url);
const WebSocket = _require("ws");

// ── Types ───────────────────────────────────────────────────────────

export interface DaemonServerOptions {
  port: number;
  uiDir: string;
  uiName: string;
  log: (msg: string) => void;
  /** Extra /api/* routes before fallback to serveUi */
  extraApiRoutes?: (url: URL, req: IncomingMessage, res: ServerResponse) => boolean;
  /** Called when a pi session WebSocket sends a message (5th arg is the raw decoded WS text). */
  onPiMessage: (ws: any, parsed: any, getPiClient: () => any, setPiClient: (c: any) => void, raw?: string) => void;
  /** Called when a pi session WebSocket closes */
  onPiClose: (piClient: any, ws: any) => void;
  /** Called when a pi session WebSocket errors */
  onPiError?: (piClient: any, ws: any) => void;
  /** Called when a browser WebSocket connects (after adding to set) */
  onBrowserConnect?: (ws: any, req?: IncomingMessage) => void;
  /** Called when a browser WebSocket sends a message */
  onBrowserMessage?: (ws: any, parsed: any) => void;
  /** Called when a browser sends a "watch" message. Receives the ws, sessionId, and the piClient (if found). Return value is stored in browserWatchMap. */
  onBrowserWatch?: (ws: any, sessionId: string | null, piClient: any | null) => any;
  /** Extra WebSocket upgrade paths beyond /ws/pi and /ws/browser */
  extraUpgrades?: (pathname: string, req: IncomingMessage, socket: any, head: Buffer) => boolean;
  /** Listen address (default "127.0.0.1") */
  listenAddress?: string;
  /** Custom origin validation regex (default: localhost/127.0.0.1 only) */
  originPattern?: RegExp;
  /** Optional async cleanup hook awaited on SIGTERM/SIGINT (bounded by shutdownTimeoutMs). */
  onShutdown?: () => Promise<void> | void;
  /** Max time to wait for onShutdown before exiting on SIGTERM/SIGINT (default: 2000ms). */
  shutdownTimeoutMs?: number;
}

// ── Server factory ──────────────────────────────────────────────────

export function createDaemonServer(opts: DaemonServerOptions) {
  const {
    port, uiDir, uiName, log,
    extraApiRoutes,
    onPiMessage, onPiClose, onPiError,
    onBrowserConnect, onBrowserMessage, onBrowserWatch,
    extraUpgrades,
    listenAddress = "127.0.0.1",
    originPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
    onShutdown,
    shutdownTimeoutMs = 2000,
  } = opts;

  const piClients = new Map<string, any>();
  const browserClients = new Set<any>();
  const browserWatchMap = new WeakMap<any, any>();

  // ── HTTP Server ─────────────────────────────────────────────────

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    // Let daemon-specific API routes run before generic CORS/OPTIONS shortcuts so
    // loopback-only and GET-only endpoints enforce 403/405 on OPTIONS too.
    if (extraApiRoutes && extraApiRoutes(url, req, res)) return;

    const origin = req.headers.origin || "";
    const allowedOrigin = (origin.match(originPattern) ? origin : `http://localhost:${port}`);
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (url.pathname === "/api/health") {
      // A daemon whose startup hook failed is listening but degraded: sessions connect and their
      // questions have no consumer. Report that instead of a flat "ok".
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: startupError ? "degraded" : "ok",
        ...(startupError ? { startupError } : {}),
        port, sessions: piClients.size, browsers: browserClients.size, uptime: process.uptime(),
      }));
      return;
    }

    if (url.pathname === "/api/sessions") {
      const sessions = Array.from(piClients.values()).map((c: any) => c.session);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(sessions));
      return;
    }

    serveUi(url.pathname, res, { uiDir, name: uiName, log });
  });

  // ── Pi WebSocket ────────────────────────────────────────────────

  const piWss = new WebSocket.Server({ noServer: true });
  piWss.on("connection", (ws: any) => {
    let piClient: any = null;

    ws.on("message", (data: Buffer) => {
      try {
        const raw = data.toString();
        const parsed = JSON.parse(raw);
        onPiMessage(
          ws, parsed,
          () => piClient,
          (c: any) => { piClient = c; },
          raw,
        );
      } catch (e: any) { log(`pi message error: ${e.message}`); }
    });

    let cleanedUp = false;
    function cleanup(kind: "close" | "error") {
      if (cleanedUp || !piClient) return;
      cleanedUp = true;
      const c = piClient;
      piClient = null;
      try {
        if (kind === "error" && onPiError) onPiError(c, ws);
      } catch (e: any) { log(`onPiError callback error: ${e.message}`); }
      try {
        onPiClose(c, ws);
      } catch (e: any) { log(`onPiClose callback error: ${e.message}`); }
    }
    ws.on("close", () => cleanup("close"));
    ws.on("error", () => cleanup("error"));
  });

  // ── Browser WebSocket ───────────────────────────────────────────

  const browserWss = new WebSocket.Server({ noServer: true });
  browserWss.on("connection", (ws: any, req?: IncomingMessage) => {
    browserClients.add(ws);
    log(`browser connected (total: ${browserClients.size})`);
    if (onBrowserConnect) onBrowserConnect(ws, req);

    ws.on("message", (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === "watch") {
          const watchId = parsed.sessionId ?? null;
          const client = watchId ? piClients.get(watchId) : null;
          const watchData = onBrowserWatch ? onBrowserWatch(ws, watchId, client) : watchId;
          browserWatchMap.set(ws, watchData);
          log(`browser watching: ${watchId}`);
          return;
        }
        if (onBrowserMessage) onBrowserMessage(ws, parsed);
      } catch (e: any) { log(`browser message error: ${e.message}`); }
    });

    ws.on("close", () => {
      browserClients.delete(ws);
      log(`browser disconnected (total: ${browserClients.size})`);
    });
    ws.on("error", () => browserClients.delete(ws));
  });

  // ── Upgrade routing ─────────────────────────────────────────────

  server.on("upgrade", (req: IncomingMessage, socket: any, head: Buffer) => {
    const origin = req.headers.origin || "";
    if (origin && !origin.match(originPattern)) {
      log(`rejected WebSocket upgrade from origin: ${origin}`);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(req.url || "/", `http://localhost`);
    if (url.pathname === "/ws/pi") {
      piWss.handleUpgrade(req, socket, head, (ws: any) => piWss.emit("connection", ws, req));
    } else if (url.pathname === "/ws/browser") {
      browserWss.handleUpgrade(req, socket, head, (ws: any) => browserWss.emit("connection", ws, req));
    } else if (extraUpgrades && extraUpgrades(url.pathname, req, socket, head)) {
      // handled by caller
    } else {
      socket.destroy();
    }
  });

  // ── Ping interval ──────────────────────────────────────────────

  const pingInterval = setInterval(() => {
    for (const [, client] of piClients) {
      if (client.ws) { try { client.ws.ping(); } catch {} }
    }
  }, 30000);
  if (pingInterval.unref) pingInterval.unref();

  // ── Broadcast helpers ──────────────────────────────────────────

  function broadcastToBrowsers(eventOrRaw: object | string) {
    if (browserClients.size === 0) return;
    const data = typeof eventOrRaw === "string" ? eventOrRaw : JSON.stringify(eventOrRaw);
    for (const browser of browserClients) {
      try { browser.send(data); } catch { browserClients.delete(browser); }
    }
  }

  function sendToMatchingBrowsers(
    predicate: (browser: any, watchData: any) => boolean,
    eventOrRaw: object | string,
  ) {
    let data: string | null = null;
    for (const browser of browserClients) {
      if (!predicate(browser, browserWatchMap.get(browser))) continue;
      if (data === null) {
        data = typeof eventOrRaw === "string" ? eventOrRaw : JSON.stringify(eventOrRaw);
      }
      try { browser.send(data); } catch { browserClients.delete(browser); }
    }
  }

  // ── Start ─────────────────────────────────────────────────────

  /** Set by the caller once listening succeeds; nothing with side effects (a Discord bot, a watcher)
   *  may start before that, or a second daemon that loses the port leaves a duplicate bot running. */
  let onListening: (() => void) | null = null;
  /** Set when a startup hook threw: the daemon answers HTTP but one of its consumers is missing
   *  (a Discord bot, a watcher), so /api/health must not claim to be healthy. */
  let startupError: string | null = null;

  function start(afterListen?: () => void) {
    onListening = afterListen ?? null;
    server.listen(port, listenAddress, () => {
      log(`listening on http://${listenAddress}:${port}`);
      try {
        onListening?.();
      } catch (error: any) {
        startupError = String(error?.message ?? error);
        log(`afterListen failed: ${startupError}`);
      }
    });

    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        log(`port ${port} already in use — daemon likely already running`);
        // `return` matters: relying on exit() to stop execution made a second daemon log a
        // misleading "server error" and report failure when exit was intercepted (tests) or thrown.
        process.exit(0);
        return;
      }
      log(`server error: ${err.message}`);
      process.exit(1);
      return;
    });

    let shuttingDown = false;
    const handleShutdownSignal = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      server.close();
      const finish = () => { process.exit(0); };
      if (!onShutdown) {
        finish();
        return;
      }
      const forceExitTimer = setTimeout(finish, Math.max(0, shutdownTimeoutMs));
      if (forceExitTimer.unref) forceExitTimer.unref();
      Promise.resolve()
        .then(() => onShutdown())
        .catch((error: any) => { daemonLog.warn("onShutdown error", error); })
        .finally(() => {
          clearTimeout(forceExitTimer);
          finish();
        });
    };

    process.on("SIGHUP", () => {});
    process.on("SIGTERM", handleShutdownSignal);
    process.on("SIGINT", handleShutdownSignal);
  }

  return {
    server,
    piClients,
    browserClients,
    browserWatchMap,
    broadcastToBrowsers,
    sendToMatchingBrowsers,
    piWss,
    browserWss,
    getStartupError: () => startupError,
    start,
  };
}
