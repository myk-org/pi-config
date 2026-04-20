#!/usr/bin/env node
/**
 * Pidash server — standalone daemon that aggregates all pi sessions.
 *
 * Spawned automatically by the pidash extension on first pi session start.
 * Listens on a fixed port (default 19190) for:
 * - Pi session WebSocket clients at /ws/pi (extensions forward events here)
 * - Browser WebSocket clients at /ws/browser (viewers watch/interact here)
 * - HTTP requests (web UI at /, API at /api/*)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const DEFAULT_PORT = 19190;
const port = parseInt(process.env.PI_PIDASH_PORT || "", 10) || DEFAULT_PORT;

const LOG_PATH = path.join(process.env.HOME || "/tmp", ".pi", "pidash-debug.log");
function log(msg: string) {
  const line = `${new Date().toISOString()} [srv] ${msg}\n`;
  console.log(msg);
  try { fs.appendFileSync(LOG_PATH, line); } catch {}
}

// ── Session state ───────────────────────────────────────────────────

interface SessionInfo {
  pid: number;
  cwd: string;
  branch: string;
  model: string;
  startedAt: string;
  lastActivity: number;
  active: boolean;
  sessionFile?: string;
  gitDirty?: boolean;
  gitChanges?: number;
  container?: boolean;
  diffPort?: number | null;
  contextWindow?: number;
  thinkingLevel?: string;
}

interface PiClient {
  ws: any;
  session: SessionInfo;
  eventBuffer: string[];
}

const piClients = new Map<number, PiClient>();
const browserClients = new Set<any>();
const browserWatchMap = new WeakMap<any, number | null>();

// ── HTTP Server ─────────────────────────────────────────────────────

const UI_DIR = path.join(
  path.dirname(process.argv[1] || __filename),
  "..", "extensions", "orchestrator", "pidash-ui", "dist",
);

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", `http://localhost:${port}`);

  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || `http://localhost:${port}`);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (url.pathname === "/api/sessions") {
    const sessions = Array.from(piClients.values()).map(c => c.session);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(sessions));
    return;
  }

  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      port,
      sessions: piClients.size,
      browsers: browserClients.size,
      uptime: process.uptime(),
    }));
    return;
  }

  // Serve static files from dist/
  const MIME: Record<string, string> = {
    ".html": "text/html", ".js": "application/javascript",
    ".css": "text/css", ".json": "application/json",
    ".woff2": "font/woff2", ".woff": "font/woff",
    ".svg": "image/svg+xml", ".png": "image/png",
  };

  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const absPath = path.join(UI_DIR, filePath);

  // Security: prevent directory traversal
  if (!absPath.startsWith(UI_DIR)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  try {
    const data = fs.readFileSync(absPath);
    const ext = path.extname(absPath).toLowerCase();
    const headers: Record<string, string> = { "Content-Type": MIME[ext] || "application/octet-stream" };
    // No cache for HTML, long cache for hashed assets
    if (ext === ".html") {
      headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
    } else if (filePath.includes("/assets/")) {
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    }
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    // SPA fallback — serve index.html for unknown routes
    try {
      const html = fs.readFileSync(path.join(UI_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } catch {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>pidash</h1><p>UI is building... Run <code>/pidash restart</code> from the pi TUI, then refresh this page.</p>");
    }
  }
});

// ── WebSocket Server ────────────────────────────────────────────────

const _require = createRequire(import.meta.url);
const WebSocket = _require("ws");

// Pi session clients
const piWss = new WebSocket.Server({ noServer: true });
piWss.on("connection", (ws: any) => {
  let piClient: PiClient | null = null;

  ws.on("message", (data: Buffer) => {
    try {
      const parsed = JSON.parse(data.toString());

      if (parsed.type === "register") {
        const session: SessionInfo = {
          pid: parsed.pid,
          cwd: parsed.cwd || "",
          branch: parsed.branch || "",
          model: parsed.model || "",
          startedAt: parsed.startedAt || new Date().toISOString(),
          lastActivity: Date.now(),
          active: true,
          sessionFile: parsed.sessionFile || "",
          gitDirty: parsed.gitDirty || false,
          gitChanges: parsed.gitChanges || 0,
          container: parsed.container || false,
          diffPort: parsed.diffPort || null,
          contextWindow: parsed.contextWindow || 0,
          thinkingLevel: parsed.thinkingLevel || "medium",
        };
        // Re-registration: update existing inactive session (keep event buffer)
        const existing = piClients.get(parsed.pid);
        if (existing) {
          existing.ws = ws;
          existing.session = session;
          existing.eventBuffer = []; // Clear stale buffer — extension will replay current events
          piClient = existing;
        } else {
          piClient = { ws, session, eventBuffer: [] };
        }
        piClients.set(parsed.pid, piClient);
        log(`session registered: PID ${parsed.pid}, cwd: ${parsed.cwd}`);
        broadcastToBrowsers({ type: "session_added", session });
        return;
      }

      if (parsed.type === "update_info" && piClient) {
        if (parsed.model !== undefined) piClient.session.model = parsed.model;
        if (parsed.branch !== undefined) piClient.session.branch = parsed.branch;
        if (parsed.gitDirty !== undefined) piClient.session.gitDirty = parsed.gitDirty;
        if (parsed.gitChanges !== undefined) piClient.session.gitChanges = parsed.gitChanges;
        if (parsed.contextWindow !== undefined) piClient.session.contextWindow = parsed.contextWindow;
        if (parsed.diffPort !== undefined) piClient.session.diffPort = parsed.diffPort;
        if (parsed.thinkingLevel !== undefined) piClient.session.thinkingLevel = parsed.thinkingLevel;
        piClient.session.lastActivity = Date.now();
        broadcastToBrowsers({ type: "session_updated", session: piClient.session });
        return;
      }

      // Session switch (e.g., /resume) — update session info
      if (parsed.type === "session_switch" && piClient) {
        if (parsed.cwd) piClient.session.cwd = parsed.cwd;
        if (parsed.branch) piClient.session.branch = parsed.branch;
        if (parsed.sessionFile) piClient.session.sessionFile = parsed.sessionFile;
        piClient.session.lastActivity = Date.now();
        broadcastToBrowsers({ type: "session_updated", session: piClient.session });
        log(`session switched: PID ${piClient.session.pid}, cwd: ${parsed.cwd}`);
        return;
      }

      // Forward pi event to browsers watching this session + buffer
      if (piClient) {
        piClient.session.lastActivity = Date.now();
        const pid = piClient.session.pid;
        const raw = data.toString();

        // Buffer the event for replay on browser connect
        // Skip extension_ui_request — these are one-time interactions
        if (parsed.type !== "extension_ui_request") {
          piClient.eventBuffer.push(raw);
          if (piClient.eventBuffer.length > 5000) piClient.eventBuffer.shift();
        }

        for (const browser of browserClients) {
          if (browserWatchMap.get(browser) === pid) {
            try { browser.send(raw); } catch {}
          }
        }
      }
    } catch (e: any) {
      log(`pi message parse error: ${e.message}`);
    }
  });

  ws.on("close", () => {
    if (piClient) {
      const pid = piClient.session.pid;
      piClient.session.active = false;
      piClient.ws = null;
      log(`session disconnected: PID ${pid} (kept as inactive)`);
      broadcastToBrowsers({ type: "session_updated", session: piClient.session });
    }
  });

  ws.on("error", (e: Error) => {
    log(`pi ws error: ${e.message}`);
    if (piClient) {
      piClient.session.active = false;
      piClient.ws = null;
    }
  });
});

// Browser clients
const browserWss = new WebSocket.Server({ noServer: true });
browserWss.on("connection", (ws: any) => {
  browserClients.add(ws);
  browserWatchMap.set(ws, null);
  log(`browser connected (total: ${browserClients.size})`);

  ws.on("message", (data: Buffer) => {
    try {
      const parsed = JSON.parse(data.toString());

      if (parsed.type === "watch") {
        browserWatchMap.set(ws, parsed.pid ?? null);
        log(`browser watching PID: ${parsed.pid}`);
        // Replay buffered events
        if (parsed.pid) {
          const client = piClients.get(parsed.pid);
          if (client) {
            for (const event of client.eventBuffer) {
              try { ws.send(event); } catch {}
            }
            log(`replayed ${client.eventBuffer.length} events for PID ${parsed.pid}`);
          }
        }
        return;
      }

      if (parsed.type === "prompt" && parsed.pid && parsed.text) {
        const piClient = piClients.get(parsed.pid);
        if (piClient) {
          piClient.ws.send(JSON.stringify({ type: "prompt", text: parsed.text }));
          log(`prompt forwarded to PID ${parsed.pid}: ${parsed.text.slice(0, 50)}`);
        }
        return;
      }

      // Forward extension UI responses (ask_user answers) to pi session
      if (parsed.type === "extension_ui_response" && parsed.pid && parsed.id) {
        const piClient = piClients.get(parsed.pid);
        if (piClient && piClient.ws) {
          const response: any = { type: "extension_ui_response", id: parsed.id };
          if (parsed.value !== undefined) response.value = parsed.value;
          if (parsed.confirmed !== undefined) response.confirmed = parsed.confirmed;
          if (parsed.cancelled) response.cancelled = true;
          piClient.ws.send(JSON.stringify(response));
          log(`UI response forwarded to PID ${parsed.pid}: ${JSON.stringify(response).slice(0, 100)}`);
        }
        return;
      }

      // Forward pidash commands to pi session
      if (parsed.type === "pidash-command" && parsed.pid) {
        const piClient = piClients.get(parsed.pid);
        if (piClient && piClient.ws) {
          piClient.ws.send(JSON.stringify(parsed));
          log(`command forwarded to PID ${parsed.pid}: ${parsed.command}`);
        }
        return;
      }
    } catch {}
  });

  ws.on("close", () => {
    browserClients.delete(ws);
    log(`browser disconnected (total: ${browserClients.size})`);
  });

  ws.on("error", () => browserClients.delete(ws));
});

function broadcastToBrowsers(event: object) {
  const data = JSON.stringify(event);
  for (const browser of browserClients) {
    try { browser.send(data); } catch { browserClients.delete(browser); }
  }
}

// Route upgrade requests to the correct WS server
server.on("upgrade", (req: IncomingMessage, socket: any, head: Buffer) => {
  const url = new URL(req.url || "/", `http://localhost:${port}`);

  if (url.pathname === "/ws/pi") {
    piWss.handleUpgrade(req, socket, head, (ws: any) => piWss.emit("connection", ws, req));
  } else if (url.pathname === "/ws/browser") {
    browserWss.handleUpgrade(req, socket, head, (ws: any) => browserWss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// Clean up stale inactive sessions (disconnected > 5 min ago)
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [pid, client] of piClients.entries()) {
    if (!client.session.active && now - client.session.lastActivity > 5 * 60 * 1000) {
      piClients.delete(pid);
      log(`cleaned up stale session: PID ${pid}`);
      broadcastToBrowsers({ type: "session_removed", pid });
    }
  }
}, 60 * 1000); // Check every minute
if (cleanupInterval.unref) cleanupInterval.unref();

// Ping all pi clients every 30s to keep connections alive
const pingInterval = setInterval(() => {
  for (const [pid, client] of piClients) {
    if (client.ws) {
      try { client.ws.ping(); } catch {}
    }
  }
}, 30000);
if (pingInterval.unref) pingInterval.unref();

// ── Start ───────────────────────────────────────────────────────────

server.listen(port, "0.0.0.0", () => {
  log(`pidash server listening on http://0.0.0.0:${port}`);
});

server.on("error", (err: any) => {
  if (err.code === "EADDRINUSE") {
    log(`port ${port} already in use — daemon likely already running`);
    process.exit(0);
  }
  log(`server error: ${err.message}`);
  process.exit(1);
});

process.on("SIGTERM", () => { log("SIGTERM received"); server.close(); process.exit(0); });
process.on("SIGINT", () => { log("SIGINT received"); server.close(); process.exit(0); });
