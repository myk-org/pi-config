/**
 * Reading the last assistant reply out of a session transcript.
 *
 * Lives here so `/last` is testable without a live session: the daemon hands
 * over its entries and this decides what "the last reply" means.
 */
import { createLogger } from "../logger.ts";

const log = createLogger("chat-transcript");

/** Join the text blocks of a message, ignoring tool calls and thinking. */
export function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n")
    .trim();
}

/** Last assistant text in the transcript, or "" when there is none yet. */
export function lastAssistantText(entries: any[]): string {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const text = messageText(entry.message);
    if (text) {
      log.debug("last assistant text found", { index, chars: text.length });
      return text;
    }
  }
  log.debug("no assistant text in transcript", { entries: entries.length });
  return "";
}
