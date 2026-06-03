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

// ── Discord bot ─────────────────────────────────────────────────────
//
// Optional: bridges Discord DMs to pi sessions. Enable by setting
// DISCORD_BOT_TOKEN (and optionally DISCORD_ALLOWED_USERS) in ~/.pi/discord.env.
//
// Architecture: the bot runs inside this daemon, not as a separate process.
// It has direct access to piClients/sessions — no WebSocket self-connection.

const DISCORD_ENV_FILE = path.join(process.env.HOME || "~", ".pi", "discord.env");
try {
  for (const line of fs.readFileSync(DISCORD_ENV_FILE, "utf-8").split("\n")) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

if (process.env.DISCORD_BOT_TOKEN) {
  const discordToken = process.env.DISCORD_BOT_TOKEN;
  const discordAllowedUsers = new Set(
    (process.env.DISCORD_ALLOWED_USERS || "").split(",").map((s: string) => s.trim()).filter(Boolean),
  );

  let discordAvailable = false;
  try {
    _require.resolve("discord.js");
    discordAvailable = true;
  } catch {
    log("[discord] discord.js not installed — run: npm install -g discord.js");
  }

  if (discordAvailable) {
    const {
      Client: DiscordClient, GatewayIntentBits, Partials, ChannelType,
      REST, Routes, SlashCommandBuilder,
      ActionRowBuilder, ButtonBuilder, ButtonStyle,
    } = _require("discord.js");

    const discord = new DiscordClient({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    // Track prompts that originated from Discord DMs (to suppress USER echo)
    const discordOriginatedPrompts = new Set<string>();

    // Per-user state — persisted to disk
    const DISCORD_STATE_FILE = path.join(process.env.HOME || "~", ".pi", "discord-state.json");

    interface DiscordUserState {
      watchedSessionId: string | null;
      responseChannelId: string | null;
      pendingAskUser: { id: string; sessionId: string } | null;
    }
    const discordUserStates = new Map<string, DiscordUserState>();

    function loadDiscordState() {
      try {
        const data = JSON.parse(fs.readFileSync(DISCORD_STATE_FILE, "utf-8"));
        for (const [k, v] of Object.entries(data)) discordUserStates.set(k, v as DiscordUserState);
      } catch {}
    }
    function saveDiscordState() {
      try {
        const obj: Record<string, DiscordUserState> = {};
        for (const [k, v] of discordUserStates) obj[k] = v;
        fs.writeFileSync(DISCORD_STATE_FILE, JSON.stringify(obj));
      } catch {}
    }
    loadDiscordState();

    function getDiscordState(userId: string): DiscordUserState {
      let state = discordUserStates.get(userId);
      if (!state) {
        state = {
          watchedSessionId: null,
          responseChannelId: null,
          pendingAskUser: null,
        };
        discordUserStates.set(userId, state);
      }
      return state;
    }

    function getSessionName(sessionId: string | null): string {
      if (!sessionId) return "none";
      const client = piClients.get(sessionId);
      if (!client) return "unknown";
      return client.session.cwd.split("/").pop() || client.session.cwd;
    }

    // Discord text chunking (2000 char limit)
    function chunkDiscordText(text: string): string[] {
      if (text.length <= 2000) return [text];
      const chunks: string[] = [];
      let rest = text;
      while (rest.length > 2000) {
        let cut = rest.lastIndexOf("\n", 2000);
        if (cut < 1000) cut = 2000;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n+/, "");
      }
      if (rest) chunks.push(rest);
      return chunks;
    }

    async function sendDiscordDM(channelId: string, text: string) {
      try {
        const channel = await discord.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) return;
        for (const chunk of chunkDiscordText(text)) {
          await channel.send(chunk);
        }
      } catch (e: any) {
        log(`[discord] send error: ${e.message}`);
      }
    }

    function formatDiscordSessionList(): string {
      const allSessions = getActiveSessions();
      if (allSessions.length === 0) return "No active sessions.";

      // Find watched session for any user
      const watchedIds = new Set<string>();
      for (const state of discordUserStates.values()) {
        if (state.watchedSessionId) watchedIds.add(state.watchedSessionId);
      }

      const lines = allSessions.map((s, i) => {
        const status = s.active ? (s.working ? "[active]" : "[idle]") : "[idle]";
        const watched = watchedIds.has(s.sessionId) ? " ← watching" : "";
        const name = s.cwd.split("/").pop() || s.cwd;
        return `**${i + 1}.** ${name} — ${s.model || "—"} ${s.branch ? `(${s.branch})` : ""} ${status}${watched}`;
      });

      return `**Sessions (${allSessions.length}):**\n${lines.join("\n")}\n\nUse \`/sessions\` to watch one.`;
    }

    // Forward pi events to Discord users watching that session
    function forwardToDiscord(sessionId: string, ev: any) {
      if (discordUserStates.size === 0) return;
      // Skip replay events — only forward live events
      const client = piClients.get(sessionId);
      if (client?.replaying) return;

      for (const [, state] of discordUserStates) {
        if (state.watchedSessionId !== sessionId || !state.responseChannelId) continue;

        // Show user messages from TUI in Discord
        if (ev.type === "message_start" && ev.message?.role === "user") {
          const content = ev.message.content;
          if (Array.isArray(content)) {
            const text = content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
            // Skip echo if this message originated from Discord
            if (text && discordOriginatedPrompts.has(text)) {
              discordOriginatedPrompts.delete(text);
              // Don't send — user already sees their own message in Discord
            } else if (text) {
              sendDiscordDM(state.responseChannelId!, `───
▶ **USER:** ${text}`);
            }
          }
        }

        // Typing indicator when AI is working
        if (ev.type === "agent_start" && state.responseChannelId) {
          const chId = state.responseChannelId;
          const sendTyping = async () => {
            try {
              const ch = await discord.channels.fetch(chId);
              if (ch?.sendTyping) await ch.sendTyping();
            } catch {}
          };
          sendTyping();
          if ((state as any)._typingInterval) clearInterval((state as any)._typingInterval);
          (state as any)._typingInterval = setInterval(sendTyping, 8000);
        }
        if (ev.type === "agent_end") {
          if ((state as any)._typingInterval) {
            clearInterval((state as any)._typingInterval);
            (state as any)._typingInterval = null;
          }
        }

        // Capture streaming text deltas from assistant
        if (ev.type === "message_update") {
          const ame = ev.assistantMessageEvent;
          if (ame?.type === "text_delta" && ame.delta) {
            (state as any)._lastText = ((state as any)._lastText || "") + ame.delta;
          }
        }

        // Send captured text when assistant message completes
        if (ev.type === "message_end" && ev.message?.role === "assistant") {
          const text = (state as any)._lastText || "";
          (state as any)._lastText = "";
          if (text) sendDiscordDM(state.responseChannelId!, text);
        }

        // Ask user dialogs
        if (ev.type === "extension_ui_request" && ev.id && ev.title) {
          state.pendingAskUser = { id: ev.id, sessionId };
          let msg = `**${ev.title}**\n`;
          if (ev.options && ev.options.length > 0) {
            msg += ev.options.map((o: string, i: number) => `${i + 1}. ${o}`).join("\n");
            msg += "\n\nReply with the number or text.";
          } else {
            msg += "Type your response:";
          }
          sendDiscordDM(state.responseChannelId, msg);
        }
      }
    }

    // Hook into pi event forwarding
    piEventHooks.push(forwardToDiscord);

    // Register slash commands (guild-scoped for instant availability)
    async function registerDiscordCommands(clientId: string) {
      const commands = [
        new SlashCommandBuilder()
          .setName("sessions")
          .setDescription("List pi sessions — tap a button to watch one"),
        new SlashCommandBuilder()
          .setName("status")
          .setDescription("Show current watched session info"),
        new SlashCommandBuilder()
          .setName("stop")
          .setDescription("Stop/interrupt the current agent (like Esc in terminal)"),
      ];

      const rest = new REST().setToken(discordToken);
      for (const guild of discord.guilds.cache.values()) {
        try {
          await rest.put(Routes.applicationGuildCommands(clientId, (guild as any).id), {
            body: commands.map((c: any) => c.toJSON()),
          });
          log(`[discord] slash commands registered for guild: ${(guild as any).name}`);
        } catch (e: any) {
          log(`[discord] failed to register commands for guild ${(guild as any).name}: ${e.message}`);
        }
      }
    }

    // Handle slash commands
    discord.on("interactionCreate", async (interaction: any) => {
      const safeReply = async (data: any) => {
        try { await interaction.reply(data); } catch (e: any) {
          log(`[discord] reply failed: ${e.message}`);
        }
      };

      // Handle button clicks (session selection)
      if (interaction.isButton()) {
        if (discordAllowedUsers.size > 0 && !discordAllowedUsers.has(interaction.user.id)) {
          await safeReply({ content: "Not authorized.", ephemeral: true }).catch(() => {});
          return;
        }
        if (interaction.customId === "unwatch") {
          const state = getDiscordState(interaction.user.id);
          state.watchedSessionId = null;
          saveDiscordState();
          try { discord.user.setActivity(""); } catch {}
          try {
            await interaction.update({ content: "Disconnected from all sessions.", components: [] });
          } catch {}
          return;
        }
        const match = interaction.customId.match(/^watch:(.+)$/);
        if (match) {
          const targetSessionId = match[1];
          const client = piClients.get(targetSessionId);
          if (!client) {
            await safeReply({ content: "Session no longer available.", ephemeral: true }).catch(() => {});
            return;
          }
          const session = client.session;
          const state = getDiscordState(interaction.user.id);
          state.watchedSessionId = session.sessionId;
          state.responseChannelId = interaction.channelId;

          const name = session.cwd.split("/").pop() || session.cwd;

          // Get the user's DM channel for responses
          try {
            const dmChannel = await interaction.user.createDM();
            state.responseChannelId = dmChannel.id;
          } catch {}

          try {
            await interaction.update({
              content: `Now watching: **${name}** (${session.model || "—"})`,
              components: [],
            });
          } catch (e: any) {
            log(`[discord] button update failed: ${e.message}`);
          }

          // Update bot activity to show current session
          try {
            discord.user.setActivity(`${name} (${session.model || "—"})`, { type: 3 }); // type 3 = Watching
          } catch {}

          saveDiscordState();
          log(`[discord] user ${interaction.user.username} watching: ${session.sessionId}`);
        }
        return;
      }

      if (!interaction.isChatInputCommand()) return;
      if (discordAllowedUsers.size > 0 && !discordAllowedUsers.has(interaction.user.id)) {
        await safeReply({ content: "Not authorized.", ephemeral: true });
        return;
      }

      const state = getDiscordState(interaction.user.id);
      const cmd = interaction.commandName;

      if (cmd === "sessions") {
        try {
          const allSessions = getActiveSessions();
          if (allSessions.length === 0) {
            await safeReply("No active sessions.");
            return;
          }

          // Build buttons for each session
          const rows: any[] = [];
          let currentRow = new ActionRowBuilder();
          for (let i = 0; i < Math.min(allSessions.length, 25); i++) {
            const s = allSessions[i];
            const name = (s.cwd.split("/").pop() || s.cwd).slice(0, 80);
            const isWatched = s.sessionId === state.watchedSessionId;
            currentRow.addComponents(
              new ButtonBuilder()
                .setCustomId(`watch:${s.sessionId}`)
                .setLabel(name)
                .setStyle(isWatched ? ButtonStyle.Success : (s.active ? ButtonStyle.Primary : ButtonStyle.Secondary))
            );
            if ((i + 1) % 5 === 0 || i === Math.min(allSessions.length, 25) - 1) {
              rows.push(currentRow);
              currentRow = new ActionRowBuilder();
            }
          }

          // Add unwatch button if watching something
          if (state.watchedSessionId) {
            const unwatchRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId("unwatch")
                .setLabel("Disconnect")
                .setStyle(ButtonStyle.Danger)
            );
            rows.push(unwatchRow);
          }

          const lines = allSessions.map((s, i) => {
            const name = s.cwd.split("/").pop() || s.cwd;
            const status = s.active ? (s.working ? "[active] " : "[idle] ") : "[idle] ";
            const watched = s.sessionId === state.watchedSessionId ? " **← watching**" : "";
            return `${status} **${i + 1}.** ${name} — ${s.model || "—"} ${s.branch ? `(${s.branch})` : ""}${watched}`;
          });

          await safeReply({
            content: `**Sessions (${allSessions.length}):**\n${lines.join("\n")}`,
            components: rows,
          });
        } catch (e: any) {
          log(`[discord] /sessions error: ${e.message}`);
          try { await safeReply(`Error: ${e.message}`); } catch {}
        }
        return;
      }

      if (cmd === "status") {
        if (!state.watchedSessionId) {
          await safeReply("Not watching any session. Use `/sessions` and tap a button.");
          return;
        }
        const client = piClients.get(state.watchedSessionId);
        if (!client) {
          await safeReply("Watched session no longer active.");
          state.watchedSessionId = null;
          return;
        }
        const s = client.session;
        const name = s.cwd.split("/").pop() || s.cwd;
        const status = s.active ? (s.working ? "[active]" : "[idle]") : "[idle]";
        await safeReply([
          `**Session:** ${name}`,
          `**Model:** ${s.model || "—"}`,
          `**Branch:** ${s.branch || "—"}`,
          `**Status:** ${status}`,
          `**CWD:** ${s.cwd}`,
          s.container ? "**Container:** 📦" : "",
        ].filter(Boolean).join("\n"));
        return;
      }

      if (cmd === "stop") {
        if (!state.watchedSessionId) {
          await safeReply("Not watching any session.");
          return;
        }
        const client = piClients.get(state.watchedSessionId);
        if (client?.ws) {
          client.ws.send(JSON.stringify({ type: "pidash-command", command: "abort" }));
        }
        await safeReply("⏹️ Stop signal sent.");
        return;
      }
    });

    // Download Discord attachment and convert to base64
    async function downloadAttachment(url: string): Promise<{ data: string; mimeType: string } | null> {
      try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const buffer = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get("content-type") || "application/octet-stream";
        return { data: buffer.toString("base64"), mimeType: contentType };
      } catch (e: any) {
        log(`[discord] attachment download error: ${e.message}`);
        return null;
      }
    }

    // Handle DM messages (prompts + ask_user responses)
    discord.on("raw", async (event: any) => {
      if (event.t !== "MESSAGE_CREATE") return;
      const d = event.d;
      if (d.author?.bot) return;
      if (discordAllowedUsers.size > 0 && !discordAllowedUsers.has(d.author?.id)) return;
      if (d.guild_id) return; // Only DMs

      const text = (d.content || "").trim();
      if (!text && (!d.attachments || d.attachments.length === 0)) return;

      const userId = d.author.id;
      const channelId = d.channel_id;
      const state = getDiscordState(userId);
      state.responseChannelId = channelId;

      log(`[discord] DM from ${d.author.username}: ${text.slice(0, 80)} (watched=${getSessionName(state.watchedSessionId)})`);

      // Handle /stop in DM text
      if (text.toLowerCase() === "/stop") {
        if (state.watchedSessionId) {
          const client = piClients.get(state.watchedSessionId);
          if (client?.ws) {
            client.ws.send(JSON.stringify({ type: "pidash-command", command: "abort" }));
            await sendDiscordDM(channelId, "⏹️ Stop signal sent.");
          } else {
            await sendDiscordDM(channelId, "Watched session is disconnected.");
          }
        } else {
          await sendDiscordDM(channelId, "Not watching any session.");
        }
        return;
      }

      // Handle pending ask_user response
      if (state.pendingAskUser) {
        const ask = state.pendingAskUser;
        state.pendingAskUser = null;
        const client = piClients.get(ask.sessionId);
        if (client?.ws) {
          client.ws.send(JSON.stringify({
            type: "extension_ui_response",
            id: ask.id,
            value: text,
          }));
        }
        return;
      }

      // Check if watching a session
      if (!state.watchedSessionId) {
        await sendDiscordDM(channelId, "Not watching any session. Use `/sessions` and tap a button.");
        return;
      }

      // Forward prompt to pi session
      const client = piClients.get(state.watchedSessionId);
      if (!client?.ws) {
        await sendDiscordDM(channelId, "Watched session is disconnected.");
        return;
      }

      // Process attachments (images, text files)
      const attachments = d.attachments || [];
      const images: Array<{ data: string; mimeType: string; filename: string }> = [];
      const fileContents: string[] = [];

      if (attachments.length > 0) {
        for (const att of attachments) {
          const isImage = att.content_type?.startsWith("image/");
          const isText = att.content_type?.startsWith("text/") ||
            /\.(txt|log|md|json|yaml|yml|toml|csv|xml|html|css|js|ts|py|sh|go|java|rs|rb|c|cpp|h|hpp)$/i.test(att.filename || "");

          if (isImage) {
            const downloaded = await downloadAttachment(att.url);
            if (downloaded) {
              images.push({ ...downloaded, filename: att.filename || "image" });
            }
          } else if (isText && att.size < 100000) { // <100KB text files
            try {
              const response = await fetch(att.url);
              if (response.ok) {
                const content = await response.text();
                fileContents.push(`--- ${att.filename} ---\n${content}`);
              }
            } catch (e: any) {
              log(`[discord] text file download error: ${e.message}`);
            }
          } else {
            // Binary or large file — just mention it
            fileContents.push(`[Attached file: ${att.filename} (${att.content_type}, ${(att.size / 1024).toFixed(1)}KB) — binary file not included]`);
          }
        }
      }

      // Build the prompt with any text file contents appended
      const fullText = fileContents.length > 0
        ? (text ? text + "\n\n" : "") + fileContents.join("\n\n")
        : text;

      if (!fullText && images.length === 0) return; // Nothing to send

      discordOriginatedPrompts.add(fullText || text);
      setTimeout(() => discordOriginatedPrompts.delete(fullText || text), 30000);
      client.ws.send(JSON.stringify({
        type: "prompt",
        text: fullText || "",
        images: images.length > 0 ? images : undefined,
      }));
    });

    discord.once("ready", async (c: any) => {
      log(`[discord] bot connected as ${c.user.tag}`);
      if (discordAllowedUsers.size > 0) {
        log(`[discord] allowed users: ${[...discordAllowedUsers].join(", ")}`);
      } else {
        log("[discord] WARNING: no DISCORD_ALLOWED_USERS set — all DMs accepted");
      }
      await registerDiscordCommands(c.user.id);

      // Restore activity from persisted state
      for (const [, state] of discordUserStates) {
        if (state.watchedSessionId) {
          const name = getSessionName(state.watchedSessionId);
          if (name !== "unknown" && name !== "none") {
            try { discord.user.setActivity(name, { type: 3 }); } catch {}
          }
        }
      }
    });

    discord.on("error", (e: any) => log(`[discord] error: ${e.message}`));

    discord.login(discordToken).catch((e: any) => {
      log(`[discord] login failed: ${e.message}`);
    });
  }
} else {
  log("[discord] no DISCORD_BOT_TOKEN — Discord bot disabled");
}

// ── Start ───────────────────────────────────────────────────────────

start();
