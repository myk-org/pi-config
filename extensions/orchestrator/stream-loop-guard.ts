/**
 * Streaming repetition/degeneration loop abort guard (issue #1374).
 *
 * Some providers intermittently fail to emit `<EOS>` and stream hundreds of
 * repeated short lines (e.g. `.\n.\n.\n...`) or repeated 2–4 line blocks until
 * hitting the token limit. This module inspects `message_update` text/thinking
 * deltas with an O(1) sliding tail buffer, ignores fenced code blocks and
 * legitimate structural constructs, and calls `ctx.abort()` once per message on
 * unambiguous degeneration.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { isLiveExtensionCtx } from "../shared/live-ctx.js";

const log = createLogger("orchestrator");

export const CONSECUTIVE_LINE_THRESHOLD = 12;
export const BLOCK_REPEAT_THRESHOLD = 5;
export const MIN_BLOCK_SIZE = 2;
export const MAX_BLOCK_SIZE = 4;

const MAX_RECENT_LINES = Math.max(
  CONSECUTIVE_LINE_THRESHOLD,
  MAX_BLOCK_SIZE * BLOCK_REPEAT_THRESHOLD,
);
const MAX_TRACKED_LINE_LEN = 512;
const MAX_SAMPLE_LEN = 120;

const BACKTICK_OPEN_RE = /^[ \t]*(`{3,})([^`]*)$/;
const TILDE_OPEN_RE = /^[ \t]*(~{3,})(.*)$/;
const CLOSING_DELIMITER_RE = /^[}\]),;]+$/;

export type StreamKind = "text" | "thinking";
export type RepetitionKind = "repeated_line" | "repeated_block";

export interface StreamLoopDetection {
  kind: RepetitionKind;
  stream: StreamKind;
  runLength: number;
  sample: string;
}

interface FenceState {
  char: "`" | "~";
  length: number;
}

interface LineEntry {
  raw: string;
  trimmed: string;
}

function matchOpeningFence(line: string): FenceState | null {
  const backticks = BACKTICK_OPEN_RE.exec(line);
  if (backticks) return { char: "`", length: backticks[1].length };
  const tildes = TILDE_OPEN_RE.exec(line);
  if (tildes) return { char: "~", length: tildes[1].length };
  return null;
}

function isClosingFence(line: string, fence: FenceState): boolean {
  const trimmed = line.trim();
  if (trimmed.length < fence.length) return false;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] !== fence.char) return false;
  }
  return true;
}

function isMarkdownTableRow(trimmed: string): boolean {
  return (
    trimmed.length >= 3 &&
    trimmed.startsWith("|") &&
    trimmed.endsWith("|") &&
    /[^|\s]/.test(trimmed)
  );
}

function truncateSample(text: string): string {
  return text.length <= MAX_SAMPLE_LEN ? text : `${text.slice(0, MAX_SAMPLE_LEN - 1)}…`;
}

class StreamLineTracker {
  private pendingLine = "";
  private pendingOversized = false;
  private openFence: FenceState | null = null;
  private readonly recentLines: LineEntry[] = [];

  constructor(private readonly stream: StreamKind) {}

  reset(): void {
    this.pendingLine = "";
    this.pendingOversized = false;
    this.openFence = null;
    this.recentLines.length = 0;
  }

  hasState(): boolean {
    return (
      this.pendingLine.length > 0 ||
      this.pendingOversized ||
      this.openFence !== null ||
      this.recentLines.length > 0
    );
  }

  push(delta: string): StreamLoopDetection | null {
    let pos = 0;
    while (pos < delta.length) {
      const nl = delta.indexOf("\n", pos);
      if (nl === -1) {
        this.appendPending(delta.slice(pos));
        break;
      }
      this.appendPending(delta.slice(pos, nl));
      const detection = this.commitLine();
      if (detection) return detection;
      pos = nl + 1;
    }
    return null;
  }

  private appendPending(chunk: string): void {
    if (this.pendingOversized || chunk.length === 0) return;
    // Allow 1 extra char for a trailing '\r' before '\n'.
    const remaining = MAX_TRACKED_LINE_LEN + 1 - this.pendingLine.length;
    if (chunk.length > remaining) {
      this.pendingLine = "";
      this.pendingOversized = true;
      return;
    }
    this.pendingLine += chunk;
  }

  private commitLine(): StreamLoopDetection | null {
    const raw = this.pendingLine.endsWith("\r")
      ? this.pendingLine.slice(0, -1)
      : this.pendingLine;
    const oversized = this.pendingOversized || raw.length > MAX_TRACKED_LINE_LEN;
    this.pendingLine = "";
    this.pendingOversized = false;

    if (oversized) {
      if (!this.openFence) {
        this.recentLines.length = 0;
      }
      return null;
    }

    if (this.openFence) {
      if (isClosingFence(raw, this.openFence)) {
        this.openFence = null;
        this.recentLines.length = 0;
      }
      return null;
    }

    const opened = matchOpeningFence(raw);
    if (opened) {
      this.openFence = opened;
      this.recentLines.length = 0;
      return null;
    }

    const trimmed = raw.trim();
    if (isMarkdownTableRow(trimmed)) {
      this.recentLines.length = 0;
      return null;
    }

    this.recentLines.push({ raw, trimmed });
    if (this.recentLines.length > MAX_RECENT_LINES) {
      this.recentLines.shift();
    }

    return this.detectLoop();
  }

  private detectLoop(): StreamLoopDetection | null {
    const n = this.recentLines.length;
    const last = this.recentLines[n - 1];

    // Rule 1: >= 12 consecutive identical trimmed non-empty lines.
    if (last.trimmed.length > 0 && n >= CONSECUTIVE_LINE_THRESHOLD) {
      const start = n - CONSECUTIVE_LINE_THRESHOLD;
      let allMatch = true;
      let allSameRaw = true;
      for (let i = start; i < n - 1; i += 1) {
        if (this.recentLines[i].trimmed !== last.trimmed) {
          allMatch = false;
          break;
        }
        if (this.recentLines[i].raw !== last.raw) {
          allSameRaw = false;
        }
      }
      // Deeply nested JSON/code closing braces have identical trimmed text but varying indentation.
      if (allMatch && !(CLOSING_DELIMITER_RE.test(last.trimmed) && !allSameRaw)) {
        return {
          kind: "repeated_line",
          stream: this.stream,
          runLength: CONSECUTIVE_LINE_THRESHOLD,
          sample: truncateSample(last.trimmed),
        };
      }
    }

    // Rule 2: >= 5 consecutive exact repeats of a short 2–4 line block.
    for (let blockSize = MIN_BLOCK_SIZE; blockSize <= MAX_BLOCK_SIZE; blockSize += 1) {
      const windowSize = blockSize * BLOCK_REPEAT_THRESHOLD;
      if (n < windowSize) continue;
      const start = n - windowSize;

      const distinct = new Set<string>();
      let hasNonEmpty = false;
      let allClosingOrEmpty = true;
      for (let offset = 0; offset < blockSize; offset += 1) {
        const line = this.recentLines[start + offset].trimmed;
        distinct.add(line);
        if (line.length > 0) {
          hasNonEmpty = true;
          if (!CLOSING_DELIMITER_RE.test(line)) {
            allClosingOrEmpty = false;
          }
        }
      }
      // Require >= 2 distinct lines so single-line runs obey Rule 1's >= 12 threshold.
      if (!hasNonEmpty || distinct.size < 2) continue;

      let allBlocksMatch = true;
      let allBlocksSameRaw = true;
      for (let r = 1; r < BLOCK_REPEAT_THRESHOLD && allBlocksMatch; r += 1) {
        for (let offset = 0; offset < blockSize; offset += 1) {
          const base = this.recentLines[start + offset];
          const cur = this.recentLines[start + r * blockSize + offset];
          if (cur.trimmed !== base.trimmed) {
            allBlocksMatch = false;
            break;
          }
          if (cur.raw !== base.raw) {
            allBlocksSameRaw = false;
          }
        }
      }

      if (allBlocksMatch && !(allClosingOrEmpty && !allBlocksSameRaw)) {
        const blockSample = this.recentLines
          .slice(start, start + blockSize)
          .map((entry) => entry.trimmed)
          .join("\\n");
        return {
          kind: "repeated_block",
          stream: this.stream,
          runLength: BLOCK_REPEAT_THRESHOLD,
          sample: truncateSample(blockSample),
        };
      }
    }

    return null;
  }
}

export class StreamLoopGuard {
  private aborted = false;
  private readonly streams: Record<StreamKind, StreamLineTracker> = {
    text: new StreamLineTracker("text"),
    thinking: new StreamLineTracker("thinking"),
  };

  reset(): void {
    this.aborted = false;
    this.streams.text.reset();
    this.streams.thinking.reset();
  }

  resetStream(stream: StreamKind): void {
    this.streams[stream].reset();
  }

  hasState(): boolean {
    return this.aborted || this.streams.text.hasState() || this.streams.thinking.hasState();
  }

  push(stream: StreamKind, delta: string): StreamLoopDetection | null {
    if (this.aborted || delta.length === 0) return null;
    const detection = this.streams[stream].push(delta);
    if (detection) {
      this.aborted = true;
    }
    return detection;
  }
}

export function registerStreamLoopGuard(pi: ExtensionAPI): void {
  const guard = new StreamLoopGuard();

  const reset = (reason: string): void => {
    if (guard.hasState()) {
      log.debug("stream_loop_guard_reset", { reason });
    }
    guard.reset();
  };

  pi.on("turn_start", () => reset("turn_start"));
  pi.on("message_start", () => reset("message_start"));
  pi.on("session_start", () => reset("session_start"));
  pi.on("session_shutdown", () => reset("session_shutdown"));

  pi.on("message_update", (event, ctx) => {
    const inner = (event as { assistantMessageEvent?: { type?: string; delta?: unknown } } | undefined)
      ?.assistantMessageEvent;
    if (!inner || typeof inner !== "object") return;

    if (inner.type === "text_start") {
      guard.resetStream("text");
      return;
    }
    if (inner.type === "thinking_start") {
      guard.resetStream("thinking");
      return;
    }

    let stream: StreamKind;
    if (inner.type === "text_delta") {
      stream = "text";
    } else if (inner.type === "thinking_delta") {
      stream = "thinking";
    } else {
      return;
    }

    if (typeof inner.delta !== "string" || inner.delta.length === 0) return;

    const detection = guard.push(stream, inner.delta);
    if (!detection) return;

    log.warn("stream_repetition_loop_aborted", {
      kind: detection.kind,
      stream: detection.stream,
      runLength: detection.runLength,
      sample: detection.sample,
    });

    if (!isLiveExtensionCtx(ctx)) return;

    try {
      ctx.abort?.();
    } catch (err) {
      log.warn("stream_repetition_loop_abort_failed", { error: String(err) });
    }

    if (ctx.hasUI) {
      try {
        ctx.ui?.notify?.("Aborted streaming repetition loop", "warning");
      } catch (err) {
        log.debug("stream_repetition_loop_notify_failed", { error: String(err) });
      }
    }
  });
}
