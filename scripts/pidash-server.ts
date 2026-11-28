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

import * as path from "node:path";
import { createRequire } from "node:module";
import { createAsyncDebugLogWriter, createDaemonServer, resolveUiDir } from "./daemon-shared.ts";
import type { SessionInfo } from "../extensions/shared/types.ts";
import {
  buildSessionNotification,
  buildSessionUpdatedBroadcast,
  clearPendingUiRequests,
  createAsyncAgentRegistry,
  disconnectPidashSession,
  dismissAllViewAsks,
  handlePidashBrowserMessage,
  handlePidashBrowserWatch,
  isInteractiveUiRequest,
  isLoopbackAddress,
  processPiPendingUiEvent,
  reconcileActiveAsyncAgents,
  registerPidashSession,
  resetSessionViewState,
  shouldDeliverSupervisedPeerBroadcast,
  shouldNotifyWorktreeChange,
  updatePidashSession,
  type PiClient,
} from "./pidash-session-state.ts";
import { setupDiscordBot } from "./pidash-discord.ts";
import { applyActivityEvent, initialActivityState, shouldAcceptActivityEvent } from "../extensions/pidash/activity-state.ts";
import { createLogger } from "../extensions/shared/logger.ts";
import { ComsRegistry } from "../extensions/coms/coms-registry.ts";
import { pickSupervisionRecord } from "../extensions/coms/coms-peers.ts";
import { readBuildStatus } from "./podman-peer-image.mjs";

const activityLog = createLogger("pidash");
const serverLog = createLogger("pidash-server");

const DEFAULT_PORT = 19190;
const port = parseInt(process.env.PI_PIDASH_PORT || "", 10) || DEFAULT_PORT;

const LOG_PATH = path.join(process.env.HOME || "/tmp", ".pi", "pidash-debug.log");
const debugLogWriter = createAsyncDebugLogWriter(LOG_PATH, (msg, err) => {
  serverLog.warn(msg, err);
});
process.on("beforeExit", () => { void debugLogWriter.flush(); });

function log(msg: string) {
  const line = `${new Date().toISOString()} [srv] ${msg}\n`;
  serverLog.info(msg);
  debugLogWriter.write(line);
}

// Pluggable event hooks — Discord bot registers here to receive pi events
const piEventHooks: Array<(sessionId: string, event: any) => void> = [];

// ── Session state ───────────────────────────────────────────────────


// Async agent state (managed outside daemon-shared — uses its own WebSocket server)
const _require = createRequire(import.meta.url);
const WebSocket = _require("ws");
const asyncWss = new WebSocket.Server({ noServer: true });
let asyncRegistry: ReturnType<typeof createAsyncAgentRegistry>;
// Per-browser remote address (used to gate destructive worktree mutations to localhost)
const browserRemoteAddrMap = new WeakMap<any, string>();
// Per-session learned git repository root (used to scope minimal worktrees-changed notices)
const sessionRepoRootMap = new Map<string, string>();

function getActiveSessions(): SessionInfo[] {
  return Array.from(piClients.values()).map(c => c.session).filter(s => s.active);
}

function sendToWatchers(sessionId: string, eventOrRaw: object | string) {
  const session = piClients.get(sessionId)?.session;
  sendToMatchingBrowsers(
    (browser, watchId) =>
      watchId === sessionId
      && shouldDeliverSupervisedPeerBroadcast({
        session,
        remoteAddress: browserRemoteAddrMap.get(browser),
      }),
    eventOrRaw,
  );
}

function broadcastAuthorizedBrowsers(session: SessionInfo, eventOrRaw: object | string) {
  sendToMatchingBrowsers(
    (browser) =>
      shouldDeliverSupervisedPeerBroadcast({
        session,
        remoteAddress: browserRemoteAddrMap.get(browser),
      }),
    eventOrRaw,
  );
}

function handlePiMessage(ws: any, parsed: any, getPiClient: () => any, setPiClient: (c: any) => void, rawMsg?: string): void {
  if (parsed.type === "register") {
    const piClient = registerPidashSession(piClients, ws, parsed, broadcastToBrowsers);
    setPiClient(piClient);
    log(`session registered: ${piClient.session.sessionId}, cwd: ${parsed.cwd}`);
    // replaying flag cleared when extension sends replay_complete
    return;
  }

  const piClient = getPiClient() as PiClient | null;
  if (piClient && piClient.ws !== ws) {
    activityLog.warn(`stale connection event ignored: session=${piClient.session.sessionId} type=${parsed.type}`);
    return;
  }

  // Forward session name changes to all browsers so sidebar stays current
  if (parsed.type === "session_info_changed" && piClient) {
    if (parsed.name !== undefined) piClient.session.name = parsed.name;
    piClient.session.lastActivity = Date.now();
    broadcastToBrowsers({ type: "session_updated", session: piClient.session });
    return;
  }

  if (parsed.type === "update_info" && piClient) {
    if (parsed.model !== undefined) {
      piClient.session.model = parsed.model;
      piClient.viewState.model = parsed.model;
    }
    if (typeof parsed.reasoning === "boolean") piClient.session.reasoning = parsed.reasoning;
    if (typeof parsed.supportsImages === "boolean") piClient.session.supportsImages = parsed.supportsImages;
    if (parsed.branch !== undefined) piClient.session.branch = parsed.branch;
    if (parsed.gitDirty !== undefined) piClient.session.gitDirty = parsed.gitDirty;
    if (parsed.gitChanges !== undefined) piClient.session.gitChanges = parsed.gitChanges;
    if (parsed.contextWindow !== undefined) piClient.session.contextWindow = parsed.contextWindow;
    if (parsed.diffPort !== undefined) piClient.session.diffPort = parsed.diffPort;
    if (parsed.thinkingLevel !== undefined) piClient.session.thinkingLevel = parsed.thinkingLevel;
    if (parsed.comsName !== undefined) piClient.session.comsName = parsed.comsName || undefined;
    if (parsed.comsPurpose !== undefined) piClient.session.comsPurpose = parsed.comsPurpose || undefined;
    if (parsed.comsProject !== undefined) piClient.session.comsProject = parsed.comsProject || undefined;
    updatePidashSession(piClient.session, parsed);
    broadcastToBrowsers(buildSessionUpdatedBroadcast(piClient.session, parsed));
    return;
  }

  // Session switch (e.g., /resume) — update session info
  if (parsed.type === "session_switch" && piClient) {
    if (parsed.cwd) piClient.session.cwd = parsed.cwd;
    if (parsed.branch) piClient.session.branch = parsed.branch;
    if (parsed.sessionFile) piClient.session.sessionFile = parsed.sessionFile;
    if (parsed.model !== undefined) piClient.session.model = parsed.model;
    if (parsed.contextWindow !== undefined) piClient.session.contextWindow = parsed.contextWindow;
    if (parsed.thinkingLevel !== undefined) piClient.session.thinkingLevel = parsed.thinkingLevel;
    updatePidashSession(piClient.session, parsed);
    piClient.session.activity = "idle";
    piClient.session.activitySequence = 0;
    piClient.session.activityBeforePrompt = undefined;
    piClient.session.streaming = false;
    piClient.session.working = false;
    sessionRepoRootMap.delete(piClient.session.sessionId);
    resetSessionViewState(piClient); // Clear viewState to prevent cross-session leakage
    clearPendingUiRequests(piClient);
    broadcastToBrowsers({ type: "session_updated", session: piClient.session });
    log(`session switched: ${piClient.session.sessionId}, cwd: ${parsed.cwd}`);
    return;
  }

  if (parsed.type === "session_shutdown" && piClient) {
    const reason = parsed.reason || "unknown";
    dismissAllViewAsks(piClient.viewState);
    clearPendingUiRequests(piClient);
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
    reconcileActiveAsyncAgents(piClient, asyncRegistry.agents.values());
    log(`replay complete for ${piClient.session.sessionId}`);
    return;
  }

  // Forward list/panel responses directly to watchers (not buffered into viewState)
  if (
    (parsed.type === "sessions-list" ||
      parsed.type === "models-list" ||
      parsed.type === "worktrees-list" ||
      parsed.type === "worktrees-detail" ||
      parsed.type === "worktrees-op-result") &&
    piClient
  ) {
    if (parsed.type === "worktrees-list" && typeof parsed.repoRoot === "string" && parsed.repoRoot) {
      sessionRepoRootMap.set(piClient.session.sessionId, parsed.repoRoot);
    }
    sendToWatchers(piClient.session.sessionId, rawMsg ?? parsed);
    return;
  }

  // #968: settings files are shared across sessions — a settings write must
  // fan out to EVERY connected browser, not just watchers of the writing
  // session (Qodo R3: shared settings stayed stale across sessions).
  if (parsed.type === "settings-broadcast" && parsed.payload) {
    broadcastToBrowsers(parsed.payload);
    return;
  }

  // #1512: fan out rootless Podman peer image build progress to all connected browsers
  if (parsed.type === "podman-build-status") {
    broadcastToBrowsers(parsed);
    return;
  }

  // #1427: worktree mutations send a minimal invalidation notice ONLY to browsers
  // watching sessions in the same repository (never broadcasting paths/metadata globally).
  if (parsed.type === "worktrees-broadcast" && piClient) {
    const sourceSessionId = piClient.session.sessionId;
    const repoRoot = typeof parsed.repoRoot === "string" && parsed.repoRoot
      ? parsed.repoRoot
      : sessionRepoRootMap.get(sourceSessionId);
    if (repoRoot) {
      sessionRepoRootMap.set(sourceSessionId, repoRoot);
    }
    sendToMatchingBrowsers((_browser, watchId) => {
      const watchedClient = typeof watchId === "string" ? piClients.get(watchId) : undefined;
      return shouldNotifyWorktreeChange({
        watchId: typeof watchId === "string" ? watchId : null,
        sourceSessionId,
        repoRoot,
        watchedSessionRepoRoot: typeof watchId === "string" ? sessionRepoRootMap.get(watchId) : undefined,
        watchedSessionCwd: watchedClient?.session.cwd,
      });
    }, { type: "worktrees-changed", sourceSessionId });
    return;
  }

  // Forward pi event to browsers watching this session + buffer
  if (piClient) {
    piClient.session.lastActivity = Date.now();

    // Prompt wait is activity state, independent of streaming and queued prompts.
    if (["agent_start", "agent_end", "agent_settled", "ui_prompt_start", "ui_prompt_end"].includes(parsed.type)) {
      const event = { type: parsed.type, sequence: Number(parsed.activitySequence) };
      const previous = {
        activity: piClient.session.activity || (piClient.session.working ? "working" : "idle"),
        streaming: piClient.session.streaming || false,
        sequence: piClient.session.activitySequence || 0,
        activityBeforePrompt: piClient.session.activityBeforePrompt,
      } as const;
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || !shouldAcceptActivityEvent(previous, event)) {
        activityLog.warn(`stale activity event ignored: session=${piClient.session.sessionId} type=${event.type} sequence=${parsed.activitySequence} current=${previous.sequence}`);
      } else {
        const next = applyActivityEvent(previous, event);
        piClient.session.activity = next.activity;
        piClient.session.activitySequence = next.sequence;
        piClient.session.activityBeforePrompt = next.activityBeforePrompt;
        piClient.session.streaming = next.streaming;
        piClient.session.working = next.activity === "working";
        piClient.viewState.streaming = next.streaming;
        activityLog.info(`activity transition: session=${piClient.session.sessionId} ${previous.activity}->${next.activity} sequence=${next.sequence}`);
        broadcastToBrowsers({ type: "session_updated", session: piClient.session });
      }
    }

    const sid = piClient.session.sessionId;
    const raw = rawMsg ?? JSON.stringify(parsed);

    const pendingAction = processPiPendingUiEvent(piClient, parsed, raw, sendToWatchers);
    if (pendingAction === "recorded") {
      log(`pending UI request recorded: ${sid} id=${parsed.id} method=${parsed.method}`);
    } else if (pendingAction === "dismissed") {
      log(`pending UI request dismissed: ${sid} id=${parsed.id}`);
    }

    // Forward to event hooks (Discord bot, etc.)
    for (const hook of piEventHooks) {
      try { hook(sid, parsed); } catch (e: any) {
        log(`[discord] hook error: ${e.message}`);
      }
    }

    // Broadcast metadata-only notification frame to authorized browsers (skip during replay;
    // never broadcast raw tool output text to browsers watching other sessions).
    if (parsed.type === "tool_execution_end" && !piClient.replaying) {
      broadcastAuthorizedBrowsers(piClient.session, buildSessionNotification(sid, piClient.session.cwd, parsed));
    }

    // Broadcast AI turn complete to authorized browsers (skip during replay)
    if (parsed.type === "agent_end" && !piClient.replaying) {
      broadcastAuthorizedBrowsers(piClient.session, {
        type: "session_turn_complete",
        sessionId: sid,
        cwd: piClient.session.cwd,
      });
    }

    // Broadcast input-needed events to authorized browsers (skip during replay)
    if (!piClient.replaying && isInteractiveUiRequest(parsed)) {
      broadcastAuthorizedBrowsers(piClient.session, {
        type: "session_input_needed",
        sessionId: sid,
        cwd: piClient.session.cwd,
        title: parsed.title || "Input needed",
        method: parsed.method,
      });
    }
  }
}

function handleBrowserMessage(ws: any, parsed: any): void {
  handlePidashBrowserMessage({
    ws,
    parsed,
    piClients,
    watchedSessionId: browserWatchMap.get(ws),
    remoteAddress: browserRemoteAddrMap.get(ws),
    onLog: log,
  });
}

const { piClients, browserClients, browserWatchMap, broadcastToBrowsers, sendToMatchingBrowsers, start } = createDaemonServer({
  port,
  uiDir: resolveUiDir(process.argv[1], import.meta.url, "..", "extensions", "pidash", "pidash-ui", "dist"),
  uiName: "pidash-ui",
  log,
  listenAddress: "0.0.0.0",
  // Pidash binds to 0.0.0.0 — accept localhost + private/LAN IPs (RFC 1918 + link-local)
  originPattern: /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|\[::1\])(:\d+)?$/,

  extraApiRoutes: (url, req, res) => {
    if (url.pathname === "/api/peers" || url.pathname === "/api/podman-build-status") {
      if (!isLoopbackAddress(req.socket?.remoteAddress)) {
        log(`rejected non-loopback ${url.pathname} request from ${req.socket?.remoteAddress || "unknown"}`);
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "localhost access required" }));
        return true;
      }
    }
    if (url.pathname === "/api/peers") {
      try {
        const reg = ComsRegistry.forCwd();
        const records = reg.readSupervisionRecords();
        const rows = reg.readLiveRows().map((row) => {
          const rec = pickSupervisionRecord(records, row);
          const container = row.container ?? (typeof rec?.container === "string" && rec.container.trim() ? rec.container.trim() : null);
          const hostPid = (container && rec?.container === container && Number.isInteger(rec?.childPid) && rec.childPid > 0)
            ? rec.childPid
            : (row.hostPid ?? null);
          return {
            name: row.name,
            project: row.project,
            pid: hostPid ?? row.pid,
            ...(hostPid ? { hostPid } : {}),
            ...(container ? { container } : {}),
            cwd: row.cwd,
            purpose: row.purpose,
            busy: row.busy,
            queueDepth: row.queueDepth,
            contextUsedPct: row.contextUsedPct,
            startedAt: row.startedAt,
            heartbeatAt: row.heartbeatAt,
          };
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rows));
      } catch (err: any) {
        serverLog.warn("api_peers_failed", { error: err?.message ?? String(err) });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "failed to read coms peers" }));
      }
      return true;
    }
    if (url.pathname === "/api/podman-build-status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(readBuildStatus()));
      return true;
    }
    return false;
  },

  onPiMessage: handlePiMessage,

  onPiClose: (piClient, ws) => {
    disconnectPidashSession(piClient, ws, "close", event => {
      log(`session disconnected: ${piClient.session.sessionId} (kept as inactive)`);
      broadcastToBrowsers(event);
    });
  },

  onPiError: (piClient, ws) => {
    disconnectPidashSession(piClient, ws, "error", event => {
      log(`session errored: ${piClient.session.sessionId} (kept as inactive)`);
      broadcastToBrowsers(event);
    });
  },

  onBrowserWatch: (ws, watchId, client) =>
    handlePidashBrowserWatch({
      ws,
      watchId,
      client,
      remoteAddress: browserRemoteAddrMap.get(ws),
      onLog: log,
    }),

  onBrowserConnect: (ws, req) => {
    browserWatchMap.set(ws, null);
    if (req?.socket?.remoteAddress) {
      browserRemoteAddrMap.set(ws, req.socket.remoteAddress);
    }
  },

  onBrowserMessage: handleBrowserMessage,

  extraUpgrades: (pathname, req, socket, head) => {
    if (pathname === "/ws/async") {
      if (!isLoopbackAddress(req.socket?.remoteAddress)) {
        log(`rejected non-loopback /ws/async upgrade from ${req.socket?.remoteAddress || "unknown"}`);
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return true;
      }
      asyncWss.handleUpgrade(req, socket, head, (ws: any) => asyncWss.emit("connection", ws, req));
      return true;
    }
    return false;
  },

  onShutdown: () => debugLogWriter.flush(),
});

asyncRegistry = createAsyncAgentRegistry(piClients, broadcastToBrowsers);

// Async agent WebSocket handler (loopback-only, validated against active sessions)
function handleAsyncConnection(ws: any) {
  log("async agent WebSocket connected");
  let agentId: string | null = null;

  ws.on("message", (data: Buffer) => {
    try {
      const parsed = JSON.parse(data.toString());

      if (parsed.type === "async_register") {
        if (agentId && agentId !== parsed.id) {
          asyncRegistry.disconnect(ws, agentId);
          agentId = null;
        }
        const info = asyncRegistry.register(ws, parsed);
        if (info) {
          agentId = info.id;
          log(`async agent registered: ${info.id} (${info.agent})`);
        }
        return;
      }

      if (parsed.type === "async_event" && parsed.id) {
        if (asyncRegistry.event(ws, parsed)) {
          log(`async event from ${parsed.id}: ${parsed.event?.type}`);
        }
        return;
      }

      if (parsed.type === "async_complete" && parsed.id) {
        asyncRegistry.complete(ws, parsed);
        return;
      }
    } catch (e: any) { log(`async message error: ${e.message}`); }
  });

  const cleanupAsyncAgent = () => {
    asyncRegistry.disconnect(ws, agentId);
  };

  ws.on("close", cleanupAsyncAgent);
  ws.on("error", cleanupAsyncAgent);
}
asyncWss.on("connection", handleAsyncConnection);

// Clean up stale inactive sessions (disconnected > 5 min ago)
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, client] of piClients.entries()) {
    if (!client.session.active && now - client.session.lastActivity > 5 * 60 * 1000) {
      piClients.delete(sessionId);
      sessionRepoRootMap.delete(sessionId);
      log(`cleaned up stale session: ${sessionId}`);
      broadcastToBrowsers({ type: "session_removed", sessionId });
    }
  }
}, 60 * 1000); // Check every minute
if (cleanupInterval.unref) cleanupInterval.unref();

// ── Discord bot ─────────────────────────────────────────────────────

// ── Start ───────────────────────────────────────────────────────────
//
// The Discord bot starts only AFTER the port is ours. A second daemon that loses the port exits
// inside `start()`, and starting the bot at module scope meant it had already connected with the
// same token — two bots answering the same user, duplicate prompts.

start(() => {
  setupDiscordBot({
    piClients,
    piEventHooks,
    getActiveSessions,
    log,
  });
});
