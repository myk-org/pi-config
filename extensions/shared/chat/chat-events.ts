/**
 * Turning pi events into Discord output.
 *
 * Two things the old bot could not do: it showed nothing for tool calls (a
 * long `cargo test` looked like the agent had died) and it buffered assistant
 * deltas until `message_end`, so a multi-minute turn produced only a typing
 * indicator. Both are decided here, pure, so they can be tested.
 */

import { createLogger } from "../logger.ts";
import { truncateLine } from "./chat-format.ts";

const log = createLogger("chat-events");

export interface RenderState {
  /** Assistant text accumulated since the last flush. */
  pendingText: string;
  /** Id of the Discord message currently being edited, if streaming. */
  streamMessageId: string | null;
  /** Last text pushed to the live message, to skip no-op edits. */
  streamedText: string;
  /**
   * Prompt we forwarded that will come back as a user message. Per state, so two
   * watchers of one session both suppress the echo instead of one consuming it.
   */
  expectedEcho?: string;
}

export function initialRenderState(): RenderState {
  return { pendingText: "", streamMessageId: null, streamedText: "", expectedEcho: undefined };
}

export type RenderAction =
  | { kind: "append-text"; text: string }
  | { kind: "flush-assistant"; text: string }
  | { kind: "tool"; text: string }
  | { kind: "user"; text: string }
  | { kind: "agent-start" }
  | { kind: "agent-end" }
  | { kind: "none" };

/** One-line summary of a tool invocation, for the transcript. */
export function toolLine(event: any): string | null {
  const name = event?.toolName || event?.name || event?.tool;
  if (!name) return null;
  const args = event?.args || event?.input || {};
  const detail =
    typeof args === "string"
      ? args
      : args.command || args.path || args.pattern || args.query || args.url || "";
  const trimmed = typeof detail === "string" ? truncateLine(detail, 120) : "";
  return trimmed ? `🔧 **${name}** — \`${trimmed}\`` : `🔧 **${name}**`;
}

/**
 * Decide what a single pi event means for the Discord channel.
 *
 * `assistantDeltas` are accumulated and flushed at message end; tool calls emit
 * immediately so progress is visible while a command runs.
 */
export function renderEvent(
  event: any,
  state: RenderState,
): RenderAction {
  const type = event?.type;

  if (type === "message_update") {
    const delta = event?.assistantMessageEvent?.delta;
    if (event?.assistantMessageEvent?.type === "text_delta" && typeof delta === "string" && delta) {
      state.pendingText += delta;
      return { kind: "append-text", text: delta };
    }
    return { kind: "none" };
  }

  if (type === "message_end" && event?.message?.role === "assistant") {
    const text = state.pendingText;
    state.pendingText = "";
    return text ? { kind: "flush-assistant", text } : { kind: "none" };
  }

  if (type === "message_start" && event?.message?.role === "user") {
    const content = event.message.content;
    const text = Array.isArray(content)
      ? content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n")
      : typeof content === "string"
        ? content
        : "";
    return text ? { kind: "user", text } : { kind: "none" };
  }

  if (type === "tool_execution_start" || type === "tool_call") {
    const line = toolLine({ ...event, ...(event?.toolCall || {}) });
    return line ? { kind: "tool", text: line } : { kind: "none" };
  }

  if (type === "agent_start") return { kind: "agent-start" };
  if (type === "agent_end" || type === "agent_settled") return { kind: "agent-end" };

  return { kind: "none" };
}

/**
 * Text safe to put in a live-edited message: a message body may not exceed the
 * limit, and truncating mid-stream is better than a rejected edit.
 */
export function streamingView(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const tail = text.slice(-limit);
  log.debug("streaming view truncated", { length: text.length, limit });
  return `…${tail.slice(10)}`;
}

/**
 * Whether a user message is the echo of a prompt we just forwarded.
 *
 * Pulled out of the watcher loop because the old code deleted the marker inside
 * the loop, so with two watchers only the first saw the suppression and the
 * second got a duplicate (Qodo 8faf3fdd, 9306351e).
 */
export function shouldSuppressEcho(expected: string | undefined, actual: string): boolean {
  if (expected === undefined) return false;
  return expected.trim() === actual.trim();
}
