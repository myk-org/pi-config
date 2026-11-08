/**
 * Where a session's question should be delivered, and who should be nudged.
 *
 * A question used to reach Discord only when its session had a target, and a target only existed
 * after the user had picked that session. So a background session asking something was invisible
 * unless you happened to be watching it. These decisions are pure so they can be asserted without
 * a Discord client.
 */

/** The delivery route for one session's question. */
export type PromptTargetPlan =
  | { action: "existing"; channelId: string }
  | { action: "create-thread"; parentChannelId: string }
  | { action: "use-dm" }
  | { action: "use-channel"; channelId: string }
  | { action: "nowhere" };

export interface PromptTargetInput {
  /** A target the user already has for this session (watched it before). */
  existingChannelId: string | null;
  /** Channel a thread could be created in (the user's home channel), if any. */
  parentChannelId: string | null;
  /** Whether that parent accepts threads (forum channels create them differently). */
  parentSupportsThreads: boolean;
  /** A DM channel the user already has, if any. */
  hasDm: boolean;
  /** Last resort: the channel the user is currently in. */
  fallbackChannelId: string | null;
}

/** Prefer what already exists, then a NEW thread (keeps the question with its session and gives the
 *  answer a route home), then the DM, then the current channel. */
export function planPromptTarget(input: PromptTargetInput): PromptTargetPlan {
  if (input.existingChannelId) return { action: "existing", channelId: input.existingChannelId };
  if (input.parentChannelId && input.parentSupportsThreads) {
    return { action: "create-thread", parentChannelId: input.parentChannelId };
  }
  if (input.hasDm) return { action: "use-dm" };
  if (input.parentChannelId) return { action: "use-channel", channelId: input.parentChannelId };
  if (input.fallbackChannelId) return { action: "use-channel", channelId: input.fallbackChannelId };
  return { action: "nowhere" };
}

/** Whether to tell a user who is sitting in ANOTHER session that this one is asking. The prompt
 *  itself stays in its own thread; a nudge pointing at it is all the watched channel gets. */
export function shouldNudge(input: {
  watchedSessionId: string | null;
  askedSessionId: string;
  askedChannelId: string | null;
}): boolean {
  if (!input.watchedSessionId) return false;
  if (input.watchedSessionId === input.askedSessionId) return false;
  return Boolean(input.askedChannelId);
}

/** Sessions whose thread mapping may be evicted to stay under the cap. A session with a pending
 *  question keeps its thread: evicting it would leave a question the user can no longer answer. */
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

/** The pending prompt with this id, in WHICHEVER session it belongs to.
 *
 *  A prompt in another session's thread is still the user's prompt: resolving only the watched
 *  session's one made Approve/Deny answer "that prompt is no longer waiting" — and answering must
 *  never move the user's watch to the asking session. */
export function promptById<T extends { id: string }>(
  pendingPrompts: Record<string, T> | undefined,
  promptId: string,
): T | null {
  for (const prompt of Object.values(pendingPrompts ?? {})) {
    if (prompt?.id === promptId) return prompt;
  }
  return null;
}
