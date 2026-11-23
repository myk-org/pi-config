/**
 * Discord bot for pidash — thin Discord.js transport adapter.
 *
 * Session routing, prompt-target lifecycle, watch switching, reaction routing,
 * state hydration/persistence, and unified session RPC live in
 * `discord-session-routing.ts`; platform-neutral bridge logic lives in
 * `extensions/shared/chat/`.
 *
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
  saveInboundAttachment,
  MAX_IMAGE_BYTES,
  MAX_INLINE_TEXT_BYTES,
} from "../shared/chat/chat-attachments.ts";
import type { PendingPrompt } from "../shared/chat/chat-prompts.ts";
import { buildPromptControls } from "./discord-prompt-controls.ts";
import {
  entriesFromModels,
  orderPickerEntries,
  pickerLabel,
  slicePickerPage,
} from "../shared/chat/chat-picker.ts";
import { compareCommandPayloads } from "./discord-commands.ts";
import { MAX_LAST_PROMPT_CHARS, hardenFilePermissions, readState, writeState } from "../shared/chat/chat-state.ts";
import { jobIdAt, renderJobsView } from "./discord-jobs-view.ts";
import { planBoard } from "./discord-board.ts";
import {
  createDiscordSessionRouter,
  promptById,
  sessionIdFromTopic,
  type DiscordRuntimeUserState,
} from "./discord-session-routing.ts";
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
import { createChatBridge, type ChatBridge } from "../shared/chat/chat-bridge.ts";
import type { ChatAdapter, ChatCapabilities, ChatTarget } from "../shared/chat/chat-types.ts";
import { parseEnvFile, resolveDiscordConfig } from "./discord-config.ts";

const log = createLogger("pidash-discord");

const STREAM_EDIT_INTERVAL_MS = 1500;
const TYPING_REFRESH_MS = 8000;
/** One "not authorized" reply per user per window, not per message. */
const UNAUTHORIZED_NOTICE_MS = 10 * 60 * 1000;
const PICKER_CONTEXT_LIMIT = 50;

/** Commands whose answer arrives as a broadcast event, with the exact type. */
const PASSTHROUGH: Record<string, { command: string; eventType: string; label: string }> = {
  tasks: { command: "tasks-list", eventType: "tasks-list", label: "Tasks" },
  coms: { command: "coms-peers", eventType: "coms-peers", label: "Coms peers" },
  memory: { command: "memory-status", eventType: "memory-status", label: "Memory" },
  mcp: { command: "mcp-list", eventType: "mcp-list", label: "MCP servers" },
};

const COMMANDS = [
  ["sessions", "List pi sessions — pick one to watch"],
  ["status", "Show the watched session"],
  ["stop", "Interrupt the running turn"],
  ["disconnect", "Stop watching — clears the watch, its threads and pending questions"],
  ["board", "Forum session board — one thread per session"],
  ["compact", "Compact the watched session's context"],
  ["model", "Show or set the model"],
  ["thinking", "Show or set the thinking level"],
  ["async", "List or kill background async agents"],
  ["cron", "List or kill scheduled cron jobs"],
  ["tasks", "List tasks in the watched session"],
  ["coms", "List coms peers in the watched session's project"],
  ["memory", "Memory status of the watched session"],
  ["mcp", "MCP servers known to the watched session"],
  ["diff", "Link to the session's diff viewer"],
  ["watch", "Watch a session by name"],
  ["notify", "Turn turn-complete notifications on or off"],
  ["file", "Send a file from the session's working directory"],
] as const;

export function setupDiscordBot(opts: {
  piClients: Map<string, any>;
  piEventHooks: Array<(sessionId: string, event: any) => void>;
  getActiveSessions: () => any[];
  log?: (msg: string) => void;
}): void {
  const { piClients, piEventHooks, getActiveSessions } = opts;
  const _require = createRequire(import.meta.url);

  const home = process.env.HOME;
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
    StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
    ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, MessageFlags,
    SeparatorSpacingSize, ApplicationIntegrationType, InteractionContextType,
    ContextMenuCommandBuilder, ApplicationCommandType,
  } = _require("discord.js");

  const discord = new DiscordClient({
    intents: [
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });

  const notifyUsers = new Set<string>();

  // ── Discord transport helpers ────────────────────────────────────────────
  async function sendText(
    channelId: string,
    text: string,
    components: any[] = [],
  ): Promise<string | null> {
    try {
      const channel = await discord.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return null;
      let lastId: string | null = null;
      const chunks = chunkDiscordText(text);
      for (let i = 0; i < chunks.length; i++) {
        const payload: any = { content: chunks[i], ...NO_MENTIONS };
        if (i === chunks.length - 1 && components.length) payload.components = components;
        const sent = await (channel as any).send(payload);
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
      await message.edit({
        content: streamingView(text, DISCORD_TEXT_LIMIT),
        ...NO_MENTIONS,
        flags: MessageFlags.SuppressNotifications,
      });
      return true;
    } catch (error) {
      log.debug("discord edit failed", { messageId, error: String(error) });
      return false;
    }
  }

  function startTyping(state: DiscordRuntimeUserState, channelId: string): void {
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

  function clearTyping(state: DiscordRuntimeUserState): void {
    if (state.typingInterval) clearInterval(state.typingInterval);
    if (state.typingSafety) clearTimeout(state.typingSafety);
    state.typingInterval = null;
    state.typingSafety = null;
  }

  function lanHost(): string | null {
    try {
      const os = _require("node:os") as typeof import("node:os");
      for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses ?? []) {
          if (address.family === "IPv4" && !address.internal) return address.address;
        }
      }
    } catch {}
    return null;
  }

  async function isReachable(rawUrl: string): Promise<boolean> {
    const net = _require("node:net") as typeof import("node:net");
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return new Promise((resolve) => {
      const socket = net.connect({ host: url.hostname, port });
      const settle = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(700, () => settle(false));
      socket.once("connect", () => settle(true));
      socket.once("error", () => settle(false));
    });
  }

  function dashboardUrl(): string | null {
    const host = lanHost();
    if (!host) return null;
    return `http://${host}:${process.env.PI_PIDASH_PORT || 19190}`;
  }

  function inboxDir(cwd: string | undefined): string {
    const base = cwd && cwd.trim() ? cwd : process.cwd();
    return `${base}/.pi/tmp/discord-inbox`;
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

  function sendPromptToSession(
    sessionId: string,
    payload: { text: string; images?: Array<{ data: string; mimeType: string; filename: string }> },
  ): boolean {
    const client = piClients.get(sessionId);
    if (!client?.ws) return false;
    try {
      client.ws.send(JSON.stringify({ type: "prompt", text: payload.text, images: payload.images }));
      return true;
    } catch (error) {
      log.warn("prompt send failed", { sessionId, error: String(error) });
      return false;
    }
  }

  // ── Session router (deep policy module behind the transport port) ────────
  const router = createDiscordSessionRouter({
    fetchChannel: (channelId, options) => (options ? discord.channels.fetch(channelId, options) : discord.channels.fetch(channelId)),
    hasSendPermissions: (channel) => {
      const permissions = channel?.permissionsFor?.(discord.user);
      if (!permissions) return true;
      return Boolean(permissions.has(["ViewChannel", channel.isThread?.() ? "SendMessagesInThreads" : "SendMessages"]));
    },
    createThread: async (parentChannelId, name, reason) => {
      const parent: any = await discord.channels.fetch(parentChannelId);
      const thread = await parent.threads.create({
        name,
        autoArchiveDuration: 1440,
        reason,
      });
      return thread.id as string;
    },
    sendText: (channelId, text) => sendText(channelId, text),
    clearTyping,
    listLiveSessions: () => [...piClients.entries()]
      .filter(([, client]) => Boolean(client?.ws))
      .map(([sessionId, client]) => ({
        sessionId,
        lastActivity: Number(client?.session?.lastActivity) || 0,
      })),
    isSessionLive: (sessionId) => Boolean(piClients.get(sessionId)?.ws),
    getSession: (sessionId) => piClients.get(sessionId)?.session ?? null,
    getActiveSessions,
    sendCommand: command,
    sendPrompt: sendPromptToSession,
    subscribeEvents: (hook) => {
      piEventHooks.push(hook);
      return () => {
        const index = piEventHooks.indexOf(hook);
        if (index >= 0) piEventHooks.splice(index, 1);
      };
    },
    readPersistedState: () => readState(config.stateFile),
    writePersistedState: (state) => writeState(config.stateFile, state),
    isUserAllowed: (userId) => config.allowAll || config.allowedUsers.has(userId),
    log,
  });

  // ── Shared chat bridge with Discord as its ChatAdapter ───────────────────
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
      const state = [...router.runtime.values()].find((s) => (s.threadId || s.responseChannelId) === channelId);
      if (!state) return;
      if (active) startTyping(state, channelId);
      else clearTyping(state);
    },
  };

  const bridge: ChatBridge = createChatBridge({
    adapter,
    promptTtlMs: config.promptTtlMs,
    streamEditIntervalMs: STREAM_EDIT_INTERVAL_MS,
    users: () => router.runtime.entries(),
    renderPrompt: async (target, prompt, body) => {
      const controls = buildPromptControls(prompt, { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder });
      const sentId = await sendText(target.threadId || target.channelId, body, controls);
      if (!sentId) log.warn("question could not be delivered", { promptId: prompt.id, session: prompt.sessionId });
      else log.info("question delivered with controls", { promptId: prompt.id, controls: controls.length });
    },
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

  piEventHooks.push((sessionId: string, event: any) => {
    if (event?.type === "extension_ui_request" || event?.type === "ui-dismiss" || event?.type === "ui_prompt_end") {
      router.handleUiRequest(sessionId, event, bridge);
      return;
    }
    if (router.runtime.size === 0) return;
    if (piClients.get(sessionId)?.replaying) return;
    bridge.onPiEvent(sessionId, event);
  });

  // ── Forum board ──────────────────────────────────────────────────────────
  async function renderBoard(): Promise<any> {
    const forumId = config.forumChannelId;
    if (!forumId) {
      return { content: "No board configured. Set `DISCORD_FORUM_CHANNEL_ID` to a forum channel id." };
    }
    let forum: any;
    try {
      forum = await discord.channels.fetch(forumId);
    } catch (error) {
      log.warn("forum channel not reachable", { forumId, error: String(error) });
      return { content: `Cannot read forum channel ${forumId} — check the id and my permissions.` };
    }
    if (!forum?.threads?.create) {
      return { content: `Channel ${forumId} is not a forum channel.` };
    }

    const sessions = getActiveSessions();
    const active = await forum.threads.fetchActive().catch(() => ({ threads: new Map() }));
    const existing = new Map<string, string>();
    for (const thread of active.threads?.values?.() ?? []) {
      const sessionId = sessionIdFromTopic(thread.topic);
      if (sessionId) existing.set(sessionId, thread.id);
    }

    const plan = planBoard(
      sessions.map((session: any) => ({ sessionId: String(session.sessionId), label: router.sessionName(String(session.sessionId)) })),
      Object.fromEntries(existing),
    );

    let created = 0;
    for (const planned of plan.toCreate) {
      const sessionId = planned.sessionId;
      try {
        const thread = await forum.threads.create({
          name: truncateLine(router.sessionName(sessionId), 90),
          message: { content: `${router.sessionName(sessionId)} — pi session. Type here to prompt it.` },
          reason: `pi session ${sessionId}`,
        });
        await thread.setTopic(`pi session:${sessionId}`).catch((error: any) =>
          log.warn("board topic could not be set", { sessionId, error: String(error) }));
        existing.set(sessionId, thread.id);
        created++;
      } catch (error) {
        log.warn("board thread creation failed", { sessionId, error: String(error) });
      }
    }
    log.info("board rendered", { sessions: sessions.length, created, forumId });

    if (!plan.options.length) return { content: "No active sessions to show on the board." };
    return {
      content: `**Board** — ${plan.total} session(s), ${created} new thread(s) in <#${forumId}>.`,
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId("boardpick").setPlaceholder("Open a session thread").addOptions(plan.options),
      )],
      ...(plan.sessionIds.length ? { boardSessionIds: plan.sessionIds } : {}),
    };
  }

  // ── Reaction shortcuts ───────────────────────────────────────────────────
  discord.on("messageReactionAdd", async (reaction: any, user: any) => {
    try {
      if (user?.bot) return;
      if (reaction?.partial) await reaction.fetch().catch(() => {});
      const message = reaction?.message?.partial ? await reaction.message.fetch().catch(() => null) : reaction?.message;
      if (!message || message.author?.id !== discord.user?.id) return;
      await router.handleReaction({
        userId: String(user?.id ?? ""),
        channelId: String(message.channelId ?? ""),
        emoji: reaction.emoji?.name ?? "",
        messageId: message.id,
        deleteMessage: () => message.delete(),
        expectEcho: (state, sessionId, text) => bridge.expectEcho(state, sessionId, text),
      });
    } catch (error) {
      log.warn("reaction handling failed", { error: String(error) });
    }
  });

  // ── Slash command registration ───────────────────────────────────────────
  async function registerCommands(clientId: string, guildId?: string): Promise<void> {
    const rest = new REST().setToken(config.token);
    const builders = COMMANDS.map(([name, description]) => {
      const builder = new SlashCommandBuilder()
        .setName(name)
        .setDescription(description)
        .setContexts(
          InteractionContextType.Guild,
          InteractionContextType.BotDM,
          InteractionContextType.PrivateChannel,
        )
        .setIntegrationTypes(
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        );
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
    const askAbout = new ContextMenuCommandBuilder()
      .setName("Ask PI about this")
      .setType(ApplicationCommandType.Message)
      .setContexts(
        InteractionContextType.Guild,
        InteractionContextType.BotDM,
        InteractionContextType.PrivateChannel,
      )
      .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
      .toJSON();
    const body = [...builders.map((b: any) => b.toJSON()), askAbout];
    const scope = guildId ? `guild:${guildId}` : "global";
    try {
      const route = guildId
        ? Routes.applicationGuildCommands(clientId, guildId)
        : Routes.applicationCommands(clientId);
      const current = (await rest.get(route)) as any[];
      const comparison = compareCommandPayloads(current as any[], body as any[]);
      if (!comparison.changed) {
        log.debug("slash commands unchanged", { scope, count: body.length });
        return;
      }
      log.info("command definitions changed", { scope, commands: comparison.differing.slice(0, 10) });
      await rest.put(route, { body });
      log.info("slash commands registered", { scope, count: body.length });
    } catch (error) {
      log.warn("slash command registration failed", { scope, error: String(error) });
    }
  }

  // ── Interaction helpers & UI state maps ──────────────────────────────────
  const isComponent = (interaction: any) => Boolean(interaction.isButton?.() || interaction.isStringSelectMenu?.());

  async function acknowledge(interaction: any, content: string, ephemeral = true): Promise<void> {
    try {
      if (isComponent(interaction)) await interaction.update({ content, components: [] });
      else if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
      else await interaction.reply({ content, ephemeral });
    } catch (error) {
      log.debug("acknowledge failed", { error: String(error) });
    }
  }

  function resolvePrompt(prompt: PendingPrompt, raw: string, state: DiscordRuntimeUserState, interaction: any): void {
    const answered = bridge.answer(state, raw, (content) => void acknowledge(interaction, content), prompt.sessionId);
    if (answered) router.releasePromptOnlyTarget(state, prompt.sessionId);
  }

  async function switchWatch(state: DiscordRuntimeUserState, interaction: any, sessionId: string): Promise<void> {
    const result = await router.switchWatch(state, {
      userId: interaction.user.id,
      username: interaction.user.username,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      canCreateThread: Boolean(interaction.channel?.threads?.create),
      createThread: interaction.channel?.threads?.create
        ? async (name, reason) => {
          const thread = await interaction.channel.threads.create({
            name,
            autoArchiveDuration: 1440,
            reason,
          });
          return thread.id as string;
        }
        : undefined,
      openDm: async () => (await interaction.user.createDM())?.id ?? null,
    }, sessionId);
    await acknowledge(interaction, result.ackText);
  }

  interface PickerContext {
    sessionId: string;
    preferGroup: string | null;
    ordered: ReturnType<typeof entriesFromModels>;
  }
  interface JobListContext {
    sessionId: string;
    kind: "async" | "cron";
    stoppable: string[];
  }

  const pickerContexts = new Map<string, PickerContext>();
  const jobLists = new Map<string, JobListContext>();
  const boardLists = new Map<string, string[]>();

  function rememberBounded<T>(map: Map<string, T>, key: string, value: T): void {
    map.set(key, value);
    while (map.size > PICKER_CONTEXT_LIMIT) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  function modelPickerComponents(page: ReturnType<typeof slicePickerPage>): any[] {
    const rows: any[] = [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`modelpick:${page.page}`)
        .setPlaceholder(`Choose a model (${page.total})`)
        .addOptions(page.items.map((entry, index) => ({
          label: pickerLabel(entry),
          value: String(page.offset + index),
          default: entry.current === true,
        }))),
    )];
    if (page.pages > 1) {
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`modelpage:${page.page - 1}`).setLabel("◀").setStyle(ButtonStyle.Secondary).setDisabled(page.page <= 1),
        new ButtonBuilder().setCustomId(`modelpage:${page.page + 1}`).setLabel("▶").setStyle(ButtonStyle.Secondary).setDisabled(page.page >= page.pages),
      ));
    }
    return rows;
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

  function sessionComponents(page: ReturnType<typeof buildSessionPage>, state: DiscordRuntimeUserState): any[] {
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

  async function sendWorkspaceFile(interaction: any, cwd: string, relative: string): Promise<void> {
    try {
      const root = fs.realpathSync(path.resolve(cwd));
      const candidate = path.resolve(root, relative);
      const resolvedPath = fs.realpathSync(candidate);
      if (resolvedPath !== root && !resolvedPath.startsWith(root + path.sep)) {
        await acknowledge(interaction, "That path resolves outside the session directory.");
        return;
      }
      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        await acknowledge(interaction, "That is not a file.");
        return;
      }
      if (stat.size > MAX_IMAGE_BYTES) {
        await acknowledge(interaction, `File is ${formatKB(stat.size)} — over the ${formatKB(MAX_IMAGE_BYTES)} limit.`);
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      await interaction.editReply({
        files: [{ attachment: fs.readFileSync(resolvedPath), name: path.basename(resolvedPath) }],
        ...NO_MENTIONS,
      });
      log.info("file sent to discord", { userId: interaction.user.id, channelId: interaction.channelId, size: stat.size });
    } catch (error) {
      log.warn("workspace file delivery failed", { userId: interaction.user.id, channelId: interaction.channelId, code: (error as NodeJS.ErrnoException)?.code ?? null });
      await acknowledge(interaction, "Could not read or deliver that file.");
    }
  }

  async function statusCard(session: any, sessionId: string): Promise<any> {
    const state = session.active ? (session.working ? "working" : "idle") : "detached";
    const badge = session.working ? "🟢" : session.active ? "⚪" : "🔴";
    const container = new ContainerBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`# ${badge} ${router.sessionName(sessionId)}`),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**${state}** · ${session.model || "—"}${session.thinkingLevel ? ` · thinking ${session.thinkingLevel}` : ""}`,
        ),
      )
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent([
          session.branch ? `**Branch:** ${session.branch}` : null,
          `**CWD:** \`${session.cwd}\``,
          session.supportsImages === undefined ? null : `**Images:** ${session.supportsImages ? "supported" : "not supported"}`,
          session.container ? "**Container:** 📦" : null,
        ].filter(Boolean).join("\n")),
      );

    const links: any[] = [];
    const candidates: Array<{ label: string; url: string }> = [];
    const dashboard = dashboardUrl();
    if (dashboard) candidates.push({ label: "Dashboard", url: dashboard });
    const host = lanHost();
    if (session.diffPort && host) {
      candidates.push({ label: "Diff", url: `http://${host}:${session.diffPort}` });
    }
    const reachable = await Promise.all(candidates.map((candidate) => isReachable(candidate.url)));
    candidates.forEach((candidate, index) => {
      if (reachable[index]) {
        links.push(new ButtonBuilder().setLabel(candidate.label).setStyle(ButtonStyle.Link).setURL(candidate.url));
      } else {
        log.debug("skipping unreachable link", { label: candidate.label, url: candidate.url });
      }
    });
    if (links.length) container.addActionRowComponents(new ActionRowBuilder().addComponents(...links.slice(0, 5)));
    return { components: [container], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral };
  }

  // ── Interactions ─────────────────────────────────────────────────────────
  discord.on("interactionCreate", async (interaction: any) => {
    const authorized = config.allowAll || config.allowedUsers.has(interaction.user?.id);
    if (!authorized) {
      if (interaction.isRepliable?.()) {
        await interaction.reply({ content: "Not authorized.", ephemeral: true }).catch(() => {});
      }
      log.warn("unauthorized discord interaction rejected", { user: interaction.user?.id });
      return;
    }

    const state = router.userState(interaction.user.id);
    state.updatedAt = Date.now();

    if (interaction.isAutocomplete?.()) {
      const focused = interaction.options.getFocused(true);
      await interaction.respond(filterSessionChoices(sessionSummaries(), String(focused?.value ?? ""))).catch(() => {});
      return;
    }

    if (isComponent(interaction)) {
      const customId: string = interaction.customId || "";
      if (customId === "unwatch") {
        router.disconnectUser(state);
        await acknowledge(interaction, "Disconnected.");
        return;
      }
      const watch = customId.match(/^watch:(.+)$/);
      if (watch) {
        await switchWatch(state, interaction, watch[1]);
        return;
      }
      const picker = pickerContexts.get(String(interaction.message?.id ?? ""));

      const modelPick = customId.match(/^modelpick:(\d+)$/);
      if (modelPick && interaction.isStringSelectMenu?.()) {
        if (!picker) {
          await acknowledge(interaction, "This model list expired — run `/model` again.");
          return;
        }
        const choice = picker.ordered[Number(interaction.values?.[0])];
        if (!choice) {
          await acknowledge(interaction, "That choice is no longer in the list — run `/model` again.");
          return;
        }
        command(picker.sessionId, { command: "set-model", modelId: choice.id });
        await acknowledge(interaction, `Switching **${router.sessionName(picker.sessionId)}** to \`${choice.id}\`.`);
        log.info("model chosen from picker", { session: picker.sessionId, modelId: choice.id });
        return;
      }

      const modelPage = customId.match(/^modelpage:(\d+)$/);
      if (modelPage) {
        if (!picker) {
          await acknowledge(interaction, "This model list expired — run `/model` again.");
          return;
        }
        const page = slicePickerPage(picker.ordered, Number(modelPage[1]));
        await interaction.update({
          content: `**Model** — page ${page.page}/${page.pages} of ${page.total}`,
          components: modelPickerComponents(page),
        }).catch((error: any) => log.warn("model page failed", { error: String(error) }));
        return;
      }

      const killJob = customId.match(/^(async|cron)-kill:(\d+)$/);
      if (killJob) {
        const [, kind, rawIndex] = killJob;
        const list = jobLists.get(String(interaction.message?.id ?? ""));
        const targetId = list ? jobIdAt(list.stoppable, Number(rawIndex)) : null;
        if (!list || !targetId) {
          await acknowledge(interaction, "That list expired — run the command again.");
          return;
        }
        const ok = command(list.sessionId, { command: `${kind}-kill`, target: targetId });
        await acknowledge(interaction, ok ? `Stopped \`${truncateLine(targetId, 40)}\`.` : "Could not stop that job.");
        log.info("job killed from discord", { kind, session: list.sessionId, target: targetId, ok });
        return;
      }

      if (customId === "boardpick" && interaction.isStringSelectMenu?.()) {
        const sessionIds = boardLists.get(String(interaction.message?.id ?? ""));
        const picked = sessionIds?.[Number(interaction.values?.[0])];
        const sessionId = picked ? String(picked) : "";
        const forumId = config.forumChannelId;
        if (!sessionId || !forumId) {
          await acknowledge(interaction, "That board list expired — run `/board` again.");
          return;
        }
        let threadId: string | null = null;
        try {
          const forum: any = await discord.channels.fetch(forumId);
          const active = await forum.threads.fetchActive();
          for (const thread of active.threads.values()) {
            if (sessionIdFromTopic(thread.topic) === sessionId) { threadId = thread.id; break; }
          }
        } catch (error) {
          log.warn("board thread lookup failed", { sessionId, error: String(error) });
        }
        if (!threadId) {
          await acknowledge(interaction, "No board thread for that session — run `/board` again.");
          return;
        }
        state.threads = { ...(state.threads ?? {}), [sessionId]: threadId };
        await switchWatch(state, interaction, sessionId);
        log.info("board thread opened", { sessionId, threadId });
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

      const interactionChannelId = interaction?.channelId ?? interaction?.channel?.id ?? null;
      const modalOpen = customId.match(/^answer-modal:([^:]+)$/);
      if (modalOpen) {
        const promptId = modalOpen[1];
        const owned = promptById(state.pendingPrompts, promptId, router.interactionThreadSession(interactionChannelId));
        if (!owned) {
          await acknowledge(interaction, "That prompt is no longer waiting.");
          return;
        }
        const modal = new ModalBuilder()
          .setCustomId(`answer-submit:${promptId}`)
          .setTitle("Your answer")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("value")
                .setLabel(truncateLine(owned.options[0] || "Answer", 45))
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(1800),
            ),
          );
        await interaction.showModal(modal).catch((error: any) => log.warn("modal open failed", { error: String(error) }));
        return;
      }

      const answer = customId.match(/^answer:([^:]+):(.+)$/);
      if (answer) {
        const [, promptId, choice] = answer;
        const prompt = promptById(state.pendingPrompts, promptId, router.interactionThreadSession(interactionChannelId));
        if (!prompt) {
          await acknowledge(interaction, "That prompt is no longer waiting.");
          return;
        }
        const raw = interaction.isStringSelectMenu?.() ? String(Number(interaction.values?.[0]) + 1) : choice;
        resolvePrompt(prompt, String(raw), state, interaction);
        return;
      }
      return;
    }

    if (interaction.isMessageContextMenuCommand?.()) {
      const channelId = String(interaction.channelId ?? "");
      const route = router.resolveInteractionRoute({
        kind: "message-context-menu",
        handler: "message-context-menu",
        fallbackHandler: "context-menu",
        channelId,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        disconnectedReply: "The watched session is disconnected.",
      });
      if (!route.ok) {
        await interaction.reply({ content: route.reply, ephemeral: true }).catch(() => {});
        return;
      }
      const targetSession = route.sessionId;
      const message = interaction.targetMessage;
      const attachmentNames = [...(message.attachments?.values?.() ?? [])].map((a: any) => a.name).filter(Boolean);
      const quoted = (message.content || "").trim();
      if (!quoted && !attachmentNames.length) {
        await interaction.reply({ content: "That message has no text or attachments.", ephemeral: true }).catch(() => {});
        return;
      }
      const header = `Asked from Discord on ${interaction.user.username}'s message`;
      const prompt = [
        `${header}:`,
        "```",
        quoted.slice(0, 1500),
        "```",
        attachmentNames.length ? `Attachments: ${attachmentNames.join(", ")}` : null,
        "",
        "Look at this and tell me what to do.",
      ].filter(Boolean).join("\n");
      const openDm = async () => (await interaction.user.createDM())?.id ?? null;
      if (!await router.establishReplyTarget(route.state, targetSession, interaction.user.id, openDm)) {
        router.logInboundDrop({
          reason: "interaction-reply-destination-unavailable",
          channelId,
          userId: interaction.user.id,
          watchedSessionId: targetSession,
          watchLive: true,
          ownsTarget: false,
        });
        await acknowledge(interaction, "Could not open a private reply channel. Enable DMs and try again.");
        return;
      }
      bridge.expectEcho(route.state, targetSession, prompt);
      sendPromptToSession(targetSession, { text: prompt });
      await interaction.reply({ content: `Sent to **${router.sessionName(targetSession)}**.`, ephemeral: true }).catch(() => {});
      log.info("context menu prompt forwarded", { userId: interaction.user.id, session: targetSession, chars: prompt.length });
      return;
    }

    if (interaction.isModalSubmit?.()) {
      const submit = String(interaction.customId || "").match(/^answer-submit:([^:]+)$/);
      if (!submit) return;
      const interactionChannelId = interaction?.channelId ?? interaction?.channel?.id ?? null;
      const owned = promptById(state.pendingPrompts, submit[1], router.interactionThreadSession(interactionChannelId));
      if (!owned) {
        await acknowledge(interaction, "That prompt is no longer waiting.");
        return;
      }
      const value = interaction.fields.getTextInputValue("value");
      bridge.answerLiteral(state, value, (content) => void acknowledge(interaction, content), owned.sessionId);
      return;
    }

    if (!interaction.isChatInputCommand?.()) return;
    const name = interaction.commandName;

    if (name === "sessions") {
      const sessions = sessionSummaries();
      const built = buildSessionPage(sessions, 1);
      await interaction.reply({
        content: sessions.length ? renderSessionsPage(built, state.watchedSessionId) : "No active sessions.",
        components: sessions.length ? sessionComponents(built, state) : [],
        ephemeral: true,
      }).catch((error: any) => log.warn("sessions reply failed", { error: String(error) }));
      return;
    }

    if (name === "disconnect") {
      const wasWatching = state.watchedSessionId;
      router.disconnectUser(state);
      await interaction.reply({
        content: wasWatching ? `Disconnected from **${router.sessionName(wasWatching)}**.` : "Was not watching anything.",
        ephemeral: true,
      }).catch(() => {});
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

    if (name === "board") {
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      const { boardSessionIds, ...view } = await renderBoard();
      const reply: any = await interaction.editReply(view).catch((error: any) => {
        log.warn("board reply failed", { error: String(error) });
        return null;
      });
      if (reply?.id && Array.isArray(boardSessionIds)) {
        rememberBounded(boardLists, reply.id, boardSessionIds);
        log.debug("board list stored", { messageId: reply.id, sessions: boardSessionIds.length });
      }
      return;
    }

    const route = router.resolveInteractionRoute({
      kind: "chat-input-command",
      handler: "slash-command",
      fallbackHandler: `slash-command:${name}`,
      commandName: name,
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      disconnectedReply: "The selected session is disconnected.",
    });
    if (!route.ok) {
      await acknowledge(interaction, route.reply);
      return;
    }
    const watched = route.sessionId;
    const client = piClients.get(watched);
    const session = client.session;

    if (name === "status") {
      await interaction.reply(await statusCard(session, watched)).catch((error: any) =>
        log.warn("status card failed", { error: String(error) }));
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
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
        const models = await router.requestModels(watched);
        if (!models.length) {
          await interaction.editReply({ content: `Model: **${session.model || "—"}** (no model list available)` }).catch(() => {});
          return;
        }
        const entries = entriesFromModels(models, session.model);
        const currentGroup = entries.find((entry) => entry.current)?.group
          ?? entries.find((entry) => entry.label === session.model)?.group
          ?? null;
        const ordered = orderPickerEntries(entries, currentGroup);
        const page = slicePickerPage(ordered, 1);
        const reply: any = await interaction.editReply({
          content: `**Model** — current: ${session.model || "—"}\nPage ${page.page}/${page.pages} of ${page.total}`,
          components: modelPickerComponents(page),
        }).catch((error: any) => {
          log.warn("model picker failed", { error: String(error) });
          return null;
        });
        if (reply?.id) {
          rememberBounded(pickerContexts, reply.id, { sessionId: watched, preferGroup: currentGroup, ordered });
          log.debug("picker context stored", { messageId: reply.id, session: watched, entries: ordered.length });
        }
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
      await sendWorkspaceFile(interaction, session.cwd, String(interaction.options?.getString?.("path", true) || ""));
      return;
    }

    if (name === "async" || name === "cron") {
      const isAsync = name === "async";
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      const res = await router.requestSessionEvent({
        sessionId: watched,
        command: isAsync ? "async-list" : "cron-list",
        eventType: isAsync ? "async-list" : "cron-list",
      });
      if (!res.ok) {
        await interaction.editReply({ content: "No data for this session yet." }).catch(() => {});
        return;
      }
      const view = renderJobsView(isAsync ? "async" : "cron", res.value);
      const rows: any[] = [];
      if (view.stoppable.length) {
        rows.push(new ActionRowBuilder().addComponents(
          ...view.stoppable.map((id, index) => new ButtonBuilder()
            .setCustomId(`${isAsync ? "async-kill" : "cron-kill"}:${watched}:${id}`)
            .setLabel(`Stop ${index + 1}`)
            .setStyle(ButtonStyle.Danger)),
        ));
      }
      await interaction.editReply({ content: view.content, components: rows })
        .catch((error: any) => log.warn(`${name} reply failed`, { error: String(error) }));
      log.info(`${name} listed`, { session: watched, stoppable: view.stoppable.length });
      return;
    }

    const passthrough = PASSTHROUGH[name];
    if (passthrough) {
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      const body = await router.requestPassthrough(watched, passthrough);
      await interaction.editReply({ content: body }).catch(() => {});
      return;
    }
  });

  // ── Inbound messages (DMs and owned threads/targets) ─────────────────────
  discord.on("messageCreate", async (message: any) => {
    if (!message || message.author?.bot) return;
    if (!router.firstSighting(message.id)) return;

    const userId = message.author.id;
    const authorized = config.allowAll || config.allowedUsers.has(userId);
    if (!authorized) {
      const state = router.userState(userId);
      const now = Date.now();
      if (now - state.unauthorizedNotifiedAt > UNAUTHORIZED_NOTICE_MS) {
        state.unauthorizedNotifiedAt = now;
        await message.reply("Not authorized.").catch(() => {});
      }
      log.warn("unauthorized discord message", { userId });
      return;
    }

    const gate = router.resolveMessageGate({
      userId,
      channelId: message.channelId,
      guildId: message.guildId,
    });
    if (!gate.allowed) return;
    const { state, threadSessionId } = gate;

    const text = (message.content || "").trim();
    const resolveInbound = () => router.resolveMessageSession({
      state,
      userId,
      channelId: message.channelId,
      guildId: message.guildId,
      threadSessionId,
    });
    let inbound = resolveInbound();

    const noTargetReply = () => message.reply(inbound.deadTarget
      ? "The session this channel belonged to is gone. Use `/sessions` and pick one."
      : "Not watching any session. Use `/sessions` and pick one.").catch(() => {});

    const authorOwnsChannel = state.target?.channelId === message.channelId
      || Object.values(state.targets ?? {}).some((target) => target?.channelId === message.channelId);
    const drop = (reason: string, level: "info" | "warn" = "warn") => router.logInboundDrop({
      reason,
      channelId: message.channelId,
      guildId: message.guildId,
      threadSessionId,
      watchedSessionId: state.watchedSessionId ?? null,
      watchLive: Boolean(state.watchedSessionId && piClients.get(state.watchedSessionId)?.ws),
      targets: state.targets,
      ownsTarget: authorOwnsChannel,
      userId,
      inbound,
    }, level);

    if (/^\/stop$/i.test(text)) {
      if (!inbound.sessionId) {
        drop("stop-no-target");
        await noTargetReply();
        return;
      }
      const sent = command(inbound.sessionId, { command: "abort" });
      await message.reply(sent ? "⏹️ Stop sent." : "Session is not connected.").catch(() => {});
      return;
    }

    const askers = router.resolveChannelAskers({
      state,
      channelId: message.channelId,
      guildId: message.guildId,
      inbound,
    });
    if (askers.ambiguous) {
      drop("ambiguous-askers");
      await message.reply("This channel carries more than one session. Send in that session's thread or use `/sessions`.").catch(() => {});
      return;
    }
    const { answerSession, hasPrompt } = askers;

    if (/^\/(cancel|dismiss)$/i.test(text)) {
      if (!hasPrompt) {
        drop("cancel-nothing-pending", "info");
        await message.reply("Nothing pending.").catch(() => {});
        return;
      }
      const dismissed = bridge.answer(state, "/cancel", (content) => void message.reply(content).catch(() => {}), answerSession);
      if (dismissed && answerSession && !(state.pendingPrompts ?? {})[answerSession]) {
        router.releasePromptOnlyTarget(state, answerSession);
      }
      return;
    }

    router.logRoutedDecision(message.channelId, inbound, answerSession, {
      kind: "message",
      handler: "messageCreate",
      channelId: message.channelId,
      guildId: message.guildId,
      threadSessionId,
      watchedSessionId: state.watchedSessionId ?? null,
      watchLive: Boolean(state.watchedSessionId && piClients.get(state.watchedSessionId)?.ws),
      targets: state.targets,
      inbound,
      answerSessionId: answerSession ?? null,
    });

    if (hasPrompt) {
      const outcome = bridge.handleInbound(
        state, text,
        (content) => void message.reply(content).catch(() => {}),
        answerSession,
      );
      if (outcome === "answered" || outcome === "cancelled") {
        if (answerSession) router.releasePromptOnlyTarget(state, answerSession);
        return;
      }
      if (outcome === "expired") {
        await message.reply("The waiting prompt expired; sending your message as a new prompt.").catch(() => {});
        inbound = resolveInbound();
      } else if (outcome === "not-an-answer" && (state.pendingPrompt?.method === "confirm" || hasPrompt) && text) {
        await message.reply("That isn't an answer to the pending question (still waiting). Forwarding it as a prompt.").catch(() => {});
      }
    }

    if (inbound.ambiguous) {
      drop("ambiguous");
      await message.reply("This channel carries more than one session. Send in that session's thread or use `/sessions`.").catch(() => {});
      return;
    }
    const targetSessionId = inbound.sessionId;
    if (!targetSessionId) {
      drop("no-target");
      await noTargetReply();
      return;
    }
    if (inbound.source === "target") {
      log.debug("discord_prompt_via_target", { sessionId: targetSessionId, channelId: message.channelId });
    }
    const client = piClients.get(targetSessionId);
    if (!client?.ws) {
      drop("session-disconnected");
      const streams = router.streamsHere(state, targetSessionId, message.channelId);
      await message.reply(inbound.source === "thread"
        ? "That thread's session is not connected."
        : streams
          ? `This channel streams ${router.sessionNameFor(targetSessionId)}, but that session is not connected to the daemon right now.`
          : "The watched session is disconnected.").catch(() => {});
      return;
    }

    const openDm = async () => (await message.author.createDM())?.id ?? null;
    if (inbound.source === "active" && !await router.establishReplyTarget(state, targetSessionId, userId, openDm)) {
      drop("reply-destination-unavailable");
      await message.reply("Could not open a private reply channel. Enable DMs and try again.").catch(() => {});
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
        if (fetched) {
          images.push({ data: fetched.buffer.toString("base64"), mimeType: fetched.contentType, filename: plan.filename });
          const saved = saveInboundAttachment(inboxDir(client?.session?.cwd), plan.filename, fetched.buffer);
          if (saved) notes.push(`[Saved to ${saved}]`);
        } else {
          notes.push(`[Could not download ${plan.filename} (too large or unavailable)]`);
        }
        continue;
      }
      if (plan.kind === "text") {
        const fetched = await fetchAttachment(plan.url, MAX_INLINE_TEXT_BYTES);
        if (fetched) {
          notes.push(`--- ${plan.filename} ---\n${fetched.buffer.toString("utf-8")}`);
          const saved = saveInboundAttachment(inboxDir(client?.session?.cwd), plan.filename, fetched.buffer);
          if (saved) notes.push(`[Saved to ${saved}]`);
        } else {
          notes.push(`[Could not download ${plan.filename} (too large or unavailable)]`);
        }
        continue;
      }
      const described = describeSkippedAttachment(plan);
      if (described) notes.push(described);
    }

    const imageNote = imageSupportNote(client.session?.supportsImages, images.length);
    if (imageNote) {
      notes.push(imageNote);
      images.length = 0;
      await message.reply(imageNote).catch(() => {});
    }

    if (!text && images.length === 0 && notes.length === 0) return;

    const fullText = notes.length ? (text ? `${text}\n\n` : "") + notes.join("\n\n") : text;
    bridge.expectEcho(state, targetSessionId, fullText);
    state.lastPrompts = {
      ...(state.lastPrompts ?? {}),
      [targetSessionId]: {
        text: fullText.slice(0, MAX_LAST_PROMPT_CHARS),
        hadImages: images.length > 0,
        truncated: fullText.length > MAX_LAST_PROMPT_CHARS,
      },
    };
    router.persist();
    sendPromptToSession(targetSessionId, { text: fullText, images: images.length ? images : undefined });
    log.info("prompt forwarded from discord", {
      userId,
      session: router.sessionName(targetSessionId),
      chars: fullText.length,
      images: images.length,
      supportsImages: client.session?.supportsImages ?? null,
    });
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────
  discord.once("ready", async (client: any) => {
    log.info("bot connected", { tag: client.user.tag, allowAll: config.allowAll, allowed: config.allowedUsers.size });
    const active = getActiveSessions();
    log.info("session capabilities", {
      count: active.length,
      unknown: active.filter((session: any) => session.supportsImages === undefined).length,
      sessions: active.map((session: any) => ({
        session: String(session.sessionId).split(":").pop(),
        supportsImages: session.supportsImages ?? null,
      })),
    });
    await registerCommands(client.user.id);
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

  let shuttingDown = false;
  const shutdown = (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    router.shutdown();
    try { discord.destroy(); } catch {}
    log.info("discord bot stopped", { signal: signal ?? null });
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      shutdown(signal);
      if (signal === "SIGINT") process.exit(0);
    });
  }
  process.once("beforeExit", () => shutdown());
}
