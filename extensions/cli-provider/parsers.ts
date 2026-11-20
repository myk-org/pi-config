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
  private textParts: string[] = [];
  private textLength = 0;
  thinking = "";
  sessionId?: string;
  usage?: CliUsage;

  get text(): string {
    if (this.textParts.length === 0) return "";
    if (this.textParts.length === 1) return this.textParts[0];
    const joined = this.textParts.join("");
    this.textParts = [joined];
    return joined;
  }

  set text(value: string) {
    this.textParts = value ? [value] : [];
    this.textLength = value.length;
  }

  private appendText(delta: string): void {
    if (!delta) return;
    this.textParts.push(delta);
    this.textLength += delta.length;
  }

  private setText(value: string): void {
    this.textParts = value ? [value] : [];
    this.textLength = value.length;
  }

  private startsWithCurrentText(candidate: string): boolean {
    if (candidate.length < this.textLength) return false;
    if (this.textLength === 0) return true;
    let offset = 0;
    for (let i = 0; i < this.textParts.length; i++) {
      const part = this.textParts[i];
      if (!candidate.startsWith(part, offset)) return false;
      offset += part.length;
    }
    return true;
  }

  private endsWithCurrentText(suffix: string): boolean {
    if (suffix.length > this.textLength) return false;
    if (suffix.length === 0) return true;
    let remaining = suffix.length;
    for (let i = this.textParts.length - 1; i >= 0 && remaining > 0; i--) {
      const part = this.textParts[i];
      if (part.length >= remaining) {
        return part.endsWith(suffix.slice(0, remaining));
      }
      const tailOffset = remaining - part.length;
      if (!suffix.startsWith(part, tailOffset)) return false;
      remaining = tailOffset;
    }
    return remaining === 0;
  }

  /** Feed one NDJSON object; returns events to emit to pi. */
  push(ev: any, out: CliStreamEvent[] = []): CliStreamEvent[] {
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
      this.appendText(delta);
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
        this.appendText(ev.content);
        out.push({ kind: "text_delta", text: ev.content });
      } else if (this.startsWithCurrentText(ev.content)) {
        const delta = ev.content.slice(this.textLength);
        this.setText(ev.content);
        if (delta) out.push({ kind: "text_delta", text: delta });
      } else if (this.textLength === 0) {
        this.setText(ev.content);
        out.push({ kind: "text_delta", text: ev.content });
      }
      return out;
    }

    const piece = assistantTextFromEvent(ev);
    if (piece) {
      if (this.startsWithCurrentText(piece)) {
        const delta = piece.slice(this.textLength);
        this.setText(piece);
        if (delta) out.push({ kind: "text_delta", text: delta });
      } else if (!this.endsWithCurrentText(piece)) {
        this.appendText(piece);
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
        if (this.startsWithCurrentText(finalText)) {
          const delta = finalText.slice(this.textLength);
          this.setText(finalText);
          if (delta) out.push({ kind: "text_delta", text: delta });
        } else if (this.text !== finalText) {
          // Prefer authoritative result if stream was wrong/empty
          if (this.textLength === 0) {
            this.setText(finalText);
            out.push({ kind: "text_delta", text: finalText });
          } else {
            this.setText(finalText);
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
    const buf = lineBuffer.value;
    let start = 0;
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const trimmed = buf.slice(start, nl).trim();
      if (trimmed) {
        try {
          this.push(JSON.parse(trimmed), events);
        } catch {
          /* incomplete / non-json line */
        }
      }
      start = nl + 1;
      nl = buf.indexOf("\n", start);
    }
    lineBuffer.value = start === 0 ? buf : buf.slice(start);
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
export function extractCliUsage(ev: any): CliUsage | undefined {
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
