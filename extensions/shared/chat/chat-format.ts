/**
 * Discord message formatting helpers — pure, no discord.js.
 *
 * Lives next to the bot rather than inside it so the behaviour that used to be
 * untestable (chunking, mention suppression) can be covered by node:test.
 */

import { createLogger } from "../logger.ts";

const log = createLogger("chat-format");

/** Default single-message limit when an adapter does not pass its own. */
export const DEFAULT_TEXT_LIMIT = 2000;

const FENCE = "```";

/** Language tag of the fence still open at the end of the given lines, or null. */
function openFenceAfter(lines: string[]): string | null {
  let open: string | null = null;
  for (const line of lines) {
    const matches = line.match(/```/g);
    if (!matches || matches.length % 2 === 0) continue;
    if (open === null) {
      const idx = line.indexOf(FENCE);
      open = line.slice(idx + FENCE.length).trim();
    } else {
      open = null;
    }
  }
  return open;
}

/**
 * Split text into Discord-sized chunks without leaving a code fence open.
 *
 * The previous implementation cut at the last newline before 2000 chars and
 * dropped the remainder's leading newlines, which broke any code block that
 * straddled the cut: the first chunk ended mid-fence and Discord rendered the
 * rest as plain text. Here a chunk that ends inside a fence closes it, and the
 * next chunk reopens it with the same language tag.
 */
export function chunkText(text: string, limit = DEFAULT_TEXT_LIMIT): string[] {
  if (!text) return [];
  if (limit < 32) throw new Error("limit too small to chunk safely");
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  const fenceLang = () => openFenceAfter(current);
  const closingCost = () => (fenceLang() === null ? 0 : FENCE.length + 1);
  const reopening = () => {
    const lang = fenceLang();
    return lang === null ? "" : FENCE + lang;
  };

  const flush = () => {
    if (!current.length) return;
    const lang = fenceLang();
    let body = current.join("\n");
    if (lang !== null) body += "\n" + FENCE;
    chunks.push(body);
    const reopen = lang === null ? "" : FENCE + lang;
    current = reopen ? [reopen] : [];
    currentLen = reopen.length;
  };

  for (const line of text.split("\n")) {
    // A single line longer than the limit cannot be helped by newline splitting.
    let pieces = [line];
    if (line.length > limit - FENCE.length * 2) {
      pieces = [];
      for (let i = 0; i < line.length; i += limit - FENCE.length * 2) {
        pieces.push(line.slice(i, i + limit - FENCE.length * 2));
      }
    }
    for (const piece of pieces) {
      const projected = currentLen + (current.length ? 1 : 0) + piece.length + closingCost();
      if (current.length > 0 && projected > limit) flush();
      current.push(piece);
      currentLen = currentLen + (current.length > 0 ? 1 : 0) + piece.length;
    }
  }
  flush();

  const out = enforceLimit(chunks.filter((chunk) => chunk.trim().length > 0), limit);
  log.debug("chunked discord text", { chunks: out.length, length: text.length, limit });
  return out;
}

/**
 * Guarantee the size invariant.
 *
 * The line-based pass reserves room for a closing/reopening fence, but a single
 * source line longer than the limit can still produce a chunk over it (a fenced
 * block holding one giant line did: 402 chars at a 400 limit). Discord rejects
 * such a message outright, so the limit wins here even though a split inside a
 * pathological single-line fence cannot be repaired.
 */
function enforceLimit(chunks: string[], limit: number): string[] {
  const out: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= limit) {
      out.push(chunk);
      continue;
    }
    let rest = chunk;
    const room = Math.max(1, limit - (FENCE.length + 1));
    while (rest.length > limit) {
      let cut = rest.lastIndexOf("\n", room);
      if (cut < Math.floor(room / 3)) cut = room;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\n+/, "");
    }
    if (rest.trim()) out.push(rest);
    log.debug("hard-split an oversized chunk", { from: chunk.length, limit });
  }
  return out;
}

/** Truncate for one-line summaries (status lines, button labels). */
export function truncateLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/** Escape Discord markdown so user/tool output cannot re-style the message. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>])/g, "\\$1");
}

/* Aliases kept so the Discord-facing modules and their tests read unchanged. */
export const chunkDiscordText = chunkText;
export const escapeDiscordMarkdown = escapeMarkdown;
export const DISCORD_TEXT_LIMIT = DEFAULT_TEXT_LIMIT;
