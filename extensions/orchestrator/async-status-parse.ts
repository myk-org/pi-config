/**
 * Pure parsers for async agent output.log JSONL — no TUI deps (unit-testable).
 */

function formatParsedAsyncEvent(ev: any): string | null {
  if (ev.type === "message_update" && ev.assistantMessageEvent) {
    const ae = ev.assistantMessageEvent;
    if (ae.type === "text_delta" && ae.delta) return ae.delta;
    return null;
  }
  if (ev.type === "tool_execution_start") {
    const name = ev.toolName || "tool";
    const cmd = ev.args?.command
      ? ` ${String(ev.args.command).slice(0, 80)}`
      : "";
    return `\n→ ${name}${cmd}`;
  }
  if (ev.type === "tool_execution_end") {
    const text = ev.result?.content?.[0]?.text || "";
    const prefix = ev.isError ? "✗" : "✓";
    return `\n${prefix} ${String(text).slice(0, 200)}`;
  }
  if (ev.type === "agent_end") return "\n--- Agent finished ---";
  return null;
}

/** Parse one JSONL event line from async output.log into display text. */
export function parseAsyncOutputLine(raw: string): string | null {
  try {
    const ev = JSON.parse(raw);
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) return null;
    return formatParsedAsyncEvent(ev);
  } catch {
    return null;
  }
}

export interface ExtractAsyncFallbackOptions {
  /** When true, extract only assistant `text_delta` streams (omits tool/agent annotations and plain-text lines). */
  textOnly?: boolean;
}

/**
 * Extract readable fallback output from raw JSONL stdout tail when no `message_end`
 * text block was captured.
 * - Preserves plain-text non-JSON lines (e.g. crash/stack-trace output) alongside parsed events.
 * - Returns `""` when valid JSONL events parsed but produced no readable text (never leaks raw JSON envelopes).
 * - Falls back to raw `stdoutTail.slice(-maxChars)` only when no JSONL events parsed at all.
 */
export function extractAsyncFallbackOutput(
  stdoutTail: string,
  maxChars = 2000,
  opts?: ExtractAsyncFallbackOptions,
): string {
  if (!stdoutTail) return "";
  const textOnly = opts?.textOnly === true;
  let extracted = "";
  let parsedAnyJson = false;

  for (const line of stdoutTail.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsedObj: any = null;
    try {
      const candidate = JSON.parse(trimmed);
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsedObj = candidate;
      }
    } catch {
      /* not valid JSON */
    }

    if (parsedObj !== null) {
      parsedAnyJson = true;
      if (textOnly) {
        if (
          parsedObj.type === "message_update" &&
          parsedObj.assistantMessageEvent?.type === "text_delta" &&
          parsedObj.assistantMessageEvent.delta
        ) {
          extracted += parsedObj.assistantMessageEvent.delta;
        }
      } else {
        const display = formatParsedAsyncEvent(parsedObj);
        if (display !== null) extracted += display;
      }
    } else if (!textOnly && !trimmed.startsWith("{")) {
      // Preserve plain-text error/crash lines alongside any extracted JSONL events.
      extracted += (extracted ? "\n" : "") + trimmed;
    }
  }

  const readable = extracted.trim();
  if (readable) {
    return readable.length > maxChars ? readable.slice(-maxChars) : readable;
  }
  if (parsedAnyJson) return "";
  return stdoutTail.slice(-maxChars);
}
