/**
 * Pure parsers for async agent output.log JSONL — no TUI deps (unit-testable).
 */

/** Parse one JSONL event line from async output.log into display text. */
export function parseAsyncOutputLine(raw: string): string | null {
  try {
    const ev = JSON.parse(raw);
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
  } catch {
    return null;
  }
}
