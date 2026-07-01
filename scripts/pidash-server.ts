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

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { createDaemonServer } from "./daemon-shared.ts";
import type { SessionInfo } from "../extensions/shared/types.ts";
import { setupDiscordBot } from "./pidash-discord.ts";

const DEFAULT_PORT = 19190;
const port = parseInt(process.env.PI_PIDASH_PORT || "", 10) || DEFAULT_PORT;

const LOG_PATH = path.join(process.env.HOME || "/tmp", ".pi", "pidash-debug.log");
function log(msg: string) {
  const line = `${new Date().toISOString()} [srv] ${msg}\n`;
  console.log(msg);
  try { fs.appendFileSync(LOG_PATH, line); } catch {}
}

// Pluggable event hooks — Discord bot registers here to receive pi events
const piEventHooks: Array<(sessionId: string, event: any) => void> = [];

// ── Session state ───────────────────────────────────────────────────

interface PiClient {
  ws: any;
  session: SessionInfo;
  eventBuffer: string[];
  replaying: boolean;
}



// Async agent state (managed outside daemon-shared — uses its own WebSocket server)
const _require = createRequire(import.meta.url);
const WebSocket = _require("ws");
const asyncWss = new WebSocket.Server({ noServer: true });
const asyncAgents = new Map<string, { id: string; agent: string; task: string; cwd: string; sessionId?: string }>();

function getActiveSessions(): SessionInfo[] {
  return Array.from(piClients.values()).map(c => c.session).filter(s => s.active);
}

function sendToWatchers(sessionId: string, event: object) {
  const data = JSON.stringify(event);
  for (const browser of browserClients) {
    if (browserWatchMap.get(browser) === sessionId) {
      try { browser.send(data); } catch {}
    }
  }
}

const { piClients, browserClients, browserWatchMap, broadcastToBrowsers, start } = createDaemonServer({
  port,
  uiDir: path.join(path.dirname(process.argv[1] || __filename), "..", "extensions", "pidash", "pidash-ui", "dist"),
  uiName: "pidash-ui",
  log,
  listenAddress: "0.0.0.0",
  // Pidash binds to 0.0.0.0 — accept localhost + private/LAN IPs (RFC 1918 + link-local)
  originPattern: /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|\[::1\])(:\d+)?$/,

  onPiMessage: (ws, parsed, getPiClient, setPiClient) => {
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
        contextWindow: parsed.contextWindow || 0,
        diffPort: parsed.diffPort || null,
        thinkingLevel: parsed.thinkingLevel || "medium",
      };
      // Re-registration: update existing inactive session (keep event buffer)
      const existing = piClients.get(sessionId);
      let piClient: PiClient;
      if (existing) {
        existing.ws = ws;
        existing.session = session;
        existing.eventBuffer = []; // Clear stale buffer — extension will replay current events
        existing.replaying = true;
        piClient = existing;
      } else {
        piClient = { ws, session, eventBuffer: [], replaying: true };
      }
      setPiClient(piClient);
      piClients.set(sessionId, piClient);
      log(`session registered: ${sessionId}, cwd: ${parsed.cwd}`);
      broadcastToBrowsers({ type: "session_added", session });
      // replaying flag cleared when extension sends replay_complete
      return;
    }

    const piClient = getPiClient() as PiClient | null;

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

    // Forward list responses directly to watchers (not buffered)
    if ((parsed.type === "sessions-list" || parsed.type === "models-list") && piClient) {
      sendToWatchers(piClient.session.sessionId, parsed);
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
      const raw = JSON.stringify(parsed);

      // Buffer the event for replay on browser connect
      // Skip extension_ui_request (one-time interactions)
      if (parsed.type !== "extension_ui_request") {
        piClient.eventBuffer.push(raw);
        while (piClient.eventBuffer.length > 10000) piClient.eventBuffer.shift();
      }

      for (const browser of browserClients) {
        if (browserWatchMap.get(browser) === sid) {
          try { browser.send(raw); } catch {}
        }
      }

      // Forward to event hooks (Discord bot, etc.)
      for (const hook of piEventHooks) {
        try { hook(sid, parsed); } catch (e: any) {
          log(`[discord] hook error: ${e.message}`);
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
  },

  onPiClose: (piClient) => {
    piClient.session.active = false;
    piClient.ws = null;
    log(`session disconnected: ${piClient.session.sessionId} (kept as inactive)`);
    sendToWatchers(piClient.session.sessionId, { type: "session_updated", session: piClient.session });
  },

  onPiError: (piClient) => {
    piClient.session.active = false;
    piClient.ws = null;
  },

  onBrowserWatch: (ws, watchId, client) => {
    // Replay buffered events
    if (client) {
      for (const event of client.eventBuffer) {
        try { ws.send(event); } catch {}
      }
      log(`replayed ${client.eventBuffer.length} events for ${watchId}`);
    }
    return watchId;  // pidash stores just the sessionId string
  },

  onBrowserConnect: (ws) => {
    browserWatchMap.set(ws, null);
  },

  onBrowserMessage: (ws, parsed) => {
    if (parsed.type === "prompt" && (parsed.text || parsed.images) && parsed.sessionId) {
      const piClient = piClients.get(parsed.sessionId);
      if (piClient && piClient.ws) {
        const fwd: any = { type: "prompt", text: parsed.text || "" };
        if (parsed.images && parsed.images.length > 0) fwd.images = parsed.images;
        piClient.ws.send(JSON.stringify(fwd));
        log(`prompt forwarded to ${parsed.sessionId}: ${(parsed.text || "").slice(0, 50)}${parsed.images ? ` [+${parsed.images.length} images]` : ""}`);
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
  },

  extraUpgrades: (pathname, req, socket, head) => {
    if (pathname === "/ws/async") {
      asyncWss.handleUpgrade(req, socket, head, (ws: any) => asyncWss.emit("connection", ws, req));
      return true;
    }
    return false;
  },
});

// Async agent WebSocket handler
function handleAsyncConnection(ws: any) {
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
    } catch (e: any) { log(`async message error: ${e.message}`); }
  });

  ws.on("close", () => {
    if (agentId) asyncAgents.delete(agentId);
  });

  ws.on("error", () => {
    if (agentId) asyncAgents.delete(agentId);
  });
}
asyncWss.on("connection", handleAsyncConnection);

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

// ── Discord bot ─────────────────────────────────────────────────────

setupDiscordBot({
  piClients,
  piEventHooks,
  getActiveSessions,
  log,
});

// ── Start ───────────────────────────────────────────────────────────

start();
