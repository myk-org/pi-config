/**
 * Discord bot for pidash — bridges Discord to pi sessions.
 *
 * This file is wiring only: the decisions that used to be buried in it (chunking,
 * attachment limits, answer mapping, state, layout, event rendering) live in the
 * sibling `discord-*.ts` modules with tests. Enable by setting DISCORD_BOT_TOKEN
 * (and DISCORD_ALLOWED_USERS, or DISCORD_ALLOW_ALL=true) in ~/.pi/discord.env.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { createLogger } from "../shared/logger.ts";
import { chunkDiscordText, NO_MENTIONS, truncateLine } from "./discord-format.ts";
import {
  classifyAttachment,
  describeSkippedAttachment,
  fetchAttachment,
  formatKB,
  MAX_IMAGE_BYTES,
} from "./discord-attachments.ts";
import {
  mapAnswer,
  renderPrompt,
  toBridgeResponse,
  isPromptExpired,
  type PendingPrompt,
  type PromptMethod,
} from "./discord-answers.ts";
import {
  buildSessionPage,
  renderSessionsPage,
  filterSessionChoices,
  BUTTONS_PER_ROW,
  type SessionSummary,
} from "./discord-sessions-view.ts";
import {
  initialRenderState,
  renderEvent,
  streamingView,
  type RenderState,
} from "./discord-render.ts";
import {
  hardenFilePermissions,
  readState,
  writeState,
  type DiscordUserState,
  type PersistedDiscordState,
} from "./discord-state.ts";

const log = createLogger("pidash-discord");

/** Discord message ids already handled — a RESUME can redeliver MESSAGE_CREATE. */
const SEEN_MESSAGE_LIMIT = 500;
/** Streaming edits are throttled to stay inside Discord's edit budget. */
const STREAM_EDIT_INTERVAL_MS = 1500;
const TYPING_REFRESH_MS = 8000;

interface RuntimeUserState extends DiscordUserState {
  pendingPrompt: PendingPrompt | null;
  render: RenderState;
  typingInterval: ReturnType<typeof setInterval> | null;
  typingSafety: ReturnType<typeof setTimeout> | null;
  lastStreamEdit: number;
}

export function setupDiscordBot(opts: {
  piClients: Map<string, any>;
  piEventHooks: Array<(sessionId: string, event: any) => void>;
  getActiveSessions: () => any[];
  log?: (msg: string) => void;
}): void {
  const { piClients, piEventHooks, getActiveSessions } = opts;
  const _require = createRequire(import.meta.url);

  const homeDir = process.env.HOME;
  if (!homeDir) {
    log.error("HOME not set — Discord bot disabled (cannot locate credentials)");
    return;
  }

  const ENV_FILE = path.join(homeDir, ".pi", "discord.env");
  const STATE_FILE = path.join(homeDir, ".pi", "discord-state.json");

  hardenFilePermissions(ENV_FILE);
  try {
    for (const line of fs.readFileSync(ENV_FILE, "utf-8").split("\n")) {
      const match = line.match(/^(\w+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {
    // No credentials file is the normal "bot disabled" case.
  }
  hardenFilePermissions(STATE_FILE);

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    log.info("no DISCORD_BOT_TOKEN — Discord bot disabled");
    return;
  }

  const allowedUsers = new Set(
    (process.env.DISCORD_ALLOWED_USERS || "").split(",").map((s) => s.trim()).filter(Boolean),
  );
  // Fail closed: a token without an allowlist used to mean "anyone who can DM the
  // bot controls the agent". Open access now has to be asked for explicitly.
  const allowAll = process.env.DISCORD_ALLOW_ALL === "true";
  if (allowedUsers.size === 0 && !allowAll) {
    log.error("DISCORD_ALLOWED_USERS is empty — refusing to start (set DISCORD_ALLOW_ALL=true to allow every user)");
    return;
  }

  try {
    _require.resolve("discord.js");
  } catch {
    log.error("discord.js is not installed — Discord bot disabled");
    return;
  }

  const {
    Client: DiscordClient, GatewayIntentBits, Partials,
    REST, Routes, SlashCommandBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder,
  } = _require("discord.js");

  const discord = new DiscordClient({
    intents: [
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  // ── state ────────────────────────────────────────────────────────────────
  const persisted: PersistedDiscordState = readState(STATE_FILE);
  const runtime = new Map<string, RuntimeUserState>();

  function userState(userId: string): RuntimeUserState {
    let state = runtime.get(userId);
    if (!state) {
      const stored = persisted.users[userId];
      state = {
        watchedSessionId: stored?.watchedSessionId ?? null,
        responseChannelId: stored?.responseChannelId ?? null,
        threadId: stored?.threadId ?? null,
        updatedAt: stored?.updatedAt ?? Date.now(),
        pendingPrompt: null,
        render: initialRenderState(),
        typingInterval: null,
        typingSafety: null,
        lastStreamEdit: 0,
      };
      runtime.set(userId, state);
    }
    return state;
  }

  function persist(): void {
    for (const [userId, state] of runtime) {
      // Pending prompts and timers never touch the disk.
      persisted.users[userId] = {
        watchedSessionId: state.watchedSessionId,
        responseChannelId: state.responseChannelId,
        threadId: state.threadId ?? null,
        updatedAt: state.updatedAt,
      };
    }
    writeState(STATE_FILE, persisted);
  }

  /** Users who asked for turn-complete notifications on unwatched sessions. */
  const notifyUsers = new Set<string>();

  const seenMessages = new Set<string>();
  function firstSighting(messageId: string): boolean {
    if (!messageId) return true;
    if (seenMessages.has(messageId)) return false;
    seenMessages.add(messageId);
    if (seenMessages.size > SEEN_MESSAGE_LIMIT) {
      const oldest = seenMessages.values().next().value;
      if (oldest) seenMessages.delete(oldest);
    }
    return true;
  }

  // ── sending ──────────────────────────────────────────────────────────────
  async function sendText(channelId: string, text: string): Promise<string | null> {
    try {
      const channel = await discord.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return null;
      let lastId: string | null = null;
      for (const chunk of chunkDiscordText(text)) {
        const sent = await (channel as any).send({ content: chunk, ...NO_MENTIONS });
        lastId = sent?.id ?? lastId;
      }
      return lastId;
    } catch (error) {
      log.warn("discord send failed", { channelId, error: String(error) });
      return null;
    }
  }

  async function editText(channelId: string, messageId: string, text: string): Promise<void> {
    try {
      const channel = await discord.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return;
      const message = await (channel as any).messages.fetch(messageId);
      await message.edit({ content: streamingView(text, 2000), ...NO_MENTIONS });
    } catch (error) {
      log.debug("discord edit failed", { messageId, error: String(error) });
    }
  }

  function startTyping(state: RuntimeUserState, channelId: string): void {
    clearTyping(state);
    const send = () => {
      discord.channels.fetch(channelId)
        .then((channel: any) => channel?.sendTyping?.())
        .catch(() => {});
    };
    send();
    state.typingInterval = setInterval(send, TYPING_REFRESH_MS);
    state.typingSafety = setTimeout(() => clearTyping(state), 5 * 60 * 1000);
  }

  function clearTyping(state: RuntimeUserState): void {
    if (state.typingInterval) clearInterval(state.typingInterval);
    if (state.typingSafety) clearTimeout(state.typingSafety);
    state.typingInterval = null;
    state.typingSafety = null;
  }

  function sessionName(sessionId: string | null): string {
    if (!sessionId) return "none";
    const client = piClients.get(sessionId);
    if (!client) return "unknown";
    return client.session.cwd.split("/").pop() || client.session.cwd;
  }

  function command(sessionId: string, payload: Record<string, unknown>): boolean {
    const client = piClients.get(sessionId);
    if (!client?.ws) return false;
    try {
      client.ws.send(JSON.stringify({ type: "pidash-command", sessionId, ...payload }));
      return true;
    } catch (error) {
      log.warn("command send failed", { sessionId, error: String(error) });
      return false;
    }
  }

  // ── pi events -> Discord ─────────────────────────────────────────────────
  function forwardSessionEvent(sessionId: string, event: any): void {
    if (runtime.size === 0) return;
    const client = piClients.get(sessionId);
    if (client?.replaying) return;

    for (const [userId, state] of runtime) {
      if (state.watchedSessionId !== sessionId) continue;
      const channelId = state.threadId || state.responseChannelId;
      if (!channelId) continue;

      const action = renderEvent(event, state.render);

      if (action.kind === "agent-start") {
        startTyping(state, channelId);
        continue;
      }

      if (action.kind === "append-text") {
        const now = Date.now();
        if (now - state.lastStreamEdit < STREAM_EDIT_INTERVAL_MS) continue;
        state.lastStreamEdit = now;
        const text = state.render.pendingText;
        if (!state.render.streamMessageId) {
          void sendText(channelId, streamingView(text, 2000)).then((id) => {
            state.render.streamMessageId = id;
            state.render.streamedText = text;
          });
        } else if (text !== state.render.streamedText) {
          void editText(channelId, state.render.streamMessageId, text).then(() => {
            state.render.streamedText = text;
          });
        }
        continue;
      }

      if (action.kind === "flush-assistant") {
        // The live message already shows this turn's text; only send a fresh
        // message when streaming never started (edit budget exhausted, or a
        // very short turn).
        if (state.render.streamMessageId) {
          void editText(channelId, state.render.streamMessageId, action.text);
          state.render.streamMessageId = null;
          state.render.streamedText = "";
        } else {
          void sendText(channelId, action.text);
        }
        continue;
      }

      if (action.kind === "tool") {
        void sendText(channelId, action.text);
        continue;
      }

      if (action.kind === "user") {
        // The prompt we just forwarded comes back as a user message; the client
        // carries the exact text, so matching it is deterministic (the old bot
        // keyed a global Set by text and raced with itself).
        if (client?.lastDiscordPrompt !== undefined) {
          const expected = client.lastDiscordPrompt;
          delete client.lastDiscordPrompt;
          if (expected === action.text) continue;
        }
        void sendText(channelId, `───\n▶ **USER:** ${action.text}`);
        continue;
      }

      if (action.kind === "agent-end") {
        clearTyping(state);
        state.render.streamMessageId = null;
        state.render.streamedText = "";
      }
    }
  }

  piEventHooks.push((sessionId: string, event: any) => {
    if (event?.type === "extension_ui_request") {
      onUiRequest(sessionId, event);
      return;
    }
    if (event?.type === "agent_settled") void notifyTurnComplete(sessionId);
    forwardSessionEvent(sessionId, event);
  });

  /**
   * Tell subscribed users that a turn finished in a session they are NOT
   * watching. This is what makes Discord useful as a monitor: the browser has
   * the same signal, and before this the bot only ever spoke about the one
   * session you had selected.
   */
  async function notifyTurnComplete(sessionId: string): Promise<void> {
    if (notifyUsers.size === 0) return;
    const client = piClients.get(sessionId);
    if (!client) return;
    const name = sessionName(sessionId);
    const model = client.session?.model || "—";
    for (const userId of notifyUsers) {
      const state = runtime.get(userId);
      if (state?.watchedSessionId === sessionId) continue;
      try {
        const user = await discord.users.fetch(userId);
        const dm = await user.createDM();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`watch:${sessionId}`).setLabel(truncateLine(`Watch ${name}`, 80)).setStyle(ButtonStyle.Primary),
        );
        await (dm as any).send({
          content: `✅ Turn finished in **${name}** (${model})`,
          components: [row],
          ...NO_MENTIONS,
        });
        log.debug("turn-complete notification sent", { userId, sessionId });
      } catch (error) {
        log.debug("notification failed", { userId, error: String(error) });
      }
    }
  }

  // ── ask-user prompts ─────────────────────────────────────────────────────
  function onUiRequest(sessionId: string, event: any): void {
    const method = (event.method || "input") as PromptMethod;
    for (const [userId, state] of runtime) {
      if (state.watchedSessionId !== sessionId) continue;
      const channelId = state.threadId || state.responseChannelId;
      if (!channelId) continue;
      state.pendingPrompt = {
        id: event.id,
        sessionId,
        method,
        options: method === "confirm" ? ["Yes", "No"] : Array.isArray(event.options) ? event.options : [],
        createdAt: Date.now(),
      };
      const title = truncateLine(String(event.title || "The agent is asking"), 500);
      const body = renderPrompt(state.pendingPrompt, title);
      const row = method === "confirm"
        ? new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`answer:${event.id}:yes`).setLabel("Approve").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`answer:${event.id}:no`).setLabel("Deny").setStyle(ButtonStyle.Danger),
          )
        : method === "select" && state.pendingPrompt.options.length > 0 && state.pendingPrompt.options.length <= 25
          ? new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId(`answer:${event.id}:select`)
                .setPlaceholder("Choose an option")
                .addOptions(state.pendingPrompt.options.slice(0, 25).map((option: string, i: number) => ({
                  label: truncateLine(option, 100), value: String(i),
                }))),
            )
          : null;
      void sendText(channelId, body).then((sentId) => {
        if (sentId && row) {
          void discord.channels.fetch(channelId)
            .then((channel: any) => channel?.messages?.fetch(sentId))
            .then((message: any) => message?.edit({ components: [row] }))
            .catch(() => {});
        }
      });
      log.info("prompt forwarded to discord", { userId, sessionId, method });
    }
  }

  // ── slash commands ───────────────────────────────────────────────────────
  const COMMANDS = [
    ["sessions", "List pi sessions — pick one to watch"],
    ["status", "Show the watched session"],
    ["stop", "Interrupt the running turn"],
    ["compact", "Compact the watched session's context"],
    ["model", "Show or set the model"],
    ["thinking", "Show or set the thinking level"],
    ["tasks", "List tasks in the watched session"],
    ["coms", "List coms peers in the watched session's project"],
    ["memory", "Memory status of the watched session"],
    ["diff", "Link to the session's diff viewer"],
    ["watch", "Watch a session by name"],
    ["notify", "Turn turn-complete notifications on or off"],
    ["file", "Send a file from the session's working directory"],
  ] as const;

  async function registerCommands(clientId: string, guildId?: string): Promise<void> {
    const rest = new REST().setToken(token);
    const builders = COMMANDS.map(([name, description]) => {
      const builder = new SlashCommandBuilder().setName(name).setDescription(description);
      if (name === "model") builder.addStringOption((o: any) => o.setName("value").setDescription("Model id to switch to"));
      if (name === "thinking") builder.addStringOption((o: any) => o.setName("value").setDescription("off | minimal | low | medium | high | xhigh | max"));
      if (name === "watch") {
        builder.addStringOption((o: any) =>
          o.setName("session").setDescription("Session to watch").setRequired(true).setAutocomplete(true));
      }
      if (name === "notify") builder.addStringOption((o: any) => o.setName("state").setDescription("on | off"));
      if (name === "file") builder.addStringOption((o: any) => o.setName("path").setDescription("Path relative to the session cwd").setRequired(true));
      return builder;
    });
    const body = builders.map((b: any) => b.toJSON());
    try {
      if (guildId) await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
      else await rest.put(Routes.applicationCommands(clientId), { body });
      log.info("slash commands registered", { scope: guildId ? `guild:${guildId}` : "global" });
    } catch (error) {
      log.warn("slash command registration failed", { guildId, error: String(error) });
    }
  }

  // ── interactions ─────────────────────────────────────────────────────────
  discord.on("interactionCreate", async (interaction: any) => {
    const authorized = allowAll || allowedUsers.has(interaction.user?.id);
    if (!authorized) {
      if (interaction.isRepliable?.()) {
        await interaction.reply({ content: "Not authorized.", ephemeral: true }).catch(() => {});
      }
      log.warn("unauthorized discord interaction rejected", { user: interaction.user?.id });
      return;
    }

    const state = userState(interaction.user.id);
    state.updatedAt = Date.now();

    if (interaction.isAutocomplete?.()) {
      const focused = interaction.options.getFocused(true);
      const choices = filterSessionChoices(sessionSummaries(), String(focused?.value ?? ""));
      await interaction.respond(choices).catch(() => {});
      return;
    }

    // Buttons and selects
    if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
      const customId: string = interaction.customId || "";
      if (customId === "unwatch") {
        state.watchedSessionId = null;
        state.threadId = null;
        persist();
        await interaction.update({ content: "Disconnected.", components: [] }).catch(() => {});
        return;
      }
      const watch = customId.match(/^watch:(.+)$/);
      if (watch) {
        await switchWatch(state, interaction, watch[1]);
        return;
      }
      const page = customId.match(/^sessions:(\d+)$/);
      if (page) {
        const sessions = sessionSummaries();
        const built = buildSessionPage(sessions, Number(page[1]));
        await interaction.update({
          content: renderSessionsPage(built, state.watchedSessionId),
          components: sessionComponents(built, state),
        }).catch(() => {});
        return;
      }
      const answer = customId.match(/^answer:([^:]+):(.+)$/);
      if (answer) {
        const [, promptId, choice] = answer;
        const prompt = state.pendingPrompt;
        if (!prompt || prompt.id !== promptId) {
          await interaction.reply({ content: "That prompt is no longer waiting.", ephemeral: true }).catch(() => {});
          return;
        }
        const raw = interaction.isStringSelectMenu?.()
          ? String(Number(interaction.values?.[0]) + 1)
          : choice;
        resolvePrompt(prompt, String(raw), state, interaction);
        return;
      }
      return;
    }

    if (!interaction.isChatInputCommand?.()) return;
    const name = interaction.commandName;
    const watched = state.watchedSessionId;

    if (name === "sessions") {
      const sessions = sessionSummaries();
      const built = buildSessionPage(sessions, 1);
      await interaction.reply({
        content: sessions.length ? renderSessionsPage(built, watched) : "No active sessions.",
        components: sessions.length ? sessionComponents(built, state) : [],
        ephemeral: true, // session names/branches are not for the whole channel
      }).catch((error: any) => log.warn("sessions reply failed", { error: String(error) }));
      return;
    }

    if (name === "notify") {
      const target = (interaction.options?.getString?.("state") || "on").toLowerCase();
      const enable = target !== "off";
      if (enable) notifyUsers.add(interaction.user.id);
      else notifyUsers.delete(interaction.user.id);
      await interaction.reply({
        content: enable ? "Turn-complete notifications on for every session." : "Turn-complete notifications off.",
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    if (name === "watch") {
      const wanted = interaction.options?.getString?.("session", true) || "";
      const sessions = sessionSummaries();
      const exact = sessions.find((s) => s.sessionId === wanted);
      const picked = exact || (filterSessionChoices(sessions, wanted, 1)[0]
        ? sessions.find((s) => s.sessionId === filterSessionChoices(sessions, wanted, 1)[0].value)
        : undefined);
      if (!picked) {
        await interaction.reply({ content: `No session matches \`${wanted}\`.`, ephemeral: true }).catch(() => {});
        return;
      }
      await switchWatch(state, interaction, picked.sessionId);
      return;
    }

    if (!watched) {
      await interaction.reply({ content: "Not watching any session. Use `/sessions` first.", ephemeral: true }).catch(() => {});
      return;
    }
    const client = piClients.get(watched);
    if (!client) {
      state.watchedSessionId = null;
      persist();
      await interaction.reply({ content: "The watched session is gone; cleared.", ephemeral: true }).catch(() => {});
      return;
    }
    const session = client.session;

    if (name === "status") {
      await interaction.reply({
        content: [
          `**Session:** ${sessionName(watched)}`,
          `**Model:** ${session.model || "—"}`,
          `**Branch:** ${session.branch || "—"}`,
          `**Status:** ${session.active ? (session.working ? "working" : "idle") : "detached"}`,
          `**CWD:** ${session.cwd}`,
        ].join("\n"),
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    if (name === "stop") {
      const sent = command(watched, { command: "abort" });
      await interaction.reply({ content: sent ? "⏹️ Stop sent." : "Session is not connected.", ephemeral: true }).catch(() => {});
      return;
    }

    if (name === "compact") {
      const sent = command(watched, { command: "compact" });
      await interaction.reply({ content: sent ? "🗜️ Compacting." : "Session is not connected.", ephemeral: true }).catch(() => {});
      return;
    }

    const value = interaction.options?.getString?.("value") || "";
    if (name === "model") {
      if (!value) {
        await interaction.reply({ content: `Model: **${session.model || "—"}**`, ephemeral: true }).catch(() => {});
        return;
      }
      command(watched, { command: "set-model", modelId: value });
      await interaction.reply({ content: `Switching model to \`${value}\`.`, ephemeral: true }).catch(() => {});
      return;
    }

    if (name === "thinking") {
      if (!value) {
        await interaction.reply({ content: `Thinking: **${session.thinkingLevel || "medium"}**`, ephemeral: true }).catch(() => {});
        return;
      }
      command(watched, { command: "set-thinking", level: value });
      await interaction.reply({ content: `Thinking → \`${value}\`.`, ephemeral: true }).catch(() => {});
      return;
    }

    if (name === "file") {
      const relative = interaction.options?.getString?.("path", true) || "";
      await sendWorkspaceFile(state, interaction, session.cwd, relative);
      return;
    }

    for (const passthrough of ["tasks", "coms", "memory", "diff"] as const) {
      if (name !== passthrough) continue;
      if (passthrough === "diff") {
        await interaction.reply({
          content: session.diffPort ? `Diff viewer: http://localhost:${session.diffPort}` : "No diff viewer for this session.",
          ephemeral: true,
        }).catch(() => {});
        return;
      }
      // These are answered by a broadcast event the browser also consumes; the
      // simplest correct thing here is a one-shot request and a short wait.
      const requestId = `discord-${Date.now()}`;
      const response = await requestOnce(watched, `${passthrough}-list`, requestId);
      await interaction.reply({ content: response, ephemeral: true }).catch(() => {});
      return;
    }
  });

  function resolvePrompt(
    prompt: PendingPrompt,
    raw: string,
    state: RuntimeUserState,
    interaction: any,
  ): void {
    if (isPromptExpired(prompt)) {
      state.pendingPrompt = null;
      void interaction.reply({ content: "That prompt expired.", ephemeral: true }).catch(() => {});
      return;
    }
    const answer = mapAnswer(prompt, raw);
    if (answer.kind === "reject") {
      void interaction.reply({ content: `Didn't understand that: ${answer.reason}.`, ephemeral: true }).catch(() => {});
      return;
    }
    const payload = toBridgeResponse(prompt, answer);
    const client = piClients.get(prompt.sessionId);
    if (payload && client?.ws) {
      client.ws.send(JSON.stringify({ ...payload, sessionId: prompt.sessionId }));
      state.pendingPrompt = null;
      void interaction.update({ content: "Answer sent.", components: [] }).catch(() => {});
      log.info("prompt answered from discord", { id: prompt.id, kind: answer.kind });
    } else {
      void interaction.reply({ content: "Session is not connected.", ephemeral: true }).catch(() => {});
    }
  }

  /**
   * Point this user at a session. In a guild the conversation moves into a
   * thread named after the session, so history per session survives a restart
   * and several watchers do not share one DM stream. Outside a guild (or when
   * threads are unavailable) it falls back to the DM channel.
   */
  async function switchWatch(state: RuntimeUserState, interaction: any, sessionId: string): Promise<void> {
    const client = piClients.get(sessionId);
    if (!client) {
      await interaction.reply?.({ content: "Session no longer available.", ephemeral: true }).catch(() => {});
      return;
    }
    state.watchedSessionId = client.session.sessionId;
    const name = sessionName(state.watchedSessionId);
    // Deliberately no model/branch here: a thread lives in a guild channel, and
    // session inventory in a shared channel is exactly the leak past reviews
    // flagged. The ephemeral command reply carries the details instead.
    const header = `Now watching **${name}**.`;

    let threadId: string | null = null;
    if (interaction.guildId && interaction.channel?.threads?.create) {
      try {
        const thread = await interaction.channel.threads.create({
          name: truncateLine(name, 90),
          autoArchiveDuration: 1440,
          reason: `pi session ${name}`,
        });
        threadId = thread.id;
        log.info("watching in a thread", { threadId, sessionId });
      } catch (error) {
        log.warn("thread creation failed, falling back to DM", { error: String(error) });
      }
    }
    state.threadId = threadId;
    if (!threadId) {
      try {
        state.responseChannelId = (await interaction.user.createDM()).id;
      } catch {
        log.warn("could not open DM", { user: interaction.user.username });
      }
    }
    persist();

    const target = threadId || state.responseChannelId;
    if (threadId) {
      await sendText(threadId, `${header} Ask here; slash commands still work in the server.`);
    }
    await interaction.update?.({
      content: threadId
        ? `${header} Continue in the thread.`
        : `${header} (${client.session.model || "—"}) Send prompts in DM.`,
      components: [],
    }).catch(() => {});
    if (!target) log.warn("no channel for responses", { sessionId });
  }

  /**
   * Send a file from the session's working directory.
   *
   * Confined to the cwd on purpose: this is a chat command, not a file-server,
   * so `..` and absolute paths are refused rather than resolved.
   */
  async function sendWorkspaceFile(
    state: RuntimeUserState,
    interaction: any,
    cwd: string,
    relative: string,
  ): Promise<void> {
    const resolved = path.resolve(cwd, relative);
    const root = path.resolve(cwd);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      await interaction.reply({ content: "Path is outside the session directory.", ephemeral: true }).catch(() => {});
      return;
    }
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        await interaction.reply({ content: "That is not a file.", ephemeral: true }).catch(() => {});
        return;
      }
      if (stat.size > MAX_IMAGE_BYTES) {
        await interaction.reply({ content: `File is ${formatKB(stat.size)} — over the ${formatKB(MAX_IMAGE_BYTES)} limit.`, ephemeral: true }).catch(() => {});
        return;
      }
      const channelId = state.threadId || state.responseChannelId;
      if (!channelId) {
        await interaction.reply({ content: "No channel to send to yet — watch a session first.", ephemeral: true }).catch(() => {});
        return;
      }
      await interaction.deferReply?.({ ephemeral: true }).catch(() => {});
      const channel = await discord.channels.fetch(channelId);
      await (channel as any).send({ files: [{ attachment: fs.readFileSync(resolved), name: path.basename(resolved) }], ...NO_MENTIONS });
      await interaction.editReply?.({ content: `Sent \`${path.basename(resolved)}\`.` }).catch(() => {});
      log.info("file sent to discord", { file: path.basename(resolved), size: stat.size });
    } catch (error) {
      await interaction.reply({ content: `Could not read that file: ${String(error).slice(0, 120)}`, ephemeral: true }).catch(() => {});
    }
  }

  function sessionSummaries(): SessionSummary[] {
    return getActiveSessions().map((session: any) => ({
      sessionId: session.sessionId,
      cwd: session.cwd,
      model: session.model,
      branch: session.branch,
      active: session.active,
      working: session.working,
      name: session.name,
      agentType: session.agentType,
    }));
  }

  function sessionComponents(page: ReturnType<typeof buildSessionPage>, state: RuntimeUserState): any[] {
    const rows: any[] = [];
    for (let i = 0; i < page.items.length; i += BUTTONS_PER_ROW) {
      const row = new ActionRowBuilder();
      for (const session of page.items.slice(i, i + BUTTONS_PER_ROW)) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`watch:${session.sessionId}`)
            .setLabel(truncateLine(session.name || session.cwd.split("/").pop() || session.cwd, 80))
            .setStyle(session.sessionId === state.watchedSessionId ? ButtonStyle.Success : ButtonStyle.Secondary),
        );
      }
      rows.push(row);
    }
    // Exactly one navigation row at most: sessions occupy at most 4 rows by
    // construction (SESSIONS_PER_PAGE), so this can never exceed Discord's 5.
    const nav = new ActionRowBuilder();
    let navUsed = false;
    if (page.pages > 1) {
      nav.addComponents(
        new ButtonBuilder().setCustomId(`sessions:${page.page - 1}`).setLabel("◀").setStyle(ButtonStyle.Secondary).setDisabled(page.page <= 1),
        new ButtonBuilder().setCustomId(`sessions:${page.page + 1}`).setLabel("▶").setStyle(ButtonStyle.Secondary).setDisabled(page.page >= page.pages),
      );
      navUsed = true;
    }
    if (state.watchedSessionId) {
      nav.addComponents(new ButtonBuilder().setCustomId("unwatch").setLabel("Disconnect").setStyle(ButtonStyle.Danger));
      navUsed = true;
    }
    if (navUsed) rows.push(nav);
    return rows.slice(0, 5);
  }

  /** One-shot request/response against a session's broadcast events. */
  async function requestOnce(sessionId: string, commandName: string, requestId: string): Promise<string> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        piEventHooks.splice(piEventHooks.indexOf(hook), 1);
        resolve("Timed out waiting for the session.");
      }, 5000);
      const hook = (eventSessionId: string, event: any) => {
        if (eventSessionId !== sessionId) return;
        if (event.requestId && event.requestId !== requestId) return;
        if (!/^(tasks|coms|memory)/.test(String(event.type || ""))) return;
        clearTimeout(timer);
        const index = piEventHooks.indexOf(hook);
        if (index >= 0) piEventHooks.splice(index, 1);
        resolve(`\`\`\`json\n${JSON.stringify(event).slice(0, 1800)}\n\`\`\``);
      };
      piEventHooks.push(hook);
      if (!command(sessionId, { command: commandName, requestId })) {
        clearTimeout(timer);
        const index = piEventHooks.indexOf(hook);
        if (index >= 0) piEventHooks.splice(index, 1);
        resolve("Session is not connected.");
      }
    });
  }

  // ── DMs ──────────────────────────────────────────────────────────────────
  discord.on("messageCreate", async (message: any) => {
    if (!message || message.author?.bot) return;
    if (message.guildId) return; // DMs only; the server is the control surface
    if (!firstSighting(message.id)) {
      log.debug("duplicate discord message ignored", { id: message.id });
      return;
    }
    const userId = message.author.id;
    const authorized = allowAll || allowedUsers.has(userId);
    if (!authorized) {
      // One reply, then silence: a mistyped user id used to look like a dead bot.
      if (firstSighting(`${message.id}:auth`)) {
        await message.reply("Not authorized.").catch(() => {});
      }
      log.warn("unauthorized discord DM", { userId });
      return;
    }

    const state = userState(userId);
    state.updatedAt = Date.now();
    state.responseChannelId = message.channelId;

    const text = (message.content || "").trim();

    // A pending prompt owns the next message — but only if it is still valid and
    // the text actually answers it. Anything else falls through to a prompt, so
    // the user's message is never silently swallowed.
    if (state.pendingPrompt) {
      const prompt = state.pendingPrompt;
      if (isPromptExpired(prompt)) {
        state.pendingPrompt = null;
        await message.reply("The waiting prompt expired; sending your message as a new prompt.").catch(() => {});
      } else {
        const answer = mapAnswer(prompt, text);
        if (answer.kind !== "reject") {
          const payload = toBridgeResponse(prompt, answer);
          const client = piClients.get(prompt.sessionId);
          if (payload && client?.ws) {
            client.ws.send(JSON.stringify({ ...payload, sessionId: prompt.sessionId }));
            state.pendingPrompt = null;
            await message.reply(answer.kind === "cancel" ? "Dismissed." : "Answer sent.").catch(() => {});
            return;
          }
          await message.reply("The session is not connected.").catch(() => {});
          return;
        }
        await message.reply(`That prompt is still waiting — ${answer.reason}, or /cancel.`).catch(() => {});
        return;
      }
    }

    if (/^\/stop$/i.test(text)) {
      if (!state.watchedSessionId) {
        await message.reply("Not watching any session.").catch(() => {});
        return;
      }
      const sent = command(state.watchedSessionId, { command: "abort" });
      await message.reply(sent ? "⏹️ Stop sent." : "Session is not connected.").catch(() => {});
      return;
    }
    if (/^\/cancel$/i.test(text)) {
      state.pendingPrompt = null;
      await message.reply("Nothing pending.").catch(() => {});
      return;
    }

    if (!state.watchedSessionId) {
      await message.reply("Not watching any session. Use `/sessions` and pick one.").catch(() => {});
      return;
    }
    const client = piClients.get(state.watchedSessionId);
    if (!client?.ws) {
      await message.reply("The watched session is disconnected.").catch(() => {});
      return;
    }

    const notes: string[] = [];
    const images: Array<{ data: string; mimeType: string; filename: string }> = [];
    for (const attachment of message.attachments?.values?.() ?? []) {
      const plan = classifyAttachment({
        url: attachment.url,
        filename: attachment.name,
        contentType: attachment.contentType ?? undefined,
        size: attachment.size,
      });
      if (plan.kind === "image") {
        const fetched = await fetchAttachment(plan.url);
        if (fetched) images.push({ data: fetched.buffer.toString("base64"), mimeType: fetched.contentType, filename: plan.filename });
        else notes.push(`[Could not download ${plan.filename}]`);
        continue;
      }
      if (plan.kind === "text") {
        const fetched = await fetchAttachment(plan.url);
        if (fetched) notes.push(`--- ${plan.filename} ---\n${fetched.buffer.toString("utf-8")}`);
        else notes.push(`[Could not download ${plan.filename}]`);
        continue;
      }
      const described = describeSkippedAttachment(plan);
      if (described) notes.push(described);
    }

    if (!text && images.length === 0 && notes.length === 0) return;

    const fullText = notes.length ? (text ? `${text}\n\n` : "") + notes.join("\n\n") : text;
    client.lastDiscordPrompt = fullText;
    client.ws.send(JSON.stringify({ type: "prompt", text: fullText, images: images.length ? images : undefined }));
    log.info("prompt forwarded from discord", { userId, session: sessionName(state.watchedSessionId), chars: fullText.length, images: images.length });
  });

  // ── lifecycle ────────────────────────────────────────────────────────────
  discord.once("ready", async (client: any) => {
    log.info("bot connected", { tag: client.user.tag, allowAll, allowed: allowedUsers.size });
    await registerCommands(client.user.id); // global: makes commands work in DMs too
    for (const guild of discord.guilds.cache.values()) {
      await registerCommands(client.user.id, (guild as any).id);
    }
  });

  // A bot invited after startup still gets its guild commands.
  discord.on("guildCreate", async (guild: any) => {
    log.info("joined guild, registering commands", { guild: guild.name });
    if (discord.user?.id) await registerCommands(discord.user.id, guild.id);
  });

  discord.on("error", (error: any) => log.error("discord client error", { error: String(error) }));

  discord.login(token).catch((error: any) => log.error("discord login failed", { error: String(error) }));

  // The daemon can exit without unwinding our timers; clear them explicitly.
  const shutdown = () => {
    for (const state of runtime.values()) clearTyping(state);
    persist();
    try { discord.destroy(); } catch {}
    log.info("discord bot stopped");
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.once("beforeExit", shutdown);
}
