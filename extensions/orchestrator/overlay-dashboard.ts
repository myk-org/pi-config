/**
 * Shared fullscreen overlay list → detail dashboard (pi-tui ui.custom + overlay).
 * Used by /async-status and /cron list.
 */

import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  isKeyRelease,
  Key,
  matchesKey,
  parseKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type KeyId,
} from "@earendil-works/pi-tui";
import { createLogger } from "../shared/logger.js";
import {
  bulkRemove,
  bulkResultMessage,
  enterAction,
  reconcileSelection,
  selectionIndexFor,
  type OverlayId,
  type OverlaySelection,
} from "./overlay-dashboard-utils.js";

const log = createLogger("overlay-dashboard");

export {
  bulkRemove,
  bulkResultMessage,
  enterAction,
  reconcileSelection,
  selectionIndexFor,
  type EnterAction,
  type OverlayId,
  type OverlaySelection,
} from "./overlay-dashboard-utils.js";

/** Footer hint shown when a list spec does not provide its own. */
export const DEFAULT_LIST_HINTS = "↑↓/jk select · Enter view · x kill · Esc close";
/** Appended to the default hints only for `selectable` specs. */
export const SELECT_HINT = "Space multi-select";
/** Default auto-clear duration for inline overlay feedback banners. */
export const DEFAULT_NOTICE_MS = 4000;

export type OverlayNoticeLevel = "info" | "warning" | "error";

export interface OverlayNotice {
  message: string;
  level: OverlayNoticeLevel;
}

export type OverlayNotify = (message: string, level?: OverlayNoticeLevel) => void;

/**
 * Normalize a raw terminal input sequence into a single-key string when possible.
 * Handles plain characters, Kitty CSI-u (including NumLock/CapsLock lock bits and
 * non-Latin base layout keys), and xterm modifyOtherKeys. Shift+letter normalizes
 * to uppercase ("X"); unrecognized sequences pass through unchanged.
 */
export function normalizeOverlayKey(data: string): string {
  if (!data || isKeyRelease(data)) return "";
  const parsed = parseKey(data);
  if (!parsed) return data;
  const shiftedLetter = /^shift\+([a-z])$/.exec(parsed);
  if (shiftedLetter) return shiftedLetter[1].toUpperCase();
  return parsed;
}

/**
 * Match a raw terminal input sequence against a single-key overlay binding.
 * Lowercase "x" matches unshifted x; uppercase "X" matches Shift+x.
 * Supports legacy input, Kitty CSI-u (including NumLock/CapsLock and non-Latin
 * base layout keys), and modifyOtherKeys. Ignores key release events.
 */
export function matchesOverlayKey(data: string, key: string): boolean {
  if (!data || !key || isKeyRelease(data)) return false;
  if (key.length === 1 && key >= "A" && key <= "Z") {
    return matchesKey(data, `shift+${key.toLowerCase()}` as KeyId);
  }
  return matchesKey(data, key as KeyId);
}

export const OVERLAY_OPTS = {
  overlay: true as const,
  overlayOptions: {
    anchor: "center" as const,
    width: "100%" as const,
    maxHeight: "100%" as const,
  },
};

export interface OverlayRowParts {
  /** Already themed status glyph (e.g. ■). */
  glyph: string;
  /** Plain title; dashboard applies accent/text. */
  title: string;
  /** Dim id label (already themed or plain). */
  idLabel: string;
  /** Already themed right-side segments. */
  rightParts: string[];
}

export interface OverlayListSpec<
  TId extends OverlayId,
  TItem extends { id: TId },
> {
  title: string;
  /** Optional inline suffix rendered beside the title (e.g. `[1] Roster  [2] Activity` tab bar). */
  headerSuffix?: (theme: Theme) => string;
  countLabel: (items: readonly TItem[]) => string;
  borderTitle: (items: readonly TItem[]) => string;
  /** Defaults to DEFAULT_LIST_HINTS (+ "Space multi-select" when selectable). */
  footerHints?: string;
  /** Optional footer hints shown while multi-select has 1+ ticked rows. */
  selectedFooterHints?: string;
  listItems: () => TItem[];
  emptyBody?: string | (() => string);
  rowParts: (item: TItem, theme: Theme) => OverlayRowParts;
  /** Optional destructive/action key (x). */
  onX?: (item: TItem, notify: OverlayNotify) => void;
  /** Opt-in multi-select: Space toggles the focused row; `x` then acts on the whole selection. */
  selectable?: boolean;
  /** The dashboard owns no selection a caller can keep: a re-opened list would start empty and
   *  silently drop what the user ticked (coms: tick peers, inspect one, Esc back, `m` sent to the
   *  focused row only). The caller persists the ids it is given and passes them back as
   *  `initialSelectionIds`; nothing here knows what the rows mean. */
  onSelectionChange?: (ids: TId[]) => void;
  /** Called instead of onX while the multi-select set is non-empty. */
  onXSelected?: (items: TItem[], notify: OverlayNotify) => void;
  /** Optional bulk-action key (a) — destructive, so callers should confirm first. */
  onKillAll?: (notify: OverlayNotify) => void;
  /** Optional compose key (m): the caller needs the whole terminal for a text dialog, so the
   *  list closes and can be re-opened once the composed text is handled. Compose acts on the
   *  SELECTION, like `x`: every multi-selected row, or just the focused one when nothing is
   *  selected. Handling only the focused row silently dropped the rest (#1084).
   *
   *  `missingIds` names selected rows that are GONE by the time `m` is pressed (a peer left, a job
   *  finished). They are reported, never filtered away in silence: a send that reached less than
   *  the whole selection must say so. */
  onCompose?: (items: TItem[], missingIds: readonly TId[]) => void;
  /** Optional extra single-key actions (e.g. `n` add, `e` edit, `p` pause). "close" hands the
   *  terminal to the caller (a dialog), "redraw" refreshes the rows in place, "redraw-clear"
   *  refreshes and clears the multi-selection, false means the key was not handled and the
   *  built-in keys below still see it. `selected` is the Space-picked set (empty when nothing
   *  is selected), so an action that only makes sense on one row can refuse instead of silently
   *  acting on the focused one. */
  onKey?: (
    key: string,
    item: TItem | undefined,
    selected: readonly TItem[],
    notify: OverlayNotify,
  ) => "close" | "redraw" | "redraw-clear" | false;
  /** Enter hands the item back to the caller instead of opening a detail pane: a caller that
   *  navigates a level deeper opens its own overlay and re-opens this list when that one closes,
   *  which is what makes Esc walk back one level at a time. */
  onSelect?: (item: TItem) => void;
}

export interface OverlayDetailSpec {
  footerHints: string;
  /** Stick scroll to bottom as body grows (live logs). */
  followTail?: boolean;
  getHeader: (theme: Theme) => string;
  getBodyLines: (theme: Theme) => string[];
  emptyBody?: string;
  /** Return true to close after action. */
  onX?: () => boolean | void;
  /** Optional single-key actions in detail view (e.g. c/d/p/r).
   *  "close" closes the detail pane, "redraw" invalidates and re-renders, false/void ignores. */
  onKey?: (key: string) => "close" | "redraw" | false | void;
  tickMs?: number;
  pollMs?: number;
  /** Return true when content changed (triggers re-render). */
  onPoll?: () => boolean | void;
}

export function padAnsi(text: string, width: number): string {
  const truncated = truncateToWidth(text, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

export function borderSegment(theme: Theme, width: number, title: string): string {
  const label = title
    ? ` ${truncateToWidth(title, Math.max(0, width - 3))} `
    : "";
  const labelWidth = visibleWidth(label);
  return (
    theme.fg("border", "─") +
    (label ? theme.fg("text", label) : "") +
    theme.fg("border", "─".repeat(Math.max(0, width - 1 - labelWidth)))
  );
}

/** Join left + right columns with gap, truncated to width. */
export function splitRow(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  const leftMax = Math.max(0, width - rightWidth - 2);
  const leftTruncated = truncateToWidth(left, leftMax);
  const gap = Math.max(2, width - visibleWidth(leftTruncated) - rightWidth);
  return truncateToWidth(leftTruncated + " ".repeat(gap) + right, width);
}

export class OverlayListDashboard<
  TId extends OverlayId,
  TItem extends { id: TId },
> implements Component {
  private closed = false;
  private ticker: ReturnType<typeof setInterval>;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  /** Multi-selected ids — seeded by the caller, reported back on every change. */
  private readonly multi: Set<TId>;
  /** Inline feedback banner visible inside fullscreen overlays. */
  private notice: OverlayNotice | undefined;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private keybindings: KeybindingsManager,
    private spec: OverlayListSpec<TId, TItem>,
    private selection: OverlaySelection<TId>,
    private done: (value: TId | null) => void,
    initialMulti: readonly TId[] = [],
    /** The caller deliberately allows an empty list (a filter that can match nothing), so an
     *  action that empties the rows keeps the filter/create keys reachable instead of closing. */
    private readonly keepOpenWhenEmpty = false,
    private readonly onNotify?: OverlayNotify,
    private readonly noticeTimeoutMs: number = DEFAULT_NOTICE_MS,
  ) {
    this.multi = new Set(initialMulti);
    this.ticker = setInterval(() => { this.invalidate(); this.tui.requestRender(); }, 1000);
  }

  /** Show an inline status/warning banner inside the fullscreen overlay. */
  setNotice(message: string, level: OverlayNoticeLevel = "info"): void {
    if (this.closed) return;
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = undefined;
    }
    this.notice = { message, level };
    log.debug("list_notice_set", { level, chars: message.length });
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

  private readonly emitNotice: OverlayNotify = (message, level = "info") => {
    this.setNotice(message, level);
    this.onNotify?.(message, level);
  };

  private items(): TItem[] {
    return this.spec.listItems();
  }

  /** The rows Space picked, in list order; ids whose row is gone are dropped. */
  private selectedItems(items: readonly TItem[] = this.items()): TItem[] {
    if (this.multi.size === 0) return [];
    return items.filter((item) => this.multi.has(item.id));
  }

  private cleanup(): boolean {
    if (this.closed) return false;
    this.closed = true;
    clearInterval(this.ticker);
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = undefined;
    }
    return true;
  }

  private close(result: TId | null): void {
    if (this.cleanup()) this.done(result);
  }

  dispose(): void {
    this.cleanup();
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    const items = this.items();
    reconcileSelection(this.selection, items);
    const selected = this.selectedItems(items);

    if (matchesKey(data, Key.escape) && selected.length > 0) {
      this.multi.clear();
      this.spec.onSelectionChange?.([]);
      this.clearNotice();
      log.debug("list_multi_select_clear", { reason: "escape", count: selected.length });
      this.invalidate();
      this.tui.requestRender(true);
      return;
    }
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c"))
    ) {
      this.close(null);
      return;
    }
    if (
      this.keybindings.matches(data, "tui.select.confirm") ||
      matchesKey(data, Key.enter)
    ) {
      const item = items[this.selection.index];
      if (item) this.close(item.id);
      return;
    }
    if (
      this.keybindings.matches(data, "tui.select.up") ||
      matchesKey(data, Key.up) ||
      matchesOverlayKey(data, "k")
    ) {
      const hadNotice = !!this.notice;
      this.clearNotice();
      if (items.length > 0) {
        this.selection.index =
          (this.selection.index - 1 + items.length) % items.length;
        this.selection.id = items[this.selection.index]?.id;
        this.invalidate();
        this.tui.requestRender(true);
      } else if (hadNotice) {
        this.tui.requestRender(true);
      }
      return;
    }
    if (
      this.keybindings.matches(data, "tui.select.down") ||
      matchesKey(data, Key.down) ||
      matchesOverlayKey(data, "j")
    ) {
      const hadNotice = !!this.notice;
      this.clearNotice();
      if (items.length > 0) {
        this.selection.index = (this.selection.index + 1) % items.length;
        this.selection.id = items[this.selection.index]?.id;
        this.invalidate();
        this.tui.requestRender(true);
      } else if (hadNotice) {
        this.tui.requestRender(true);
      }
      return;
    }
    const normalizedKey = normalizeOverlayKey(data);
    const prevNotice = this.notice;
    const action = this.spec.onKey?.(
      normalizedKey,
      items[this.selection.index],
      selected,
      this.emitNotice,
    );
    if (action === "close") {
      log.debug("list_key_action", { key: normalizedKey, outcome: "close" });
      this.close(null);
      return;
    }
    if (action === "redraw" || action === "redraw-clear") {
      if (this.notice === prevNotice) this.clearNotice();
      if (action === "redraw-clear") {
        if (this.multi.size > 0) {
          this.multi.clear();
          this.spec.onSelectionChange?.([]);
        }
      } else if (this.multi.size > 0) {
        const visible = new Set(this.items().map((item) => item.id));
        let pruned = false;
        for (const id of [...this.multi]) {
          if (!visible.has(id)) {
            this.multi.delete(id);
            pruned = true;
          }
        }
        if (pruned) this.spec.onSelectionChange?.([...this.multi]);
      }
      log.debug("list_key_action", { key: normalizedKey, outcome: action });
      this.invalidate();
      this.tui.requestRender(true);
      return;
    }
    if (this.spec.selectable && matchesOverlayKey(data, Key.space)) {
      this.clearNotice();
      const focused = items[this.selection.index];
      if (focused) {
        if (this.multi.has(focused.id)) this.multi.delete(focused.id);
        else this.multi.add(focused.id);
        log.debug("list_multi_select_toggle", { id: focused.id, size: this.multi.size });
        this.spec.onSelectionChange?.([...this.multi]);
        this.invalidate();
        this.tui.requestRender(true);
      }
      return;
    }
    if (
      (matchesOverlayKey(data, "a") || matchesOverlayKey(data, "A") || matchesOverlayKey(data, "X")) &&
      this.spec.onKillAll
    ) {
      log.debug("list_kill_all_key", { key: normalizedKey, selected: this.multi.size });
      this.clearNotice();
      // Cleared for the same reason the x path clears it: killing marks jobs failed, so the
      // stale ids would survive and a following `x` would act on them (or on nothing) instead
      // of on the newly focused running row.
      this.multi.clear();
      this.spec.onSelectionChange?.([]);
      this.spec.onKillAll(this.emitNotice);
      this.invalidate();
      this.tui.requestRender(true);
      return;
    }
    if (matchesOverlayKey(data, "m") && this.spec.onCompose) {
      // Same target set `x` uses: the multi-selection when there is one, else the focused row.
      const wanted = this.multi.size > 0
        ? [...this.multi]
        : [items[this.selection.index]?.id].filter((id): id is TId => id !== undefined);
      // Row order for what survived, the ids for what did not — a vanished peer is reported, not
      // dropped: an empty `targets` still reaches the caller instead of `m` doing nothing.
      const targets = items.filter((item) => wanted.includes(item.id));
      const missingIds = wanted.filter((id) => !items.some((item) => item.id === id));
      log.debug("list_compose_key", { rows: targets.length, missing: missingIds.length, multi: this.multi.size > 0 });
      this.spec.onCompose(targets, missingIds);
      this.close(null);
      return;
    }
    if (matchesOverlayKey(data, "x")) {
      this.clearNotice();
      if (this.multi.size > 0) {
        // Cleared unconditionally: killed jobs disappear, and stale ids would leak.
        this.multi.clear();
        this.spec.onSelectionChange?.([]);
      }
      if (selected.length > 0) {
        log.debug("list_multi_x", { count: selected.length });
        this.spec.onXSelected?.(selected, this.emitNotice);
        if (this.items().length === 0 && !this.keepOpenWhenEmpty) {
          this.close(null);
          return;
        }
        this.invalidate();
        this.tui.requestRender(true);
        return;
      }
      const item = items[this.selection.index];
      if (item) {
        this.spec.onX?.(item, this.emitNotice);
        if (this.items().length === 0 && !this.keepOpenWhenEmpty) {
          this.close(null);
          return;
        }
        this.invalidate();
        this.tui.requestRender(true);
      }
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const theme = this.theme;
    const items = this.items();
    reconcileSelection(this.selection, items);
    const selectedCount = this.selectedItems(items).length;
    log.debug("list_render", { items: items.length, focused: this.selection.index, multi: selectedCount });

    const rows = this.tui.terminal.rows || 30;
    const bodyHeight = Math.max(5, rows - (this.notice ? 6 : 5));
    const innerWidth = Math.max(0, width - 2);
    const lines: string[] = [];

    const baseHeaderLeft = theme.fg("accent", theme.bold(this.spec.title));
    const suffix = this.spec.headerSuffix ? this.spec.headerSuffix(theme) : "";
    const headerLeft = suffix ? `${baseHeaderLeft}  ${suffix}` : baseHeaderLeft;
    const headerRight = theme.fg("muted", this.spec.countLabel(items));
    const headerPad = Math.max(
      1,
      width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4,
    );
    lines.push(
      truncateToWidth(
        `  ${headerLeft}${" ".repeat(headerPad)}${headerRight}  `,
        width,
      ),
    );

    const baseBorderTitle = this.spec.borderTitle(items);
    const borderTitle = selectedCount > 0
      ? (baseBorderTitle ? `${baseBorderTitle} · ${selectedCount} selected` : `${selectedCount} selected`)
      : baseBorderTitle;
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

    lines.push(truncateToWidth(theme.fg("dim", `  ${this.footerText(selectedCount)}`), width));

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  /** Spec hints, falling back to the shared defaults (+ toggle hint when selectable). The bulk
   *  keys named are only the ones this spec really wires, so a list that has `x` but no `X` does
   *  not advertise a selection action that goes nowhere. */
  private footerText(selectedCount: number): string {
    const base = this.baseFooterText(selectedCount);
    if (selectedCount === 0) return base;
    const withEscClear = /\bEsc close\b/.test(base)
      ? base.replace(/\bEsc close\b/, "Esc clear")
      : /\bEsc clear\b/.test(base)
        ? base
        : `${base} · Esc clear`;
    return `${selectedCount} selected · ${withEscClear}`;
  }

  private baseFooterText(selectedCount: number): string {
    if (selectedCount > 0 && this.spec.selectedFooterHints) return this.spec.selectedFooterHints;
    if (this.spec.footerHints) return this.spec.footerHints;
    if (!this.spec.selectable) return DEFAULT_LIST_HINTS;
    const bulk = [...(this.spec.onXSelected ? ["x"] : []), ...(this.spec.onKillAll ? ["X"] : [])];
    log.debug("list_footer_hints", { source: "default", selectable: true, bulk: bulk.length });
    return bulk.length === 0
      ? `${DEFAULT_LIST_HINTS} · ${SELECT_HINT}`
      : `${DEFAULT_LIST_HINTS} · ${SELECT_HINT} · ${bulk.join("/")} on selection`;
  }

  private renderRows(
    items: ReadonlyArray<TItem>,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const out: string[] = [];

    log.debug("list_render_rows", { items: items.length, height, multi: this.multi.size });
    if (items.length === 0 && this.spec.emptyBody) {
      const emptyText = typeof this.spec.emptyBody === "function" ? this.spec.emptyBody() : this.spec.emptyBody;
      return [theme.fg("dim", emptyText)];
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

    for (let i = 0; i < visible.length; i++) {
      const item = visible[i];
      const index = start + i;
      const isSelected = index === this.selection.index;
      const parts = this.spec.rowParts(item, theme);
      const marker = isSelected ? theme.fg("accent", "❯") : " ";
      const title = isSelected
        ? theme.fg("accent", parts.title)
        : theme.fg("text", parts.title);
      const picked = this.spec.selectable
        ? this.multi.has(item.id) ? theme.fg("accent", "▸") : " "
        : "";
      const left = `${picked} ${marker} ${parts.glyph} ${title} ${parts.idLabel}`;
      const right = `${parts.rightParts.join(dot)} `;
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

export class OverlayScrollDetail implements Component {
  private scrollOffset = 0;
  private maxScroll = 0;
  private following: boolean;
  private closed = false;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private wrappedWidth: number | undefined;
  private wrappedBodyRef: string[] | undefined;
  private wrappedBodyLen = 0;
  private cachedWrapped: string[] = [];
  private ticker: ReturnType<typeof setInterval>;
  private poller: ReturnType<typeof setInterval> | undefined;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private spec: OverlayDetailSpec,
    private done: (value: null) => void,
  ) {
    this.following = !!spec.followTail;
    // Tick always invalidates — headers may show live clocks / durations.
    this.ticker = setInterval(() => {
      this.invalidate();
      this.tui.requestRender();
    }, spec.tickMs ?? 1000);
    if (spec.onPoll) {
      this.poller = setInterval(() => {
        if (spec.onPoll?.()) {
          this.invalidate();
          this.tui.requestRender();
        }
      }, spec.pollMs ?? 500);
      if (spec.onPoll()) {
        this.invalidate();
        this.tui.requestRender();
      }
    }
  }

  private cleanup(): boolean {
    if (this.closed) return false;
    this.closed = true;
    clearInterval(this.ticker);
    if (this.poller) clearInterval(this.poller);
    return true;
  }

  private close(): void {
    if (this.cleanup()) this.done(null);
  }

  dispose(): void {
    this.cleanup();
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.close();
      return;
    }
    if (matchesOverlayKey(data, "x") && this.spec.onX) {
      if (this.spec.onX()) this.close();
      else {
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.up) || matchesOverlayKey(data, "k")) {
      if (this.scrollOffset > 0) {
        this.scrollOffset--;
        this.following = false;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.down) || matchesOverlayKey(data, "j")) {
      if (this.scrollOffset < this.maxScroll) {
        this.scrollOffset++;
        this.invalidate();
        this.tui.requestRender();
      }
      if (this.scrollOffset >= this.maxScroll) this.following = true;
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 10);
      this.following = false;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset = Math.min(this.maxScroll, this.scrollOffset + 10);
      if (this.scrollOffset >= this.maxScroll) this.following = true;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
      this.following = false;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.scrollOffset = this.maxScroll;
      this.following = true;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (this.spec.onKey) {
      const res = this.spec.onKey(normalizeOverlayKey(data));
      if (res === "close") {
        this.close();
      } else if (res === "redraw") {
        this.invalidate();
        this.tui.requestRender();
      }
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const theme = this.theme;
    const header = this.spec.getHeader(theme);
    const footer = theme.fg("dim", this.spec.footerHints);
    const sep = theme.fg("border", "─".repeat(Math.max(1, width)));

    const body = this.spec.getBodyLines(theme);
    const wrapWidth = Math.max(10, width - 2);
    if (
      this.wrappedWidth !== width ||
      this.wrappedBodyRef !== body ||
      body.length < this.wrappedBodyLen
    ) {
      this.wrappedWidth = width;
      this.wrappedBodyRef = body;
      this.wrappedBodyLen = 0;
      this.cachedWrapped = [];
    }
    if (body.length > this.wrappedBodyLen) {
      for (let i = this.wrappedBodyLen; i < body.length; i++) {
        for (const wl of wrapTextWithAnsi(body[i], wrapWidth)) {
          this.cachedWrapped.push(truncateToWidth(wl, width));
        }
      }
      this.wrappedBodyLen = body.length;
    }
    const wrapped = this.cachedWrapped.length > 0
      ? this.cachedWrapped
      : [theme.fg("dim", this.spec.emptyBody ?? "(empty)")];

    const rows = this.tui.terminal.rows || 30;
    const viewHeight = Math.max(6, rows - 8);
    this.maxScroll = Math.max(0, wrapped.length - viewHeight);
    if (this.following && this.spec.followTail) {
      this.scrollOffset = this.maxScroll;
    }
    if (this.scrollOffset > this.maxScroll) this.scrollOffset = this.maxScroll;

    const visible = wrapped.slice(
      this.scrollOffset,
      this.scrollOffset + viewHeight,
    );
    while (visible.length < viewHeight) visible.push("");

    this.cachedLines = [
      truncateToWidth(header, width),
      sep,
      ...visible,
      sep,
      truncateToWidth(footer, width),
    ];
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

/**
 * Loop: list overlay → detail overlay until list closed / empty.
 */
export async function openListDetailOverlay<
  TId extends OverlayId,
  TItem extends { id: TId },
>(
  ctx: ExtensionCommandContext,
  options: {
    emptyMessage: string;
    /** Keep filter/create keys available when a caller deliberately supplies an empty list. */
    allowEmpty?: boolean;
    listSpec: OverlayListSpec<TId, TItem>;
    /** Re-open the list focused on this row (a caller returning from a deeper level). An id that
     *  is no longer there falls back to the first row. */
    initialSelectionId?: TId;
    /** Re-open the list with these rows still ticked. The caller keeps them across re-opens
     *  (`listSpec.onSelectionChange` gives it the new set); ids that no longer exist are simply
     *  never matched. */
    initialSelectionIds?: readonly TId[];
    /** Optional inline banner shown immediately when the list first opens (e.g. outcome of a
     *  dialog-backed bulk action). Cleared after the first open so detail round-trips do not replay it. */
    initialNotice?: OverlayNotice;
    /** Omitted by a list whose Enter navigates deeper (`listSpec.onSelect`). */
    createDetail?: (
      item: TItem,
      tui: TUI,
      theme: Theme,
      done: (value: null) => void,
    ) => Component;
  },
): Promise<void> {
  if (!ctx.hasUI) return;

  // Seeded from the caller's row so Esc returns to where the user was, not to row 0.
  const selection: OverlaySelection<TId> = {
    index: selectionIndexFor(options.listSpec.listItems(), options.initialSelectionId),
    ...(options.initialSelectionId !== undefined ? { id: options.initialSelectionId } : {}),
  };

  // Preserve multi-selection across Enter → detail → Esc by default for all selectable lists.
  let multiIds: TId[] = [...(options.initialSelectionIds ?? [])];
  const listSpec: OverlayListSpec<TId, TItem> = {
    ...options.listSpec,
    onSelectionChange: (ids) => {
      multiIds = [...ids];
      options.listSpec.onSelectionChange?.(ids);
    },
  };
  const forwardNotify: OverlayNotify = (msg, level = "info") => {
    try {
      ctx.ui?.notify?.(msg, level);
    } catch {}
  };
  let pendingNotice = options.initialNotice;

  while (true) {
    const items = options.listSpec.listItems();
    if (items.length === 0 && !options.allowEmpty) {
      ctx.ui.notify(options.emptyMessage, "info");
      return;
    }

    log.debug("overlay_list_open", { count: items.length, allowEmpty: !!options.allowEmpty, multi: multiIds.length });
    const picked = await ctx.ui.custom<TId | null>(
      (tui, theme, keybindings, done) => {
        const dash = new OverlayListDashboard(
          tui,
          theme,
          keybindings,
          listSpec,
          selection,
          done,
          multiIds,
          options.allowEmpty === true,
          forwardNotify,
        );
        if (pendingNotice) {
          dash.setNotice(pendingNotice.message, pendingNotice.level);
          pendingNotice = undefined;
        }
        return dash;
      },
      OVERLAY_OPTS,
    );

    if (picked === null || picked === undefined) return;

    const item = options.listSpec.listItems().find((i) => i.id === picked);
    if (!item) continue;

    // A list whose Enter goes a level deeper returns to its caller, which opens the next level
    // and comes back here on Esc — that is the whole back-navigation contract.
    const action = enterAction({ onSelect: options.listSpec.onSelect, createDetail: options.createDetail });
    if (action === "navigate") {
      options.listSpec.onSelect?.(item);
      return;
    }
    const createDetail = options.createDetail;
    if (action === "none" || !createDetail) return;

    await ctx.ui.custom<null>(
      (tui, theme, _kb, done) =>
        createDetail(item, tui, theme, done),
      OVERLAY_OPTS,
    );

    if (multiIds.length > 0) {
      const remaining = new Set(options.listSpec.listItems().map((i) => i.id));
      const pruned = multiIds.filter((id) => remaining.has(id));
      if (pruned.length !== multiIds.length) {
        multiIds = pruned;
        options.listSpec.onSelectionChange?.([...multiIds]);
      }
    }
  }
}
