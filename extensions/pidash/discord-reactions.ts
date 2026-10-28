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
  for (const [sessionId, target] of Object.entries(targets ?? {})) {
    if (target.threadId === channelId || target.channelId === channelId) {
      log.debug("reaction session matched", { sessionId, channelId });
      return sessionId;
    }
  }
  if (fallbackChannelId && fallbackChannelId === channelId && watchedSessionId) {
    log.debug("reaction session matched current target", { sessionId: watchedSessionId, channelId });
    return watchedSessionId;
  }
  return null;
}

/** Forum thread topic carries the session id, e.g. `pi · session:123:/repo`. */
export function sessionIdFromTopic(topic: unknown): string | null {
  const match = String(topic ?? "").match(/session:(\S+)/);
  return match ? match[1] : null;
}
