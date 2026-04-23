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
  sessionId: string;
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
  working?: boolean;
}

interface PiClient {
  ws: any;
  session: SessionInfo;
  eventBuffer: string[];
  replaying: boolean;
}

const piClients = new Map<string, PiClient>();
const browserClients = new Set<any>();
const browserWatchMap = new WeakMap<any, string | null>();

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
        const sessionId = parsed.sessionId || `${parsed.pid}:${parsed.cwd}`;
        const session: SessionInfo = {
          sessionId,
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
        const existing = piClients.get(sessionId);
        if (existing) {
          existing.ws = ws;
          existing.session = session;
          existing.eventBuffer = []; // Clear stale buffer — extension will replay current events
          existing.replaying = true;
          piClient = existing;
        } else {
          piClient = { ws, session, eventBuffer: [], replaying: true };
        }
        piClients.set(sessionId, piClient);
        log(`session registered: ${sessionId}, cwd: ${parsed.cwd}`);
        broadcastToBrowsers({ type: "session_added", session });
        // replaying flag cleared when extension sends replay_complete
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
        sendToWatchers(piClient.session.sessionId, { type: "session_updated", session: piClient.session });
        return;
      }

      // Session switch (e.g., /resume) — update session info
      if (parsed.type === "session_switch" && piClient) {
        if (parsed.cwd) piClient.session.cwd = parsed.cwd;
        if (parsed.branch) piClient.session.branch = parsed.branch;
        if (parsed.sessionFile) piClient.session.sessionFile = parsed.sessionFile;
        piClient.session.lastActivity = Date.now();
        piClient.eventBuffer.length = 0; // Clear buffer to prevent cross-session replay
        sendToWatchers(piClient.session.sessionId, { type: "session_updated", session: piClient.session });
        log(`session switched: ${piClient.session.sessionId}, cwd: ${parsed.cwd}`);
        return;
      }

      if (parsed.type === "session_shutdown" && piClient) {
        const reason = parsed.reason || "unknown";
        log(`session shutdown: ${piClient.session.sessionId}, reason: ${reason}`);
        sendToWatchers(piClient.session.sessionId, {
          type: "session_shutdown",
          sessionId: piClient.session.sessionId,
          reason,
          targetSessionFile: parsed.targetSessionFile,
        });
        return;
      }

      if (parsed.type === "replay_complete" && piClient) {
        piClient.replaying = false;
        log(`replay complete for ${piClient.session.sessionId}`);
        return;
      }

      // Forward pi event to browsers watching this session + buffer
      if (piClient) {
        piClient.session.lastActivity = Date.now();

        // Track AI working state and broadcast to all browsers
        if (parsed.type === "agent_start") {
          piClient.session.working = true;
          broadcastToBrowsers({ type: "session_updated", session: piClient.session });
        }
        if (parsed.type === "agent_end") {
          piClient.session.working = false;
          broadcastToBrowsers({ type: "session_updated", session: piClient.session });
        }

        const sid = piClient.session.sessionId;
        const raw = data.toString();

        // Buffer the event for replay on browser connect
        // Skip extension_ui_request — these are one-time interactions
        if (parsed.type !== "extension_ui_request") {
          piClient.eventBuffer.push(raw);
          while (piClient.eventBuffer.length > 10000) piClient.eventBuffer.shift();
        }

        for (const browser of browserClients) {
          if (browserWatchMap.get(browser) === sid) {
            try { browser.send(raw); } catch {}
          }
        }

        // Broadcast notification-worthy events to ALL browsers (skip during replay)
        if (parsed.type === "tool_execution_end" && !piClient.replaying) {
          const toolName = parsed.toolName || "";
          const isSubagent = toolName === "subagent" || !!(parsed.args?.agent);
          const isError = parsed.isError === true;
          const resultText = parsed.result?.content?.[0]?.text || "";

          const notifEvent = JSON.stringify({
            type: "session_notification",
            sessionId: sid,
            cwd: piClient.session.cwd,
            toolName,
            isError,
            isSubagent,
            agentName: parsed.args?.name || parsed.args?.agent || "",
            resultText: resultText.slice(0, 200),
          });
          for (const browser of browserClients) {
            try { browser.send(notifEvent); } catch {}
          }
        }

        // Broadcast AI turn complete to ALL browsers (skip during replay)
        if (parsed.type === "agent_end" && !piClient.replaying) {
          const notifEvent = JSON.stringify({
            type: "session_turn_complete",
            sessionId: sid,
            cwd: piClient.session.cwd,
          });
          for (const browser of browserClients) {
            try { browser.send(notifEvent); } catch {}
          }
        }

        // Broadcast input-needed events to ALL browsers (skip during replay)
        if (!piClient.replaying && parsed.type === "extension_ui_request" && parsed.id && (parsed.method === "select" || parsed.method === "confirm" || parsed.method === "input")) {
          const notifEvent = JSON.stringify({
            type: "session_input_needed",
            sessionId: sid,
            cwd: piClient.session.cwd,
            title: parsed.title || "Input needed",
            method: parsed.method,
          });
          for (const browser of browserClients) {
            try { browser.send(notifEvent); } catch {}
          }
        }
      }
    } catch (e: any) {
      log(`pi message parse error: ${e.message}`);
    }
  });

  ws.on("close", () => {
    if (piClient) {
      piClient.session.active = false;
      piClient.ws = null;
      log(`session disconnected: ${piClient.session.sessionId} (kept as inactive)`);
      sendToWatchers(piClient.session.sessionId, { type: "session_updated", session: piClient.session });
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
        const watchId = parsed.sessionId ?? null;
        browserWatchMap.set(ws, watchId);
        log(`browser watching: ${watchId}`);
        // Replay buffered events
        if (watchId) {
          const client = piClients.get(watchId);
          if (client) {
            for (const event of client.eventBuffer) {
              try { ws.send(event); } catch {}
            }
            log(`replayed ${client.eventBuffer.length} events for ${watchId}`);
          }
        }
        return;
      }

      if (parsed.type === "prompt" && parsed.text && parsed.sessionId) {
        const piClient = piClients.get(parsed.sessionId);
        if (piClient && piClient.ws) {
          piClient.ws.send(JSON.stringify({ type: "prompt", text: parsed.text }));
          log(`prompt forwarded to ${parsed.sessionId}: ${parsed.text.slice(0, 50)}`);
        }
        return;
      }

      // Forward extension UI responses (ask_user answers) to pi session
      if (parsed.type === "extension_ui_response" && parsed.id) {
        if (!parsed.sessionId) return;
        const piClient = piClients.get(parsed.sessionId);
        if (piClient && piClient.ws) {
          const response: any = { type: "extension_ui_response", id: parsed.id };
          if (parsed.value !== undefined) response.value = parsed.value;
          if (parsed.confirmed !== undefined) response.confirmed = parsed.confirmed;
          if (parsed.cancelled) response.cancelled = true;
          piClient.ws.send(JSON.stringify(response));
          log(`UI response forwarded to ${parsed.sessionId}: ${JSON.stringify(response).slice(0, 100)}`);
        }
        return;
      }

      // Forward pidash commands to pi session
      if (parsed.type === "pidash-command") {
        if (!parsed.sessionId) return;
        const piClient = piClients.get(parsed.sessionId);
        if (piClient && piClient.ws) {
          piClient.ws.send(JSON.stringify(parsed));
          log(`command forwarded to ${parsed.sessionId}: ${parsed.command}`);
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

function sendToWatchers(sessionId: string, event: object) {
  const data = JSON.stringify(event);
  for (const browser of browserClients) {
    if (browserWatchMap.get(browser) === sessionId) {
      try { browser.send(data); } catch {}
    }
  }
}

// Async agent clients
const asyncWss = new WebSocket.Server({ noServer: true });
const asyncAgents = new Map<string, { id: string; agent: string; task: string; cwd: string; sessionId?: string }>();

asyncWss.on("connection", (ws: any) => {
  log("async agent WebSocket connected");
  let agentId: string | null = null;

  ws.on("message", (data: Buffer) => {
    try {
      const parsed = JSON.parse(data.toString());

      if (parsed.type === "async_register") {
        log(`async agent registered: ${parsed.id} (${parsed.agent})`);
        agentId = parsed.id;
        asyncAgents.set(agentId, {
          id: parsed.id,
          agent: parsed.agent,
          task: parsed.task,
          cwd: parsed.cwd,
          sessionId: parsed.sessionId,
        });
        // Broadcast to all browsers
        broadcastToBrowsers({
          type: "async_agent_start",
          id: parsed.id,
          agent: parsed.agent,
          task: parsed.task,
          cwd: parsed.cwd,
          sessionId: parsed.sessionId,
        });
        return;
      }

      if (parsed.type === "async_event" && parsed.id) {
        log(`async event from ${parsed.id}: ${parsed.event?.type}`);
        broadcastToBrowsers({
          type: "async_agent_event",
          id: parsed.id,
          event: parsed.event,
          sessionId: asyncAgents.get(parsed.id)?.sessionId,
        });
        return;
      }

      if (parsed.type === "async_complete" && parsed.id) {
        broadcastToBrowsers({
          type: "async_agent_complete",
          id: parsed.id,
          success: parsed.success,
          sessionId: asyncAgents.get(parsed.id)?.sessionId,
        });
        asyncAgents.delete(parsed.id);
        return;
      }
    } catch {}
  });

  ws.on("close", () => {
    if (agentId) asyncAgents.delete(agentId);
  });

  ws.on("error", () => {
    if (agentId) asyncAgents.delete(agentId);
  });
});

// Route upgrade requests to the correct WS server
server.on("upgrade", (req: IncomingMessage, socket: any, head: Buffer) => {
  const url = new URL(req.url || "/", `http://localhost:${port}`);

  if (url.pathname === "/ws/pi") {
    piWss.handleUpgrade(req, socket, head, (ws: any) => piWss.emit("connection", ws, req));
  } else if (url.pathname === "/ws/browser") {
    browserWss.handleUpgrade(req, socket, head, (ws: any) => browserWss.emit("connection", ws, req));
  } else if (url.pathname === "/ws/async") {
    asyncWss.handleUpgrade(req, socket, head, (ws: any) => asyncWss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// Clean up stale inactive sessions (disconnected > 5 min ago)
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, client] of piClients.entries()) {
    if (!client.session.active && now - client.session.lastActivity > 5 * 60 * 1000) {
      piClients.delete(sessionId);
      log(`cleaned up stale session: ${sessionId}`);
      broadcastToBrowsers({ type: "session_removed", sessionId });
    }
  }
}, 60 * 1000); // Check every minute
if (cleanupInterval.unref) cleanupInterval.unref();

// Ping all pi clients every 30s to keep connections alive
const pingInterval = setInterval(() => {
  for (const [, client] of piClients) {
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
