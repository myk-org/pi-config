/**
 * Parse CLI JSON / stream-json stdout into text + session id.
 */

export interface CliParseResult {
  text: string;
  sessionId?: string;
  thinking?: string;
}

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

/**
 * Parse Cursor agent stream-json (NDJSON). Accumulate assistant text deltas
 * and last session id.
 */
export function parseCursorStreamJson(stdout: string): CliParseResult {
  let text = "";
  let thinking = "";
  let sessionId: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: any;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof ev.session_id === "string") sessionId = ev.session_id;
    if (typeof ev.sessionId === "string") sessionId = ev.sessionId;
    // Common stream-json shapes
    if (ev.type === "assistant" && typeof ev.message?.content === "string") {
      text += ev.message.content;
    } else if (ev.type === "text" && typeof ev.text === "string") {
      text += ev.text;
    } else if (ev.type === "content_block_delta" && typeof ev.delta?.text === "string") {
      text += ev.delta.text;
    } else if (typeof ev.text === "string" && ev.type !== "thinking") {
      text += ev.text;
    }
    if (ev.type === "thinking" && typeof ev.text === "string") {
      thinking += ev.text;
    }
    if (ev.type === "result" && typeof ev.result === "string") {
      text = ev.result || text;
    }
  }
  return { text, sessionId, thinking: thinking || undefined };
}

export function parseCliOutput(agent: string, stdout: string): CliParseResult {
  if (agent === "cursor") return parseCursorStreamJson(stdout);
  if (agent === "gemini") return parseGeminiJson(stdout);
  return parseClaudeJson(stdout);
}
