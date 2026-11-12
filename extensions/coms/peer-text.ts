/**
 * Peer text is another process's input (#1084). A purpose, subject or id that carried an ANSI
 * sequence could move the cursor, clear the screen or forge a prompt in the viewer's terminal,
 * so every peer-supplied string is normalized here before it is rendered.
 *
 * Pure and log-free beyond one debug line: strip escape sequences, collapse whitespace, drop
 * control characters, then cap the field. Only lengths are logged — the text never is.
 */
import { createLogger } from "../shared/logger.js";

const log = createLogger("coms-peer-text");

/** OSC: `ESC ] … BEL` / `ESC ] … ESC \` — window titles, hyperlinks, clipboard writes. */
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** CSI: `ESC [ params intermediates final` — cursor moves, clears, colors. */
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
/** Charset selection: `ESC ( B`, `ESC # 8` … */
const ANSI_CHARSET = /\x1b[()#][0-9A-Za-z]/g;
/** Any remaining two-character escape. */
const ANSI_ESC = /\x1b[@-_]/g;
/** C0 (minus the whitespace we collapse) and C1 controls. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * One peer-supplied line: no escape sequences, no control characters, single-line, capped.
 * `max` is a hard cap — callers pass the width the field is allowed to occupy.
 */
export function sanitizePeerText(text: unknown, max = 120): string {
  const raw = typeof text === "string" ? text : String(text ?? "");
  const stripped = raw
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_CHARSET, "")
    .replace(ANSI_ESC, "")
    .replace(CONTROL, "")
    .replace(/\s+/g, " ")
    .trim();
  const out = stripped.length > max ? stripped.slice(0, max).trimEnd() : stripped;
  // A count, never the content: a hostile name is exactly what must not land in the log.
  if (out !== raw) log.debug("peer_text_sanitized", { before: raw.length, after: out.length });
  return out;
}
