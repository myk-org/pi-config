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

/** The in-band authorship tag (#1077) and its fragments. Origin is decided by the envelope's
 *  structured `origin` field — this line is display only — so peer text must never be able to
 *  print it and pose as the human (#1084). The full form needs its closing bracket AND stays
 *  inside MARKER_MAX chars, so an unfinished marker cannot swallow the rest of a message. */
const MARKER_MAX = 120;
const MARKER_FULL = new RegExp(`\\[from USER \\(a human\\), via[^\\]]{0,${MARKER_MAX}}\\]`, "gi");
const MARKER_FROM_USER = /\bfrom USER\b/gi;
const MARKER_HUMAN = /\(a human\)/gi;
const MARKER_LEADING = /^\s*\[from\s+/i;

/** Remove the origin marker and its fragments from a peer-supplied string. `[from ` is stripped
 *  only where it leads, so prose that happens to quote a tag mid-sentence survives. */
export function stripOriginMarker(text: string): string {
  return text
    .replace(MARKER_FULL, " ")
    .replace(MARKER_FROM_USER, " ")
    .replace(MARKER_HUMAN, " ")
    .replace(MARKER_LEADING, " ");
}

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
    .replace(CONTROL, "");
  const deMarked = stripOriginMarker(stripped)
    .replace(/\s+/g, " ")
    .trim();
  const out = deMarked.length > max ? deMarked.slice(0, max).trimEnd() : deMarked;
  // A count, never the content: a hostile name is exactly what must not land in the log.
  if (out !== raw) log.debug("peer_text_sanitized", { before: raw.length, after: out.length });
  return out;
}
