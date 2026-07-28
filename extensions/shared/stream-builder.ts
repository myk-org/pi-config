/**
 * Shared stream builder — assembles DriverStreamEvents into pi's
 * AssistantMessageEventStream.
 *
 * Both cli-provider and acpx-provider had near-identical ~100-line blocks
 * for mapping text_delta/thinking_delta events into the pi event stream
 * format. This module unifies that into a single, testable function.
 *
 * @module shared/stream-builder
 */

import type {
  AssistantMessage,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { DriverStreamEvent } from "./provider-driver.js";

/**
 * State tracker for building AssistantMessage content blocks from
 * a stream of DriverStreamEvents. Manages thinking/text block indices
 * and emits the correct pi event stream events.
 */
export class StreamAssembler {
  private thinkingIndex = -1;
  private textIndex = -1;
  private thinkingClosed = false;

  constructor(
    private readonly output: AssistantMessage,
    private readonly stream: AssistantMessageEventStream,
  ) {}

  /** Process a single driver event and emit corresponding pi stream events. */
  handleEvent(event: DriverStreamEvent): void {
    switch (event.kind) {
      case "thinking_delta":
        this.handleThinkingDelta(event.text);
        break;
      case "text_delta":
        this.handleTextDelta(event.text);
        break;
      case "session":
        // Session events are handled by the driver adapter, not the stream builder.
        break;
      case "turn_complete":
        // Handled by finalize().
        break;
    }
  }

  /**
   * Finalize the stream — close any open content blocks and emit done.
   * Call after all events have been processed or when the turn completes.
   *
   * @param finalText - Authoritative final text from the parser (may differ from accumulated deltas).
   * @param finalThinking - Authoritative final thinking from the parser.
   * @param stopReason - Stop reason for the done event.
   */
  finalize(opts?: {
    finalText?: string;
    finalThinking?: string;
    stopReason?: string;
    usage?: import("./provider-driver.js").DriverUsage;
  }): void {
    const finalText = opts?.finalText;
    const finalThinking = opts?.finalThinking;

    // Close thinking block if still open
    if (this.thinkingIndex >= 0 && !this.thinkingClosed) {
      const block = this.output.content[this.thinkingIndex];
      if (block.type === "thinking") {
        // Apply authoritative thinking if available and block was empty
        if (!block.thinking && finalThinking) {
          block.thinking = finalThinking;
          this.stream.push({
            type: "thinking_delta",
            contentIndex: this.thinkingIndex,
            delta: finalThinking,
            partial: this.output,
          });
        }
        this.stream.push({
          type: "thinking_end",
          contentIndex: this.thinkingIndex,
          content: block.thinking,
          partial: this.output,
        });
      }
      this.thinkingClosed = true;
    }

    // Handle text: either apply authoritative final text or close existing block
    if (this.textIndex < 0 && finalText) {
      // No text block yet but parser returned text — create and emit it
      this.output.content.push({ type: "text", text: finalText });
      this.textIndex = this.output.content.length - 1;
      this.stream.push({
        type: "text_start",
        contentIndex: this.textIndex,
        partial: this.output,
      });
      this.stream.push({
        type: "text_delta",
        contentIndex: this.textIndex,
        delta: finalText,
        partial: this.output,
      });
    } else if (this.textIndex >= 0 && finalText) {
      const block = this.output.content[this.textIndex];
      if (block.type === "text") {
        // Prefer authoritative final text if it differs
        if (finalText !== block.text) {
          const missing = finalText.startsWith(block.text)
            ? finalText.slice(block.text.length)
            : "";
          if (missing) {
            block.text = finalText;
            this.stream.push({
              type: "text_delta",
              contentIndex: this.textIndex,
              delta: missing,
              partial: this.output,
            });
          } else {
            block.text = finalText;
          }
        }
      }
    }

    // Close text block
    if (this.textIndex >= 0) {
      const block = this.output.content[this.textIndex];
      if (block.type === "text") {
        this.stream.push({
          type: "text_end",
          contentIndex: this.textIndex,
          content: block.text,
          partial: this.output,
        });
      }
    }

    // Map driver usage to pi's usage format
    if (opts?.usage) {
      const u = opts.usage;
      this.output.usage = {
        input: u.inputTokens ?? 0,
        output: u.outputTokens ?? 0,
        cacheRead: u.cachedReadTokens ?? 0,
        cacheWrite: u.cachedWriteTokens ?? 0,
        totalTokens: u.totalTokens ?? ((u.inputTokens ?? 0) + (u.outputTokens ?? 0)),
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: u.costUsd ?? 0,
        },
      };
    }

    this.output.stopReason = opts?.stopReason || "stop";
    const reason = (this.output.stopReason === "aborted" ? "aborted" : "stop") as "stop" | "aborted";
    this.stream.push({ type: "done", reason, message: this.output });
    this.stream.end();
  }

  /**
   * Emit an error event and end the stream.
   */
  emitError(error: unknown, aborted?: boolean): void {
    this.output.stopReason = aborted ? "aborted" : "error";
    this.output.errorMessage =
      error instanceof Error ? error.message : String(error);
    this.stream.push({
      type: "error",
      reason: this.output.stopReason as "aborted" | "error",
      error: this.output,
    });
    this.stream.end();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private handleThinkingDelta(text: string): void {
    if (this.thinkingIndex < 0) {
      this.output.content.push({ type: "thinking", thinking: "" });
      this.thinkingIndex = this.output.content.length - 1;
      this.stream.push({
        type: "thinking_start",
        contentIndex: this.thinkingIndex,
        partial: this.output,
      });
    }
    const block = this.output.content[this.thinkingIndex];
    if (block.type === "thinking") {
      block.thinking += text;
      this.stream.push({
        type: "thinking_delta",
        contentIndex: this.thinkingIndex,
        delta: text,
        partial: this.output,
      });
    }
  }

  private handleTextDelta(text: string): void {
    // Close thinking block on first text delta
    if (this.thinkingIndex >= 0 && !this.thinkingClosed) {
      this.thinkingClosed = true;
      const thinkBlock = this.output.content[this.thinkingIndex];
      if (thinkBlock.type === "thinking") {
        this.stream.push({
          type: "thinking_end",
          contentIndex: this.thinkingIndex,
          content: thinkBlock.thinking,
          partial: this.output,
        });
      }
    }

    if (this.textIndex < 0) {
      this.output.content.push({ type: "text", text: "" });
      this.textIndex = this.output.content.length - 1;
      this.stream.push({
        type: "text_start",
        contentIndex: this.textIndex,
        partial: this.output,
      });
    }
    const block = this.output.content[this.textIndex];
    if (block.type === "text") {
      block.text += text;
      this.stream.push({
        type: "text_delta",
        contentIndex: this.textIndex,
        delta: text,
        partial: this.output,
      });
    }
  }
}

/**
 * Create a fresh AssistantMessage output object for stream building.
 * Reusable across all drivers.
 */
export function createAssistantMessageOutput(model: {
  api: string;
  provider: string;
  id: string;
}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
}
