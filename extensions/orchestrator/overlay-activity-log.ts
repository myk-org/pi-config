/**
 * Shared Unified Live Activity Log view (`[1] Roster / [2] Activity`) for `/async` and `/coms` overlays.
 *
 * Aggregates chronological lifecycle events, tool calls, errors, and responses/COMS messages
 * across active and recent agents/peers with filter cycling (`f`), inline search (`/`),
 * auto-follow toggle (`Space`), Kitty CSI-u key handling, narrow/wide responsive layout,
 * inline feedback banners, and jump-to-detail (`Enter`).
 */

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  isKeyRelease,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../shared/logger.js";
import {
  borderSegment,
  DEFAULT_NOTICE_MS,
  matchesOverlayKey,
  normalizeOverlayKey,
  padAnsi,
  type OverlayNotice,
  type OverlayNoticeLevel,
  type OverlayNotify,
} from "./overlay-dashboard.js";

const log = createLogger("overlay-activity-log");

export type OverlayActivityTab = "roster" | "activity";
export type ActivityCategory = "lifecycle" | "tool" | "error" | "message";
export type ActivityFilter = "all" | "errors" | "tools" | "messages";

export const ACTIVITY_FILTERS: readonly ActivityFilter[] = [
  "all",
  "errors",
  "tools",
  "messages",
];

export interface ActivityEvent {
  /** Stable event identifier. */
  id: string;
  /** Epoch milliseconds used for chronological ordering. */
  timestamp: number;
  /** Owning job or peer id (used to jump to detail/transcript on Enter). */
  sourceId: string;
  /** Sanitized display label of the job or peer. */
  sourceLabel: string;
  /** Event category used by the `f` filter cycle. */
  category: ActivityCategory;
  /** Single-line sanitized summary text. */
  summary: string;
}

export interface ActivityJobSource {
  id: string;
  agent: string;
  name?: string;
  task: string;
  status: string;
  workerDir?: string;
  startedAt: number;
  durationMs?: number;
  output?: string;
}

export type OverlayActivityResult =
  | { type: "close" }
  | { type: "switch-tab"; tab: OverlayActivityTab }
  | { type: "inspect"; event: ActivityEvent };

export interface OverlayActivitySpec {
  title: string;
  listEvents: () => ActivityEvent[];
  initialFilter?: ActivityFilter;
  initialSearch?: string;
  initialFollowing?: boolean;
  onFilterChange?: (filter: ActivityFilter) => void;
  onSearchChange?: (search: string) => void;
  onFollowChange?: (following: boolean) => void;
  emptyMessage?: string;
  pollMs?: number;
}

/** Strip ANSI escape sequences and control characters, collapsing whitespace to one line. */
export function sanitizeActivityText(text: string, maxLen = 160): string {
  const cleaned = String(text ?? "")
    // Remove CSI / OSC ANSI escape sequences
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // Remove remaining C0/C1 control chars
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLen - 1))}…`;
}

/** Cycle through `All | Errors | Tools | Messages`. */
export function nextActivityFilter(current: ActivityFilter): ActivityFilter {
  const idx = ACTIVITY_FILTERS.indexOf(current);
  return ACTIVITY_FILTERS[(idx + 1) % ACTIVITY_FILTERS.length];
}

/** Human-readable filter pill label. */
export function activityFilterLabel(filter: ActivityFilter): string {
  switch (filter) {
    case "errors":
      return "Errors";
    case "tools":
      return "Tools";
    case "messages":
      return "Messages";
    default:
      return "All";
  }
}

/** Test whether an event passes the active category filter and text search query. */
export function matchesActivityFilter(
  event: ActivityEvent,
  filter: ActivityFilter,
  search: string,
): boolean {
  if (filter === "errors" && event.category !== "error") return false;
  if (filter === "tools" && event.category !== "tool") return false;
  if (filter === "messages" && event.category !== "message") return false;

  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return (
    event.sourceLabel.toLowerCase().includes(needle) ||
    event.summary.toLowerCase().includes(needle) ||
    event.sourceId.toLowerCase().includes(needle) ||
    event.category.toLowerCase().includes(needle)
  );
}

/** Filter events preserving chronological order. */
export function filterActivityEvents(
  events: readonly ActivityEvent[],
  filter: ActivityFilter,
  search: string,
): ActivityEvent[] {
  return events.filter((ev) => matchesActivityFilter(ev, filter, search));
}

/** Format epoch ms as compact `HH:MM:SS`. */
export function formatActivityTimestamp(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "--:--:--";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** Format the `[1] Roster  [2] Activity` tab indicator for overlay headers. */
export function formatActivityTabBar(
  activeTab: OverlayActivityTab,
  theme: Pick<Theme, "fg" | "bold">,
): string {
  const roster =
    activeTab === "roster"
      ? theme.fg("accent", theme.bold("[1] Roster"))
      : theme.fg("muted", "1 Roster");
  const activity =
    activeTab === "activity"
      ? theme.fg("accent", theme.bold("[2] Activity"))
      : theme.fg("muted", "2 Activity");
  return `${roster}  ${activity}`;
}

/** Plain-text single-line representation for headless / non-UI fallback output. */
export function formatActivityEventPlain(event: ActivityEvent): string {
  const ts = formatActivityTimestamp(event.timestamp);
  const tag = event.category.toUpperCase();
  return `[${ts}] [${tag}] ${sanitizeActivityText(event.sourceLabel, 32)}: ${sanitizeActivityText(event.summary, 140)}`;
}

const MAX_LOG_TAIL_BYTES = 64 * 1024;
const DEFAULT_MAX_EVENTS_PER_JOB = 40;
const DEFAULT_MAX_TOTAL_EVENTS = 400;
const LOG_PARSE_CACHE_MAX = 64;

interface ParsedLogEntry {
  category: ActivityCategory;
  summary: string;
  explicitTs?: number;
}

const logParseCache = new Map<string, { size: number; mtimeMs: number; entries: ParsedLogEntry[] }>();

function readTailText(filePath: string, size: number, maxBytes = MAX_LOG_TAIL_BYTES): string | null {
  try {
    if (size <= 0) return "";
    if (size <= maxBytes) return fs.readFileSync(filePath, "utf-8");
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.allocUnsafe(maxBytes);
      const read = fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
      const text = buf.toString("utf-8", 0, read);
      // Drop potentially truncated first line
      const firstNl = text.indexOf("\n");
      return firstNl >= 0 ? text.slice(firstNl + 1) : text;
    } finally {
      fs.closeSync(fd);
    }
  } catch (err: unknown) {
    log.debug("activity_log_tail_read_failed", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function parseJobOutputLogCached(logPath: string): ParsedLogEntry[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(logPath);
  } catch {
    return [];
  }
  const cached = logParseCache.get(logPath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.entries;
  }

  const rawTail = readTailText(logPath, stat.size);
  const parsedLogEntries: ParsedLogEntry[] = [];
  if (rawTail) {
    let pendingDelta = "";
    const flushDelta = () => {
      const text = sanitizeActivityText(pendingDelta, 120);
      pendingDelta = "";
      if (text) parsedLogEntries.push({ category: "message", summary: text });
    };

    for (const line of rawTail.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let ev: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          ev = parsed as Record<string, unknown>;
        }
      } catch {
        // Plain-text line (e.g. stderr/crash output)
        if (!trimmed.startsWith("{")) {
          flushDelta();
          const isErr = /error|exception|fatal|failed|traceback/i.test(trimmed);
          parsedLogEntries.push({
            category: isErr ? "error" : "message",
            summary: sanitizeActivityText(trimmed, 120),
          });
        }
        continue;
      }
      if (!ev) continue;

      const explicitTs = parseEventTimestamp(ev, 0) || undefined;
      if (ev.type === "tool_execution_start") {
        flushDelta();
        const toolName = typeof ev.toolName === "string" ? ev.toolName : "tool";
        const args = ev.args as Record<string, unknown> | undefined;
        const detail = typeof args?.command === "string"
          ? args.command
          : typeof args?.path === "string"
            ? args.path
            : typeof args?.query === "string"
              ? args.query
              : "";
        parsedLogEntries.push({
          category: "tool",
          summary: sanitizeActivityText(`→ ${toolName}${detail ? ` ${detail}` : ""}`, 120),
          explicitTs,
        });
      } else if (ev.type === "tool_execution_end") {
        flushDelta();
        const toolName = typeof ev.toolName === "string" ? ev.toolName : "tool";
        const result = ev.result as { content?: Array<{ text?: string }> } | undefined;
        const snippet = result?.content?.[0]?.text ?? "";
        const isError = ev.isError === true;
        parsedLogEntries.push({
          category: isError ? "error" : "tool",
          summary: sanitizeActivityText(
            `${isError ? "✗" : "✓"} ${toolName}${snippet ? `: ${snippet}` : ""}`,
            120,
          ),
          explicitTs,
        });
      } else if (ev.type === "message_update") {
        const ae = ev.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (ae?.type === "text_delta" && typeof ae.delta === "string") {
          pendingDelta += ae.delta;
          if (pendingDelta.length >= 120 || pendingDelta.includes("\n")) {
            flushDelta();
          }
        }
      } else if (ev.type === "message_end") {
        flushDelta();
        const msg = ev.message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
        if (msg?.role === "assistant" && Array.isArray(msg.content)) {
          const text = msg.content
            .filter((p) => p?.type === "text" && typeof p.text === "string")
            .map((p) => p.text)
            .join(" ");
          const clean = sanitizeActivityText(text, 120);
          if (clean) {
            parsedLogEntries.push({ category: "message", summary: clean, explicitTs });
          }
        }
      } else if (ev.type === "agent_end") {
        flushDelta();
        parsedLogEntries.push({
          category: "lifecycle",
          summary: "agent finished",
          explicitTs,
        });
      } else if (ev.type === "error" || typeof ev.error === "string") {
        flushDelta();
        parsedLogEntries.push({
          category: "error",
          summary: sanitizeActivityText(String(ev.error ?? ev.message ?? "error"), 120),
          explicitTs,
        });
      }
    }
    flushDelta();
  }

  logParseCache.delete(logPath);
  logParseCache.set(logPath, { size: stat.size, mtimeMs: stat.mtimeMs, entries: parsedLogEntries });
  while (logParseCache.size > LOG_PARSE_CACHE_MAX) {
    const oldest = logParseCache.keys().next();
    if (oldest.done) break;
    logParseCache.delete(oldest.value);
  }
  return parsedLogEntries;
}

function parseEventTimestamp(ev: Record<string, unknown>, fallback: number): number {
  const raw = ev.timestamp ?? ev.ts ?? ev.time;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

/**
 * Aggregate chronological lifecycle, tool, error, and response events across async/sync jobs.
 * Reads bounded tails of each job's `output.log` so polling stays fast even on long runs.
 */
export function collectAsyncActivityEvents(
  jobs: readonly ActivityJobSource[],
  opts: { maxPerJob?: number; maxTotal?: number; now?: number } = {},
): ActivityEvent[] {
  const maxPerJob = opts.maxPerJob ?? DEFAULT_MAX_EVENTS_PER_JOB;
  const maxTotal = opts.maxTotal ?? DEFAULT_MAX_TOTAL_EVENTS;
  const now = opts.now ?? Date.now();
  const all: ActivityEvent[] = [];

  for (const job of jobs) {
    const sourceLabel = sanitizeActivityText(job.name || job.agent || job.id, 36) || job.id;
    const startTs = Number.isFinite(job.startedAt) && job.startedAt > 0 ? job.startedAt : now;
    const isTerminal = job.status === "complete" || job.status === "failed";
    const endTs = isTerminal
      ? startTs + Math.max(1, job.durationMs ?? Math.max(0, now - startTs))
      : Math.max(startTs, now);

    const jobEvents: ActivityEvent[] = [];
    jobEvents.push({
      id: `${job.id}:start`,
      timestamp: startTs,
      sourceId: job.id,
      sourceLabel,
      category: "lifecycle",
      summary: `started (${sanitizeActivityText(job.agent, 24)}) — ${sanitizeActivityText(job.task, 80)}`,
    });

    const parsedLogEntries = job.workerDir
      ? parseJobOutputLogCached(path.join(job.workerDir, "output.log"))
      : [];

    const boundedLog = parsedLogEntries.slice(-Math.max(1, maxPerJob - 2));
    const span = Math.max(1, endTs - startTs);
    for (let i = 0; i < boundedLog.length; i++) {
      const entry = boundedLog[i];
      const interpTs = startTs + Math.floor(((i + 1) / (boundedLog.length + 1)) * span);
      jobEvents.push({
        id: `${job.id}:log:${i}`,
        timestamp: entry.explicitTs ?? interpTs,
        sourceId: job.id,
        sourceLabel,
        category: entry.category,
        summary: entry.summary,
      });
    }

    if (isTerminal) {
      const snippet = job.output ? ` — ${sanitizeActivityText(job.output, 80)}` : "";
      jobEvents.push({
        id: `${job.id}:end`,
        timestamp: endTs,
        sourceId: job.id,
        sourceLabel,
        category: job.status === "failed" ? "error" : "lifecycle",
        summary: `${job.status === "failed" ? "failed" : "completed"}${snippet}`,
      });
    }

    all.push(...jobEvents);
  }

  all.sort((a, b) => (a.timestamp !== b.timestamp ? a.timestamp - b.timestamp : a.id.localeCompare(b.id)));
  if (all.length > maxTotal) return all.slice(-maxTotal);
  return all;
}

/** Extract a single printable character for inline search input, supporting Kitty CSI-u. */
function extractSearchChar(data: string): string | null {
  if (!data || isKeyRelease(data)) return null;
  if (matchesOverlayKey(data, Key.space)) return " ";
  const norm = normalizeOverlayKey(data);
  if (norm.length === 1 && norm >= " " && norm !== "\x7f") return norm;
  if (data.length === 1 && data >= " " && data !== "\x7f") return data;
  return null;
}

function categoryGlyph(category: ActivityCategory, theme: Theme): string {
  switch (category) {
    case "error":
      return theme.fg("error", "✖");
    case "tool":
      return theme.fg("warning", "⚙");
    case "message":
      return theme.fg("accent", "◆");
    default:
      return theme.fg("muted", "●");
  }
}

function categoryTag(category: ActivityCategory, theme: Theme, compact: boolean): string {
  if (compact) {
    switch (category) {
      case "error":
        return theme.fg("error", "[E]");
      case "tool":
        return theme.fg("warning", "[T]");
      case "message":
        return theme.fg("accent", "[M]");
      default:
        return theme.fg("muted", "[L]");
    }
  }
  switch (category) {
    case "error":
      return theme.fg("error", "ERR ");
    case "tool":
      return theme.fg("warning", "TOOL");
    case "message":
      return theme.fg("accent", "MSG ");
    default:
      return theme.fg("muted", "LIFE");
  }
}

/**
 * Fullscreen interactive Activity Log view (`[2] Activity`) shared by `/async` and `/coms`.
 */
export class OverlayActivityView implements Component {
  private filter: ActivityFilter;
  private search: string;
  private searchMode = false;
  private following: boolean;
  private selectedIndex = 0;
  private closed = false;
  private cachedEvents: ActivityEvent[] = [];
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private notice: OverlayNotice | undefined;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private poller: ReturnType<typeof setInterval>;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private keybindings: KeybindingsManager | undefined,
    private spec: OverlayActivitySpec,
    private done: (result: OverlayActivityResult) => void,
    private readonly onNotify?: OverlayNotify,
    private readonly noticeTimeoutMs: number = DEFAULT_NOTICE_MS,
  ) {
    this.filter = spec.initialFilter ?? "all";
    this.search = spec.initialSearch ?? "";
    this.following = spec.initialFollowing ?? true;
    this.cachedEvents = this.spec.listEvents();

    const initial = this.filteredEvents();
    if (this.following && initial.length > 0) {
      this.selectedIndex = initial.length - 1;
    }

    this.poller = setInterval(() => {
      if (this.closed) return;
      this.cachedEvents = this.spec.listEvents();
      this.invalidate();
      this.tui.requestRender();
    }, spec.pollMs ?? 1000);
    this.poller.unref?.();
  }

  /** Show an inline status/warning/error banner inside the activity overlay. */
  setNotice(message: string, level: OverlayNoticeLevel = "info"): void {
    if (this.closed) return;
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = undefined;
    }
    this.notice = { message, level };
    log.debug("activity_notice_set", { level, chars: message.length });
    if (this.noticeTimeoutMs > 0) {
      this.noticeTimer = setTimeout(() => {
        this.noticeTimer = undefined;
        if (this.closed || !this.notice) return;
        this.notice = undefined;
        this.invalidate();
        this.tui.requestRender(true);
      }, this.noticeTimeoutMs);
      this.noticeTimer.unref?.();
    }
    this.invalidate();
    this.tui.requestRender(true);
  }

  clearNotice(): void {
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = undefined;
    }
    if (this.notice) {
      this.notice = undefined;
      this.invalidate();
    }
  }

  private filteredEvents(): ActivityEvent[] {
    return filterActivityEvents(this.cachedEvents, this.filter, this.search);
  }

  private cleanup(): boolean {
    if (this.closed) return false;
    this.closed = true;
    clearInterval(this.poller);
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = undefined;
    }
    return true;
  }

  private finish(result: OverlayActivityResult): void {
    if (this.cleanup()) this.done(result);
  }

  dispose(): void {
    this.cleanup();
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;

    // Inline search input mode (`/`): printable chars edit query, Enter confirms, Esc clears & exits.
    if (this.searchMode) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        this.searchMode = false;
        this.search = "";
        this.spec.onSearchChange?.("");
        this.invalidate();
        this.tui.requestRender(true);
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.searchMode = false;
        this.invalidate();
        this.tui.requestRender(true);
        return;
      }
      if (matchesKey(data, Key.backspace) || data === "\x7f" || data === "\b") {
        if (this.search.length > 0) {
          this.search = this.search.slice(0, -1);
          this.spec.onSearchChange?.(this.search);
          this.invalidate();
          this.tui.requestRender(true);
        }
        return;
      }
      const ch = extractSearchChar(data);
      if (ch !== null) {
        this.search += ch;
        this.spec.onSearchChange?.(this.search);
        this.invalidate();
        this.tui.requestRender(true);
      }
      return;
    }

    const events = this.filteredEvents();
    this.clampSelection(events.length);

    if (
      this.keybindings?.matches(data, "tui.select.cancel") ||
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c"))
    ) {
      this.finish({ type: "close" });
      return;
    }

    if (matchesOverlayKey(data, "1")) {
      log.debug("activity_switch_tab", { tab: "roster" });
      this.finish({ type: "switch-tab", tab: "roster" });
      return;
    }

    if (matchesOverlayKey(data, "2")) {
      this.invalidate();
      this.tui.requestRender(true);
      return;
    }

    if (matchesOverlayKey(data, "f")) {
      this.filter = nextActivityFilter(this.filter);
      this.spec.onFilterChange?.(this.filter);
      const next = this.filteredEvents();
      this.selectedIndex = this.following && next.length > 0 ? next.length - 1 : 0;
      log.debug("activity_filter_cycled", { filter: this.filter, matches: next.length });
      this.setNotice(`Filter: ${activityFilterLabel(this.filter)} (${next.length})`, "info");
      return;
    }

    if (matchesOverlayKey(data, "/") || data === "/") {
      this.clearNotice();
      this.searchMode = true;
      log.debug("activity_search_started");
      this.invalidate();
      this.tui.requestRender(true);
      return;
    }

    if (matchesOverlayKey(data, Key.space)) {
      this.following = !this.following;
      this.spec.onFollowChange?.(this.following);
      if (this.following && events.length > 0) {
        this.selectedIndex = events.length - 1;
      }
      log.debug("activity_follow_toggled", { following: this.following });
      this.setNotice(this.following ? "Auto-follow resumed." : "Auto-follow paused.", "info");
      return;
    }

    if (
      this.keybindings?.matches(data, "tui.select.up") ||
      matchesKey(data, Key.up) ||
      matchesOverlayKey(data, "k")
    ) {
      this.clearNotice();
      if (this.following) {
        this.following = false;
        this.spec.onFollowChange?.(false);
      }
      if (events.length > 0 && this.selectedIndex > 0) {
        this.selectedIndex--;
      }
      this.invalidate();
      this.tui.requestRender(true);
      return;
    }

    if (
      this.keybindings?.matches(data, "tui.select.down") ||
      matchesKey(data, Key.down) ||
      matchesOverlayKey(data, "j")
    ) {
      this.clearNotice();
      if (this.following) {
        this.following = false;
        this.spec.onFollowChange?.(false);
      }
      if (events.length > 0 && this.selectedIndex < events.length - 1) {
        this.selectedIndex++;
      }
      this.invalidate();
      this.tui.requestRender(true);
      return;
    }

    if (matchesKey(data, Key.pageUp)) {
      this.clearNotice();
      if (this.following) {
        this.following = false;
        this.spec.onFollowChange?.(false);
      }
      this.selectedIndex = Math.max(0, this.selectedIndex - 10);
      this.invalidate();
      this.tui.requestRender(true);
      return;
    }

    if (matchesKey(data, Key.pageDown)) {
      this.clearNotice();
      if (this.following) {
        this.following = false;
        this.spec.onFollowChange?.(false);
      }
      this.selectedIndex = Math.min(Math.max(0, events.length - 1), this.selectedIndex + 10);
      this.invalidate();
      this.tui.requestRender(true);
      return;
    }

    if (matchesKey(data, Key.home)) {
      this.clearNotice();
      if (this.following) {
        this.following = false;
        this.spec.onFollowChange?.(false);
      }
      this.selectedIndex = 0;
      this.invalidate();
      this.tui.requestRender(true);
      return;
    }

    if (matchesKey(data, Key.end)) {
      this.clearNotice();
      this.following = true;
      this.spec.onFollowChange?.(true);
      this.selectedIndex = Math.max(0, events.length - 1);
      this.invalidate();
      this.tui.requestRender(true);
      return;
    }

    if (
      this.keybindings?.matches(data, "tui.select.confirm") ||
      matchesKey(data, Key.enter)
    ) {
      const picked = events[this.selectedIndex];
      if (!picked) {
        this.setNotice("No activity event to open.", "info");
        this.onNotify?.("No activity event to open.", "info");
        return;
      }
      log.debug("activity_inspect_event", { sourceId: picked.sourceId, category: picked.category });
      this.finish({ type: "inspect", event: picked });
    }
  }

  private clampSelection(count: number): void {
    if (count <= 0) {
      this.selectedIndex = 0;
      return;
    }
    if (this.following) {
      this.selectedIndex = count - 1;
      return;
    }
    if (this.selectedIndex >= count) this.selectedIndex = count - 1;
    if (this.selectedIndex < 0) this.selectedIndex = 0;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const theme = this.theme;
    const allEvents = this.cachedEvents;
    const events = filterActivityEvents(allEvents, this.filter, this.search);
    this.clampSelection(events.length);
    log.debug("activity_render", {
      total: allEvents.length,
      matched: events.length,
      filter: this.filter,
      following: this.following,
      width,
    });

    const rows = this.tui.terminal.rows || 30;
    const extraChrome = (this.notice ? 1 : 0) + (this.searchMode || this.search ? 1 : 0);
    const bodyHeight = Math.max(5, rows - (5 + extraChrome));
    const innerWidth = Math.max(0, width - 2);
    const compact = width < 72;
    const lines: string[] = [];

    const titleLeft = `${theme.fg("accent", theme.bold(this.spec.title))}  ${formatActivityTabBar("activity", theme)}`;
    const countRight = theme.fg(
      "muted",
      events.length === allEvents.length
        ? `${events.length} event${events.length === 1 ? "" : "s"}`
        : `${events.length}/${allEvents.length} events`,
    );
    const headerPad = Math.max(1, width - visibleWidth(titleLeft) - visibleWidth(countRight) - 4);
    lines.push(
      truncateToWidth(`  ${titleLeft}${" ".repeat(headerPad)}${countRight}  `, width),
    );

    const borderTitle = [
      `activity`,
      `filter: ${activityFilterLabel(this.filter)}`,
      this.following ? "follow: ON" : "follow: PAUSED",
      ...(this.search ? [`/${sanitizeActivityText(this.search, 24)}`] : []),
    ].join(" · ");
    lines.push(
      theme.fg("border", "╭") +
        borderSegment(theme, innerWidth, borderTitle) +
        theme.fg("border", "╮"),
    );

    const divider = theme.fg("border", "│");
    const rowLines = this.renderRows(events, innerWidth, bodyHeight, compact);
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(divider + padAnsi(rowLines[i] ?? "", innerWidth) + divider);
    }

    lines.push(
      theme.fg("border", "╰") +
        theme.fg("border", "─".repeat(innerWidth)) +
        theme.fg("border", "╯"),
    );

    if (this.searchMode || this.search) {
      const prompt = this.searchMode
        ? theme.fg("accent", `  / ${this.search}▌`) + theme.fg("dim", "  (Enter confirm · Esc clear)")
        : theme.fg("muted", `  / ${this.search}`) + theme.fg("dim", "  (press / to edit, Esc in search to clear)");
      lines.push(truncateToWidth(prompt, width));
    }

    if (this.notice) {
      const color = this.notice.level === "error"
        ? "error"
        : this.notice.level === "warning"
          ? "warning"
          : "accent";
      const prefix = this.notice.level === "error"
        ? "✖"
        : this.notice.level === "warning"
          ? "⚠"
          : "ℹ";
      lines.push(truncateToWidth(theme.fg(color, `  ${prefix} ${this.notice.message}`), width));
    }

    const footer = compact
      ? "1 Roster · f filter · / search · Space follow · Enter open · Esc close"
      : "1 Roster · 2 Activity · ↑↓/jk scroll · f filter (All|Errors|Tools|Messages) · / search · Space follow · Enter detail · Esc close";
    lines.push(truncateToWidth(theme.fg("dim", `  ${footer}`), width));

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  private renderRows(
    events: readonly ActivityEvent[],
    width: number,
    height: number,
    compact: boolean,
  ): string[] {
    const theme = this.theme;
    if (events.length === 0) {
      const reason = this.search || this.filter !== "all"
        ? `No activity events match filter=${activityFilterLabel(this.filter)}${this.search ? ` search="/${sanitizeActivityText(this.search, 30)}"` : ""}.`
        : (this.spec.emptyMessage ?? "No activity events recorded yet.");
      return [truncateToWidth(theme.fg("dim", `  ${reason}`), width)];
    }

    let start = 0;
    if (events.length > height) {
      if (this.following) {
        start = Math.max(0, events.length - height);
      } else {
        start = Math.min(
          Math.max(0, this.selectedIndex - Math.floor(height / 2)),
          events.length - height,
        );
      }
    }

    const visible = events.slice(start, start + height);
    const out: string[] = [];

    for (let i = 0; i < visible.length; i++) {
      const ev = visible[i];
      const idx = start + i;
      const isSelected = idx === this.selectedIndex;
      const marker = isSelected ? theme.fg("accent", "❯") : " ";
      const ts = theme.fg("dim", formatActivityTimestamp(ev.timestamp));
      const glyph = categoryGlyph(ev.category, theme);
      const tag = categoryTag(ev.category, theme, compact);
      const labelMax = compact ? 12 : 20;
      const sourceText = sanitizeActivityText(ev.sourceLabel, labelMax);
      const source = isSelected
        ? theme.fg("accent", sourceText)
        : theme.fg("text", sourceText);
      const summary = ev.category === "error"
        ? theme.fg("error", sanitizeActivityText(ev.summary, 140))
        : theme.fg("muted", sanitizeActivityText(ev.summary, 140));
      const line = compact
        ? `${marker} ${ts} ${tag} ${source} ${summary}`
        : ` ${marker} ${ts} ${glyph} ${tag} ${source} · ${summary}`;
      out.push(truncateToWidth(line, width));
    }

    if (start > 0 && out.length > 0) {
      out[0] = truncateToWidth(theme.fg("dim", `   ... ${start} earlier`), width);
    }
    if (start + height < events.length && out.length > 0) {
      out[out.length - 1] = truncateToWidth(
        theme.fg("dim", `   ... ${events.length - start - height} newer`),
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
