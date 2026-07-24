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
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  reconcileSelection,
  type OverlayId,
  type OverlaySelection,
} from "./overlay-dashboard-utils.js";

export {
  reconcileSelection,
  type OverlayId,
  type OverlaySelection,
} from "./overlay-dashboard-utils.js";

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
  countLabel: (items: readonly TItem[]) => string;
  borderTitle: (items: readonly TItem[]) => string;
  footerHints: string;
  listItems: () => TItem[];
  rowParts: (item: TItem, theme: Theme) => OverlayRowParts;
  /** Optional destructive/action key (x). */
  onX?: (item: TItem) => void;
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

  constructor(
    private tui: TUI,
    private theme: Theme,
    private keybindings: KeybindingsManager,
    private spec: OverlayListSpec<TId, TItem>,
    private selection: OverlaySelection<TId>,
    private done: (value: TId | null) => void,
  ) {
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
  }

  private items(): TItem[] {
    return this.spec.listItems();
  }

  private cleanup(): boolean {
    if (this.closed) return false;
    this.closed = true;
    clearInterval(this.ticker);
    return true;
  }

  private close(result: TId | null): void {
    if (this.cleanup()) this.done(result);
  }

  dispose(): void {
    this.cleanup();
  }

  handleInput(data: string): void {
    const items = this.items();
    reconcileSelection(this.selection, items);

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
      data === "k"
    ) {
      if (items.length > 0) {
        this.selection.index =
          (this.selection.index - 1 + items.length) % items.length;
        this.selection.id = items[this.selection.index]?.id;
        this.tui.requestRender();
      }
      return;
    }
    if (
      this.keybindings.matches(data, "tui.select.down") ||
      matchesKey(data, Key.down) ||
      data === "j"
    ) {
      if (items.length > 0) {
        this.selection.index = (this.selection.index + 1) % items.length;
        this.selection.id = items[this.selection.index]?.id;
        this.tui.requestRender();
      }
      return;
    }
    if (data === "x") {
      const item = items[this.selection.index];
      if (item) {
        this.spec.onX?.(item);
        if (this.items().length === 0) {
          this.close(null);
          return;
        }
        this.tui.requestRender();
      }
    }
  }

  render(width: number): string[] {
    const theme = this.theme;
    const items = this.items();
    reconcileSelection(this.selection, items);

    const rows = this.tui.terminal.rows || 30;
    const bodyHeight = Math.max(6, rows - 5);
    const innerWidth = width - 2;
    const lines: string[] = [];

    const headerLeft = theme.fg("accent", theme.bold(this.spec.title));
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

    lines.push(
      theme.fg("border", "╭") +
        borderSegment(theme, innerWidth, this.spec.borderTitle(items)) +
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

    lines.push(
      truncateToWidth(theme.fg("dim", `  ${this.spec.footerHints}`), width),
    );

    return lines;
  }

  private renderRows(
    items: ReadonlyArray<TItem>,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const out: string[] = [];

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
      const left = ` ${marker} ${parts.glyph} ${title} ${parts.idLabel}`;
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

  invalidate(): void {}
}

export class OverlayScrollDetail implements Component {
  private scrollOffset = 0;
  private maxScroll = 0;
  private following: boolean;
  private closed = false;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
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
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.close();
      return;
    }
    if (data === "x" && this.spec.onX) {
      if (this.spec.onX()) this.close();
      else {
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      if (this.scrollOffset > 0) {
        this.scrollOffset--;
        this.following = false;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
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
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const theme = this.theme;
    const header = this.spec.getHeader(theme);
    const footer = theme.fg("dim", this.spec.footerHints);
    const sep = theme.fg("border", "─".repeat(Math.max(1, width)));

    const body = this.spec.getBodyLines(theme);
    const wrapped: string[] = [];
    for (const line of body) {
      for (const wl of wrapTextWithAnsi(line, Math.max(10, width - 2))) {
        wrapped.push(truncateToWidth(wl, width));
      }
    }
    if (wrapped.length === 0) {
      wrapped.push(theme.fg("dim", this.spec.emptyBody ?? "(empty)"));
    }

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
    listSpec: OverlayListSpec<TId, TItem>;
    createDetail: (
      item: TItem,
      tui: TUI,
      theme: Theme,
      done: (value: null) => void,
    ) => Component;
  },
): Promise<void> {
  if (!ctx.hasUI) return;

  const selection: OverlaySelection<TId> = { index: 0 };

  while (true) {
    const items = options.listSpec.listItems();
    if (items.length === 0) {
      ctx.ui.notify(options.emptyMessage, "info");
      return;
    }

    const picked = await ctx.ui.custom<TId | null>(
      (tui, theme, keybindings, done) =>
        new OverlayListDashboard(
          tui,
          theme,
          keybindings,
          options.listSpec,
          selection,
          done,
        ),
      OVERLAY_OPTS,
    );

    if (picked === null || picked === undefined) return;

    const item = options.listSpec.listItems().find((i) => i.id === picked);
    if (!item) continue;

    await ctx.ui.custom<null>(
      (tui, theme, _kb, done) =>
        options.createDetail(item, tui, theme, done),
      OVERLAY_OPTS,
    );
  }
}
