/**
 * Parse CLI JSON / stream-json stdout into text + session id.
 * Also supports incremental NDJSON event parsing for live streaming.
 */

/** Per-turn usage extracted from CLI result events. */
export interface CliUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface CliParseResult {
  text: string;
  sessionId?: string;
  thinking?: string;
  usage?: CliUsage;
}

export type CliStreamEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "text_delta"; text: string }
  | { kind: "done"; text?: string; sessionId?: string };

/** Parse Claude-style single JSON object. */
export function parseClaudeJson(stdout: string): CliParseResult {
  const data = JSON.parse(stdout.trim());
  const text =
    typeof data.result === "string"
      ? data.result
      : typeof data.content === "string"
        ? data.content
        : Array.isArray(data.content)
          ? data.content
              .filter((b: any) => b?.type === "text" && typeof b.text === "string")
              .map((b: any) => b.text)
              .join("")
          : "";
  const sessionId =
    typeof data.session_id === "string"
      ? data.session_id
      : typeof data.sessionId === "string"
        ? data.sessionId
        : undefined;
  return { text: text || "", sessionId };
}

/** Parse Gemini-style JSON. */
export function parseGeminiJson(stdout: string): CliParseResult {
  const data = JSON.parse(stdout.trim());
  let text = "";
  if (typeof data.response === "string") text = data.response;
  else if (typeof data.text === "string") text = data.text;
  else if (typeof data.result === "string") text = data.result;
  const sessionId =
    typeof data.session_id === "string"
      ? data.session_id
      : typeof data.sessionId === "string"
        ? data.sessionId
        : undefined;
  return { text, sessionId };
}

function assistantTextFromEvent(ev: any): string {
  if (ev?.type === "assistant" && Array.isArray(ev.message?.content)) {
    return ev.message.content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
  }
  if (ev?.type === "assistant" && typeof ev.message?.content === "string") {
    return ev.message.content;
  }
  if (ev?.type === "text" && typeof ev.text === "string") return ev.text;
  if (ev?.type === "content_block_delta" && typeof ev.delta?.text === "string") {
    return ev.delta.text;
  }
  return "";
}

/**
 * Incremental parser state for stream-json NDJSON (cursor / claude / gemini).
 * Handles both pure deltas and cumulative snapshots (cursor emits both).
 */
export class StreamJsonAccumulator {
  text = "";
  thinking = "";
  sessionId?: string;
  usage?: CliUsage;

  /** Feed one NDJSON object; returns events to emit to pi. */
  push(ev: any): CliStreamEvent[] {
    const out: CliStreamEvent[] = [];
    if (!ev || typeof ev !== "object") return out;

    if (typeof ev.session_id === "string") {
      this.sessionId = ev.session_id;
      out.push({ kind: "session", sessionId: ev.session_id });
    } else if (typeof ev.sessionId === "string") {
      this.sessionId = ev.sessionId;
      out.push({ kind: "session", sessionId: ev.sessionId });
    }

    if (ev.type === "thinking" && ev.subtype === "delta" && typeof ev.text === "string") {
      this.thinking += ev.text;
      out.push({ kind: "thinking_delta", text: ev.text });
    }

    if (ev.type === "content_block_delta" && typeof ev.delta?.text === "string") {
      const delta = ev.delta.text;
      this.text += delta;
      out.push({ kind: "text_delta", text: delta });
      return out;
    }

    // Gemini CLI: {"type":"message","role":"assistant","content":"...","delta":true}
    if (
      ev.type === "message" &&
      ev.role === "assistant" &&
      typeof ev.content === "string" &&
      ev.content.length > 0
    ) {
      if (ev.delta === true) {
        this.text += ev.content;
        out.push({ kind: "text_delta", text: ev.content });
      } else if (ev.content.startsWith(this.text)) {
        const delta = ev.content.slice(this.text.length);
        this.text = ev.content;
        if (delta) out.push({ kind: "text_delta", text: delta });
      } else if (!this.text) {
        this.text = ev.content;
        out.push({ kind: "text_delta", text: ev.content });
      }
      return out;
    }

    const piece = assistantTextFromEvent(ev);
    if (piece) {
      if (piece.startsWith(this.text)) {
        const delta = piece.slice(this.text.length);
        this.text = piece;
        if (delta) out.push({ kind: "text_delta", text: delta });
      } else if (!this.text.endsWith(piece)) {
        this.text += piece;
        out.push({ kind: "text_delta", text: piece });
      }
    }

    if (ev.type === "result") {
      const finalText =
        typeof ev.result === "string"
          ? ev.result
          : typeof ev.text === "string"
            ? ev.text
            : undefined;
      if (finalText !== undefined) {
        if (finalText.startsWith(this.text)) {
          const delta = finalText.slice(this.text.length);
          this.text = finalText;
          if (delta) out.push({ kind: "text_delta", text: delta });
        } else if (this.text !== finalText) {
          // Prefer authoritative result if stream was wrong/empty
          if (!this.text) {
            this.text = finalText;
            out.push({ kind: "text_delta", text: finalText });
          } else {
            this.text = finalText;
          }
        }
      }
      // Extract usage from result event (format varies by CLI agent)
      this.usage = extractCliUsage(ev);

      out.push({
        kind: "done",
        text: this.text,
        sessionId: this.sessionId,
      });
    }

    return out;
  }

  /** Feed a chunk of stdout (may contain partial lines). */
  feedChunk(chunk: string, lineBuffer: { value: string }): CliStreamEvent[] {
    lineBuffer.value += chunk;
    const events: CliStreamEvent[] = [];
    const lines = lineBuffer.value.split("\n");
    lineBuffer.value = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(...this.push(JSON.parse(trimmed)));
      } catch {
        /* incomplete / non-json line */
      }
    }
    return events;
  }

  flush(lineBuffer: { value: string }): CliStreamEvent[] {
    const trimmed = lineBuffer.value.trim();
    lineBuffer.value = "";
    if (!trimmed) return [];
    try {
      return this.push(JSON.parse(trimmed));
    } catch {
      return [];
    }
  }
}

/**
 * Parse Cursor agent stream-json (NDJSON). Accumulate assistant text deltas
 * and last session id.
 */
export function parseCursorStreamJson(stdout: string): CliParseResult {
  const acc = new StreamJsonAccumulator();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      acc.push(JSON.parse(trimmed));
    } catch {
      /* skip */
    }
  }
  return {
    text: acc.text,
    sessionId: acc.sessionId,
    thinking: acc.thinking || undefined,
    usage: acc.usage,
  };
}

/**
 * Extract usage from a CLI result event. Handles three formats:
 * - Cursor: result.usage.{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}
 * - Claude: result.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens} + result.total_cost_usd
 * - Gemini: result.stats.{input_tokens, output_tokens, total_tokens, cached}
 */
function extractCliUsage(ev: any): CliUsage | undefined {
  if (!ev || typeof ev !== "object") return undefined;

  // Cursor format: result.usage.{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}
  if (ev.usage && typeof ev.usage === "object" && typeof ev.usage.inputTokens === "number") {
    const u = ev.usage;
    return {
      inputTokens: u.inputTokens ?? undefined,
      outputTokens: u.outputTokens ?? undefined,
      cachedReadTokens: u.cacheReadTokens ?? undefined,
      cachedWriteTokens: u.cacheWriteTokens ?? undefined,
      totalTokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
    };
  }

  // Claude format: result.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}
  if (ev.usage && typeof ev.usage === "object" && typeof ev.usage.input_tokens === "number") {
    const u = ev.usage;
    const cost = typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : undefined;
    return {
      inputTokens: u.input_tokens ?? undefined,
      outputTokens: u.output_tokens ?? undefined,
      cachedReadTokens: u.cache_read_input_tokens ?? undefined,
      cachedWriteTokens: u.cache_creation_input_tokens ?? undefined,
      totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
      costUsd: cost,
    };
  }

  // Gemini format: result.stats.{input_tokens, output_tokens, total_tokens, cached}
  if (ev.stats && typeof ev.stats === "object" && typeof ev.stats.input_tokens === "number") {
    const s = ev.stats;
    return {
      inputTokens: s.input_tokens ?? undefined,
      outputTokens: s.output_tokens ?? undefined,
      cachedReadTokens: s.cached ?? undefined,
      totalTokens: s.total_tokens ?? undefined,
    };
  }

  return undefined;
}

export function parseCliOutput(agent: string, stdout: string): CliParseResult {
  if (agent === "cursor") return parseCursorStreamJson(stdout);
  // Prefer stream-json NDJSON when present; fall back to single JSON object
  if (stdout.includes("\n") && stdout.trim().startsWith("{")) {
    const first = stdout.trim().split("\n")[0];
    try {
      const ev = JSON.parse(first);
      if (ev?.type) return parseCursorStreamJson(stdout);
    } catch {
      /* fall through */
    }
  }
  if (agent === "gemini") return parseGeminiJson(stdout);
  return parseClaudeJson(stdout);
}
