/**
 * /qa overlay & configurable shortcut (default Alt+Q) (#1453):
 * - Extracts real human Q&A pairs from `ctx.sessionManager.getBranch()`, excluding automated/background turns
 * - Fullscreen scrollable list -> detail reader with `/` live filter (reusing overlay-dashboard primitives)
 * - 1-key quoting into the TUI editor via `ctx.ui.pasteToEditor()`: `r` quotes whole answer, `1`–`9` quotes section/item
 * - 1-line dim "buried answer" widget above editor when >= 1 background turn follows the latest human answer
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, KeyId, TUI } from "@earendil-works/pi-tui";
import {
  Key,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { isBrowserDispatch, isLiveExtensionCtx } from "../shared/live-ctx.js";
import { createLogger } from "../shared/logger.js";
import { resolveBridgeSessionKey } from "../shared/session-bridge.js";
import { SYSTEM_NOTE_MARKER } from "../shared/system-note.js";
import { normalizeShortcut } from "../shared/widget-visibility.js";
import {
  OVERLAY_OPTS,
  OverlayScrollDetail,
  borderSegment,
  matchesOverlayKey,
  normalizeOverlayKey,
  padAnsi,
  reconcileSelection,
  splitRow,
  type OverlaySelection,
} from "./overlay-dashboard.js";
import { getSetting } from "./project-settings.js";

const log = createLogger("qa-overlay");

export const QA_HINT_WIDGET_KEY = "qa-buried-answer";
export const QA_SHORTCUT_SETTING_KEY = "qa_overlay_shortcut" as const;
export const CRON_USER_MESSAGE_ENTRY_TYPE = "cron-user-message";

const MAX_SESSIONS = 32;
const MAX_QUOTABLE_SECTIONS = 9;
const MAX_QUOTE_LABEL_CHARS = 72;
const MAX_PREVIEW_CHARS = 60;

// ── Public types ────────────────────────────────────────────────────

export interface QaSection {
  /** 1-based shortcut digit (`1`..`9`). */
  index: number;
  kind: "heading" | "item";
  label: string;
  /** 0-based line index within `pair.answer.split("\n")`. */
  lineIndex: number;
}

export interface QaPair {
  /** Stable identifier for overlay selection and dismissal tracking. */
  id: string;
  promptEntryId: string;
  answerEntryId: string;
  question: string;
  questionPreview: string;
  answer: string;
  answerTitle: string;
  sections: QaSection[];
  timestamp?: string;
}

export interface QaHistory {
  /** Human Q&A pairs ordered newest-first. */
  pairs: QaPair[];
  /** Latest human Q&A pair when buried by >= 1 background turn before the next human prompt. */
  buriedLatest: QaPair | null;
  backgroundTurnsAfterLatest: number;
}

// ── Text & Markdown helpers ─────────────────────────────────────────

/** Collapse whitespace and truncate cleanly with an ellipsis. */
function cleanPreview(raw: string, maxChars: number): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

/** Strip common inline Markdown syntax while preserving snake_case identifiers. */
export function stripInlineMarkdown(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/(^|[\s([{"'])\*([^*]+)\*(?=[\s)\]}"'.,;:!?]|$)/g, "$1$2")
    .replace(/(^|[\s([{"'])_([^_]+)_(?=[\s)\]}"'.,;:!?]|$)/g, "$1$2")
    .replace(/^>\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Format a concise `Re: "<label>" — ` prefix for `ctx.ui.pasteToEditor()`. */
export function formatQuotePrefix(label: string): string {
  const cleaned = cleanPreview(
    stripInlineMarkdown(label)
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/"/g, "'")
      .replace(/:+$/, ""),
    MAX_QUOTE_LABEL_CHARS,
  );
  const safe = cleaned || "earlier answer";
  return `Re: "${safe}" — `;
}

/** Format a normalized KeyId (`"alt+q"`) into a human-friendly badge (`"Alt+Q"`), or `"/qa"` when disabled. */
export function formatShortcutLabel(shortcut: KeyId | null): string {
  if (!shortcut) return "/qa";
  return shortcut
    .split("+")
    .map((part) => {
      if (part.length === 1) return part.toUpperCase();
      return part[0].toUpperCase() + part.slice(1);
    })
    .join("+");
}

/** Format the 1-line dim buried-answer hint widget text. */
export function formatBuriedAnswerHint(pair: QaPair, shortcut: KeyId | null): string {
  const preview = cleanPreview(
    pair.questionPreview.replace(/"/g, "'"),
    MAX_PREVIEW_CHARS,
  );
  const trigger = formatShortcutLabel(shortcut);
  return `💬 Answer ready for "${preview}" — ${trigger} to read`;
}

/**
 * Extract up to 9 quotable Markdown headings (`#`–`######`) and numbered list items (`1.` / `1)`)
 * from an assistant answer, ignoring lines inside fenced code blocks.
 */
export function extractAnswerSections(markdown: string): QaSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: QaSection[] = [];
  let inFence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (inFence === null) inFence = marker;
      else if (inFence === marker) inFence = null;
      continue;
    }
    if (inFence !== null) continue;

    const headingMatch = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (headingMatch) {
      const label = cleanPreview(
        stripInlineMarkdown(headingMatch[1]).replace(/:+$/, ""),
        MAX_QUOTE_LABEL_CHARS,
      );
      if (label) {
        sections.push({
          index: sections.length + 1,
          kind: "heading",
          label,
          lineIndex: i,
        });
        if (sections.length >= MAX_QUOTABLE_SECTIONS) break;
      }
      continue;
    }

    const itemMatch = /^\s*\d{1,2}[.)]\s+(.+?)\s*$/.exec(line);
    if (itemMatch) {
      const label = cleanPreview(
        stripInlineMarkdown(itemMatch[1]).replace(/:+$/, ""),
        MAX_QUOTE_LABEL_CHARS,
      );
      if (label) {
        sections.push({
          index: sections.length + 1,
          kind: "item",
          label,
          lineIndex: i,
        });
        if (sections.length >= MAX_QUOTABLE_SECTIONS) break;
      }
    }
  }

  return sections;
}

/** Extract a concise heading or first meaningful prose line from an assistant answer. */
export function extractAnswerTitle(markdown: string, fallback = "earlier answer"): string {
  const lines = markdown.split(/\r?\n/);
  let inFence: string | null = null;

  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (inFence === null) inFence = marker;
      else if (inFence === marker) inFence = null;
      continue;
    }
    if (inFence !== null) continue;

    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[-*_]{3,}$/.test(trimmed)) continue;

    const unwrapped = trimmed
      .replace(/^#{1,6}\s+/, "")
      .replace(/\s+#+$/, "")
      .replace(/^\d{1,2}[.)]\s+/, "")
      .replace(/^[-*+]\s+/, "");
    const cleaned = cleanPreview(
      stripInlineMarkdown(unwrapped).replace(/:+$/, ""),
      MAX_QUOTE_LABEL_CHARS,
    );
    if (cleaned) return cleaned;
  }

  return cleanPreview(fallback, MAX_QUOTE_LABEL_CHARS) || "earlier answer";
}

// ── Branch Q&A extraction (human vs background classification) ──────

const AUTOMATED_USER_PATTERNS: readonly RegExp[] = [
  /^\[system message — not written by the user\]/i,
  /^##\s*Async Agent Result:/i,
  /^📡\s*(?:Connected to coms|Peer joined:|Peer left:)/i,
  /^\[(?:from|steer from|response from|broadcast from)\s+[^\]]+\]/i,
  /^\/reload-flag(?:\s|$)/i,
  /^\[reload-flag\]/i,
  /^🔄\s*Reload complete/i,
  /^\[cron:/i,
  /^##\s*Cron Result:/i,
  /^\[Task Focus Reminder\]/i,
  /^\[Task Reminder\]/i,
  /^\[Stuck Task/i,
  /^⚠️\s*Task reminder:/i,
  /^⏰\s*Idle task reminder/i,
  /^\[Background Advisor Observation\]/i,
];

/** True when a `role: "user"` message text is clearly automated/background traffic, not human prose. */
export function isAutomatedUserMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith(SYSTEM_NOTE_MARKER)) return true;
  return AUTOMATED_USER_PATTERNS.some((re) => re.test(trimmed));
}

const PASSIVE_CUSTOM_TYPES = new Set([
  "coms-peer-joined",
  "coms-peer-left",
  "coms-welcome",
  "memory-reminder",
  "qa-overlay",
  "snapshots",
  "worktree",
  "skill-maintenance",
]);

const MID_TURN_CUSTOM_TYPES = new Set([
  "standing-project-memory",
  "orchestrator-turn-context",
  "magic-keyword-notice",
  "advisor-watchdog-note",
  "enforcement-violation",
  "tool-arg-rejected",
  "malformed-response-recovery",
  "skill-maintenance-nudge",
  "subagent-taskid-error",
  "subagent-chain-error",
]);

const RECOVERY_CUSTOM_TYPES = new Set([
  "subagent-chain-error",
  "subagent-taskid-error",
  "malformed-response-recovery",
]);

/**
 * Classify a `custom_message` / `role: "custom"` entry:
 * - `"passive"`: informational/hidden notice that does not trigger its own assistant turn.
 * - `"mid-turn"`: guardrail/steer/context injection belonging to whichever turn is already active.
 * - `"background"`: background turn trigger (async agent result, COMS inbound/response, idle recovery, task nudge, reload, etc.).
 */
export function classifyCustomMessage(
  customType: string,
  display?: boolean,
  details?: unknown,
): "passive" | "mid-turn" | "background" {
  const type = (customType || "").trim();
  const separateTurn =
    details !== null &&
    typeof details === "object" &&
    (details as { separateTurn?: unknown }).separateTurn === true;
  if (separateTurn) return "background";
  if (MID_TURN_CUSTOM_TYPES.has(type)) return "mid-turn";
  if (display === false) return "passive";
  if (PASSIVE_CUSTOM_TYPES.has(type)) return "passive";
  return "background";
}

/** Extract plain text (excluding thinking/toolCall blocks) and image/toolCall presence from message content. */
export function extractTextContent(content: unknown): { text: string; hasImage: boolean; hasToolCall: boolean } {
  if (typeof content === "string") {
    return { text: content.trim(), hasImage: false, hasToolCall: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", hasImage: false, hasToolCall: false };
  }
  const parts: string[] = [];
  let hasImage = false;
  let hasToolCall = false;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") {
      const trimmed = typed.text.trim();
      if (trimmed) parts.push(trimmed);
    } else if (typed.type === "image") {
      hasImage = true;
    } else if (typed.type === "toolCall") {
      hasToolCall = true;
    }
  }
  return { text: parts.join("\n\n").trim(), hasImage, hasToolCall };
}

interface PendingHumanTurn {
  promptEntryId: string;
  question: string;
  promptTimestamp?: string;
  answerEntryId?: string;
  answer?: string;
  answerTimestamp?: string;
  /** True once an assistant message in this turn produced text without tool calls. */
  hasFinalTextAnswer: boolean;
}

/**
 * Walk `ctx.sessionManager.getBranch()` and extract pure human Q&A pairs newest-first,
 * along with whether the latest human answer has been buried by >= 1 background turn.
 */
export function extractQaHistory(entries: readonly unknown[]): QaHistory {
  const chronological: QaPair[] = [];
  let owner: "none" | "human" | "background" = "none";
  const getOwner = (): "none" | "human" | "background" => owner;
  let pending: PendingHumanTurn | null = null;
  let latestHumanHasAnswer = false;
  let backgroundTurnsAfterLatest = 0;
  let backgroundTurnCountedForTrigger = false;
  const pendingCronCommands: string[] = [];

  const finalizePending = (): void => {
    if (!pending || !pending.answer || !pending.answerEntryId) {
      pending = null;
      return;
    }
    const questionPreview = cleanPreview(pending.question, MAX_PREVIEW_CHARS);
    const answerTitle = extractAnswerTitle(pending.answer, questionPreview);
    chronological.push({
      id: pending.answerEntryId,
      promptEntryId: pending.promptEntryId,
      answerEntryId: pending.answerEntryId,
      question: pending.question,
      questionPreview,
      answer: pending.answer,
      answerTitle,
      sections: extractAnswerSections(pending.answer),
      timestamp: pending.answerTimestamp || pending.promptTimestamp,
    });
    pending = null;
  };

  const enterBackgroundTurn = (): void => {
    finalizePending();
    owner = "background";
    if (latestHumanHasAnswer && chronological.length > 0) {
      backgroundTurnsAfterLatest += 1;
      backgroundTurnCountedForTrigger = true;
    }
  };

  const handleCustomKind = (customType: string, display?: boolean, details?: unknown): void => {
    const kind = classifyCustomMessage(customType, display, details);
    const isIdleRecoveryAfterAnswer =
      kind === "mid-turn" &&
      RECOVERY_CUSTOM_TYPES.has((customType || "").trim()) &&
      pending?.hasFinalTextAnswer === true;
    if (kind === "background" || isIdleRecoveryAfterAnswer) {
      enterBackgroundTurn();
    }
  };

  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i];
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as {
      type?: unknown;
      id?: unknown;
      timestamp?: unknown;
      customType?: unknown;
      display?: unknown;
      details?: unknown;
      data?: unknown;
      message?: {
        role?: unknown;
        content?: unknown;
        customType?: unknown;
        display?: unknown;
        details?: unknown;
      };
    };
    const entryId = typeof entry.id === "string" && entry.id ? entry.id : `entry-${i}`;
    const entryTimestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;

    if (entry.type === "custom" && entry.customType === CRON_USER_MESSAGE_ENTRY_TYPE) {
      const cmd =
        entry.data && typeof entry.data === "object"
          ? (entry.data as { command?: unknown }).command
          : undefined;
      if (typeof cmd === "string" && cmd.trim()) {
        pendingCronCommands.push(cmd.trim());
      }
      continue;
    }

    if (entry.type === "custom_message") {
      handleCustomKind(
        typeof entry.customType === "string" ? entry.customType : "",
        typeof entry.display === "boolean" ? entry.display : undefined,
        entry.details,
      );
      continue;
    }

    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") {
      continue;
    }

    const role = entry.message.role;
    if (role === "custom") {
      handleCustomKind(
        typeof entry.message.customType === "string" ? entry.message.customType : "",
        typeof entry.message.display === "boolean" ? entry.message.display : undefined,
        entry.message.details,
      );
      continue;
    }

    if (role === "user") {
      const { text, hasImage } = extractTextContent(entry.message.content);
      const effectiveText = text || (hasImage ? "[Image]" : "");
      const cronMatchIdx = effectiveText ? pendingCronCommands.indexOf(effectiveText.trim()) : -1;
      if (cronMatchIdx >= 0) {
        pendingCronCommands.splice(cronMatchIdx, 1);
        enterBackgroundTurn();
        continue;
      }
      if (!effectiveText || (!hasImage && isAutomatedUserMessage(effectiveText))) {
        enterBackgroundTurn();
        continue;
      }
      // Real human prompt starts a new human turn and resets buried state.
      finalizePending();
      owner = "human";
      latestHumanHasAnswer = false;
      backgroundTurnsAfterLatest = 0;
      backgroundTurnCountedForTrigger = false;
      pending = {
        promptEntryId: entryId,
        question: effectiveText,
        promptTimestamp: entryTimestamp,
        hasFinalTextAnswer: false,
      };
      continue;
    }

    if (role === "assistant") {
      const { text, hasToolCall } = extractTextContent(entry.message.content);
      const currentOwner = getOwner();
      if (currentOwner === "human" && pending) {
        if (text) {
          pending.answer = text;
          pending.answerEntryId = entryId;
          pending.answerTimestamp = entryTimestamp;
          pending.hasFinalTextAnswer = !hasToolCall;
          latestHumanHasAnswer = true;
        }
      } else if (currentOwner === "background") {
        if (latestHumanHasAnswer && chronological.length > 0 && !backgroundTurnCountedForTrigger) {
          backgroundTurnsAfterLatest += 1;
          backgroundTurnCountedForTrigger = true;
        }
      }
    }
  }

  finalizePending();

  const pairs = chronological.reverse();
  const buriedLatest =
    latestHumanHasAnswer && pairs.length > 0 && backgroundTurnsAfterLatest > 0 ? pairs[0] : null;
  return {
    pairs,
    buriedLatest,
    backgroundTurnsAfterLatest,
  };
}

/** Case-insensitive multi-token live filter across both question and answer text. */
export function filterQaPairs(pairs: readonly QaPair[], query: string): QaPair[] {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return [...pairs];
  return pairs.filter((pair) => {
    const haystack = `${pair.question}\n${pair.answer}`.toLowerCase();
    return tokens.every((tok) => haystack.includes(tok));
  });
}

/** Plain-text fallback for headless / non-UI `/qa` invocations. */
export function formatQaPlainText(pairs: readonly QaPair[]): string {
  if (pairs.length === 0) return "No human Q&A pairs in this session yet.";
  const lines = [`Human Q&A (${pairs.length}):`];
  for (let i = 0; i < Math.min(pairs.length, 20); i++) {
    const p = pairs[i];
    lines.push(`${i + 1}. Q: ${p.questionPreview}`);
    lines.push(`   A: ${p.answerTitle}`);
  }
  if (pairs.length > 20) {
    lines.push(`... and ${pairs.length - 20} more`);
  }
  return lines.join("\n");
}

function formatShortTime(timestamp?: string): string {
  if (!timestamp) return "";
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Build themed body lines for the scrollable answer reader with inline `[1]`–`[9]` section badges. */
export function buildQaDetailLines(pair: QaPair, theme: Theme): string[] {
  const lines: string[] = [];
  lines.push(theme.fg("accent", theme.bold("Q:")) + " " + theme.fg("text", pair.question));
  lines.push("");

  const sectionByLine = new Map<number, QaSection>();
  for (const s of pair.sections) {
    sectionByLine.set(s.lineIndex, s);
  }

  const answerLines = pair.answer.split(/\r?\n/);
  for (let i = 0; i < answerLines.length; i++) {
    const raw = answerLines[i];
    const section = sectionByLine.get(i);
    if (section) {
      const badge = theme.fg("accent", `[${section.index}]`);
      const text = section.kind === "heading" ? theme.bold(raw) : raw;
      lines.push(`${badge} ${text}`);
    } else {
      lines.push(raw);
    }
  }
  return lines;
}

// ── Interactive TUI List Overlay (reuses overlay-dashboard primitives) ──

export type QaListResult =
  | { action: "close" }
  | { action: "open"; pair: QaPair; filterQuery: string }
  | { action: "quote"; quoteText: string };

export class QaListOverlay implements Component {
  private filtering = false;
  private filterQuery: string;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private allPairs: readonly QaPair[],
    private selection: OverlaySelection<string>,
    private done: (result: QaListResult) => void,
    initialFilterQuery = "",
    private keybindings?: KeybindingsManager,
  ) {
    this.filterQuery = initialFilterQuery;
  }

  private visiblePairs(): QaPair[] {
    return filterQaPairs(this.allPairs, this.filterQuery);
  }

  private move(delta: number): void {
    const items = this.visiblePairs();
    if (items.length === 0) return;
    reconcileSelection(this.selection, items);
    this.selection.index = (this.selection.index + delta + items.length) % items.length;
    this.selection.id = items[this.selection.index]?.id;
    this.invalidate();
    this.tui.requestRender(true);
  }

  handleInput(data: string): void {
    if (!data || isKeyRelease(data)) return;
    const items = this.visiblePairs();
    reconcileSelection(this.selection, items);

    if (matchesKey(data, Key.ctrl("c"))) {
      this.done({ action: "close" });
      return;
    }

    if (this.filtering) {
      if (matchesKey(data, Key.escape)) {
        this.filtering = false;
        this.filterQuery = "";
        reconcileSelection(this.selection, this.visiblePairs());
        this.invalidate();
        this.tui.requestRender(true);
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.filtering = false;
        const focused = items[this.selection.index];
        if (focused) {
          this.done({ action: "open", pair: focused, filterQuery: this.filterQuery });
        } else {
          this.invalidate();
          this.tui.requestRender(true);
        }
        return;
      }
      if (matchesKey(data, Key.up)) {
        this.move(-1);
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.move(1);
        return;
      }
      if (matchesKey(data, Key.backspace) || data === "\x7f" || data === "\b") {
        if (this.filterQuery.length > 0) {
          this.filterQuery = this.filterQuery.slice(0, -1);
          reconcileSelection(this.selection, this.visiblePairs());
          this.invalidate();
          this.tui.requestRender(true);
        }
        return;
      }
      if (matchesKey(data, Key.ctrl("u"))) {
        if (this.filterQuery.length > 0) {
          this.filterQuery = "";
          reconcileSelection(this.selection, this.visiblePairs());
          this.invalidate();
          this.tui.requestRender(true);
        }
        return;
      }
      // Accept printable characters (ASCII & non-ASCII) into the live filter query.
      const key = normalizeOverlayKey(data);
      const ch =
        key === "space"
          ? " "
          : key.length === 1 && key.charCodeAt(0) >= 0x20 && key.charCodeAt(0) !== 0x7f
            ? key
            : !data.startsWith("\x1b") && !/[\x00-\x1f\x7f]/.test(data) && [...data].length === 1
              ? data
              : "";
      if (ch) {
        this.filterQuery += ch;
        reconcileSelection(this.selection, this.visiblePairs());
        this.invalidate();
        this.tui.requestRender(true);
      }
      return;
    }

    if (
      this.keybindings?.matches(data, "tui.select.cancel") ||
      matchesKey(data, Key.escape)
    ) {
      if (this.filterQuery) {
        this.filterQuery = "";
        reconcileSelection(this.selection, this.visiblePairs());
        this.invalidate();
        this.tui.requestRender(true);
        return;
      }
      this.done({ action: "close" });
      return;
    }
    if (
      this.keybindings?.matches(data, "tui.select.up") ||
      matchesKey(data, Key.up) ||
      matchesOverlayKey(data, "k")
    ) {
      this.move(-1);
      return;
    }
    if (
      this.keybindings?.matches(data, "tui.select.down") ||
      matchesKey(data, Key.down) ||
      matchesOverlayKey(data, "j")
    ) {
      this.move(1);
      return;
    }
    if (
      this.keybindings?.matches(data, "tui.select.confirm") ||
      matchesKey(data, Key.enter)
    ) {
      const focused = items[this.selection.index];
      if (focused) {
        this.done({ action: "open", pair: focused, filterQuery: this.filterQuery });
      }
      return;
    }
    if (matchesOverlayKey(data, "/")) {
      this.filtering = true;
      this.invalidate();
      this.tui.requestRender(true);
      return;
    }
    if (matchesOverlayKey(data, "r")) {
      const focused = items[this.selection.index];
      if (focused) {
        this.done({ action: "quote", quoteText: formatQuotePrefix(focused.answerTitle) });
      }
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const theme = this.theme;
    const items = this.visiblePairs();
    reconcileSelection(this.selection, items);

    const rows = this.tui.terminal.rows || 30;
    const bodyHeight = Math.max(5, rows - 5);
    const innerWidth = Math.max(0, width - 2);
    const lines: string[] = [];

    const headerLeft = theme.fg("accent", theme.bold("Human Q&A"));
    const countText = this.filterQuery
      ? `${items.length}/${this.allPairs.length} matching`
      : `${items.length} ${items.length === 1 ? "answer" : "answers"}`;
    const headerRight = theme.fg("muted", countText);
    const headerPad = Math.max(
      1,
      width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4,
    );
    lines.push(
      truncateToWidth(`  ${headerLeft}${" ".repeat(headerPad)}${headerRight}  `, width),
    );

    const borderTitle = this.filtering
      ? `Filter: /${this.filterQuery}▌`
      : this.filterQuery
        ? `Filter: /${this.filterQuery}`
        : "Newest First";
    lines.push(
      theme.fg("border", "╭") +
        borderSegment(theme, innerWidth, borderTitle) +
        theme.fg("border", "╮"),
    );

    const divider = theme.fg("border", "│");
    const rowLines = this.renderRows(items, innerWidth, bodyHeight);
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(divider + padAnsi(rowLines[i] ?? "", innerWidth) + divider);
    }

    lines.push(
      theme.fg("border", "╰") +
        theme.fg("border", "─".repeat(innerWidth)) +
        theme.fg("border", "╯"),
    );

    const footer = this.filtering
      ? "Type to filter · ↑↓ select · Enter open · Backspace erase · Esc clear"
      : this.filterQuery
        ? "↑↓/jk select · Enter read · r quote · / edit filter · Esc clear filter"
        : "↑↓/jk select · / filter · Enter read · r quote · Esc close";
    lines.push(truncateToWidth(theme.fg("dim", `  ${footer}`), width));

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  private renderRows(items: readonly QaPair[], width: number, height: number): string[] {
    const theme = this.theme;
    if (items.length === 0) {
      const msg = this.filterQuery
        ? ` No Q&A pairs matching "${this.filterQuery}".`
        : " No human Q&A pairs in this session yet.";
      return [theme.fg("dim", msg)];
    }

    let start = 0;
    if (items.length > height) {
      start = Math.min(
        Math.max(0, this.selection.index - Math.floor(height / 2)),
        items.length - height,
      );
    }
    const visible = items.slice(start, start + height);
    const dot = theme.fg("dim", " · ");
    const out: string[] = [];

    for (let i = 0; i < visible.length; i++) {
      const item = visible[i];
      const idx = start + i;
      const isSelected = idx === this.selection.index;
      const marker = isSelected ? theme.fg("accent", "❯") : " ";
      const qLabel = isSelected
        ? theme.fg("accent", item.questionPreview)
        : theme.fg("text", item.questionPreview);
      const aHint = theme.fg("dim", `→ ${item.answerTitle}`);
      const rightParts: string[] = [];
      if (item.sections.length > 0) {
        rightParts.push(theme.fg("muted", `1-${item.sections.length}`));
      }
      const time = formatShortTime(item.timestamp);
      if (time) rightParts.push(theme.fg("dim", time));
      const left = ` ${marker} ${qLabel} ${aHint}`;
      const right = rightParts.length > 0 ? `${rightParts.join(dot)} ` : "";
      out.push(splitRow(left, right, width));
    }

    if (start > 0) {
      out[0] = truncateToWidth(theme.fg("dim", `   ... ${start} more`), width);
    }
    if (start + height < items.length) {
      out[out.length - 1] = truncateToWidth(
        theme.fg("dim", `   ... ${items.length - start - height} more`),
        width,
      );
    }
    return out;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ── Overlay opener ──────────────────────────────────────────────────

export interface OpenQaOverlayOptions {
  /** Override extracted pairs (useful in unit tests). */
  pairs?: QaPair[];
  /** Invoked when the overlay is opened (e.g. to dismiss the buried-answer widget). */
  onOpen?: (latestPair: QaPair | undefined) => void;
}

/**
 * Open the interactive `/qa` list -> detail overlay and paste any quoted prefix into the editor
 * after the overlay closes. Returns the pasted quote prefix or `null` if closed without quoting.
 */
export async function openQaOverlay(
  ctx: ExtensionContext | ExtensionCommandContext,
  options: OpenQaOverlayOptions = {},
): Promise<string | null> {
  if (!ctx?.hasUI) return null;

  const pairs = options.pairs ?? extractQaHistory(safeGetBranch(ctx)).pairs;
  options.onOpen?.(pairs[0]);

  if (pairs.length === 0) {
    try {
      ctx.ui.notify("No human Q&A pairs in this session yet.", "info");
    } catch {}
    log.debug("qa_overlay_empty");
    return null;
  }

  const selection: OverlaySelection<string> = {
    index: 0,
    id: pairs[0]?.id,
  };
  let filterQuery = "";
  let quoteToPaste: string | null = null;

  log.debug("qa_overlay_open", { pairs: pairs.length });

  while (true) {
    const listResult = await ctx.ui.custom<QaListResult>(
      (tui, theme, kb, done) =>
        new QaListOverlay(tui, theme, pairs, selection, done, filterQuery, kb),
      OVERLAY_OPTS,
    );

    if (!listResult || listResult.action === "close") {
      break;
    }

    if (listResult.action === "quote") {
      quoteToPaste = listResult.quoteText;
      break;
    }

    filterQuery = listResult.filterQuery;
    const pair = listResult.pair;
    const sections = pair.sections;
    const detailFooter = sections.length > 0
      ? `↑↓/jk/PgUp/PgDn scroll · r quote answer · 1-${sections.length} quote section · Esc back`
      : "↑↓/jk/PgUp/PgDn scroll · r quote answer · Esc back";

    let detailQuote: string | null = null;
    let cachedDetailTheme: Theme | undefined;
    let cachedDetailLines: string[] | undefined;
    await ctx.ui.custom<null>(
      (tui, theme, _kb, done) =>
        new OverlayScrollDetail(
          tui,
          theme,
          {
            footerHints: detailFooter,
            getHeader: (t) =>
              t.fg("accent", t.bold("Q&A Reader")) +
              t.fg("dim", ` · ${pair.questionPreview}`),
            getBodyLines: (t) => {
              if (!cachedDetailLines || cachedDetailTheme !== t) {
                cachedDetailTheme = t;
                cachedDetailLines = buildQaDetailLines(pair, t);
              }
              return cachedDetailLines;
            },
            onKey: (key) => {
              if (key === "r") {
                detailQuote = formatQuotePrefix(pair.answerTitle);
                log.debug("qa_detail_quote_answer", { pairId: pair.id });
                return "close";
              }
              if (/^[1-9]$/.test(key)) {
                const idx = Number(key) - 1;
                const section = sections[idx];
                if (section) {
                  detailQuote = formatQuotePrefix(section.label);
                  log.debug("qa_detail_quote_section", {
                    pairId: pair.id,
                    index: section.index,
                    kind: section.kind,
                  });
                  return "close";
                }
              }
              return false;
            },
          },
          done,
        ),
      OVERLAY_OPTS,
    );

    if (detailQuote !== null) {
      quoteToPaste = detailQuote;
      break;
    }
  }

  if (quoteToPaste !== null) {
    try {
      ctx.ui.pasteToEditor(quoteToPaste);
      log.info("qa_quote_pasted", { chars: quoteToPaste.length });
    } catch (err: unknown) {
      log.warn("qa_quote_paste_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return quoteToPaste;
}

// ── Shortcut config & lifecycle registration ────────────────────────

function safeGetBranch(ctx: { sessionManager?: { getBranch?: () => unknown[] } } | undefined): unknown[] {
  try {
    const branch = ctx?.sessionManager?.getBranch?.();
    return Array.isArray(branch) ? branch : [];
  } catch (err: unknown) {
    log.warn("qa_get_branch_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Read and validate `qa_overlay_shortcut`. Empty string disables quietly; invalid syntax logs a warning. */
export function resolveConfiguredQaShortcut(cwd: string): KeyId | null {
  let raw: unknown;
  try {
    raw = getSetting(cwd || process.cwd(), QA_SHORTCUT_SETTING_KEY);
  } catch (err: unknown) {
    log.warn("qa_shortcut_setting_read_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return null;
  const normalized = normalizeShortcut(trimmed);
  if (!normalized) {
    log.warn("invalid_qa_overlay_shortcut", { value: trimmed });
    return null;
  }
  return normalized;
}

interface QaSessionState {
  dismissedAnswerId: string | null;
  hintVisible: boolean;
  overlayOpen: boolean;
}

export interface RegisterQaOverlayResult {
  registeredShortcut: KeyId | null;
}

/**
 * Register `/qa` command, configurable shortcut (`qa_overlay_shortcut`), and the 1-line
 * buried-answer widget hint lifecycle. Skipped automatically in subagent children.
 */
export function registerQaOverlay(
  pi: ExtensionAPI,
  options: { cwd?: string } = {},
): RegisterQaOverlayResult {
  if (process.env.PI_SUBAGENT_CHILD === "1") {
    log.debug("qa_overlay_skipped_subagent_child");
    return { registeredShortcut: null };
  }

  const sessions = new Map<string, QaSessionState>();
  const pendingCronDispatch: string[] = [];
  let pendingCronInput: string | null = null;

  const safeSessionKey = (ctx: unknown): string | null => {
    try {
      return resolveBridgeSessionKey(ctx as any);
    } catch (err: unknown) {
      log.debug("qa_session_key_stale", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  const getState = (ctx: unknown): QaSessionState | null => {
    const key = safeSessionKey(ctx);
    if (!key) return null;
    const existing = sessions.get(key);
    if (existing) return existing;
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    const fresh: QaSessionState = {
      dismissedAnswerId: null,
      hintVisible: false,
      overlayOpen: false,
    };
    sessions.set(key, fresh);
    return fresh;
  };

  let registeredShortcut: KeyId | null = null;

  const clearHint = (
    ctx: ExtensionContext | ExtensionCommandContext | undefined,
    force = false,
  ): void => {
    const state = getState(ctx);
    if (state) {
      if (!force && !state.hintVisible) return;
      state.hintVisible = false;
    } else if (!force) {
      return;
    }
    if (!ctx || !isLiveExtensionCtx(ctx)) return;
    try {
      ctx.ui?.setWidget?.(QA_HINT_WIDGET_KEY, undefined);
      log.debug("qa_buried_hint_cleared");
    } catch {}
  };

  const syncBuriedHint = (ctx: ExtensionContext | undefined): void => {
    if (!ctx || !isLiveExtensionCtx(ctx)) return;
    if (!ctx.hasUI || isBrowserDispatch(ctx)) return;
    const state = getState(ctx);
    if (!state) return;
    const history = extractQaHistory(safeGetBranch(ctx));
    const buried = history.buriedLatest;
    if (!buried || buried.answerEntryId === state.dismissedAnswerId) {
      clearHint(ctx);
      return;
    }
    const hintLine = formatBuriedAnswerHint(buried, registeredShortcut);
    try {
      ctx.ui.setWidget(
        QA_HINT_WIDGET_KEY,
        (_tui, theme) => ({
          render(width: number): string[] {
            return [truncateToWidth(theme.fg("dim", hintLine), width)];
          },
          invalidate(): void {},
        }),
        { placement: "aboveEditor" },
      );
      state.hintVisible = true;
      log.debug("qa_buried_hint_shown", {
        pairId: buried.answerEntryId,
        backgroundTurns: history.backgroundTurnsAfterLatest,
      });
    } catch (err: unknown) {
      log.warn("qa_buried_hint_render_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const openForContext = async (ctx: ExtensionContext | ExtensionCommandContext): Promise<void> => {
    if (!isLiveExtensionCtx(ctx)) return;
    const state = getState(ctx);
    if (!state) return;
    if (state.overlayOpen) {
      log.debug("qa_overlay_already_open");
      return;
    }
    state.overlayOpen = true;
    try {
      await openQaOverlay(ctx, {
        onOpen: (latestPair) => {
          if (latestPair) state.dismissedAnswerId = latestPair.answerEntryId;
          clearHint(ctx);
        },
      });
    } finally {
      state.overlayOpen = false;
    }
  };

  pi.events?.on?.("cron:dispatch-command", (data: unknown) => {
    const cmd =
      data && typeof data === "object"
        ? (data as { command?: unknown }).command
        : undefined;
    if (typeof cmd === "string" && cmd.trim()) {
      if (pendingCronDispatch.length >= 32) pendingCronDispatch.shift();
      pendingCronDispatch.push(cmd.trim());
    }
  });

  pi.registerCommand("qa", {
    description: "Open the human Q&A reader overlay with 1-key section quoting",
    handler: async (_args, ctx) => {
      if (!isLiveExtensionCtx(ctx)) return;
      log.debug("qa_command", { hasUI: !!ctx.hasUI, browser: isBrowserDispatch(ctx) });
      if (!ctx.hasUI || isBrowserDispatch(ctx)) {
        const pairs = extractQaHistory(safeGetBranch(ctx)).pairs;
        const text = formatQaPlainText(pairs);
        try {
          pi.sendMessage({ customType: "qa-overlay", content: text, display: true }, { triggerTurn: false });
        } catch {
          try { ctx.ui?.notify?.(text, "info"); } catch {}
        }
        return;
      }
      await openForContext(ctx);
    },
  });

  const configuredKey = resolveConfiguredQaShortcut(options.cwd || process.cwd());
  if (configuredKey && typeof (pi as { registerShortcut?: unknown }).registerShortcut === "function") {
    try {
      pi.registerShortcut(configuredKey, {
        description: "Open /qa human Q&A reader overlay",
        handler: async (ctx) => {
          if (!isLiveExtensionCtx(ctx)) return;
          await openForContext(ctx);
        },
      });
      registeredShortcut = configuredKey;
      log.info("qa_overlay_shortcut_registered", { key: configuredKey });
    } catch (err: unknown) {
      log.warn("qa_overlay_shortcut_register_failed", {
        key: configuredKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    log.debug("qa_overlay_shortcut_disabled");
  }

  pi.on("input", (event, ctx) => {
    const text = typeof event?.text === "string" ? event.text.trim() : "";
    if (event?.source === "extension") {
      const idx = text ? pendingCronDispatch.indexOf(text) : -1;
      if (idx >= 0) {
        pendingCronDispatch.splice(idx, 1);
        pendingCronInput = text;
      } else {
        pendingCronInput = null;
      }
      return;
    }
    pendingCronInput = null;
    if (!text || text.startsWith("/") || isAutomatedUserMessage(text)) return;
    if (!isLiveExtensionCtx(ctx)) return;
    const state = getState(ctx);
    if (state) state.dismissedAnswerId = null;
    clearHint(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (event?.messageType !== "user") return;
    const prompt = typeof event.prompt === "string" ? event.prompt : "";
    if (pendingCronInput !== null) {
      const rawCmd = pendingCronInput;
      pendingCronInput = null;
      const trimmed = prompt.trim();
      if (trimmed && trimmed !== rawCmd) {
        try {
          if (typeof (pi as any).appendEntry === "function") {
            (pi as any).appendEntry(CRON_USER_MESSAGE_ENTRY_TYPE, { command: trimmed });
          }
        } catch {}
      }
      return;
    }
    if (!prompt || isAutomatedUserMessage(prompt)) return;
    if (!isLiveExtensionCtx(ctx)) return;
    const state = getState(ctx);
    if (state) state.dismissedAnswerId = null;
    clearHint(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    syncBuriedHint(ctx);
  });

  pi.on("session_start", (_event, ctx) => {
    const key = safeSessionKey(ctx);
    if (key) sessions.delete(key);
    clearHint(ctx, true);
    syncBuriedHint(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearHint(ctx);
    const key = safeSessionKey(ctx);
    if (key) sessions.delete(key);
  });

  return { registeredShortcut };
}
