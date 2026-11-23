/**
 * Streaming repetition/degeneration loop abort guard (issue #1374).
 *
 * Some providers intermittently fail to emit `<EOS>` and stream hundreds of
 * repeated short lines (e.g. `.\n.\n.\n...`) or repeated 2–4 line blocks until
 * hitting the token limit. This module inspects `message_update` text/thinking
 * deltas with an O(1) sliding tail buffer, ignores fenced code blocks and
 * legitimate structural constructs (GFM tables, bounded unified diff hunks,
 * pretty-printed JSON containers, and Markdown list items), and calls
 * `ctx.abort()` once per message on unambiguous degeneration.
 */
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger, type Logger } from "../shared/logger.js";
import { isLiveExtensionCtx } from "../shared/live-ctx.js";
import {
  DEFAULT_BRIDGE_SESSION_KEY,
  resolveBridgeSessionKey,
} from "../shared/session-bridge-map.js";
import {
  clearStreamLoopAborted,
  markStreamLoopAborted,
} from "../shared/stream-loop-abort-bridge.js";

const defaultLog = createLogger("orchestrator");

export const CONSECUTIVE_LINE_THRESHOLD = 12;
export const BLOCK_REPEAT_THRESHOLD = 5;
export const MIN_BLOCK_SIZE = 2;
export const MAX_BLOCK_SIZE = 4;

const MAX_RECENT_LINES = Math.max(
  CONSECUTIVE_LINE_THRESHOLD,
  MAX_BLOCK_SIZE * BLOCK_REPEAT_THRESHOLD,
);
const MAX_TRACKED_LINE_LEN = 512;

// CommonMark fenced code blocks allow only 0–3 leading spaces (4+ spaces or tabs are indented code).
const BACKTICK_OPEN_RE = /^ {0,3}(`{3,})([^`]*)$/;
const TILDE_OPEN_RE = /^ {0,3}(~{3,})(.*)$/;
const BACKTICK_CLOSE_RE = /^ {0,3}(`{3,})[ \t]*$/;
const TILDE_CLOSE_RE = /^ {0,3}(~{3,})[ \t]*$/;

const GFM_TABLE_MULTI_COL_DELIM_RE = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/;
const GFM_TABLE_SINGLE_COL_DELIM_RE = /^\|\s*:?-{3,}:?\s*\|$/;
const MAX_DIFF_HUNK_LINES = 10_000;
const DIFF_HUNK_HEADER_RE = /^@@ -\d{1,7}(?:,(\d{1,5}))? \+\d{1,7}(?:,(\d{1,5}))? @@(?: |$)/;
const MARKDOWN_LIST_ITEM_RE = /^(?:[-*+]|\d+[.)])\s+\S/;
const CLOSING_DELIMITER_RE = /^[}\]),;]+$/;

const JSON_CLOSER_RE = /^[}\]]+,?$/;
const JSON_PROPERTY_RE = /^"(?:[^"\\]|\\.)*"\s*:\s*(.+)$/;

export type StreamKind = "text" | "thinking";
export type RepetitionKind = "repeated_line" | "repeated_block";

export interface StreamLoopDetection {
  kind: RepetitionKind;
  stream: StreamKind;
  runLength: number;
  /** Redacted structural fingerprint (never contains raw streamed text or thinking). */
  sample: string;
  sampleLength: number;
  sampleHash: string;
}

interface FenceState {
  char: "`" | "~";
  length: number;
}

interface DiffHunkState {
  oldRemaining: number;
  newRemaining: number;
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
  const match = fence.char === "`" ? BACKTICK_CLOSE_RE.exec(line) : TILDE_CLOSE_RE.exec(line);
  return match !== null && match[1].length >= fence.length;
}

function isGfmTableDelimiter(trimmed: string): boolean {
  return GFM_TABLE_MULTI_COL_DELIM_RE.test(trimmed) || GFM_TABLE_SINGLE_COL_DELIM_RE.test(trimmed);
}

function isTablePipeRow(trimmed: string): boolean {
  return trimmed.includes("|") && /[^|\s]/.test(trimmed);
}

function parseDiffHunkHeader(line: string): DiffHunkState | null {
  const match = DIFF_HUNK_HEADER_RE.exec(line);
  if (!match) return null;
  const oldRemaining = match[1] !== undefined ? Number(match[1]) : 1;
  const newRemaining = match[2] !== undefined ? Number(match[2]) : 1;
  if (
    !Number.isSafeInteger(oldRemaining) ||
    !Number.isSafeInteger(newRemaining) ||
    oldRemaining > MAX_DIFF_HUNK_LINES ||
    newRemaining > MAX_DIFF_HUNK_LINES ||
    (oldRemaining === 0 && newRemaining === 0)
  ) {
    return null;
  }
  return { oldRemaining, newRemaining };
}

function isValidJsonValueFragment(val: string): boolean {
  const trimmed = val.trim();
  if (trimmed === "{" || trimmed === "[") return true;
  const candidate = trimmed.endsWith(",") ? trimmed.slice(0, -1).trimEnd() : trimmed;
  if (candidate.length === 0) return false;
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}

function isValidJsonLine(trimmed: string): boolean {
  if (JSON_CLOSER_RE.test(trimmed)) return true;
  const prop = JSON_PROPERTY_RE.exec(trimmed);
  if (prop) return isValidJsonValueFragment(prop[1]);
  return isValidJsonValueFragment(trimmed);
}

/** Net JSON container depth delta outside double-quoted strings, or null on unterminated string. */
function computeJsonDepthDelta(trimmed: string): number | null {
  let delta = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      delta += 1;
    } else if (ch === "}" || ch === "]") {
      delta -= 1;
    }
  }
  return inString ? null : delta;
}

function redactSample(text: string): { sample: string; sampleLength: number; sampleHash: string } {
  const sampleLength = text.length;
  const sampleHash = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return {
    sample: `<redacted:len=${sampleLength},sha256=${sampleHash}>`,
    sampleLength,
    sampleHash,
  };
}

class StreamLineTracker {
  private pendingLine = "";
  private pendingOversized = false;
  private openFence: FenceState | null = null;
  private diffHunk: DiffHunkState | null = null;
  private inMarkdownTable = false;
  private prevLineTableHeader = false;
  private jsonDepth = 0;
  private readonly recentLines: LineEntry[] = [];

  constructor(private readonly stream: StreamKind) {}

  reset(): void {
    this.pendingLine = "";
    this.pendingOversized = false;
    this.openFence = null;
    this.diffHunk = null;
    this.inMarkdownTable = false;
    this.prevLineTableHeader = false;
    this.jsonDepth = 0;
    this.recentLines.length = 0;
  }

  hasState(): boolean {
    return (
      this.pendingLine.length > 0 ||
      this.pendingOversized ||
      this.openFence !== null ||
      this.diffHunk !== null ||
      this.inMarkdownTable ||
      this.prevLineTableHeader ||
      this.jsonDepth > 0 ||
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

  private clearStructuralContext(): void {
    this.diffHunk = null;
    this.inMarkdownTable = false;
    this.prevLineTableHeader = false;
    this.jsonDepth = 0;
  }

  private consumeDiffHunkLine(raw: string): boolean {
    const hunk = this.diffHunk;
    if (!hunk) return false;
    if (raw === "\\ No newline at end of file") return true;
    if (raw.startsWith("+") && hunk.newRemaining > 0) {
      hunk.newRemaining -= 1;
    } else if (raw.startsWith("-") && hunk.oldRemaining > 0) {
      hunk.oldRemaining -= 1;
    } else if ((raw.startsWith(" ") || raw === "") && hunk.oldRemaining > 0 && hunk.newRemaining > 0) {
      hunk.oldRemaining -= 1;
      hunk.newRemaining -= 1;
    } else {
      this.diffHunk = null;
      return false;
    }
    if (hunk.oldRemaining === 0 && hunk.newRemaining === 0) {
      this.diffHunk = null;
    }
    return true;
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
        this.clearStructuralContext();
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
      this.clearStructuralContext();
      this.recentLines.length = 0;
      return null;
    }

    // Bounded unified diff hunks (`@@ -old,n +new,m @@`).
    if (this.diffHunk && this.consumeDiffHunkLine(raw)) {
      this.recentLines.length = 0;
      return null;
    }
    const nextHunk = parseDiffHunkHeader(raw);
    if (nextHunk) {
      this.clearStructuralContext();
      this.diffHunk = nextHunk;
      this.recentLines.length = 0;
      return null;
    }

    const trimmed = raw.trim();

    // Un-fenced pretty-printed JSON containers (`{` / `[`).
    if (this.jsonDepth > 0) {
      if (trimmed.length > 0 && isValidJsonLine(trimmed)) {
        const delta = computeJsonDepthDelta(trimmed);
        if (delta !== null) {
          this.jsonDepth = Math.max(0, this.jsonDepth + delta);
          this.prevLineTableHeader = false;
          this.recentLines.length = 0;
          return null;
        }
      }
      this.jsonDepth = 0;
    } else if (trimmed === "{" || trimmed === "[") {
      this.inMarkdownTable = false;
      this.prevLineTableHeader = false;
      this.jsonDepth = 1;
      this.recentLines.length = 0;
      return null;
    }

    // GFM markdown tables require a header row followed by a delimiter row (`| --- |`).
    if (this.inMarkdownTable) {
      if (isTablePipeRow(trimmed)) {
        this.recentLines.length = 0;
        return null;
      }
      this.inMarkdownTable = false;
    } else if (this.prevLineTableHeader && isGfmTableDelimiter(trimmed)) {
      this.inMarkdownTable = true;
      this.prevLineTableHeader = false;
      this.recentLines.length = 0;
      return null;
    }
    this.prevLineTableHeader = isTablePipeRow(trimmed) && !isGfmTableDelimiter(trimmed);

    // Valid Markdown bullet/numbered list items (e.g. `- [ ] TODO`, `1. step`); bare `-` is not matched.
    if (MARKDOWN_LIST_ITEM_RE.test(trimmed)) {
      this.prevLineTableHeader = false;
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
          ...redactSample(last.trimmed),
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
        const blockText = this.recentLines
          .slice(start, start + blockSize)
          .map((entry) => entry.trimmed)
          .join("\n");
        return {
          kind: "repeated_block",
          stream: this.stream,
          runLength: BLOCK_REPEAT_THRESHOLD,
          ...redactSample(blockText),
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

export function registerStreamLoopGuard(
  pi: ExtensionAPI,
  opts?: { logger?: Logger },
): void {
  const log = opts?.logger ?? defaultLog;
  const guard = new StreamLoopGuard();
  let currentSessionKey = DEFAULT_BRIDGE_SESSION_KEY;
  let markedSessionKey: string | null = null;

  const clearMarkedAbort = (): void => {
    if (markedSessionKey !== null) {
      clearStreamLoopAborted(markedSessionKey);
      markedSessionKey = null;
    }
  };

  const reset = (reason: string, ctx?: unknown): void => {
    clearMarkedAbort();
    if (reason === "session_start" && ctx !== undefined) {
      currentSessionKey = resolveBridgeSessionKey(ctx);
    }
    if (guard.hasState()) {
      log.debug("stream_loop_guard_reset", { reason });
    }
    guard.reset();
  };

  pi.on("turn_start", (_event, ctx) => reset("turn_start", ctx));
  pi.on("message_start", (_event, ctx) => reset("message_start", ctx));
  pi.on("session_start", (_event, ctx) => reset("session_start", ctx));
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
      sampleLength: detection.sampleLength,
      sampleHash: detection.sampleHash,
    });

    if (!isLiveExtensionCtx(ctx)) return;

    const fromCtx = resolveBridgeSessionKey(ctx);
    const sessionKey = fromCtx !== DEFAULT_BRIDGE_SESSION_KEY ? fromCtx : currentSessionKey;
    markStreamLoopAborted(sessionKey);
    markedSessionKey = sessionKey;

    try {
      ctx.abort?.();
    } catch (err) {
      clearMarkedAbort();
      log.error(
        "stream_repetition_loop_abort_failed",
        err instanceof Error ? err : new Error(String(err)),
      );
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
