/**
 * Where a session's question should be delivered, and who should be nudged.
 *
 * A question used to reach Discord only when its session had a target, and a target only existed
 * after the user had picked that session. So a background session asking something was invisible
 * unless you happened to be watching it.
 *
 * Everything here is pure so the routes and their fallbacks are asserted without a Discord client.
 */

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

/** Everything `ensurePromptTarget` needs from the bot, injected so the wiring is testable. */
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
  log?: { debug: (message: string, data?: Record<string, unknown>) => void; info: (message: string, data?: Record<string, unknown>) => void; warn: (message: string, data?: Record<string, unknown>) => void; error: (message: string, data?: Record<string, unknown>) => void };
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

/** A target for `sessionId`, created on demand and recorded on the user's state.
 *
 *  This is the wiring behind "a session that asks a question gets a place to ask it": it reuses the
 *  session's thread, resolves the routes through {@link resolvePromptTarget}, evicts stale maps and
 *  marks the target prompt-only. Discord is reached only through the injected deps, so the whole
 *  thing is testable — including the failure that used to drop a question. */
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
    deps.log?.info("prompt target resolved", {
      sessionId,
      used: resolved.used,
      threadId: resolved.target.threadId ?? null,
      fellBackFrom: resolved.firstFailure ? "thread" : null,
    });

    // `switchWatch` may have installed its own thread for this session while Discord was being
    // called; keep that one, or the watch and the prompt's routing diverge.
    const installedWhileWorking = (state.threads ?? {})[sessionId];
    if (installedWhileWorking) {
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
      // is not pending yet), and the session the user actually watches — background questions must
      // never take the watched session's thread away.
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

/** Where to nudge a user about another session's question.
 *
 *  The watched session may have no channel of its own (watched from a DM, or a thread that was never
 *  created), and bailing there meant the user was never told — they had to notice by luck. Falls
 *  back to the channel the user last spoke from, and never returns the question's own channel. */
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

/** The prompt header: WHO is asking, then the question.
 *
 *  A DM has no thread title to look at, so without this the user sees a bare question and has to
 *  guess which session asked it. The checkout path disambiguates two sessions of the same name. */
export function promptHeader(args: { name: string; cwd: string | null; title: string | undefined }): string {
  const who = args.cwd ? `${args.name} · ${args.cwd}` : args.name;
  const question = (args.title ?? "").trim() || "The agent is asking";
  return `${who} — ${question}`;
}
