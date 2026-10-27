/**
 * Discord bot for pidash — bridges Discord to pi sessions.
 *
 * Wiring only: the decisions live in the sibling `discord-*.ts` modules with
 * tests (format, attachments, answers, state, sessions-view, render, config).
 * Enable by setting DISCORD_BOT_TOKEN plus DISCORD_ALLOWED_USERS (or
 * DISCORD_ALLOW_ALL=true) in ~/.pi/discord.env.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { createLogger } from "../shared/logger.ts";
import { chunkDiscordText, NO_MENTIONS, truncateLine, DISCORD_TEXT_LIMIT } from "./discord-format.ts";
import {
  classifyAttachment,
  describeSkippedAttachment,
  fetchAttachment,
  formatKB,
  imageSupportNote,
  MAX_IMAGE_BYTES,
  MAX_INLINE_TEXT_BYTES,
} from "../shared/chat/chat-attachments.ts";
import { renderPrompt, type PendingPrompt, type PromptMethod } from "../shared/chat/chat-prompts.ts";
import {
  buildSessionPage,
  renderSessionsPage,
  filterSessionChoices,
  sessionLabel,
  BUTTONS_PER_ROW,
  WATCH_OPTION_NAME,
  type SessionSummary,
} from "../shared/chat/chat-sessions.ts";
import { streamingView } from "../shared/chat/chat-events.ts";
import {
  createChatBridge,
  initialChatRuntime,
  type ChatBridge,
  type ChatRuntimeState,
} from "../shared/chat/chat-bridge.ts";
import type { ChatAdapter, ChatCapabilities, ChatTarget } from "../shared/chat/chat-types.ts";
import {
  hardenFilePermissions,
  readState,
  writeState,
  MAX_THREADS_PER_USER,
  type DiscordUserState,
  type PersistedDiscordState,
} from "../shared/chat/chat-state.ts";
import { parseEnvFile, resolveDiscordConfig } from "./discord-config.ts";

const log = createLogger("pidash-discord");

const SEEN_MESSAGE_LIMIT = 500;
const STREAM_EDIT_INTERVAL_MS = 1500;
const TYPING_REFRESH_MS = 8000;
/** One "not authorized" reply per user per window, not per message. */
const UNAUTHORIZED_NOTICE_MS = 10 * 60 * 1000;

/** Commands whose answer arrives as a broadcast event, with the exact type. */
const PASSTHROUGH: Record<string, { command: string; eventType: string; label: string }> = {
  tasks: { command: "tasks-list", eventType: "tasks-list", label: "Tasks" },
  coms: { command: "coms-peers", eventType: "coms-peers", label: "Coms peers" },
  memory: { command: "memory-status", eventType: "memory-status", label: "Memory" },
  mcp: { command: "mcp-list", eventType: "mcp-list", label: "MCP servers" },
};

/** Discord's runtime state = the engine's state + platform bookkeeping. */
interface RuntimeUserState extends DiscordUserState, ChatRuntimeState {
  typingInterval: ReturnType<typeof setInterval> | null;
  typingSafety: ReturnType<typeof setTimeout> | null;
  unauthorizedNotifiedAt: number;
}

export function setupDiscordBot(opts: {
  piClients: Map<string, any>;
  piEventHooks: Array<(sessionId: string, event: any) => void>;
  getActiveSessions: () => any[];
  log?: (msg: string) => void;
}): void {
  const { piClients, piEventHooks, getActiveSessions } = opts;
  const _require = createRequire(import.meta.url);

  const home = process.env.HOME;
  // Credentials file may define the token itself. The path is resolved from the
  // environment FIRST — the configured path used to be computed later and the
  // file was already read from the default location (Qodo 6ebd5ca4).
  let envFile = process.env.PIDASH_DISCORD_ENV_FILE
    || path.join(home || "", ".pi", "discord.env");
  hardenFilePermissions(envFile);
  try {
    Object.assign(process.env, {
      ...parseEnvFile(fs.readFileSync(envFile, "utf-8")),
      ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
    });
  } catch {
    // Missing file is the normal "bot disabled" case.
  }

  const resolved = resolveDiscordConfig(process.env, home);
  if (!resolved.ok) {
    log.info("discord bot disabled", { reason: resolved.reason });
    return;
  }
  const { config } = resolved;
  envFile = config.envFile;
  hardenFilePermissions(envFile);
  hardenFilePermissions(config.stateFile);

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
  const persisted: PersistedDiscordState = readState(config.stateFile);
  const runtime = new Map<string, RuntimeUserState>();

  function makeRuntime(stored: DiscordUserState | undefined): RuntimeUserState {
    const watched = stored?.watchedSessionId ?? null;
    const channelId = stored?.threadId || stored?.responseChannelId || null;
    return {
      ...initialChatRuntime(watched, channelId ? { channelId, threadId: stored?.threadId ?? null } : null),
      responseChannelId: stored?.responseChannelId ?? null,
      threadId: stored?.threadId ?? null,
      threads: { ...(stored?.threads ?? {}) },
      updatedAt: stored?.updatedAt ?? Date.now(),
      typingInterval: null,
      typingSafety: null,
      unauthorizedNotifiedAt: 0,
    };
  }

  // Saved watches must be live again after a restart: the loops below iterate
  // `runtime`, and a lazily-created entry meant a restored watch received no
  // output or approval prompts until its user happened to interact (Qodo).
  for (const [userId, stored] of Object.entries(persisted.users)) {
    runtime.set(userId, makeRuntime(stored));
  }
  log.info("discord state hydrated", { users: runtime.size, watching: [...runtime.values()].filter((s) => s.watchedSessionId).length });

  function userState(userId: string): RuntimeUserState {
    let state = runtime.get(userId);
    if (!state) {
      state = makeRuntime(persisted.users[userId]);
      runtime.set(userId, state);
    }
    return state;
  }

  function persist(): void {
    for (const [userId, state] of runtime) {
      persisted.users[userId] = {
        watchedSessionId: state.watchedSessionId,
        responseChannelId: state.responseChannelId,
        threadId: state.threadId ?? null,
        threads: state.threads ?? {},
        updatedAt: state.updatedAt,
      };
    }
    writeState(config.stateFile, persisted);
  }

  /** userId owning a thread, so prompts inside it reach the right session. */
  function userForThread(threadId: string): [string, RuntimeUserState] | null {
    for (const [userId, state] of runtime) {
      if (state.threadId === threadId) return [userId, state];
      for (const known of Object.values(state.threads ?? {})) {
        if (known === threadId) return [userId, state];
      }
    }
    return null;
  }

  const seenMessages = new Set<string>();
  function firstSighting(key: string): boolean {
    if (!key) return true;
    if (seenMessages.has(key)) return false;
    seenMessages.add(key);
    if (seenMessages.size > SEEN_MESSAGE_LIMIT) {
      const oldest = seenMessages.values().next().value;
      if (oldest) seenMessages.delete(oldest);
    }
    return true;
  }

  const notifyUsers = new Set<string>();

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

  async function editText(channelId: string, messageId: string, text: string): Promise<boolean> {
    try {
      const channel = await discord.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return false;
      const message = await (channel as any).messages.fetch(messageId);
      await message.edit({ content: streamingView(text, DISCORD_TEXT_LIMIT), ...NO_MENTIONS });
      return true;
    } catch (error) {
      log.debug("discord edit failed", { messageId, error: String(error) });
      return false;
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

  // ── the shared chat engine, with Discord as its adapter ─────────────────
  const capabilities: ChatCapabilities = {
    maxMessageLength: DISCORD_TEXT_LIMIT,
    maxButtonsPerRow: BUTTONS_PER_ROW,
    maxActionRows: 5,
    supportsEdit: true,
    supportsTyping: true,
    supportsThreads: true,
    supportsAttachments: true,
  };

  const adapter: ChatAdapter = {
    platform: "discord",
    capabilities,
    log,
    async sendText(target: ChatTarget, text: string): Promise<string | null> {
      return sendText(target.threadId || target.channelId, text);
    },
    async editText(target: ChatTarget, messageId: string, text: string): Promise<boolean> {
      return editText(target.threadId || target.channelId, messageId, text);
    },
    async setTyping(target: ChatTarget, active: boolean): Promise<void> {
      const channelId = target.threadId || target.channelId;
      const state = [...runtime.values()].find((s) => (s.threadId || s.responseChannelId) === channelId);
      if (!state) return;
      if (active) startTyping(state, channelId);
      else clearTyping(state);
    },
  };

  const bridge: ChatBridge = createChatBridge({
    adapter,
    promptTtlMs: config.promptTtlMs,
    streamEditIntervalMs: STREAM_EDIT_INTERVAL_MS,
    users: () => runtime.entries(),
    sendToSession: (sessionId, payload) => {
      const client = piClients.get(sessionId);
      if (!client?.ws) return false;
      try {
        client.ws.send(JSON.stringify({ ...payload, sessionId }));
        return true;
      } catch (error) {
        log.warn("bridge send failed", { sessionId, error: String(error) });
        return false;
      }
    },
  });

  /**
   * The daemon dispatches session events ONLY through registered hooks, so this
   * registration is what makes the bot live at all. Questions take the Discord
   * path (native buttons/menus); everything else goes through the engine.
   */
  piEventHooks.push((sessionId: string, event: any) => {
    if (event?.type === "extension_ui_request") {
      onUiRequest(sessionId, event);
      return;
    }
    if (runtime.size === 0) return;
    // Replay frames are history, not live activity.
    if (piClients.get(sessionId)?.replaying) return;
    bridge.onPiEvent(sessionId, event);
  });

  // ── ask-user prompts ─────────────────────────────────────────────────────
  /**
   * Rendering the native controls stays here (buttons/menus are Discord's), but
   * the pending-prompt lifecycle — TTL, dismissal, answer validation — belongs to
   * the engine, so the next client inherits it for free.
   */
  function onUiRequest(sessionId: string, event: any): void {
    if (event?.type === "ui-dismiss" || event?.type === "ui_prompt_end") {
      bridge.onUiEvent(sessionId, event);
      return;
    }
    const method = (event.method || "input") as PromptMethod;
    for (const [userId, state] of runtime) {
      if (state.watchedSessionId !== sessionId) continue;
      const target = state.target;
      if (!target) continue;
      const prompt = bridge.askUser(sessionId, event, state);
      if (!prompt) continue;
      const row = method === "confirm"
        ? new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`answer:${prompt.id}:yes`).setLabel("Approve").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`answer:${prompt.id}:no`).setLabel("Deny").setStyle(ButtonStyle.Danger),
          )
        : prompt.options.length > 0 && prompt.options.length <= 25
          ? new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId(`answer:${prompt.id}:select`)
                .setPlaceholder("Choose an option")
                .addOptions(prompt.options.slice(0, 25).map((option: string, i: number) => ({
                  label: truncateLine(option, 100), value: String(i),
                }))),
            )
          : null;
      log.info("prompt forwarded to discord", { userId, sessionId, method, controls: Boolean(row) });
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
    ["mcp", "MCP servers known to the watched session"],
    ["diff", "Link to the session's diff viewer"],
    ["watch", "Watch a session by name"],
    ["notify", "Turn turn-complete notifications on or off"],
    ["file", "Send a file from the session's working directory"],
  ] as const;

  async function registerCommands(clientId: string, guildId?: string): Promise<void> {
    const rest = new REST().setToken(config.token);
    const builders = COMMANDS.map(([name, description]) => {
      const builder = new SlashCommandBuilder().setName(name).setDescription(description);
      if (name === "model") builder.addStringOption((o: any) => o.setName("value").setDescription("Model id to switch to"));
      if (name === "thinking") builder.addStringOption((o: any) => o.setName("value").setDescription("off | minimal | low | medium | high | xhigh | max"));
      if (name === "watch") {
        builder.addStringOption((o: any) =>
          o.setName(WATCH_OPTION_NAME).setDescription("Session to watch").setRequired(true).setAutocomplete(true));
      }
      if (name === "notify") builder.addStringOption((o: any) => o.setName("state").setDescription("on | off"));
      if (name === "file") builder.addStringOption((o: any) => o.setName("path").setDescription("Path relative to the session cwd").setRequired(true));
      return builder;
    });
    const body = builders.map((b: any) => b.toJSON());
    try {
      if (guildId) await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
      else await rest.put(Routes.applicationCommands(clientId), { body });
      log.info("slash commands registered", { scope: guildId ? `guild:${guildId}` : "global", count: body.length });
    } catch (error) {
      log.warn("slash command registration failed", { guildId, error: String(error) });
    }
  }

  // ── interaction helpers ──────────────────────────────────────────────────
  const isComponent = (interaction: any) => Boolean(interaction.isButton?.() || interaction.isStringSelectMenu?.());

  /** Reply whether this came from a component or a slash command. */
  async function acknowledge(interaction: any, content: string, ephemeral = true): Promise<void> {
    try {
      if (isComponent(interaction)) await interaction.update({ content, components: [] });
      else if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
      else await interaction.reply({ content, ephemeral });
    } catch (error) {
      log.debug("acknowledge failed", { error: String(error) });
    }
  }

  // ── interactions ─────────────────────────────────────────────────────────
  discord.on("interactionCreate", async (interaction: any) => {
    const authorized = config.allowAll || config.allowedUsers.has(interaction.user?.id);
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
      await interaction.respond(filterSessionChoices(sessionSummaries(), String(focused?.value ?? ""))).catch(() => {});
      return;
    }

    if (isComponent(interaction)) {
      const customId: string = interaction.customId || "";
      if (customId === "unwatch") {
        state.watchedSessionId = null;
        state.threadId = null;
        state.target = null;
        persist();
        await acknowledge(interaction, "Disconnected.");
        return;
      }
      const watch = customId.match(/^watch:(.+)$/);
      if (watch) {
        await switchWatch(state, interaction, watch[1]);
        return;
      }
      const page = customId.match(/^sessions:(\d+)$/);
      if (page) {
        const built = buildSessionPage(sessionSummaries(), Number(page[1]));
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
          await acknowledge(interaction, "That prompt is no longer waiting.");
          return;
        }
        const raw = interaction.isStringSelectMenu?.() ? String(Number(interaction.values?.[0]) + 1) : choice;
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
        ephemeral: true,
      }).catch((error: any) => log.warn("sessions reply failed", { error: String(error) }));
      return;
    }

    if (name === "notify") {
      const enable = (interaction.options?.getString?.("state") || "on").toLowerCase() !== "off";
      if (enable) notifyUsers.add(interaction.user.id);
      else notifyUsers.delete(interaction.user.id);
      await interaction.reply({
        content: enable ? "Turn-complete notifications on for every session." : "Turn-complete notifications off.",
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    if (name === "watch") {
      const wanted = String(interaction.options?.getString?.(WATCH_OPTION_NAME, true) || "");
      const sessions = sessionSummaries();
      const exact = sessions.find((session) => session.sessionId === wanted);
      const choice = exact || (() => {
        const [first] = filterSessionChoices(sessions, wanted, 1);
        return first ? sessions.find((session) => session.sessionId === first.value) : undefined;
      })();
      if (!choice) {
        await acknowledge(interaction, `No session matches \`${wanted}\`.`);
        return;
      }
      await switchWatch(state, interaction, choice.sessionId);
      return;
    }

    if (!watched) {
      await acknowledge(interaction, "Not watching any session. Use `/sessions` first.");
      return;
    }
    const client = piClients.get(watched);
    if (!client) {
      state.watchedSessionId = null;
      persist();
      await acknowledge(interaction, "The watched session is gone; cleared.");
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

    if (name === "stop" || name === "compact") {
      const sent = command(watched, { command: name === "stop" ? "abort" : "compact" });
      await acknowledge(interaction, sent
        ? (name === "stop" ? "⏹️ Stop sent." : "🗜️ Compacting.")
        : "Session is not connected.");
      return;
    }

    const value = String(interaction.options?.getString?.("value") || "");
    if (name === "model") {
      if (!value) {
        await interaction.reply({ content: `Model: **${session.model || "—"}**`, ephemeral: true }).catch(() => {});
        return;
      }
      command(watched, { command: "set-model", modelId: value });
      await acknowledge(interaction, `Switching model to \`${value}\`.`);
      return;
    }

    if (name === "thinking") {
      if (!value) {
        await interaction.reply({ content: `Thinking: **${session.thinkingLevel || "medium"}**`, ephemeral: true }).catch(() => {});
        return;
      }
      command(watched, { command: "set-thinking", level: value });
      await acknowledge(interaction, `Thinking → \`${value}\`.`);
      return;
    }

    if (name === "diff") {
      await acknowledge(interaction, session.diffPort
        ? `Diff viewer: http://localhost:${session.diffPort}`
        : "No diff viewer for this session.");
      return;
    }

    if (name === "file") {
      await sendWorkspaceFile(state, interaction, session.cwd, String(interaction.options?.getString?.("path", true) || ""));
      return;
    }

    const passthrough = PASSTHROUGH[name];
    if (passthrough) {
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      const body = await requestOnce(watched, passthrough);
      await interaction.editReply({ content: body }).catch(() => {});
      return;
    }
  });

  /** Native controls (buttons/menus) answer through the engine too. */
  function resolvePrompt(_prompt: PendingPrompt, raw: string, state: RuntimeUserState, interaction: any): void {
    bridge.answer(state, raw, (content) => void acknowledge(interaction, content));
  }

  /**
   * Point this user at a session, reusing the thread already created for it.
   *
   * Creating a fresh thread on every selection lost the conversation history a
   * user had built up (Qodo f649327c); threads are remembered per session.
   */
  async function switchWatch(state: RuntimeUserState, interaction: any, sessionId: string): Promise<void> {
    const client = piClients.get(sessionId);
    if (!client) {
      await acknowledge(interaction, "Session no longer available.");
      return;
    }
    state.watchedSessionId = client.session.sessionId;
    const name = sessionName(state.watchedSessionId);
    state.threads = state.threads ?? {};

    let threadId: string | null = state.threads[sessionId] ?? null;
    if (threadId) {
      // The remembered thread may have been deleted or archived.
      try {
        const existing = await discord.channels.fetch(threadId);
        if (!existing) threadId = null;
      } catch {
        threadId = null;
      }
    }
    if (!threadId && interaction.guildId && interaction.channel?.threads?.create) {
      try {
        const thread = await interaction.channel.threads.create({
          name: truncateLine(name, 90),
          autoArchiveDuration: 1440,
          reason: `pi session ${name}`,
        });
        threadId = thread.id;
        state.threads[sessionId] = thread.id;
        const known = Object.entries(state.threads).sort((a, b) => a[1].localeCompare(b[1]));
        if (known.length > MAX_THREADS_PER_USER) delete state.threads[known[0][0]];
        log.info("created thread for session", { threadId, sessionId });
      } catch (error) {
        log.warn("thread creation failed, falling back to DM", { error: String(error) });
      }
    }
    state.threadId = threadId;
    state.target = threadId
      ? { channelId: threadId, threadId }
      : state.responseChannelId
        ? { channelId: state.responseChannelId, threadId: null }
        : null;
    if (!threadId) {
      try {
        state.responseChannelId = (await interaction.user.createDM()).id;
      } catch {
        log.warn("could not open DM", { user: interaction.user.username });
      }
    }
    if (!threadId && !state.responseChannelId && interaction.channelId) {
      // Watching from a server where neither a thread nor a DM is available left
      // the session with nowhere to write (Qodo a2346451).
      state.responseChannelId = interaction.channelId;
      log.info("falling back to the command channel for output", { channelId: interaction.channelId });
    }
    persist();

    // A thread is guild-visible: no session inventory here, only the checkout.
    const header = `Now watching **${name}**.`;
    if (threadId) await sendText(threadId, `${header} Ask here; slash commands still work in the server.`);
    await acknowledge(
      interaction,
      threadId ? `${header} Continue in the thread.` : `${header} (${client.session.model || "—"}) Send prompts in DM.`,
    );
  }

  /**
   * Send a file from the session's working directory.
   *
   * Symlinks are resolved before the containment check: a lexically-inside path
   * whose real target is `~/.pi/discord.env` must not be postable into a guild
   * thread (Qodo d9ff444e).
   */
  async function sendWorkspaceFile(state: RuntimeUserState, interaction: any, cwd: string, relative: string): Promise<void> {
    try {
      const root = fs.realpathSync(path.resolve(cwd));
      const candidate = path.resolve(root, relative);
      const resolved = fs.realpathSync(candidate);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        await acknowledge(interaction, "That path resolves outside the session directory.");
        return;
      }
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        await acknowledge(interaction, "That is not a file.");
        return;
      }
      if (stat.size > MAX_IMAGE_BYTES) {
        await acknowledge(interaction, `File is ${formatKB(stat.size)} — over the ${formatKB(MAX_IMAGE_BYTES)} limit.`);
        return;
      }
      const channelId = state.threadId || state.responseChannelId;
      if (!channelId) {
        await acknowledge(interaction, "No channel to send to yet — watch a session first.");
        return;
      }
      if (!isComponent(interaction)) await interaction.deferReply({ ephemeral: true }).catch(() => {});
      const channel = await discord.channels.fetch(channelId);
      await (channel as any).send({
        files: [{ attachment: fs.readFileSync(resolved), name: path.basename(resolved) }],
        ...NO_MENTIONS,
      });
      await acknowledge(interaction, `Sent \`${path.basename(resolved)}\`.`);
      log.info("file sent to discord", { file: path.basename(resolved), size: stat.size });
    } catch (error) {
      await acknowledge(interaction, `Could not read that file: ${String(error).slice(0, 120)}`);
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
            .setLabel(truncateLine(sessionLabel(session), 80))
            .setStyle(session.sessionId === state.watchedSessionId ? ButtonStyle.Success : ButtonStyle.Secondary),
        );
      }
      rows.push(row);
    }
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

  /** One-shot request/response, matched by EXACT event type and request id. */
  async function requestOnce(
    sessionId: string,
    spec: { command: string; eventType: string; label: string },
  ): Promise<string> {
    const requestId = `discord-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      const done = (text: string) => {
        clearTimeout(timer);
        const index = piEventHooks.indexOf(hook);
        if (index >= 0) piEventHooks.splice(index, 1);
        resolve(text);
      };
      const timer = setTimeout(() => done("Timed out waiting for the session."), 5000);
      const hook = (eventSessionId: string, event: any) => {
        if (eventSessionId !== sessionId) return;
        if (event?.type !== spec.eventType) return;
        if (event?.requestId && event.requestId !== requestId) return;
        done(`**${spec.label}**\n\`\`\`json\n${JSON.stringify(event).slice(0, 1600)}\n\`\`\``);
      };
      piEventHooks.push(hook);
      if (!command(sessionId, { command: spec.command, requestId })) {
        done("Session is not connected.");
      }
    });
  }

  // ── inbound messages (DMs and our threads) ───────────────────────────────
  discord.on("messageCreate", async (message: any) => {
    if (!message || message.author?.bot) return;
    if (!firstSighting(message.id)) return;

    const userId = message.author.id;
    const authorized = config.allowAll || config.allowedUsers.has(userId);
    if (!authorized) {
      const state = userState(userId);
      const now = Date.now();
      if (now - state.unauthorizedNotifiedAt > UNAUTHORIZED_NOTICE_MS) {
        state.unauthorizedNotifiedAt = now;
        await message.reply("Not authorized.").catch(() => {});
      }
      log.warn("unauthorized discord message", { userId });
      return;
    }

    const state = userState(userId);
    // Threads are guild channels; only ours are accepted. A message is routed by
    // the SESSION its thread belongs to, so writing in an older session's thread
    // cannot spill into whichever session is currently watched (Qodo 0d2dca6d).
    let threadSessionId: string | null = null;
    if (message.guildId) {
      const owner = userForThread(message.channelId);
      if (!owner || owner[0] !== userId) return;
      const [, ownerState] = owner;
      threadSessionId = Object.entries(ownerState.threads ?? {})
        .find(([, threadId]) => threadId === message.channelId)?.[0] ?? null;
      if (!threadSessionId) return;
    }
    state.updatedAt = Date.now();
    if (!message.guildId) {
      state.responseChannelId = message.channelId;
      if (!state.threadId) state.target = { channelId: message.channelId, threadId: null };
    }

    const text = (message.content || "").trim();

    // Control words come BEFORE a pending prompt: /stop must never be blocked by
    // a question the agent is waiting on (Qodo a611b293).
    if (/^\/stop$/i.test(text)) {
      if (!state.watchedSessionId) {
        await message.reply("Not watching any session.").catch(() => {});
        return;
      }
      const sent = command(state.watchedSessionId, { command: "abort" });
      await message.reply(sent ? "⏹️ Stop sent." : "Session is not connected.").catch(() => {});
      return;
    }
    if (/^\/(cancel|dismiss)$/i.test(text)) {
      if (!state.pendingPrompt) {
        await message.reply("Nothing pending.").catch(() => {});
        return;
      }
      // Clearing locally left the agent waiting forever: the cancelled response
      // has to travel back through ui-bridge (Qodo 7e102371).
      bridge.answer(state, "/cancel", (content) => void message.reply(content).catch(() => {}));
      return;
    }

    if (state.pendingPrompt) {
      const outcome = bridge.handleInbound(state, text, (content) => void message.reply(content).catch(() => {}));
      if (outcome === "answered" || outcome === "cancelled") return;
      if (outcome === "expired") {
        await message.reply("The waiting prompt expired; sending your message as a new prompt.").catch(() => {});
      } else if (outcome === "not-an-answer" && state.pendingPrompt?.method === "confirm" && text) {
        // Not an answer to a yes/no question, but it IS a message the user meant
        // to send: forward it and keep the prompt available (Qodo 85cacb2c).
        await message.reply("That isn't an answer to the pending question (still waiting). Forwarding it as a prompt.").catch(() => {});
      }
    }

    const targetSessionId = threadSessionId ?? state.watchedSessionId;
    if (!targetSessionId) {
      await message.reply("Not watching any session. Use `/sessions` and pick one.").catch(() => {});
      return;
    }
    const client = piClients.get(targetSessionId);
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
        const fetched = await fetchAttachment(plan.url, MAX_IMAGE_BYTES);
        if (fetched) images.push({ data: fetched.buffer.toString("base64"), mimeType: fetched.contentType, filename: plan.filename });
        else notes.push(`[Could not download ${plan.filename} (too large or unavailable)]`);
        continue;
      }
      if (plan.kind === "text") {
        const fetched = await fetchAttachment(plan.url, MAX_INLINE_TEXT_BYTES);
        if (fetched) notes.push(`--- ${plan.filename} ---\n${fetched.buffer.toString("utf-8")}`);
        else notes.push(`[Could not download ${plan.filename} (too large or unavailable)]`);
        continue;
      }
      const described = describeSkippedAttachment(plan);
      if (described) notes.push(described);
    }

    // A model without image input cannot use what we just downloaded; say so
    // rather than sending a prompt that silently fails.
    const imageNote = imageSupportNote(client.session?.supportsImages, images.length);
    if (imageNote) {
      notes.push(imageNote);
      images.length = 0;
    }

    if (!text && images.length === 0 && notes.length === 0) return;

    const fullText = notes.length ? (text ? `${text}\n\n` : "") + notes.join("\n\n") : text;
    // The engine suppresses this echo per watcher using the state's marker.
    state.render.expectedEcho = fullText;
    client.ws.send(JSON.stringify({ type: "prompt", text: fullText, images: images.length ? images : undefined }));
    log.info("prompt forwarded from discord", {
      userId,
      session: sessionName(targetSessionId),
      chars: fullText.length,
      images: images.length,
      // Visible here so a live upload proves the modality field reached us.
      supportsImages: client.session?.supportsImages ?? null,
    });
  });

  // ── lifecycle ────────────────────────────────────────────────────────────
  discord.once("ready", async (client: any) => {
    log.info("bot connected", { tag: client.user.tag, allowAll: config.allowAll, allowed: config.allowedUsers.size });
    await registerCommands(client.user.id); // global: makes DMs work too
    for (const guild of discord.guilds.cache.values()) {
      await registerCommands(client.user.id, (guild as any).id);
    }
  });

  discord.on("guildCreate", async (guild: any) => {
    log.info("joined guild, registering commands", { guild: guild.name });
    if (discord.user?.id) await registerCommands(discord.user.id, guild.id);
  });

  discord.on("error", (error: any) => log.error("discord client error", { error: String(error) }));

  discord.login(config.token).catch((error: any) => log.error("discord login failed", { error: String(error) }));

  // Signals: shutdown must not swallow the daemon's own termination semantics —
  // registering a handler replaces Node's default exit, so it exits explicitly.
  let shuttingDown = false;
  const shutdown = (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const state of runtime.values()) clearTyping(state);
    persist();
    try { discord.destroy(); } catch {}
    log.info("discord bot stopped", { signal: signal ?? null });
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      shutdown(signal);
      // Only exit when we did not inherit the handler chain of the daemon.
      if (signal === "SIGINT") process.exit(0);
    });
  }
  process.once("beforeExit", () => shutdown());
}
