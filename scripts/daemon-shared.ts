/**
 * Shared daemon server infrastructure — HTTP setup, WebSocket lifecycle,
 * browser broadcast, ping intervals, and server bootstrap.
 * Used by both pidash-server.ts and pidiff-server.ts.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { serveUi } from "./serve-ui.ts";

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
  /** Called when a pi session WebSocket sends a message */
  onPiMessage: (ws: any, parsed: any, getPiClient: () => any, setPiClient: (c: any) => void) => void;
  /** Called when a pi session WebSocket closes */
  onPiClose: (piClient: any) => void;
  /** Called when a pi session WebSocket errors */
  onPiError?: (piClient: any) => void;
  /** Called when a browser WebSocket connects (after adding to set) */
  onBrowserConnect?: (ws: any) => void;
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
  } = opts;

  const piClients = new Map<string, any>();
  const browserClients = new Set<any>();
  const browserWatchMap = new WeakMap<any, any>();

  // ── HTTP Server ─────────────────────────────────────────────────

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    const origin = req.headers.origin || "";
    const allowedOrigin = (origin.match(originPattern) ? origin : `http://localhost:${port}`);
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (url.pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", port, sessions: piClients.size, browsers: browserClients.size, uptime: process.uptime() }));
      return;
    }

    if (url.pathname === "/api/sessions") {
      const sessions = Array.from(piClients.values()).map((c: any) => c.session);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(sessions));
      return;
    }

    if (extraApiRoutes && extraApiRoutes(url, req, res)) return;

    serveUi(url.pathname, res, { uiDir, name: uiName, log });
  });

  // ── Pi WebSocket ────────────────────────────────────────────────

  const piWss = new WebSocket.Server({ noServer: true });
  piWss.on("connection", (ws: any) => {
    let piClient: any = null;

    ws.on("message", (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString());
        onPiMessage(
          ws, parsed,
          () => piClient,
          (c: any) => { piClient = c; },
        );
      } catch (e: any) { log(`pi message error: ${e.message}`); }
    });

    ws.on("close", () => { if (piClient) onPiClose(piClient); });
    ws.on("error", () => { if (piClient) (onPiError || onPiClose)(piClient); });
  });

  // ── Browser WebSocket ───────────────────────────────────────────

  const browserWss = new WebSocket.Server({ noServer: true });
  browserWss.on("connection", (ws: any) => {
    browserClients.add(ws);
    log(`browser connected (total: ${browserClients.size})`);
    if (onBrowserConnect) onBrowserConnect(ws);

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

  // ── Broadcast helper ───────────────────────────────────────────

  function broadcastToBrowsers(event: object) {
    const data = JSON.stringify(event);
    for (const browser of browserClients) {
      try { browser.send(data); } catch { browserClients.delete(browser); }
    }
  }

  // ── Start ─────────────────────────────────────────────────────

  function start() {
    server.listen(port, listenAddress, () => {
      log(`listening on http://${listenAddress}:${port}`);
    });

    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        log(`port ${port} already in use — daemon likely already running`);
        process.exit(0);
      }
      log(`server error: ${err.message}`);
      process.exit(1);
    });

    process.on("SIGHUP", () => {});
    process.on("SIGTERM", () => { server.close(); process.exit(0); });
    process.on("SIGINT", () => { server.close(); process.exit(0); });
  }

  return { server, piClients, browserClients, browserWatchMap, broadcastToBrowsers, piWss, browserWss, start };
}
