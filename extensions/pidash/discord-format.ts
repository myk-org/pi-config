/**
 * Discord defaults over the shared chat layer.
 *
 * Chunking lives in `extensions/shared/chat/chat-format.ts`; this module adds
 * the only two things that are Discord's alone: the 2000-character limit and
 * mention suppression.
 */

export {
  chunkDiscordText,
  truncateLine,
  escapeDiscordMarkdown,
  DEFAULT_TEXT_LIMIT,
} from "../shared/chat/chat-format.ts";

/** Discord's hard limit for a single message's content. */
export const DISCORD_TEXT_LIMIT = 2000;

/**
 * Suppress every mention in agent output. Model output is untrusted text: an
 * `@everyone` or a role name inside a code block would otherwise ping the whole
 * server. Spread this into every `channel.send({ content, ...NO_MENTIONS })`.
 */
export const NO_MENTIONS = { allowedMentions: { parse: [] as string[] } };
