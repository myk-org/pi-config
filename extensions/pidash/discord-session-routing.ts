/**
 * Deep Discord session-routing module for pidash.
 *
 * Consolidates user/session runtime state, persistence & allowlist hydration,
 * inbound message/interaction routing, prompt-target lifecycle & eviction,
 * watch switching & disconnect, reaction routing, diagnostics records, and
 * unified `piEventHooks` session RPC behind a narrow transport port.
 *
 * Discord transport wiring lives in `discord-bot.ts`; everything here can be
 * exercised directly against an in-memory `DiscordRoutingPort`.
 */

import * as path from "node:path";
import { createLogger } from "../shared/logger.ts";
import { truncateLine } from "./discord-format.ts";
import { checkoutName } from "../shared/chat/chat-sessions.ts";
import {
  initialChatRuntime,
  type ChatBridge,
  type ChatRuntimeState,
} from "../shared/chat/chat-bridge.ts";
import type { PromptMethod } from "../shared/chat/chat-prompts.ts";
import type { ChatTarget } from "../shared/chat/chat-types.ts";
import {
  MAX_LAST_PROMPTS,
  MAX_THREADS_PER_USER,
  type DiscordUserState,
  type PersistedDiscordState,
} from "../shared/chat/chat-state.ts";

const defaultLog = createLogger("pidash-discord-routing");

export const INBOUND_DROP_LOG_WINDOW_MS = 60_000;
export const SEEN_MESSAGE_LIMIT = 500;
const ENDED_PROMPT_LIMIT = 200;

export interface RoutingLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** Discord's runtime state = persisted Discord state + shared ChatRuntimeState + typing/rate timers. */
export interface DiscordRuntimeUserState extends DiscordUserState, ChatRuntimeState {
  typingInterval: ReturnType<typeof setInterval> | null;
  typingSafety: ReturnType<typeof setTimeout> | null;
  unauthorizedNotifiedAt: number;
}

// ── Prompt targets & inbound resolution (pure) ───────────────────────────────

export type PromptTargetPlan =
  | { action: "existing"; channelId: string }
  | { action: "create-thread"; parentChannelId: string }
  | { action: "use-dm"; channelId: string }
  | { action: "use-channel"; channelId: string }
  | { action: "nowhere" };

export interface PromptTargetInput {
  /** A target the user already has for this session (watched it before, or it asked before). */
  existingChannelId: string | null;
  /** A GUILD text channel that can hold a thread. Never a DM, never another session's thread. */
  threadParentChannelId: string | null;
  /** The user's DM channel, if one is known. */
  dmChannelId: string | null;
  /** A plain channel that accepts messages but no threads. */
  plainChannelId: string | null;
}

/** The first route that can work: reuse, then a thread, then the DM, then a plain channel. */
export function planPromptTarget(input: PromptTargetInput): PromptTargetPlan {
  if (input.existingChannelId) return { action: "existing", channelId: input.existingChannelId };
  if (input.threadParentChannelId) return { action: "create-thread", parentChannelId: input.threadParentChannelId };
  return fallbackPromptTarget(input, "thread");
}

/** The next route after `failed` — thread → dm → channel → nowhere. Thread creation failing must
 *  not drop the question when the user has a DM or a channel. */
export function fallbackPromptTarget(
  input: PromptTargetInput,
  failed: "thread" | "dm" | "channel",
): PromptTargetPlan {
  if (failed === "thread") {
    if (input.dmChannelId) return { action: "use-dm", channelId: input.dmChannelId };
    if (input.plainChannelId) return { action: "use-channel", channelId: input.plainChannelId };
    return { action: "nowhere" };
  }
  if (failed === "dm") {
    if (input.plainChannelId) return { action: "use-channel", channelId: input.plainChannelId };
    return { action: "nowhere" };
  }
  return { action: "nowhere" };
}

/** Whether to tell a user who sits in ANOTHER session that this one is asking. The prompt stays in
 *  its own thread; the watched channel gets one line pointing at it. */
export function shouldNudge(input: { watchedSessionId: string | null; askedSessionId: string }): boolean {
  if (!input.watchedSessionId) return false;
  return input.watchedSessionId !== input.askedSessionId;
}

/** Nudges are throttled per asking session: a chatty background session must not turn the watched
 *  channel into a notification wall. */
export function nudgeDue(lastNudgeAt: number | undefined, now: number, minIntervalMs = 60_000): boolean {
  if (!lastNudgeAt) return true;
  return now - lastNudgeAt >= minIntervalMs;
}

/** Sessions whose thread mapping may be evicted to stay under the cap. A session waiting on an
 *  answer keeps its thread: evicting it would leave a question the user can no longer reach.
 *  Callers must drop BOTH the thread and the target mapping for each returned session. */
export function evictableSessions(
  threads: Record<string, string>,
  pendingSessionIds: Iterable<string>,
  max: number,
): string[] {
  const pending = new Set(pendingSessionIds);
  const known = Object.entries(threads).sort((a, b) => a[1].localeCompare(b[1]));
  const excess = known.length - max;
  if (excess <= 0) return [];
  const candidates: string[] = [];
  for (const [sessionId] of known) {
    if (candidates.length >= excess) break;
    if (pending.has(sessionId)) continue;
    candidates.push(sessionId);
  }
  return candidates;
}

/** The pending prompt with this id.
 *
 *  `preferredSessionId` is the session whose thread the interaction arrived in: with concurrent
 *  sessions that happen to share a prompt id, the thread decides which one the click belongs to.
 *  Without a thread context the id must be unique — answering the wrong agent is worse than asking
 *  the user to answer in the thread. */
export function promptById<T extends { id: string; sessionId: string }>(
  pendingPrompts: Record<string, T> | undefined,
  promptId: string,
  preferredSessionId?: string | null,
): T | null {
  const matches = Object.values(pendingPrompts ?? {}).filter((prompt) => prompt?.id === promptId);
  if (matches.length === 0) return null;
  if (preferredSessionId) {
    const preferred = matches.find((prompt) => prompt.sessionId === preferredSessionId);
    if (preferred) return preferred;
  }
  return matches.length === 1 ? matches[0]! : null;
}

/** What a resolved route turned into. */
export interface ResolvedPromptTarget {
  target: { channelId: string; threadId: string | null } | null;
  /** The route that worked, or "nowhere" — logged so a dropped question is explainable. */
  used: "existing" | "thread" | "dm" | "channel" | "nowhere";
  /** Failure of the first route, when a fallback had to be taken. */
  firstFailure: string | null;
}

/** Walk the routes until one produces a target.
 *
 *  `createThread` is injected: on a real bot it calls Discord, in a test it is a stub that can fail,
 *  which is exactly the case that used to drop a question. A failure MOVES to the next route. */
export async function resolvePromptTarget(
  input: PromptTargetInput,
  createThread: (parentChannelId: string) => Promise<string>,
): Promise<ResolvedPromptTarget> {
  if (input.existingChannelId) {
    return { target: { channelId: input.existingChannelId, threadId: null }, used: "existing", firstFailure: null };
  }
  let plan = planPromptTarget(input);
  let firstFailure: string | null = null;
  while (plan.action !== "nowhere") {
    if (plan.action === "create-thread") {
      try {
        const threadId = await createThread(plan.parentChannelId);
        return { target: { channelId: threadId, threadId }, used: "thread", firstFailure };
      } catch (error) {
        firstFailure ??= String(error);
        plan = fallbackPromptTarget(input, "thread");
        continue;
      }
    }
    if (plan.action === "use-dm") {
      return { target: { channelId: plan.channelId, threadId: null }, used: "dm", firstFailure };
    }
    if (plan.action === "use-channel") {
      return { target: { channelId: plan.channelId, threadId: null }, used: "channel", firstFailure };
    }
    break;
  }
  return { target: null, used: "nowhere", firstFailure };
}

/** Everything `ensurePromptTarget` needs from the transport layer, injected so the wiring is testable. */
export interface PromptTargetDeps {
  /** Discord channel lookup (throws when the channel is gone or invisible). */
  fetchChannel: (channelId: string) => Promise<any>;
  /** Create a thread in a guild channel and return its id (throws on failure). */
  createThread: (parentChannelId: string, name: string) => Promise<string>;
  /** Persist user state after a mapping change. */
  persist: () => void;
  /** Creation promises already in flight, keyed by user+session. */
  inFlight: Map<string, Promise<{ channelId: string; threadId?: string | null } | null>>;
  maxThreads: number;
  truncate?: (text: string, max: number) => string;
  /** Where route decisions go: a dropped question must be explainable from the log. */
  log?: RoutingLogger;
}

/** The mutable slice of user state this touches. */
export interface PromptTargetState {
  threads?: Record<string, string>;
  targets?: Record<string, { channelId: string; threadId?: string | null }>;
  promptOnlyTargets?: Record<string, true>;
  /** Only the KEYS matter here: a session with a pending prompt keeps its thread. */
  pendingPrompts?: Record<string, unknown>;
  dmChannelId?: string | null;
  responseChannelId?: string | null;
  /** The session the user watches: its thread must never be evicted by background questions. */
  watchedSessionId?: string | null;
}

/** A target for `sessionId`, created on demand and recorded on the user's state. */
export async function ensurePromptTarget(
  deps: PromptTargetDeps,
  state: PromptTargetState,
  args: { userId: string; sessionId: string; name: string },
): Promise<{ channelId: string; threadId?: string | null } | null> {
  const { userId, sessionId, name } = args;
  state.targets = state.targets ?? {};
  const known = state.targets[sessionId];
  if (known) {
    deps.log?.debug("prompt target reused", { sessionId, channelId: known.channelId });
    return known;
  }

  const key = `${userId}:${sessionId}`;
  const running = deps.inFlight.get(key);
  if (running) return running;

  const work = (async () => {
    // A thread from an earlier question is reused, and re-marked prompt-only so its output does not
    // stream for good after the answer.
    const existingThread = (state.threads ?? {})[sessionId];
    if (existingThread) {
      const reused = { channelId: existingThread, threadId: existingThread };
      state.targets = state.targets ?? {};
      state.targets[sessionId] = reused;
      state.promptOnlyTargets = { ...(state.promptOnlyTargets ?? {}), [sessionId]: true };
      deps.persist();
      return reused;
    }

    const parentId = await threadParent(state, deps);
    // A user recorded before `dmChannelId` existed still has a usable DM: the stored response
    // channel is one when Discord reports no guild for it.
    let dmChannelId = state.dmChannelId ?? null;
    if (!dmChannelId && state.responseChannelId) {
      try {
        const channel = await deps.fetchChannel(state.responseChannelId);
        if (channel && !channel.guildId) dmChannelId = state.responseChannelId;
      } catch { /* gone: the remaining routes decide */ }
    }
    const resolved = await resolvePromptTarget(
      {
        existingChannelId: null,
        threadParentChannelId: parentId,
        dmChannelId,
        plainChannelId: parentId && parentId !== foreignThread(state, parentId) ? parentId : null,
      },
      (parent) => deps.createThread(parent, deps.truncate ? deps.truncate(`pi · ${name}`, 90) : name),
    );
    if (!resolved.target) {
      // No route at all: the agent waits forever, so this is an error, not a warning.
      deps.log?.error("prompt target unavailable", { sessionId, threadParentId: parentId, failure: resolved.firstFailure });
      return null;
    }
    if (resolved.firstFailure) {
      // A route failed and we fell back: that is a recoverable problem worth a warning.
      deps.log?.warn("prompt target fell back", { sessionId, used: resolved.used, failure: resolved.firstFailure });
    } else {
      deps.log?.info("prompt target resolved", { sessionId, used: resolved.used, threadId: resolved.target.threadId ?? null });
    }

    // `switchWatch` may have installed its own thread for this session while Discord was being
    // called; keep that one, or the watch and the prompt's routing diverge.
    const installedWhileWorking = (state.threads ?? {})[sessionId];
    if (installedWhileWorking) {
      deps.log?.info("prompt target adopted selected thread", { sessionId, threadId: installedWhileWorking });
      const adopted = { channelId: installedWhileWorking, threadId: installedWhileWorking };
      state.targets = state.targets ?? {};
      state.targets[sessionId] = adopted;
      deps.persist();
      return adopted;
    }
    if (resolved.target.threadId) {
      state.threads = state.threads ?? {};
      state.threads[sessionId] = resolved.target.threadId;
      // Protect, in order: sessions waiting on an answer, the session being created right now (it
      // is not pending yet), and the session the user actually watches.
      const waiting = new Set([
        ...Object.keys(state.pendingPrompts ?? {}),
        sessionId,
        ...(state.watchedSessionId ? [state.watchedSessionId] : []),
      ]);
      const evicted: string[] = [];
      for (const stale of evictableSessions(state.threads, waiting, deps.maxThreads)) {
        delete state.threads[stale];
        // Drop the TARGET too, or the evicted session keeps being delivered into a dead thread.
        if (state.targets) delete state.targets[stale];
        evicted.push(stale);
      }
      if (evicted.length) deps.log?.info("prompt targets evicted", { evicted, maxThreads: deps.maxThreads });
    }
    state.targets = state.targets ?? {};
    state.targets[sessionId] = resolved.target;
    state.promptOnlyTargets = { ...(state.promptOnlyTargets ?? {}), [sessionId]: true };
    deps.persist();
    return resolved.target;
  })().finally(() => deps.inFlight.delete(key));

  deps.inFlight.set(key, work);
  return work;
}

/** A guild channel that can hold a thread: never a DM, never another session's thread. */
async function threadParent(state: PromptTargetState, deps: PromptTargetDeps): Promise<string | null> {
  const candidate = state.responseChannelId ?? null;
  if (!candidate) return null;
  if (foreignThread(state, candidate) === candidate) return null;
  try {
    const channel = await deps.fetchChannel(candidate);
    if (!channel?.guildId && !channel?.guild) return null;
    if (typeof channel?.threads?.create !== "function") return null;
    return candidate;
  } catch {
    return null;
  }
}

/** The session that owns `channelId` when it is somebody's thread, else null. */
function foreignThread(state: PromptTargetState, channelId: string): string | null {
  for (const [sessionId, threadId] of Object.entries(state.threads ?? {})) {
    if (threadId === channelId) return sessionId;
  }
  return null;
}

/** Threads that may become output targets on startup.
 *
 *  A muted user gets none (they disconnected), and a thread that exists only to deliver a question
 *  is not a subscription. Both rules live here so hydration cannot drift from them. */
export function hydratableTargets(state: {
  threads?: Record<string, string>;
  promptOnlyTargets?: Record<string, true>;
  deliveryMuted?: boolean;
}): Record<string, string> {
  if (state.deliveryMuted) return {};
  const targets: Record<string, string> = {};
  for (const [sessionId, threadId] of Object.entries(state.threads ?? {})) {
    if (state.promptOnlyTargets?.[sessionId]) continue;
    targets[sessionId] = threadId;
  }
  return targets;
}

/** Where to nudge a user about another session's question. */
export function nudgeChannelId(args: {
  watchedTargetChannelId: string | null;
  responseChannelId: string | null;
  askedChannelId: string | null;
}): string | null {
  for (const candidate of [args.watchedTargetChannelId, args.responseChannelId]) {
    if (!candidate) continue;
    if (candidate === args.askedChannelId) continue;
    return candidate;
  }
  return null;
}

/** The prompt header: WHO is asking, then the question. */
export function promptHeader(args: {
  name: string;
  /** Only used to shorten an ambiguous name — NEVER emitted in the header. */
  cwd: string | null;
  title: string | undefined;
  /** The session id (`<pid>:<cwd>`): two sessions in ONE checkout are otherwise identical. */
  sessionId?: string | null;
}): string {
  const pid = args.sessionId?.includes(":") ? args.sessionId.split(":")[0] : args.sessionId;
  const name = args.name.trim() || "pi";
  const who = pid ? `${name} (#${pid})` : name;
  const question = (args.title ?? "").trim() || "The agent is asking";
  return `${who} — ${question}`;
}

export type InboundSource = "thread" | "watch" | "target" | "active" | "none";

export interface InboundSession {
  sessionId: string | null;
  source: InboundSource;
  /** The stored watch has no live connection; not proof that the session was deleted. */
  deadWatch?: boolean;
  /** This channel carried a session's target, but that session is gone. */
  deadTarget?: boolean;
  /** More than one live session delivers into this channel — refuse instead of guessing. */
  ambiguous?: boolean;
}

export function resolveInboundSession(input: {
  channelId: string;
  threadSessionId?: string | null;
  watchedSessionId?: string | null;
  targets?: Record<string, { channelId: string; threadId?: string | null }> | null;
  isLive: (sessionId: string) => boolean;
}): InboundSession {
  const { channelId, isLive } = input;
  const thread = (input.threadSessionId ?? "").trim();
  const watched = (input.watchedSessionId ?? "").trim();
  const deadWatch = Boolean(watched) && !isLive(watched);
  const dead = deadWatch ? { deadWatch } : {};

  // A thread IS its session: identity, not liveness, decides.
  if (thread) return { sessionId: thread, source: "thread", ...dead };
  if (watched && isLive(watched)) return { sessionId: watched, source: "watch", ...dead };

  // Prefer a thread match over a channel match: a thread is a narrower address.
  const onChannel = Object.entries(input.targets ?? {}).flatMap(([sessionId, target]) =>
    target && (target.threadId === channelId || target.channelId === channelId)
      ? [{ sessionId, exactThread: target.threadId === channelId, live: isLive(sessionId) }]
      : []);
  const delivering = onChannel.filter((match) => match.live).sort((a, b) => Number(b.exactThread) - Number(a.exactThread));
  if (delivering.length > 1 && delivering[0]!.exactThread === delivering[1]!.exactThread) {
    return { sessionId: null, source: "none", ambiguous: true, ...dead };
  }
  if (delivering.length > 0) return { sessionId: delivering[0]!.sessionId, source: "target", ...dead };

  return { sessionId: null, source: "none", ...dead, ...(onChannel.length ? { deadTarget: true } : {}) };
}

// ── Reaction shortcuts & ownership (pure) ────────────────────────────────────

export type ReactionAction = "stop" | "retry" | "delete" | null;

/** Emoji → action. Anything else is ignored, so a stray tap does nothing. */
export function reactionAction(emoji: string): ReactionAction {
  switch (emoji) {
    case "⏹":
    case "🛑":
      return "stop";
    case "🔁":
      return "retry";
    case "🗑":
    case "🗑️":
      return "delete";
    default:
      return null;
  }
}

/** Which session owns a channel: current watch first when on its fallback channel, then retained targets. */
export function sessionForChannel(
  targets: Record<string, { channelId: string; threadId?: string | null }> | undefined,
  watchedSessionId: string | null,
  fallbackChannelId: string | null | undefined,
  channelId: string,
  log: RoutingLogger = defaultLog,
): string | null {
  if (fallbackChannelId && fallbackChannelId === channelId && watchedSessionId) {
    log.debug("reaction session matched current target", { sessionId: watchedSessionId, channelId });
    return watchedSessionId;
  }
  for (const [sessionId, target] of Object.entries(targets ?? {})) {
    if (target.threadId === channelId || target.channelId === channelId) {
      log.debug("reaction session matched retained target", { sessionId, channelId });
      return sessionId;
    }
  }
  return null;
}

/** Forum thread topic carries the session id, e.g. `pi · session:123:/repo`. */
export function sessionIdFromTopic(topic: unknown): string | null {
  const match = String(topic ?? "").match(/session:(\S+)/);
  return match ? match[1] : null;
}

/** Does this user own the channel a reaction landed in? */
export function ownsChannel(
  state: { target?: { channelId: string; threadId?: string | null } | null; targets?: Record<string, { channelId: string; threadId?: string | null }> },
  channelId: string,
): boolean {
  if (state.target?.channelId === channelId) return true;
  return Object.values(state.targets ?? {}).some((target) => (target.threadId ?? target.channelId) === channelId);
}

/** Does this user watch the session, or retain a target for it? */
export function ownsSession(
  state: { watchedSessionId: string | null; targets?: Record<string, unknown> },
  sessionId: string,
): boolean {
  return state.watchedSessionId === sessionId || Boolean(state.targets?.[sessionId]);
}

// ── Diagnostic records (pure, ids & state shape only) ────────────────────────

export interface InboundRouteFacts {
  /** Which refusal this is: channel-not-owned, no-target, ambiguous, session-disconnected, nothing-pending. */
  reason: string;
  channelId: string;
  guildId?: string | null;
  threadSessionId?: string | null;
  watchedSessionId?: string | null;
  watchLive: boolean;
  targets?: Record<string, { channelId: string; threadId?: string | null }> | null;
  ownsTarget: boolean;
  /** The author. Several users can share one fallback channel, so a drop is per-user, not per-channel. */
  userId?: string | null;
  inbound?: InboundSession | null;
}

/** The record logged for every inbound message the bot refuses or drops. Ids and state shape only. */
export function inboundRouteRecord(facts: InboundRouteFacts): Record<string, unknown> {
  return {
    reason: facts.reason,
    channelId: facts.channelId,
    guildId: facts.guildId ?? null,
    isDm: !facts.guildId,
    threadSessionId: facts.threadSessionId ?? null,
    watchedSessionId: facts.watchedSessionId ?? null,
    watchLive: facts.watchLive,
    targetKeys: Object.keys(facts.targets ?? {}),
    ownsTarget: facts.ownsTarget,
    inboundSource: facts.inbound?.source ?? null,
    inboundSessionId: facts.inbound?.sessionId ?? null,
    deadWatch: Boolean(facts.inbound?.deadWatch),
    deadTarget: Boolean(facts.inbound?.deadTarget),
    ambiguous: Boolean(facts.inbound?.ambiguous),
    userId: facts.userId ?? null,
  };
}

export interface InboundTraceFacts {
  /** "message" for a plain inbound message, otherwise the interaction kind. */
  kind: string;
  /** Which handler made the decision: messageCreate, message-context-menu, slash-command. */
  handler: string;
  channelId: string;
  guildId?: string | null;
  threadSessionId?: string | null;
  watchedSessionId?: string | null;
  watchLive: boolean;
  targets?: Record<string, { channelId: string; threadId?: string | null }> | null;
  commandName?: string | null;
  watchedClientPresent?: boolean | null;
  inbound?: InboundSession | null;
  /** Where the message actually went when it answered a pending prompt. */
  answerSessionId?: string | null;
}

/** The record logged where an inbound message is routed, and at the interaction guards. */
export function inboundTraceRecord(facts: InboundTraceFacts): Record<string, unknown> {
  const targetKeys = Object.keys(facts.targets ?? {});
  return {
    kind: facts.kind,
    handler: facts.handler,
    commandName: facts.commandName ?? null,
    channelId: facts.channelId,
    isDm: !facts.guildId,
    hasThread: Boolean(facts.threadSessionId),
    threadSessionId: facts.threadSessionId ?? null,
    watchedSessionId: facts.watchedSessionId ?? null,
    watchLive: facts.watchLive,
    watchedClientPresent: facts.watchedClientPresent ?? null,
    targetsCount: targetKeys.length,
    targetKeys,
    inboundSessionId: facts.inbound?.sessionId ?? null,
    inboundSource: facts.inbound?.source ?? null,
    answerSessionId: facts.answerSessionId ?? null,
  };
}

// ── Unified piEventHooks session RPC ─────────────────────────────────────────

export type SessionRequestResult<T = any> =
  | { ok: true; value: T }
  | { ok: false; reason: "disconnected" | "timeout" };

export interface SessionRequestTransport {
  /** Register an event listener and return an idempotent unsubscribe function. */
  subscribeEvents: (hook: (sessionId: string, event: any) => void) => () => void;
  /** Send a pidash command payload to `sessionId`; returns false when disconnected. */
  sendCommand: (sessionId: string, payload: Record<string, unknown>) => boolean;
  log?: RoutingLogger;
}

export interface SessionRequestOptions<T = any> {
  sessionId: string;
  command: string;
  eventType: string;
  timeoutMs?: number;
  requestIdPrefix?: string;
  /** Optional validator/extractor: return undefined to keep waiting for a matching event. */
  match?: (event: any) => T | undefined;
}

/** One-shot parameterized session RPC over `piEventHooks` (replaces requestModels/requestEvent/requestOnce). */
export function requestSessionEvent<T = any>(
  transport: SessionRequestTransport,
  opts: SessionRequestOptions<T>,
): Promise<SessionRequestResult<T>> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const prefix = opts.requestIdPrefix ?? "discord";
  const requestId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const log = transport.log ?? defaultLog;

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: SessionRequestResult<T>) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsubscribe) {
        const unsub = unsubscribe;
        unsubscribe = null;
        unsub();
      }
      resolve(result);
    };

    const hook = (eventSessionId: string, event: any) => {
      if (eventSessionId !== opts.sessionId) return;
      if (event?.type !== opts.eventType) return;
      if (event?.requestId && event.requestId !== requestId) return;
      if (opts.match) {
        const extracted = opts.match(event);
        if (extracted === undefined) return;
        finish({ ok: true, value: extracted });
        return;
      }
      finish({ ok: true, value: event as T });
    };

    timer = setTimeout(() => {
      log.debug("request timed out", { sessionId: opts.sessionId, command: opts.command, eventType: opts.eventType });
      finish({ ok: false, reason: "timeout" });
    }, timeoutMs);

    unsubscribe = transport.subscribeEvents(hook);
    let sent = false;
    try {
      sent = transport.sendCommand(opts.sessionId, { command: opts.command, requestId });
    } catch (error) {
      log.warn("session request send failed", { sessionId: opts.sessionId, command: opts.command, error: String(error) });
      sent = false;
    }
    if (!sent) finish({ ok: false, reason: "disconnected" });
  });
}

// ── Deep Discord session router & transport port ─────────────────────────────

export interface RoutingSessionRecord {
  sessionId: string;
  cwd?: string;
  model?: string;
  lastActivity?: number;
  active?: boolean;
  name?: string;
}

export interface DiscordRoutingPort {
  /** Fetch a Discord channel (with optional `force` cache bypass). */
  fetchChannel(channelId: string, options?: { force?: boolean }): Promise<any>;
  /** Platform-specific permission check for a fetched channel (defaults to allowed). */
  hasSendPermissions?(channel: any): boolean;
  /** Create a thread under `parentChannelId` and return its thread id. */
  createThread(parentChannelId: string, name: string, reason: string): Promise<string>;
  /** Open a DM channel for `userId` and return its channel id, or null if unavailable. */
  openDm?(userId: string): Promise<string | null>;
  /** Send plain text to a channel or thread (used for nudges, watch welcome, retry refusals). */
  sendText(channelId: string, text: string): Promise<string | null>;
  /** Clear typing timers for a user state. */
  clearTyping(state: DiscordRuntimeUserState): void;
  /** List all currently connected live session ids (with their lastActivity timestamp). */
  listLiveSessions(): Array<{ sessionId: string; lastActivity: number }>;
  /** Whether `sessionId` currently has a live WebSocket connection. */
  isSessionLive(sessionId: string): boolean;
  /** Look up session metadata for `sessionId` (or null when unknown). */
  getSession(sessionId: string): RoutingSessionRecord | null;
  /** Active sessions snapshot (for session naming and cwd lookup). */
  getActiveSessions(): Array<{ sessionId?: string; id?: string; cwd?: string; name?: string }>;
  /** Send a pidash command to `sessionId`. */
  sendCommand(sessionId: string, payload: Record<string, unknown>): boolean;
  /** Forward a prompt payload to `sessionId`. */
  sendPrompt(sessionId: string, payload: { text: string; images?: Array<{ data: string; mimeType: string; filename: string }> }): boolean;
  /** Subscribe to daemon `piEventHooks` and return an unsubscribe callback. */
  subscribeEvents(hook: (sessionId: string, event: any) => void): () => void;
  /** Load initial persisted state from disk (or memory in tests). */
  readPersistedState(): PersistedDiscordState;
  /** Persist state to disk (or memory in tests). */
  writePersistedState(state: PersistedDiscordState): void;
  /** Authorization predicate (allowAll or allowlist membership). */
  isUserAllowed(userId: string): boolean;
  /** Maximum remembered threads per user (defaults to `MAX_THREADS_PER_USER`). */
  maxThreads?: number;
  /** Logger (defaults to `createLogger("pidash-discord-routing")`). */
  log?: RoutingLogger;
  /** Clock override for deterministic tests (defaults to `Date.now`). */
  now?: () => number;
}

export interface InteractionRouteInput {
  kind: "message-context-menu" | "chat-input-command";
  handler: "message-context-menu" | "slash-command";
  fallbackHandler: string;
  commandName?: string | null;
  channelId: string;
  guildId?: string | null;
  userId: string;
  disconnectedReply: string;
}

export type InteractionRouteResult =
  | { ok: true; state: DiscordRuntimeUserState; sessionId: string; inbound: InboundSession }
  | { ok: false; reason: string; reply: string; inbound: InboundSession };

export type MessageGateResult =
  | { allowed: true; state: DiscordRuntimeUserState; threadSessionId: string | null }
  | { allowed: false; reason: "thread-owned-by-other" | "channel-not-owned" };

export type ChannelAskersResult =
  | { ambiguous: true }
  | { ambiguous: false; answerSession: string | undefined; hasPrompt: boolean };

export interface WatchSwitchContext {
  userId: string;
  username?: string;
  guildId?: string | null;
  channelId?: string | null;
  canCreateThread?: boolean;
  createThread?: (name: string, reason: string) => Promise<string>;
  openDm?: () => Promise<string | null>;
}

export interface WatchSwitchResult {
  ok: boolean;
  threadId: string | null;
  ackText: string;
}

export interface ReactionRouteInput {
  userId: string;
  channelId: string;
  emoji: string;
  messageId?: string;
  deleteMessage: () => Promise<void>;
  expectEcho: (state: DiscordRuntimeUserState, sessionId: string, text: string) => void;
}

export interface ReactionRouteResult {
  action: ReactionAction;
  status: "ignored" | "unauthorized" | "no-state" | "refused" | "skipped" | "executed";
}

export interface DiscordSessionRouter {
  readonly runtime: Map<string, DiscordRuntimeUserState>;
  userState(userId: string): DiscordRuntimeUserState;
  persist(): void;
  userForThread(threadId: string): [string, DiscordRuntimeUserState] | null;
  firstSighting(key: string): boolean;
  sessionName(sessionId: string | null): string;
  sessionNameFor(sessionId: string): string;
  sessionCwdFor(sessionId: string): string | null;
  logInboundDrop(
    facts: Omit<InboundRouteFacts, "reason"> & { reason: string },
    level?: "info" | "warn",
    trace?: InboundTraceFacts,
    throttleKey?: string,
  ): void;
  logRoutedDecision(
    channelId: string,
    inbound: InboundSession,
    answerSession: string | undefined,
    trace: InboundTraceFacts,
  ): void;
  streamsHere(state: DiscordRuntimeUserState, sessionId: string, channelId: string): boolean;
  routeToActiveSession(
    resolved: InboundSession,
    where: {
      handler: string;
      channelId?: string | null;
      guildId?: string | null;
      watchedSessionId?: string | null;
      userId?: string | null;
    },
  ): InboundSession;
  resolveInteractionRoute(input: InteractionRouteInput): InteractionRouteResult;
  resolveMessageGate(input: { userId: string; channelId: string; guildId?: string | null }): MessageGateResult;
  resolveMessageSession(input: {
    state: DiscordRuntimeUserState;
    userId: string;
    channelId: string;
    guildId?: string | null;
    threadSessionId: string | null;
  }): InboundSession;
  resolveChannelAskers(input: {
    state: DiscordRuntimeUserState;
    channelId: string;
    guildId?: string | null;
    inbound: InboundSession;
  }): ChannelAskersResult;
  establishReplyTarget(
    state: DiscordRuntimeUserState,
    sessionId: string,
    userId: string,
    openDm?: () => Promise<string | null>,
  ): Promise<boolean>;
  interactionThreadSession(channelId: string | null | undefined): string | null;
  ensureSessionTarget(
    userId: string,
    state: DiscordRuntimeUserState,
    sessionId: string,
    name: string,
  ): Promise<ChatTarget | null>;
  nudgeWatchedChannel(
    userId: string,
    state: DiscordRuntimeUserState,
    asked: string,
    name: string,
    target: ChatTarget,
  ): Promise<void>;
  releasePromptOnlyTarget(state: DiscordRuntimeUserState, sessionId: string): void;
  handleUiRequest(
    sessionId: string,
    event: any,
    bridge: Pick<ChatBridge, "onUiEvent" | "askUser">,
  ): void;
  disconnectUser(state: DiscordRuntimeUserState): void;
  switchWatch(
    state: DiscordRuntimeUserState,
    ctx: WatchSwitchContext,
    sessionId: string,
  ): Promise<WatchSwitchResult>;
  handleReaction(input: ReactionRouteInput): Promise<ReactionRouteResult>;
  requestSessionEvent<T = any>(opts: SessionRequestOptions<T>): Promise<SessionRequestResult<T>>;
  requestModels(sessionId: string, timeoutMs?: number): Promise<Array<{ id: string; name?: string; provider?: string }>>;
  requestPassthrough(
    sessionId: string,
    spec: { command: string; eventType: string; label: string },
    timeoutMs?: number,
  ): Promise<string>;
  shutdown(): void;
}

export function createDiscordSessionRouter(port: DiscordRoutingPort): DiscordSessionRouter {
  const log = port.log ?? defaultLog;
  const maxThreads = port.maxThreads ?? MAX_THREADS_PER_USER;
  const now = () => (port.now ? port.now() : Date.now());

  const persisted: PersistedDiscordState = port.readPersistedState();
  const runtime = new Map<string, DiscordRuntimeUserState>();

  function makeRuntime(stored: DiscordUserState | undefined): DiscordRuntimeUserState {
    const watched = stored?.watchedSessionId ?? null;
    const channelId = stored?.threadId || stored?.responseChannelId || null;
    const base = initialChatRuntime(watched, channelId ? { channelId, threadId: stored?.threadId ?? null } : null);
    const targets: Record<string, { channelId: string; threadId: string | null }> = {};
    for (const [sessionId, threadId] of Object.entries(hydratableTargets(stored ?? {}))) {
      targets[sessionId] = { channelId: threadId, threadId };
    }
    if (!stored?.deliveryMuted) {
      for (const [sessionId, dmChannel] of Object.entries(stored?.dmTargets ?? {})) {
        targets[sessionId] = { channelId: dmChannel, threadId: null };
      }
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
      updatedAt: stored?.updatedAt ?? now(),
      typingInterval: null,
      typingSafety: null,
      unauthorizedNotifiedAt: 0,
      deliveryMuted: stored?.deliveryMuted === true,
      promptOnlyTargets: { ...(stored?.promptOnlyTargets ?? {}) },
      dmChannelId: stored?.dmChannelId ?? null,
    };
  }

  function prunablePrompts(state: DiscordRuntimeUserState): NonNullable<DiscordRuntimeUserState["lastPrompts"]> {
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
        lastPrompts: prunablePrompts(state),
        deliveryMuted: state.deliveryMuted === true,
        promptOnlyTargets: { ...(state.promptOnlyTargets ?? {}) },
        dmChannelId: state.dmChannelId ?? null,
        dmTargets: Object.fromEntries(Object.entries(state.targets ?? {}).filter(([id, target]) =>
          target.channelId === state.dmChannelId && !target.threadId && !state.promptOnlyTargets?.[id]
        ).map(([id, target]) => [id, target.channelId])),
        updatedAt: state.updatedAt,
      };
    }
    port.writePersistedState(persisted);
  }

  // Hydrate persisted watches on startup and drop users removed from the allowlist.
  let droppedUsers = 0;
  for (const [userId, stored] of Object.entries(persisted.users)) {
    if (!port.isUserAllowed(userId)) {
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
  log.info("discord state hydrated", {
    users: runtime.size,
    watching: [...runtime.values()].filter((s) => s.watchedSessionId).length,
  });

  function userState(userId: string): DiscordRuntimeUserState {
    let state = runtime.get(userId);
    if (!state) {
      state = makeRuntime(persisted.users[userId]);
      runtime.set(userId, state);
    }
    return state;
  }

  function userForThread(threadId: string): [string, DiscordRuntimeUserState] | null {
    for (const [userId, state] of runtime) {
      if (state.threadId === threadId) return [userId, state];
      for (const known of Object.values(state.threads ?? {})) {
        if (known === threadId) return [userId, state];
      }
    }
    return null;
  }

  const dropLoggedAt = new Map<string, number>();
  const routedDecisions = new Map<string, string>();
  const fallbackDecisions = new Map<string, string>();
  const seenMessages = new Set<string>();
  const targetInFlight = new Map<string, Promise<{ channelId: string; threadId?: string | null } | null>>();
  const lastNudgeAt = new Map<string, number>();
  const endedPrompts = new Set<string>();

  function hasBotState(state: DiscordRuntimeUserState | undefined): boolean {
    return Boolean(state && (
      state.watchedSessionId
      || state.responseChannelId
      || state.threadId
      || Object.keys(state.threads ?? {}).length
      || Object.keys(state.targets ?? {}).length
    ));
  }

  function claimsSession(state: DiscordRuntimeUserState | undefined, sessionId: string): boolean {
    return Boolean(state && (ownsSession(state, sessionId) || state.threads?.[sessionId]));
  }

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

  function logInboundDrop(
    facts: Omit<InboundRouteFacts, "reason"> & { reason: string },
    level: "info" | "warn" = "warn",
    trace?: InboundTraceFacts,
    throttleKey?: string,
  ): void {
    if (throttleKey) {
      const current = now();
      const last = dropLoggedAt.get(throttleKey);
      if (last !== undefined && current - last < INBOUND_DROP_LOG_WINDOW_MS) return;
      dropLoggedAt.delete(throttleKey);
      if (dropLoggedAt.size >= SEEN_MESSAGE_LIMIT) {
        const oldest = dropLoggedAt.keys().next().value;
        if (oldest !== undefined) dropLoggedAt.delete(oldest);
      }
      dropLoggedAt.set(throttleKey, current);
    }
    const record = trace
      ? { ...inboundRouteRecord(facts), ...inboundTraceRecord(trace) }
      : inboundRouteRecord(facts);
    if (level === "warn") log.warn("discord_inbound_dropped", record);
    else log.info("discord_inbound_dropped", record);
  }

  function logRoutedDecision(
    channelId: string,
    inbound: InboundSession,
    answerSession: string | undefined,
    trace: InboundTraceFacts,
  ): void {
    const decision = `${inbound.source}:${inbound.sessionId ?? ""}:${answerSession ?? ""}`;
    if (routedDecisions.get(channelId) === decision) return;
    if (routedDecisions.size > SEEN_MESSAGE_LIMIT) {
      const oldest = routedDecisions.keys().next().value;
      if (oldest !== undefined) routedDecisions.delete(oldest);
    }
    routedDecisions.set(channelId, decision);
    log.debug("discord_inbound_routed", inboundTraceRecord(trace));
  }

  function sessionName(sessionId: string | null): string {
    if (!sessionId) return "none";
    const session = port.getSession(sessionId);
    if (!session) return "unknown";
    const cwd = session.cwd ?? "";
    return cwd.split("/").pop() || cwd || sessionId;
  }

  function sessionCwdFor(sessionId: string): string | null {
    try {
      const sessions = port.getActiveSessions() ?? [];
      const found = sessions.find((session) => (session?.sessionId ?? session?.id) === sessionId);
      return typeof found?.cwd === "string" && found.cwd ? found.cwd : null;
    } catch {
      return null;
    }
  }

  function sessionNameFor(sessionId: string): string {
    try {
      const sessions = port.getActiveSessions() ?? [];
      const found = sessions.find((session) => (session?.sessionId ?? session?.id) === sessionId);
      if (typeof found?.cwd === "string" && found.cwd) return checkoutName(found as any);
      const named = typeof found?.name === "string" && found.name ? path.basename(found.name) : "";
      return named || sessionId.slice(0, 8);
    } catch {
      return sessionId.slice(0, 8);
    }
  }

  function streamsHere(state: DiscordRuntimeUserState, sessionId: string, channelId: string): boolean {
    const target = state.targets?.[sessionId] ?? (state.watchedSessionId === sessionId ? state.target : null);
    return Boolean(target && (target.threadId || target.channelId) === channelId);
  }

  function routeToActiveSession(
    resolved: InboundSession,
    where: {
      handler: string;
      channelId?: string | null;
      guildId?: string | null;
      watchedSessionId?: string | null;
      userId?: string | null;
    },
  ): InboundSession {
    const fallbackKey = `${where.handler}:${where.channelId ?? ""}:${where.userId ?? ""}`;
    if (resolved.sessionId || resolved.ambiguous || resolved.deadTarget) {
      fallbackDecisions.delete(fallbackKey);
      return resolved;
    }
    const callerState = where.userId ? runtime.get(where.userId) : undefined;
    const liveSessions = port.listLiveSessions().filter(({ sessionId }) =>
      claimsSession(callerState, sessionId)
      || ![...runtime.entries()].some(([uid, other]) => uid !== where.userId && claimsSession(other, sessionId)),
    );
    if (!liveSessions.length) {
      fallbackDecisions.delete(fallbackKey);
      return resolved;
    }
    const newest = liveSessions.reduce((best, entry) => (entry.lastActivity > best.lastActivity ? entry : best));
    const sessionId = newest.sessionId;
    if (fallbackDecisions.get(fallbackKey) !== sessionId) {
      fallbackDecisions.delete(fallbackKey);
      if (fallbackDecisions.size >= SEEN_MESSAGE_LIMIT) {
        const oldest = fallbackDecisions.keys().next().value;
        if (oldest !== undefined) fallbackDecisions.delete(oldest);
      }
      fallbackDecisions.set(fallbackKey, sessionId);
      log.debug("discord_inbound_fallback", {
        reason: liveSessions.length === 1 ? "fallback_single_active" : "fallback_newest_active",
        sessionId,
        candidates: liveSessions.length,
        handler: where.handler,
        channelId: where.channelId ?? null,
        guildId: where.guildId ?? null,
        watchedSessionId: where.watchedSessionId ?? null,
        userId: where.userId ?? null,
      });
    }
    return { ...resolved, sessionId, source: "active" };
  }

  function resolveInteractionRoute(input: InteractionRouteInput): InteractionRouteResult {
    const state = userState(input.userId);
    const channelId = String(input.channelId ?? "");
    const threadSessionId = Object.entries(state.threads ?? {}).find(([, tid]) => tid === channelId)?.[0] ?? null;
    const inbound = routeToActiveSession(resolveInboundSession({
      channelId,
      threadSessionId,
      watchedSessionId: state.watchedSessionId ?? null,
      targets: state.targets ?? {},
      isLive: (sessionId) => port.isSessionLive(sessionId),
    }), {
      handler: input.fallbackHandler,
      channelId,
      guildId: input.guildId,
      watchedSessionId: state.watchedSessionId ?? null,
      userId: input.userId,
    });

    if (!inbound.sessionId) {
      const reason = inbound.ambiguous
        ? "interaction-ambiguous"
        : inbound.deadTarget
          ? "interaction-dead-target"
          : "interaction-no-watch";
      const watchLive = Boolean(state.watchedSessionId && port.isSessionLive(state.watchedSessionId));
      logInboundDrop({
        reason,
        channelId,
        guildId: input.guildId,
        watchedSessionId: state.watchedSessionId ?? null,
        watchLive,
        targets: state.targets,
        ownsTarget: false,
        userId: input.userId,
        inbound,
      }, "warn", {
        kind: input.kind,
        handler: input.handler,
        commandName: input.commandName ?? null,
        channelId,
        guildId: input.guildId,
        watchedSessionId: state.watchedSessionId ?? null,
        watchLive,
        targets: state.targets,
        watchedClientPresent: false,
        inbound,
      });
      const reply = inbound.ambiguous
        ? "This channel carries more than one session. Send in that session's thread or use `/sessions`."
        : inbound.deadTarget
          ? "The session this channel belonged to is gone. Use `/sessions` and pick one."
          : "Not watching any session. Use `/sessions` first.";
      return { ok: false, reason, reply, inbound };
    }

    if (!port.isSessionLive(inbound.sessionId)) {
      logInboundDrop({
        reason: "interaction-session-disconnected",
        channelId,
        guildId: input.guildId,
        watchedSessionId: inbound.sessionId,
        watchLive: false,
        targets: state.targets,
        ownsTarget: false,
        userId: input.userId,
      });
      return {
        ok: false,
        reason: "interaction-session-disconnected",
        reply: input.disconnectedReply,
        inbound,
      };
    }

    return { ok: true, state, sessionId: inbound.sessionId, inbound };
  }

  function resolveMessageGate(input: {
    userId: string;
    channelId: string;
    guildId?: string | null;
  }): MessageGateResult {
    const { userId, channelId, guildId } = input;
    let threadSessionId: string | null = null;
    if (guildId) {
      const existingState = runtime.get(userId);
      const actorBucket = hasBotState(existingState) ? userId : "";
      const byThread = userForThread(channelId);
      if (byThread && byThread[0] !== userId) {
        logInboundDrop({
          reason: "thread-owned-by-other",
          channelId,
          guildId,
          watchedSessionId: existingState?.watchedSessionId ?? null,
          watchLive: Boolean(existingState?.watchedSessionId && port.isSessionLive(existingState.watchedSessionId)),
          targets: existingState?.targets,
          ownsTarget: false,
          userId,
        }, "info", undefined, `${channelId}:thread-owned-by-other:${actorBucket}`);
        return { allowed: false, reason: "thread-owned-by-other" };
      }
      const ownsTarget = existingState?.target?.channelId === channelId
        || Object.values(existingState?.targets ?? {}).some((target) => target?.channelId === channelId);
      if (!byThread && !ownsTarget) {
        logInboundDrop({
          reason: "channel-not-owned",
          channelId,
          guildId,
          watchedSessionId: existingState?.watchedSessionId ?? null,
          watchLive: Boolean(existingState?.watchedSessionId && port.isSessionLive(existingState.watchedSessionId)),
          targets: existingState?.targets,
          ownsTarget: false,
          userId,
        }, "info", undefined, `${channelId}:channel-not-owned:${actorBucket}`);
        return { allowed: false, reason: "channel-not-owned" };
      }
      threadSessionId = byThread
        ? Object.entries(byThread[1].threads ?? {}).find(([, tid]) => tid === channelId)?.[0] ?? null
        : null;
    }

    const state = userState(userId);
    state.deliveryMuted = false;
    state.updatedAt = now();
    if (!guildId) {
      state.responseChannelId = channelId;
      state.dmChannelId = channelId;
      if (!state.threadId) {
        state.targets = state.targets ?? {};
        state.target = (state.watchedSessionId && state.targets[state.watchedSessionId])
          || { channelId, threadId: null };
        if (state.watchedSessionId) state.targets[state.watchedSessionId] = state.target;
      }
    }
    return { allowed: true, state, threadSessionId };
  }

  function resolveMessageSession(input: {
    state: DiscordRuntimeUserState;
    userId: string;
    channelId: string;
    guildId?: string | null;
    threadSessionId: string | null;
  }): InboundSession {
    const { state, userId, channelId, guildId, threadSessionId } = input;
    const base = resolveInboundSession({
      channelId,
      threadSessionId,
      watchedSessionId: state.watchedSessionId ?? null,
      targets: state.targets ?? {},
      isLive: (sessionId) => port.isSessionLive(sessionId),
    });
    const withStreamingFallback: InboundSession =
      base.sessionId || base.ambiguous || !state.watchedSessionId || !streamsHere(state, state.watchedSessionId, channelId)
        ? base
        : { sessionId: state.watchedSessionId, source: "watch" };
    return routeToActiveSession(withStreamingFallback, {
      handler: "messageCreate",
      channelId,
      guildId,
      watchedSessionId: state.watchedSessionId ?? null,
      userId,
    });
  }

  function resolveChannelAskers(input: {
    state: DiscordRuntimeUserState;
    channelId: string;
    guildId?: string | null;
    inbound: InboundSession;
  }): ChannelAskersResult {
    const { state, channelId, guildId, inbound } = input;
    const askersHere = guildId
      ? Object.entries(state.targets ?? {})
        .filter(([sessionId, target]) => Boolean(target)
          && (target!.threadId === channelId || target!.channelId === channelId)
          && Boolean((state.pendingPrompts ?? {})[sessionId]))
        .map(([sessionId]) => sessionId)
      : [];
    if (askersHere.length > 1) return { ambiguous: true };
    const answerSession = guildId
      ? askersHere[0] ?? (inbound.source === "active" ? undefined : inbound.sessionId ?? undefined)
      : undefined;
    const hasPrompt = guildId
      ? Boolean(answerSession && (state.pendingPrompts ?? {})[answerSession])
      : Boolean(state.pendingPrompt);
    return { ambiguous: false, answerSession, hasPrompt };
  }

  async function establishReplyTarget(
    state: DiscordRuntimeUserState,
    sessionId: string,
    userId: string,
    openDm?: () => Promise<string | null>,
  ): Promise<boolean> {
    let target = state.targets?.[sessionId];
    if (target) {
      try {
        const channel = await port.fetchChannel(target.threadId || target.channelId, { force: true });
        const hasPerms = port.hasSendPermissions ? port.hasSendPermissions(channel) : true;
        if (!channel?.isTextBased?.() || typeof channel.send !== "function" || channel.archived || channel.locked || !hasPerms) {
          target = undefined;
        }
      } catch {
        target = undefined;
      }
    }
    if (!target) {
      try {
        const dmId = await (openDm ? openDm() : port.openDm?.(userId) ?? Promise.resolve(null));
        if (!dmId) throw new Error("DM unavailable");
        state.dmChannelId = dmId;
        target = { channelId: dmId, threadId: null };
      } catch {
        log.warn("discord reply destination unavailable", { userId, sessionId });
        return false;
      }
    }
    state.targets = { ...state.targets, [sessionId]: target };
    if (state.promptOnlyTargets) delete state.promptOnlyTargets[sessionId];
    state.deliveryMuted = false;
    persist();
    log.debug("discord reply destination established", { userId, sessionId, channelId: target.channelId });
    return true;
  }

  function interactionThreadSession(channelId: string | null | undefined): string | null {
    if (!channelId) return null;
    for (const [, state] of runtime) {
      for (const [sessionId, threadId] of Object.entries(state.threads ?? {})) {
        if (threadId === channelId && state.pendingPrompts?.[sessionId]) return sessionId;
      }
    }
    return null;
  }

  async function ensureSessionTarget(
    userId: string,
    state: DiscordRuntimeUserState,
    sessionId: string,
    name: string,
  ): Promise<ChatTarget | null> {
    return ensurePromptTarget(
      {
        fetchChannel: (channelId) => port.fetchChannel(channelId),
        createThread: (parentChannelId, threadName) =>
          port.createThread(parentChannelId, threadName, `pi session ${name}`),
        persist,
        inFlight: targetInFlight,
        maxThreads,
        truncate: truncateLine,
        log,
      },
      state,
      { userId, sessionId, name },
    );
  }

  async function nudgeWatchedChannel(
    userId: string,
    state: DiscordRuntimeUserState,
    asked: string,
    name: string,
    target: ChatTarget,
  ): Promise<void> {
    if (!shouldNudge({ watchedSessionId: state.watchedSessionId, askedSessionId: asked })) return;
    const channelId = nudgeChannelId({
      watchedTargetChannelId: state.target?.channelId ?? null,
      responseChannelId: state.responseChannelId ?? null,
      askedChannelId: target.channelId,
    });
    if (!channelId) {
      log.warn("nudge skipped: no channel to write to", { asked, watched: state.watchedSessionId });
      return;
    }
    const current = now();
    const nudgeKey = `${userId}:${asked}`;
    if (!nudgeDue(lastNudgeAt.get(nudgeKey), current)) return;
    lastNudgeAt.set(nudgeKey, current);
    try {
      await port.sendText(channelId, `❓ **${truncateLine(name, 60)}** is asking a question → <#${target.channelId}>`);
      log.info("nudged watched channel", { asked, watched: state.watchedSessionId });
    } catch (error) {
      log.debug("nudge failed", { asked, error: String(error) });
    }
  }

  function releasePromptOnlyTarget(state: DiscordRuntimeUserState, sessionId: string): void {
    if (!state.promptOnlyTargets?.[sessionId]) return;
    delete state.promptOnlyTargets[sessionId];
    if (state.watchedSessionId !== sessionId && state.targets) delete state.targets[sessionId];
    persist();
    log.debug("prompt-only target released", { sessionId });
  }

  function handleUiRequest(
    sessionId: string,
    event: any,
    bridge: Pick<ChatBridge, "onUiEvent" | "askUser">,
  ): void {
    if (event?.type === "ui-dismiss" || event?.type === "ui_prompt_end") {
      bridge.onUiEvent(sessionId, event);
      if (typeof event?.id === "string") {
        endedPrompts.add(event.id);
        if (endedPrompts.size > ENDED_PROMPT_LIMIT) {
          const oldest = endedPrompts.values().next().value;
          if (oldest !== undefined) endedPrompts.delete(oldest);
        }
      }
      return;
    }
    const method = (event.method || "input") as PromptMethod;
    const name = sessionNameFor(sessionId);
    const cwd = sessionCwdFor(sessionId);
    const titled = { ...event, title: promptHeader({ name, cwd, title: event.title, sessionId }) };
    if (typeof event?.id === "string") endedPrompts.delete(event.id);
    for (const [userId, state] of runtime) {
      void (async () => {
        const known = state.targets?.[sessionId] ?? (state.watchedSessionId === sessionId ? state.target : null);
        const target = known ?? await ensureSessionTarget(userId, state, sessionId, name);
        if (!target) {
          log.error("prompt dropped: no delivery target", { userId, sessionId, method });
          return;
        }
        if (endedPrompts.has(event?.id)) {
          log.debug("prompt skipped: ended while creating its target", { userId, sessionId });
          return;
        }
        const prompt = bridge.askUser(sessionId, titled, state);
        if (!prompt) return;
        log.info("prompt forwarded to discord", { userId, sessionId, method, promptId: prompt.id, created: !known });
        await nudgeWatchedChannel(userId, state, sessionId, name, target);
      })().catch((error: unknown) => {
        log.error("prompt delivery failed", { userId, sessionId, error: String(error) });
      });
    }
  }

  function disconnectUser(state: DiscordRuntimeUserState): void {
    port.clearTyping(state);
    state.watchedSessionId = null;
    state.threadId = null;
    state.target = null;
    state.targets = {};
    state.deliveryMuted = true;
    state.promptOnlyTargets = {};
    state.threads = {};
    state.streams = {};
    state.pendingPrompts = {};
    state.pendingPrompt = null;
    state.lastPrompts = {};
    persist();
  }

  async function switchWatch(
    state: DiscordRuntimeUserState,
    ctx: WatchSwitchContext,
    sessionId: string,
  ): Promise<WatchSwitchResult> {
    const session = port.getSession(sessionId);
    if (!session) {
      return { ok: false, threadId: null, ackText: "Session no longer available." };
    }
    state.watchedSessionId = session.sessionId;
    state.deliveryMuted = false;
    if (state.promptOnlyTargets) delete state.promptOnlyTargets[sessionId];
    const name = sessionName(state.watchedSessionId);
    state.threads = state.threads ?? {};

    let threadId: string | null = state.threads[sessionId] ?? null;
    if (threadId) {
      try {
        const existing = await port.fetchChannel(threadId);
        if (!existing) threadId = null;
      } catch {
        threadId = null;
      }
    }
    if (!threadId && ctx.guildId && (ctx.createThread || (ctx.canCreateThread && ctx.channelId))) {
      try {
        const threadName = truncateLine(name, 90);
        const reason = `pi session ${name}`;
        threadId = ctx.createThread
          ? await ctx.createThread(threadName, reason)
          : await port.createThread(ctx.channelId!, threadName, reason);
        state.threads[sessionId] = threadId;
        const waiting = new Set([...Object.keys(state.pendingPrompts ?? {}), sessionId]);
        for (const stale of evictableSessions(state.threads, waiting, maxThreads)) {
          delete state.threads[stale];
          if (state.targets) delete state.targets[stale];
        }
        log.info("created thread for session", { threadId, sessionId });
      } catch (error) {
        log.warn("thread creation failed, falling back to DM", { error: String(error) });
      }
    }
    if (!threadId) {
      try {
        const dmId = await (ctx.openDm ? ctx.openDm() : port.openDm?.(ctx.userId) ?? Promise.resolve(null));
        if (dmId) {
          state.responseChannelId = dmId;
          state.dmChannelId = dmId;
        }
      } catch {
        log.warn("could not open DM", { user: ctx.username ?? ctx.userId });
      }
    }
    if (!threadId && !state.responseChannelId && ctx.channelId) {
      state.responseChannelId = ctx.channelId;
      log.info("falling back to the command channel for output", { channelId: ctx.channelId });
    }
    state.threadId = threadId;
    const target = threadId
      ? { channelId: threadId, threadId }
      : state.responseChannelId
        ? { channelId: state.responseChannelId, threadId: null }
        : null;
    state.target = target;
    state.targets = state.targets ?? {};
    if (target) state.targets[sessionId] = target;
    persist();

    const header = `Now watching **${name}**.`;
    if (threadId) await port.sendText(threadId, `${header} Ask here; slash commands still work in the server.`);
    return {
      ok: true,
      threadId,
      ackText: threadId
        ? `${header} Continue in the thread.`
        : `${header} (${session.model || "—"}) Send prompts in DM.`,
    };
  }

  async function handleReaction(input: ReactionRouteInput): Promise<ReactionRouteResult> {
    if (!port.isUserAllowed(input.userId)) {
      return { action: null, status: "unauthorized" };
    }
    const state = runtime.get(input.userId);
    if (!state) return { action: null, status: "no-state" };
    const action = reactionAction(input.emoji);
    if (!action) return { action: null, status: "ignored" };

    const sessionId = sessionForChannel(
      state.targets,
      state.watchedSessionId,
      state.target?.channelId,
      input.channelId,
      log,
    );

    if (action === "stop") {
      if (!sessionId || !ownsSession(state, sessionId)) {
        log.info("reaction stop refused", { userId: input.userId, sessionId });
        return { action, status: "refused" };
      }
      const stopped = port.sendCommand(sessionId, { command: "abort" });
      log.info("reaction stop", { userId: input.userId, sessionId, stopped });
      return { action, status: "executed" };
    }

    if (action === "retry") {
      const remembered = sessionId ? state.lastPrompts?.[sessionId] : null;
      if (!remembered || !sessionId || !port.isSessionLive(sessionId)) {
        log.debug("reaction retry skipped", { userId: input.userId, sessionId, hasPrompt: Boolean(remembered) });
        return { action, status: "skipped" };
      }
      if (remembered.truncated) {
        await port.sendText(input.channelId, "That prompt was too long to keep in full, so 🔁 cannot resend it exactly.");
        log.info("reaction retry refused", { userId: input.userId, sessionId, reason: "truncated" });
        return { action, status: "refused" };
      }
      const text = remembered.hadImages
        ? `${remembered.text}\n\n(The images from the original message are not re-sent.)`
        : remembered.text;
      input.expectEcho(state, sessionId, text);
      port.sendPrompt(sessionId, { text });
      log.info("reaction retry", { userId: input.userId, sessionId, chars: text.length, hadImages: remembered.hadImages });
      return { action, status: "executed" };
    }

    if (!ownsChannel(state, input.channelId)) {
      log.info("reaction delete refused", { userId: input.userId, channelId: input.channelId });
      return { action, status: "refused" };
    }
    await input.deleteMessage().catch((error: any) => log.debug("reaction delete failed", { error: String(error) }));
    log.info("reaction delete", { userId: input.userId, messageId: input.messageId ?? null });
    return { action, status: "executed" };
  }

  const rpcTransport: SessionRequestTransport = {
    subscribeEvents: (hook) => port.subscribeEvents(hook),
    sendCommand: (sessionId, payload) => port.sendCommand(sessionId, payload),
    log,
  };

  function requestEventUnified<T = any>(opts: SessionRequestOptions<T>): Promise<SessionRequestResult<T>> {
    return requestSessionEvent(rpcTransport, opts);
  }

  async function requestModels(
    sessionId: string,
    timeoutMs = 5000,
  ): Promise<Array<{ id: string; name?: string; provider?: string }>> {
    const res = await requestEventUnified<Array<{ id: string; name?: string; provider?: string }>>({
      sessionId,
      command: "list-models",
      eventType: "models-list",
      timeoutMs,
      requestIdPrefix: "discord-models",
      match: (event) => (Array.isArray(event?.models) ? event.models : undefined),
    });
    return res.ok ? res.value : [];
  }

  async function requestPassthrough(
    sessionId: string,
    spec: { command: string; eventType: string; label: string },
    timeoutMs = 5000,
  ): Promise<string> {
    const res = await requestEventUnified({
      sessionId,
      command: spec.command,
      eventType: spec.eventType,
      timeoutMs,
    });
    if (!res.ok) {
      return res.reason === "disconnected"
        ? "Session is not connected."
        : "Timed out waiting for the session.";
    }
    return `**${spec.label}**\n\`\`\`json\n${JSON.stringify(res.value).slice(0, 1600)}\n\`\`\``;
  }

  function shutdown(): void {
    for (const state of runtime.values()) port.clearTyping(state);
    persist();
  }

  return {
    runtime,
    userState,
    persist,
    userForThread,
    firstSighting,
    sessionName,
    sessionNameFor,
    sessionCwdFor,
    logInboundDrop,
    logRoutedDecision,
    streamsHere,
    routeToActiveSession,
    resolveInteractionRoute,
    resolveMessageGate,
    resolveMessageSession,
    resolveChannelAskers,
    establishReplyTarget,
    interactionThreadSession,
    ensureSessionTarget,
    nudgeWatchedChannel,
    releasePromptOnlyTarget,
    handleUiRequest,
    disconnectUser,
    switchWatch,
    handleReaction,
    requestSessionEvent: requestEventUnified,
    requestModels,
    requestPassthrough,
    shutdown,
  };
}
