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
  saveInboundAttachment,
  MAX_IMAGE_BYTES,
  MAX_INLINE_TEXT_BYTES,
} from "../shared/chat/chat-attachments.ts";
import { renderPrompt, type PendingPrompt, type PromptMethod } from "../shared/chat/chat-prompts.ts";
import {
  entriesFromModels,
  orderPickerEntries,
  pickerLabel,
  slicePickerPage,
} from "../shared/chat/chat-picker.ts";
import { compareCommandPayloads } from "./discord-commands.ts";
import { MAX_LAST_PROMPTS, MAX_LAST_PROMPT_CHARS } from "../shared/chat/chat-state.ts";
import { jobIdAt, renderJobsView } from "./discord-jobs-view.ts";
import { planBoard } from "./discord-board.ts";
import { ownsChannel, ownsSession, reactionAction, sessionForChannel, sessionIdFromTopic } from "./discord-reactions.ts";
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
    // Reaction partials: a reaction on a message the bot did not cache still
    // has to reach us, or shortcuts work only on recent messages.
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });

  // ── state ────────────────────────────────────────────────────────────────
  const persisted: PersistedDiscordState = readState(config.stateFile);
  const runtime = new Map<string, RuntimeUserState>();

  function makeRuntime(stored: DiscordUserState | undefined): RuntimeUserState {
    const watched = stored?.watchedSessionId ?? null;
    const channelId = stored?.threadId || stored?.responseChannelId || null;
    const base = initialChatRuntime(watched, channelId ? { channelId, threadId: stored?.threadId ?? null } : null);
    // Retained threads must keep their session's output after a restart: without
    // rebuilding targets from the stored thread ids, a thread could send prompts
    // and receive nothing (Qodo 8c6acae5).
    const targets: Record<string, { channelId: string; threadId: string | null }> = {};
    for (const [sessionId, threadId] of Object.entries(stored?.threads ?? {})) {
      targets[sessionId] = { channelId: threadId, threadId };
    }
    if (watched && !targets[watched] && stored?.responseChannelId) {
      targets[watched] = { channelId: stored.responseChannelId, threadId: null };
    }
    return {
      ...base,
      targets,
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
  let droppedUsers = 0;
  for (const [userId, stored] of Object.entries(persisted.users)) {
    // A user removed from the allowlist must stop receiving output; restoring
    // their targets kept streaming session material to them (Qodo c30b0ca9).
    if (!config.allowAll && !config.allowedUsers.has(userId)) {
      delete persisted.users[userId];
      droppedUsers += 1;
      continue;
    }
    runtime.set(userId, makeRuntime(stored));
  }
  if (droppedUsers > 0) {
    log.info("dropped users no longer on the allowlist", { dropped: droppedUsers });
    persist();
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

  /**
   * Remembered prompts worth keeping: only sessions this user still watches or
   * retains a thread for, newest last, at most MAX_LAST_PROMPTS entries.
   * Otherwise every session a user ever touched leaves message text on disk
   * (Qodo a2f90e46).
   */
  function prunablePrompts(state: RuntimeUserState): NonNullable<RuntimeUserState["lastPrompts"]> {
    const keep = new Set<string>(Object.keys(state.targets ?? {}));
    if (state.watchedSessionId) keep.add(state.watchedSessionId);
    const entries = Object.entries(state.lastPrompts ?? {}).filter(([sessionId]) => keep.has(sessionId));
    return Object.fromEntries(entries.slice(-MAX_LAST_PROMPTS));
  }

  function persist(): void {
    for (const [userId, state] of runtime) {
      persisted.users[userId] = {
        watchedSessionId: state.watchedSessionId,
        responseChannelId: state.responseChannelId,
        threadId: state.threadId ?? null,
        threads: state.threads ?? {},
        // Without this the 🔁 shortcut forgets every prompt on restart.
        lastPrompts: prunablePrompts(state),
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
  /**
   * Send text, optionally with components ATTACHED IN THE SAME MESSAGE.
   *
   * The question flow used to post text and then edit the message to add its
   * buttons; that edit failed silently in a DM and the user saw "reply with a
   * number" with nothing to tap. One send, one failure mode, and failures are
   * logged instead of swallowed.
   */
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
        // Sends always notify. Suppressing them silenced the answer entirely:
        // Discord edits never notify, so the ONE message that creates a reply
        // is the only chance to buzz a phone. Streaming deltas arrive as edits
        // (suppressed), so a long turn still rings once, not per delta.
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

  /** Components-v2 message (a card, not a text wall). */
  async function sendCard(channelId: string, container: any, notify = false): Promise<string | null> {
    try {
      const channel = await discord.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return null;
      const sent = await (channel as any).send({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | (notify ? 0 : MessageFlags.SuppressNotifications),
        ...NO_MENTIONS,
      });
      return sent?.id ?? null;
    } catch (error) {
      log.warn("discord card send failed", { channelId, error: String(error) });
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

  /** First non-internal IPv4 so a phone on the LAN can open the dashboard. */
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

  /**
   * Is a URL reachable from another device? The diff server binds 127.0.0.1,
   * so a LAN link to it is a dead button on a phone. Probe before offering.
   */
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

  /** Where inbound files land so the agent can use normal file tools on them. */
  function inboxDir(cwd: string | undefined): string {
    const base = cwd && cwd.trim() ? cwd : process.cwd();
    return `${base}/.pi/tmp/discord-inbox`;
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

  /**
   * Forum session board: one thread per session.
   *
   * A forum channel keeps sessions from competing for a single scrolling chat.
   * The channel comes from DISCORD_FORUM_CHANNEL_ID — the bot never creates
   * channels on its own.
   */
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
      sessions.map((session: any) => ({ sessionId: String(session.sessionId), label: sessionName(String(session.sessionId)) })),
      Object.fromEntries(existing),
    );
    const byId = new Map(sessions.map((session: any) => [String(session.sessionId), session]));

    let created = 0;
    for (const planned of plan.toCreate) {
      const sessionId = planned.sessionId;
      const session: any = byId.get(sessionId) ?? {};
      try {
        const thread = await forum.threads.create({
          name: truncateLine(sessionName(sessionId), 90),
          // The starter message is readable by everyone with access to the
          // forum, so it carries no working directory — the cwd stays in the
          // ephemeral reply (Qodo 00e6ae39).
          message: { content: `${sessionName(sessionId)} — pi session. Type here to prompt it.` },
          reason: `pi session ${sessionId}`,
        });
        // The topic is the thread's identity: without it every lookup misses and
        // re-running the command would duplicate the board (Qodo 4fa32268).
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
      // The menu only carries indexes; the ids ride with the message.
      ...(plan.sessionIds.length ? { boardSessionIds: plan.sessionIds } : {}),
    };
  }

  /**
   * Reaction shortcuts on the bot's own messages: ⏹ stop, 🔁 retry the last
   * prompt, 🗑 delete. One tap beats a keyboard on a phone.
   */
  discord.on("messageReactionAdd", async (reaction: any, user: any) => {
    try {
      if (user?.bot) return;
      if (reaction?.partial) await reaction.fetch().catch(() => {});
      const message = reaction?.message?.partial ? await reaction.message.fetch().catch(() => null) : reaction?.message;
      if (!message || message.author?.id !== discord.user?.id) return;
      const userId = String(user?.id ?? "");
      if (!(config.allowAll || config.allowedUsers.has(userId))) return;
      const state = runtime.get(userId);
      if (!state) return;
      const emoji = reaction.emoji?.name ?? "";
      const action = reactionAction(emoji);
      if (!action) return;
      const channelId = String(message.channelId ?? "");
      const sessionId = sessionForChannel(state.targets, state.watchedSessionId, state.target?.channelId, channelId);

      if (action === "stop") {
        if (!sessionId || !ownsSession(state, sessionId)) {
          log.info("reaction stop refused", { userId, sessionId });
          return;
        }
        const stopped = sessionId ? command(sessionId, { command: "abort" }) : false;
        log.info("reaction stop", { userId, sessionId, stopped });
        return;
      }
      if (action === "retry") {
        const remembered = sessionId ? state.lastPrompts?.[sessionId] : null;
        const client = sessionId ? piClients.get(sessionId) : null;
        if (!remembered || !client?.ws) {
          log.debug("reaction retry skipped", { userId, sessionId, hasPrompt: Boolean(remembered) });
          return;
        }
        // A retry must send the SAME request. A truncated prompt or one that
        // carried images cannot be reproduced, so say so instead of quietly
        // submitting something else (Qodo bcacb8c5, 7e8820db).
        if (remembered.truncated) {
          await sendText(channelId, "That prompt was too long to keep in full, so 🔁 cannot resend it exactly.");
          log.info("reaction retry refused", { userId, sessionId, reason: "truncated" });
          return;
        }
        const text = remembered.hadImages
          ? `${remembered.text}\n\n(The images from the original message are not re-sent.)`
          : remembered.text;
        bridge.expectEcho(state, sessionId!, text);
        client.ws.send(JSON.stringify({ type: "prompt", text }));
        log.info("reaction retry", { userId, sessionId, chars: text.length, hadImages: remembered.hadImages });
        return;
      }
      if (action === "delete") {
        // Deleting a bot reply is only allowed where this user is the owner of
        // the target: a shared guild thread must not let one allowlisted user
        // remove another's answer (Qodo e67e18a1).
        if (!ownsChannel(state, channelId)) {
          log.info("reaction delete refused", { userId, channelId });
          return;
        }
        await message.delete().catch((error: any) => log.debug("reaction delete failed", { error: String(error) }));
        log.info("reaction delete", { userId, messageId: message.id });
        return;
      }
    } catch (error) {
      log.warn("reaction handling failed", { error: String(error) });
    }
  });

  /** Native controls for a question: buttons, a select, or a modal button. */
  function promptControls(prompt: PendingPrompt): any[] {
    if (prompt.method === "confirm") {
      return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`answer:${prompt.id}:yes`).setLabel("Approve").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`answer:${prompt.id}:no`).setLabel("Deny").setStyle(ButtonStyle.Danger),
      )];
    }
    if (prompt.options.length > 0 && prompt.options.length <= 25) {
      return [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`answer:${prompt.id}:select`)
          .setPlaceholder("Choose an option")
          .addOptions(prompt.options.slice(0, 25).map((option: string, i: number) => ({
            label: truncateLine(option, 100), value: String(i),
          }))),
      )];
    }
    // Free-text question: a modal beats "type your answer as a chat message".
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`answer-modal:${prompt.id}`).setLabel("Answer").setStyle(ButtonStyle.Primary),
    )];
  }

  const bridge: ChatBridge = createChatBridge({
    adapter,
    promptTtlMs: config.promptTtlMs,
    streamEditIntervalMs: STREAM_EDIT_INTERVAL_MS,
    users: () => runtime.entries(),
    renderPrompt: async (target, prompt, body) => {
      const controls = promptControls(prompt);
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
      // Any session with a target gets its question, not just the watched one.
      const target = state.targets?.[sessionId] ?? (state.watchedSessionId === sessionId ? state.target : null);
      if (!target) continue;
      const prompt = bridge.askUser(sessionId, event, state);
      if (!prompt) continue;
      // Delivery (with controls) happens in renderPrompt; this only records who was asked.
      log.info("prompt forwarded to discord", { userId, sessionId, method, promptId: prompt.id });
    }
  }

  // ── slash commands ───────────────────────────────────────────────────────
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

  /**
   * Do the registered commands still match what we want to register?
   *
   * Compares the fields that define a command — everything else Discord fills
   * in (ids, versions, guild scope) is ignored so a restart is a no-op.
   */
  async function registerCommands(clientId: string, guildId?: string): Promise<void> {
    const rest = new REST().setToken(config.token);
    const builders = COMMANDS.map(([name, description]) => {
      const builder = new SlashCommandBuilder()
        .setName(name)
        .setDescription(description)
        // Usable in a DM and from a private channel: the bot should not require
        // a server just to answer a question from a phone.
        .setContexts(
          InteractionContextType.Guild,
          InteractionContextType.BotDM,
          InteractionContextType.PrivateChannel,
        )
        // User install lets an allowed user add PI to their own servers/DMs
        // without an admin (requires enabling it in the Discord developer portal).
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
    // Right-click / long-press a message → send it to the agent. Cheapest big
    // win on a phone: stack traces and log lines become tasks without copying.
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
      // A bulk overwrite on every start reissues command ids, and a client that
      // cached the old ones answers "This command is outdated" when tapped
      // (live report). Only write when the definitions actually differ.
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
        disconnectUser(state);
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
        await acknowledge(interaction, `Switching **${sessionName(picker.sessionId)}** to \`${choice.id}\`.`);
        log.info("model chosen from picker", { session: picker.sessionId, modelId: choice.id });
        return;
      }

      const modelPage = customId.match(/^modelpage:(\d+)$/);
      if (modelPage) {
        if (!picker) {
          await acknowledge(interaction, "This model list expired — run `/model` again.");
          return;
        }
        // Same entries + same preference as page 1: paging never reorders, so
        // no model is skipped or shown twice across a boundary.
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
        // The forum thread already exists for this session: reuse it as the
        // session's target instead of creating a second thread elsewhere.
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
      const modalOpen = customId.match(/^answer-modal:([^:]+)$/);
      if (modalOpen) {
        const promptId = modalOpen[1];
        const owned = Object.entries(state.pendingPrompts ?? {}).find(([, prompt]) => prompt.id === promptId);
        if (!owned) {
          await acknowledge(interaction, "That prompt is no longer waiting.");
          return;
        }
        const [, prompt] = owned;
        const modal = new ModalBuilder()
          .setCustomId(`answer-submit:${promptId}`)
          .setTitle("Your answer")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("value")
                .setLabel(truncateLine(prompt.options[0] || "Answer", 45))
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

    if (interaction.isMessageContextMenuCommand?.()) {
      const state = userState(interaction.user.id);
      const targetSession = state.watchedSessionId;
      if (!targetSession) {
        await interaction.reply({ content: "Not watching any session. Use `/sessions` first.", ephemeral: true }).catch(() => {});
        return;
      }
      const client = piClients.get(targetSession);
      if (!client?.ws) {
        await interaction.reply({ content: "The watched session is disconnected.", ephemeral: true }).catch(() => {});
        return;
      }
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
      bridge.expectEcho(state, targetSession, prompt);
      client.ws.send(JSON.stringify({ type: "prompt", text: prompt }));
      await interaction.reply({ content: `Sent to **${sessionName(targetSession)}**.`, ephemeral: true }).catch(() => {});
      log.info("context menu prompt forwarded", { userId: interaction.user.id, session: targetSession, chars: prompt.length });
      return;
    }

    if (interaction.isModalSubmit?.()) {
      const submit = String(interaction.customId || "").match(/^answer-submit:([^:]+)$/);
      if (!submit) return;
      const owned = Object.entries(state.pendingPrompts ?? {}).find(([, prompt]) => prompt.id === submit[1]);
      if (!owned) {
        await acknowledge(interaction, "That prompt is no longer waiting.");
        return;
      }
      const [promptSession, prompt] = owned;
      const value = interaction.fields.getTextInputValue("value");
      bridge.answer(state, value, (content) => void acknowledge(interaction, content), promptSession || prompt.sessionId);
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

    if (name === "disconnect") {
      const wasWatching = state.watchedSessionId;
      disconnectUser(state);
      await interaction.reply({
        content: wasWatching ? `Disconnected from **${sessionName(wasWatching)}**.` : "Was not watching anything.",
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
        // No id given → picker. Typing a model id on a phone is not a thing.
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
        const models = await requestModels(watched);
        if (!models.length) {
          await interaction.editReply({ content: `Model: **${session.model || "—"}** (no model list available)` }).catch(() => {});
          return;
        }
        const entries = entriesFromModels(models, session.model);
        const currentGroup = entries.find((entry) => entry.current)?.group
          ?? entries.find((entry) => entry.label === session.model)?.group
          ?? null;
        // Order ONCE and keep it: a select value is an index into this list.
        const ordered = orderPickerEntries(entries, currentGroup);
        const page = slicePickerPage(ordered, 1);
        const reply: any = await interaction.editReply({
          content: `**Model** — current: ${session.model || "—"}\nPage ${page.page}/${page.pages} of ${page.total}`,
          components: modelPickerComponents(page),
        }).catch((error: any) => {
          log.warn("model picker failed", { error: String(error) });
          return null;
        });
        if (reply?.id) rememberPicker(reply.id, { sessionId: watched ?? "", preferGroup: currentGroup, ordered });
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

    if (name === "async" || name === "cron") {
      const isAsync = name === "async";
      const sessionId = watched ?? "";
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      const snapshot = await requestEvent(sessionId, {
        command: isAsync ? "async-list" : "cron-list",
        eventType: isAsync ? "async-list" : "cron-list",
      });
      if (!snapshot) {
        await interaction.editReply({ content: "No data for this session yet." }).catch(() => {});
        return;
      }
      const view = renderJobsView(isAsync ? "async" : "cron", snapshot);
      const rows: any[] = [];
      if (view.stoppable.length) {
        rows.push(new ActionRowBuilder().addComponents(
          ...view.stoppable.map((id, index) => new ButtonBuilder()
            .setCustomId(`${isAsync ? "async-kill" : "cron-kill"}:${sessionId}:${id}`)
            .setLabel(`Stop ${index + 1}`)
            .setStyle(ButtonStyle.Danger)),
        ));
      }
      await interaction.editReply({ content: view.content, components: rows })
        .catch((error: any) => log.warn(`${name} reply failed`, { error: String(error) }));
      log.info(`${name} listed`, { session: sessionId, stoppable: view.stoppable.length });
      return;
    }

    if (name === "board") {
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      const { boardSessionIds, ...view } = await renderBoard();
      const reply: any = await interaction.editReply(view).catch((error: any) => {
        log.warn("board reply failed", { error: String(error) });
        return null;
      });
      if (reply?.id && Array.isArray(boardSessionIds)) rememberBoard(reply.id, boardSessionIds);
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

  /**
   * Stop watching everything for this user.
   *
   * Disconnect used to live only behind /sessions → button; on a phone that is
   * two screens away from "stop bothering me".
   */
  function disconnectUser(state: RuntimeUserState): void {
    // A disconnected user is not being answered, so the typing timer must die
    // with the watch — otherwise it refreshes for up to five minutes.
    clearTyping(state);
    state.watchedSessionId = null;
    state.threadId = null;
    state.target = null;
    state.targets = {};
    // Hydration rebuilds targets from threads and streams point at messages in
    // those threads, so both must go or a restart resurrects the watch.
    state.threads = {};
    state.streams = {};
    state.pendingPrompts = {};
    state.pendingPrompt = null;
    // Prompt history is message content on disk: disconnecting must forget it,
    // not leave it behind for the next reader of the state file (Qodo 8fbf223f).
    state.lastPrompts = {};
    persist();
  }

  /** Native controls (buttons/menus) answer through the engine too. */
  function resolvePrompt(prompt: PendingPrompt, raw: string, state: RuntimeUserState, interaction: any): void {
    // Scoped to the prompt's session: cancelling in one thread must not stop
    // another session's waiting agent (Qodo 1eec9a4d).
    bridge.answer(state, raw, (content) => void acknowledge(interaction, content), prompt.sessionId);
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
    const target = threadId
      ? { channelId: threadId, threadId }
      : state.responseChannelId
        ? { channelId: state.responseChannelId, threadId: null }
        : null;
    state.target = target;
    // Keep the per-session target map in step: a retained thread must keep
    // receiving its own session's output after the user switches away.
    state.targets = state.targets ?? {};
    if (target) state.targets[sessionId] = target;
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

  /**
   * `/status` as a components-v2 card: title, state line, separator, details,
   * and link buttons. The links use the LAN address because `localhost` on a
   * phone points at the phone.
   */
  async function statusCard(session: any, sessionId: string): Promise<any> {
    const state = session.active ? (session.working ? "working" : "idle") : "detached";
    const badge = session.working ? "🟢" : session.active ? "⚪" : "🔴";
    const container = new ContainerBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`# ${badge} ${sessionName(sessionId)}`),
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

    // Only offer links a phone can actually open: the dashboard binds 0.0.0.0,
    // the diff server binds 127.0.0.1 and would be a dead button.
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

  /**
   * What a picker message is for: the session it was opened FOR, the ordering
   * it was built with, and the items it shows.
   *
   * Keyed by message id so a stale picker cannot retarget the session the user
   * switched to, paging keeps the same ordering (no duplicated/skipped models
   * across a boundary), and select values are list indexes — Discord caps
   * option values at 100 chars, which silently truncated long model ids.
   */
  interface PickerContext {
    sessionId: string;
    preferGroup: string | null;
    /** The EXACT ordered list shown to the user — select values index this. */
    ordered: ReturnType<typeof entriesFromModels>;
  }

  const pickerContexts = new Map<string, PickerContext>();
  interface JobListContext {
    sessionId: string;
    kind: "async" | "cron";
    stoppable: string[];
  }

  /**
   * Which jobs a Stop button refers to, keyed by message id.
   *
   * The old customId embedded the session id and split on ":", but session ids
   * look like `123:/repo`, so Stop resolved session `123` and killed nothing.
   */
  const jobLists = new Map<string, JobListContext>();

  const PICKER_CONTEXT_LIMIT = 50;

  /** session ids per board message, so a picker index resolves to the full id. */
  const boardLists = new Map<string, string[]>();

  function rememberBoard(messageId: string, sessionIds: string[]): void {
    boardLists.set(messageId, sessionIds);
    while (boardLists.size > PICKER_CONTEXT_LIMIT) {
      const oldest = boardLists.keys().next().value;
      if (oldest === undefined) break;
      boardLists.delete(oldest);
    }
    log.debug("board list stored", { messageId, sessions: sessionIds.length });
  }

  function rememberJobList(messageId: string, context: JobListContext): void {
    jobLists.set(messageId, context);
    while (jobLists.size > PICKER_CONTEXT_LIMIT) {
      const oldest = jobLists.keys().next().value;
      if (oldest === undefined) break;
      jobLists.delete(oldest);
    }
  }

  function rememberPicker(messageId: string, context: PickerContext): void {
    pickerContexts.set(messageId, context);
    while (pickerContexts.size > PICKER_CONTEXT_LIMIT) {
      const oldest = pickerContexts.keys().next().value;
      if (oldest === undefined) break;
      pickerContexts.delete(oldest);
    }
    log.debug("picker context stored", { messageId, session: context.sessionId, entries: context.ordered.length });
  }

  /** Select menu for one page of models, plus prev/next when paged. */
  function modelPickerComponents(page: ReturnType<typeof slicePickerPage>): any[] {
    const rows: any[] = [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`modelpick:${page.page}`)
        .setPlaceholder(`Choose a model (${page.total})`)
        .addOptions(page.items.map((entry, index) => ({
          label: pickerLabel(entry),
          // Index into the full list, resolved server-side: never truncated.
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

  /** The session's model list, via the same command the browser uses. */
  async function requestModels(sessionId: string): Promise<Array<{ id: string; name?: string; provider?: string }>> {
    const requestId = `discord-models-${Date.now()}`;
    return new Promise((resolve) => {
      const done = (models: Array<{ id: string; name?: string; provider?: string }>) => {
        clearTimeout(timer);
        const index = piEventHooks.indexOf(hook);
        if (index >= 0) piEventHooks.splice(index, 1);
        resolve(models);
      };
      const timer = setTimeout(() => done([]), 5000);
      const hook = (eventSessionId: string, event: any) => {
        if (eventSessionId !== sessionId) return;
        if (event?.type !== "models-list" || !Array.isArray(event.models)) return;
        if (event.requestId && event.requestId !== requestId) return;
        done(event.models);
      };
      piEventHooks.push(hook);
      if (!command(sessionId, { command: "list-models", requestId })) done([]);
    });
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
  /** Ask the session for one event and return it structured (null when absent). */
  async function requestEvent(
    sessionId: string,
    spec: { command: string; eventType: string },
    timeoutMs = 5000,
  ): Promise<any | null> {
    const requestId = `discord-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      const done = (event: any | null) => {
        clearTimeout(timer);
        const index = piEventHooks.indexOf(hook);
        if (index >= 0) piEventHooks.splice(index, 1);
        resolve(event);
      };
      const timer = setTimeout(() => {
        log.debug("request timed out", { sessionId, command: spec.command });
        done(null);
      }, timeoutMs);
      const hook = (eventSessionId: string, event: any) => {
        if (eventSessionId !== sessionId) return;
        if (event?.type !== spec.eventType) return;
        if (event?.requestId && event.requestId !== requestId) return;
        done(event);
      };
      piEventHooks.push(hook);
      if (!command(sessionId, { command: spec.command, requestId })) done(null);
    });
  }

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
      if (!state.threadId) {
        state.target = { channelId: message.channelId, threadId: null };
        state.targets = state.targets ?? {};
        if (state.watchedSessionId) state.targets[state.watchedSessionId] = state.target;
      }
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
      // Only a THREAD names a session. A DM is session-agnostic: passing the
      // watched session made an older session's question unreachable (Qodo
      // d9b80852).
      bridge.answer(state, "/cancel", (content) => void message.reply(content).catch(() => {}), threadSessionId ?? undefined);
      return;
    }

    if (state.pendingPrompt) {
      const outcome = bridge.handleInbound(
        state, text,
        (content) => void message.reply(content).catch(() => {}),
        threadSessionId ?? undefined,
      );
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
        if (fetched) {
          images.push({ data: fetched.buffer.toString("base64"), mimeType: fetched.contentType, filename: plan.filename });
          // Also keep a copy in the workspace: base64 reaches the model, but the
          // agent cannot open, re-read or move a blob with its own tools.
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
        }
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
      // The agent gets the note, but the person who sent the image needs to know
      // it was dropped (Qodo e2a451fc).
      await message.reply(imageNote).catch(() => {});
    }

    if (!text && images.length === 0 && notes.length === 0) return;

    const fullText = notes.length ? (text ? `${text}\n\n` : "") + notes.join("\n\n") : text;
    // The engine suppresses this echo per watcher using the state's marker.
    bridge.expectEcho(state, targetSessionId!, fullText);
    // Reaction shortcut 🔁 resends this without retyping. The flags record when
    // a faithful replay is impossible (truncated text, images omitted).
    state.lastPrompts = {
      ...(state.lastPrompts ?? {}),
      [targetSessionId!]: {
        text: fullText.slice(0, MAX_LAST_PROMPT_CHARS),
        hadImages: images.length > 0,
        truncated: fullText.length > MAX_LAST_PROMPT_CHARS,
      },
    };
    persist();
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
    // Visible capability per session: proves the producer -> hub -> bot chain
    // end to end at startup, without waiting for someone to send an image.
    const active = getActiveSessions();
    log.info("session capabilities", {
      count: active.length,
      unknown: active.filter((session: any) => session.supportsImages === undefined).length,
      sessions: active.map((session: any) => ({
        session: String(session.sessionId).split(":").pop(),
        supportsImages: session.supportsImages ?? null,
      })),
    });
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
