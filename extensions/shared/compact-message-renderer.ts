/**
 * Shared compact TUI message rendering primitives for `pi.registerMessageRenderer`.
 *
 * Used by async-agent results and COMS custom messages to render strictly 1-line
 * collapsed summaries by default while preserving full expandable details on Ctrl+O
 * and leaving the underlying LLM `content` untouched.
 */

import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { createLogger } from "./logger.js";

export type CompactCustomMessage<T = unknown> = Parameters<MessageRenderer<T>>[0];
export type CompactMessageRenderOptions = Parameters<MessageRenderer>[1];

const log = createLogger("compact-message-renderer");

const DEFAULT_SUMMARY_MAX_CHARS = 120;
const MIN_SUMMARY_WIDTH = 6;

/** Strip ANSI escape sequences (CSI/OSC/ESC) and C0/C1 control chars (preserving `\n` and `\t`). */
export function stripAnsiAndControl(value: string): string {
  return value
    // OSC sequences: ESC ] ... BEL or ST
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI sequences: ESC [ ... final byte
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // Other 2-byte ESC sequences
    .replace(/\x1b[@-Z\\-_]/g, "")
    // Remaining C0/C1 control chars except \n and \t
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

/** Extract plain text from a Pi CustomMessage `content` field (`string` or content block array). */
export function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text)
      .join("\n");
  }
  return content == null ? "" : String(content);
}

/**
 * Extract the first meaningful single-line summary from arbitrary text/markdown.
 * Strips ANSI/control characters, skips blank lines, horizontal rules, code fences,
 * and lone JSON delimiters, trims leading markdown prefixes, and caps length.
 */
export function extractSummaryLine(text: string, maxChars = DEFAULT_SUMMARY_MAX_CHARS): string {
  if (!text) return "";
  const cleaned = stripAnsiAndControl(text);
  for (const rawLine of cleaned.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    // Skip markdown fences, horizontal rules, and lone JSON bracket lines
    if (/^```/.test(line) || /^[-*_=`]{3,}$/.test(line) || /^[\[\]{},]+$/.test(line)) continue;
    // Strip leading markdown heading / blockquote / bullet prefixes
    line = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s*/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    if (maxChars > 0 && line.length > maxChars) {
      return `${line.slice(0, Math.max(1, maxChars - 1))}…`;
    }
    return line;
  }
  return "";
}

/** Format the expand keybinding hint (e.g. `(ctrl+o to expand)`). */
export function formatExpandHint(
  options: Partial<Pick<CompactMessageRenderOptions, "keyHint">> | undefined,
  theme: Theme,
): string {
  if (typeof options?.keyHint === "function") {
    try {
      const inner = options.keyHint("app.tools.expand", "to expand");
      if (inner) return `${theme.fg("dim", "(")}${inner}${theme.fg("dim", ")")}`;
    } catch (err) {
      log.debug("expand_hint_fallback", { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return theme.fg("dim", "(ctrl+o to expand)");
}

export interface CompactOneLineParts {
  prefix: string;
  summary?: string;
  separator?: string;
  hint?: string;
  outputPad?: number;
}

/**
 * Render a strictly single-line TUI component at any terminal width.
 * Keeps `prefix` and `hint` visible when space allows, truncating `summary` cleanly with `…`.
 */
export function createCompactOneLineComponent(parts: CompactOneLineParts): Component {
  const padSize = Math.max(0, Math.floor(parts.outputPad ?? 1));
  const sep = parts.separator ?? " — ";
  const summary = parts.summary ?? "";
  const hintPart = parts.hint ? `  ${parts.hint}` : "";

  return {
    render(width: number): string[] {
      const safeWidth = Math.max(1, Math.floor(width));
      const pad = safeWidth > padSize * 2 ? " ".repeat(padSize) : "";
      const innerWidth = Math.max(1, safeWidth - pad.length * 2);

      const full = summary
        ? `${parts.prefix}${sep}${summary}${hintPart}`
        : `${parts.prefix}${hintPart}`;

      if (visibleWidth(full) <= innerWidth) {
        return [pad + full];
      }

      if (summary) {
        const fixedWidth = visibleWidth(parts.prefix) + visibleWidth(sep) + visibleWidth(hintPart);
        const availSummary = innerWidth - fixedWidth;
        if (availSummary >= MIN_SUMMARY_WIDTH) {
          const trimmedSummary = truncateToWidth(summary, availSummary, "…");
          const line = `${parts.prefix}${sep}${trimmedSummary}${hintPart}`;
          return [pad + truncateToWidth(line, innerWidth, "…")];
        }
      }

      if (hintPart && visibleWidth(parts.prefix) + visibleWidth(hintPart) <= innerWidth) {
        return [pad + parts.prefix + hintPart];
      }

      return [pad + truncateToWidth(full, innerWidth, "…")];
    },
    invalidate(): void {},
  };
}

/**
 * Render the expanded custom message box with styled header and full text body,
 * matching Pi's built-in CustomMessageComponent layout.
 */
export function createExpandedCustomBox(
  header: string,
  body: string,
  outputPad: number,
  theme: Theme,
): Component {
  const padX = Math.max(0, Math.floor(outputPad ?? 1));
  const box = new Box(padX, 1, (text) => theme.bg("customMessageBg", text));
  const safeHeader = stripAnsiAndControl(header).replace(/[\r\n]+/g, " ").trim();
  box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(`[${safeHeader}]`)), 0, 0));
  if (body.length > 0) {
    box.addChild(new Spacer(1));
    box.addChild(new Text(theme.fg("customMessageText", body), 0, 0));
  }
  return box;
}
