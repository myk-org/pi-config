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
