/**
 * Reaction shortcuts and session↔channel resolution.
 *
 * Pure so the mapping can be tested without a gateway: which emoji does what,
 * and which session a reacted message belongs to.
 */
import { createLogger } from "../shared/logger.ts";

const log = createLogger("pidash-discord-reactions");

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

/**
 * Which session owns a channel: a retained thread first, then the current
 * target, and nothing when the message is somewhere unrelated.
 */
export function sessionForChannel(
  targets: Record<string, { channelId: string; threadId?: string | null }> | undefined,
  watchedSessionId: string | null,
  fallbackChannelId: string | null | undefined,
  channelId: string,
): string | null {
  // The CURRENT watch wins. Two sessions can share one DM channel, and checking
  // retained targets first made a reaction on the newest message abort the
  // earlier session (Qodo 9ee29f3e).
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
