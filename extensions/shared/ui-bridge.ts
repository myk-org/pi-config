/**
 * ui-bridge — bidirectional interactive prompt bridging for pidash (#968 part B).
 *
 * Wraps select/confirm/input prompts so they render in the TUI AND the pidash
 * browser simultaneously, with first-answer-wins race safety in both directions:
 *
 *   - browser answer  → pi.events "pidash:ui-response" → done() closes the TUI dialog
 *   - TUI answer      → resolve() emits "pidash:ui-dismiss" → browser marks answered
 *
 * Built on ctx.ui.custom (not ctx.ui.select/confirm) because only custom's
 * done callback can be invoked from outside the TUI input loop — that is what
 * lets the browser close the TUI dialog. ask_user (ask-user.ts) pioneered this
 * pattern; ui-bridge generalizes it for every other blocking prompt.
 *
 * Enforcement semantics are preserved: the browser is just another transport
 * for the same decision — the answer flows through the same code path as a
 * TUI answer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Input,
  Key,
  SelectList,
  Text,
  type SelectItem,
  fuzzyFilter,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { createLogger } from "./logger.js";

const log = createLogger("ui-bridge");

export const FILTER_AUTO_SHOW_THRESHOLD = 6;

export function computeQuestionViewportCap(termRows: number): number {
  return Math.max(3, Math.min(5, Math.floor(termRows * 0.14)));
}

export function computeBoxHeightBudget(termRows: number): number {
  return Math.max(10, Math.floor(termRows * 0.4));
}

export function computeSelectMaxVisible(
  itemCount: number,
  termRows: number,
  reservedRows = 0,
): number {
  if (itemCount <= 0) return 0;
  const byRatio = Math.max(3, Math.floor(termRows * 0.25));
  if (reservedRows <= 0) return Math.min(itemCount, byRatio);
  const remaining = Math.max(3, computeBoxHeightBudget(termRows) - reservedRows);
  return Math.min(itemCount, Math.min(byRatio, remaining));
}

export interface PromptTheme {
  fg(color: any, text: string): string;
}

export function createMinimizedBar(theme: PromptTheme, label: string): Component {
  return {
    render(width: number): string[] {
      const pad = Math.min(1, Math.max(0, Math.floor((width - 1) / 2)));
      const contentWidth = Math.max(1, width - pad * 2);
      const text =
        theme.fg("accent", `◷ ${label} paused`) +
        theme.fg("dim", " — press Tab (or Alt+P) to resume answering · Esc cancel");
      return [" ".repeat(pad) + truncateToWidth(text, contentWidth, "…")];
    },
    invalidate() {},
  };
}

export class QuestionViewport implements Component {
  private scrollOffset = 0;
  private expanded = false;
  private lastWidth = 0;
  private cachedWrapWidth = -1;
  private cachedWrapped: string[] = [];
  private cachedRenderKey = "";
  private cachedLines: string[] | undefined;

  constructor(
    private readonly question: string,
    private readonly getTermRows: () => number,
    private readonly theme: PromptTheme,
    private readonly isSelectMode: () => boolean,
    private readonly textColor: "text" | "accent" = "text",
  ) {}

  private getWrapped(width: number): { wrapped: string[]; pad: number; contentWidth: number } {
    const pad = Math.min(1, Math.max(0, Math.floor((width - 1) / 2)));
    const contentWidth = Math.max(1, width - pad * 2);
    if (this.cachedWrapWidth !== contentWidth) {
      this.cachedWrapWidth = contentWidth;
      this.cachedWrapped =
        this.question.trim() === ""
          ? []
          : wrapTextWithAnsi(this.question.replace(/\t/g, "   "), contentWidth);
    }
    return { wrapped: this.cachedWrapped, pad, contentWidth };
  }

  private getEffectiveWidth(): number {
    return this.lastWidth > 0 ? this.lastWidth : 80;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  isOverflowed(width?: number): boolean {
    const w = width ?? this.getEffectiveWidth();
    const { wrapped } = this.getWrapped(w);
    return wrapped.length > computeQuestionViewportCap(this.getTermRows());
  }

  scrollBy(delta: number): boolean {
    if (this.expanded) return false;
    const { wrapped } = this.getWrapped(this.getEffectiveWidth());
    const cap = computeQuestionViewportCap(this.getTermRows());
    if (wrapped.length <= cap) return false;
    const maxOffset = wrapped.length - cap;
    const next = Math.max(0, Math.min(maxOffset, this.scrollOffset + delta));
    if (next === this.scrollOffset) return false;
    this.scrollOffset = next;
    this.invalidate();
    return true;
  }

  scrollPage(direction: -1 | 1): boolean {
    const cap = computeQuestionViewportCap(this.getTermRows());
    return this.scrollBy(direction * Math.max(1, cap - 1));
  }

  toggleExpanded(): boolean {
    if (!this.expanded && !this.isOverflowed()) return false;
    this.expanded = !this.expanded;
    this.invalidate();
    return true;
  }

  invalidate(): void {
    this.cachedRenderKey = "";
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    this.lastWidth = width;
    const termRows = this.getTermRows();
    const selectMode = this.isSelectMode();
    const key = `${width}:${termRows}:${this.scrollOffset}:${this.expanded ? 1 : 0}:${selectMode ? 1 : 0}`;
    if (this.cachedLines && this.cachedRenderKey === key) {
      return this.cachedLines;
    }

    const { wrapped, pad, contentWidth } = this.getWrapped(width);
    if (wrapped.length === 0) {
      this.cachedRenderKey = key;
      this.cachedLines = [];
      return this.cachedLines;
    }

    const cap = computeQuestionViewportCap(termRows);
    const total = wrapped.length;
    const overflowed = total > cap;
    let visible: string[];
    let start = 0;

    if (!overflowed || this.expanded) {
      visible = wrapped;
    } else {
      const maxOffset = total - cap;
      this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
      start = this.scrollOffset;
      visible = wrapped.slice(start, start + cap);
    }

    const leftPad = " ".repeat(pad);
    const lines: string[] = visible.map((line) => leftPad + this.theme.fg(this.textColor, line));

    if (overflowed) {
      const indicator = this.expanded
        ? selectMode
          ? `lines 1–${total} of ${total} (expanded) • ctrl+e collapse`
          : `lines 1–${total} of ${total} (expanded)`
        : selectMode
          ? `lines ${start + 1}–${start + visible.length} of ${total} • shift+↑↓/pgup/pgdn scroll • ctrl+e expand`
          : `lines ${start + 1}–${start + visible.length} of ${total} • shift+↑↓ scroll`;
      lines.push(leftPad + this.theme.fg("dim", truncateToWidth(indicator, contentWidth, "…")));
    }

    lines.push("");

    this.cachedRenderKey = `${width}:${termRows}:${this.scrollOffset}:${this.expanded ? 1 : 0}:${selectMode ? 1 : 0}`;
    this.cachedLines = lines;
    return lines;
  }
}

export interface BridgedUi {
  /** Single choice from a list. Resolves undefined when cancelled. */
  select(ctx: any, title: string, options: string[]): Promise<string | undefined>;
  /** Yes/no. Resolves false when cancelled or denied. */
  confirm(ctx: any, title: string, message?: string): Promise<boolean>;
  /** Free text. Resolves undefined when cancelled. */
  input(ctx: any, title: string): Promise<string | undefined>;
}

function requestId(method: string): string {
  return `${method}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

const BROWSER_DISPATCH = Symbol.for("pi-config.browserDispatchCtx");

/** Tag the ctx pidash hands a browser-dispatched command. Tag the COPY, never the live ctx. */
export function markBrowserDispatch(ctx: unknown): void {
  if (ctx && typeof ctx === "object") (ctx as Record<symbol, unknown>)[BROWSER_DISPATCH] = true;
  log.debug("browser dispatch context marked", { tagged: Boolean(ctx && typeof ctx === "object") });
}

/** True when this command came from the pidash browser — a surface where no terminal overlay,
 *  and no keypress on it, is reachable. Callers render text instead of opening one. */
export function isBrowserDispatch(ctx: unknown): boolean {
  const browserDispatch = !!(ctx && typeof ctx === "object" && (ctx as Record<symbol, unknown>)[BROWSER_DISPATCH] === true);
  log.debug("browser dispatch context checked", { browserDispatch });
  return browserDispatch;
}

export function createBridgedUi(pi: ExtensionAPI): BridgedUi {
  /**
   * Shared bridge: emit the request to the browser, listen for its response,
   * and render the TUI dialog via ctx.ui.custom. Whichever surface answers
   * first wins; the other sees the prompt closed.
   */
  async function bridged<T>(
    ctx: any,
    method: "select" | "confirm" | "input",
    title: string,
    options: string[] = [],
    message?: string,
  ): Promise<T | undefined> {
    if (!ctx?.hasUI) {
      log.debug("bridged prompt skipped — no UI", { method });
      return undefined;
    }

    // No ui.custom (older runtime / embedded mock) — plain prompt, TUI only.
    if (typeof ctx.ui?.custom !== "function") {
      log.debug("bridged prompt degraded — no ui.custom", { method });
      if (method === "select") return await ctx.ui.select(title, options) as T | undefined;
      // The confirm wrapper compares against the "__confirmed__"/"Yes" sentinels, so a raw
      // boolean here was always rejected — every prompt without ui.custom cancelled, and an
      // approval could never succeed. Translate the answer to the sentinel the caller expects.
      if (method === "confirm") return ((await ctx.ui.confirm(title, message)) ? "__confirmed__" : "__denied__") as T | undefined;
      return await ctx.ui.input(title) as T | undefined;
    }

    const id = requestId(method);
    // Degrade to TUI-only when the event bus is absent (embedded/test contexts)
    pi.events?.emit?.("pidash:ui-request", {
      id,
      type: "extension_ui_request",
      method,
      title: message ? `${title}\n${message}` : title,
      options: method === "confirm" ? ["Yes", "No"] : method === "select" ? options : undefined,
    });
    log.debug("bridged prompt emitted", { id, method, optionCount: options.length });

    let externalDone: ((value: any) => void) | null = null;

    // Browser response — resolves through the same done() the TUI uses,
    // closing the TUI dialog if it is still open. The answer is validated
    // against what this prompt actually offered: a select answer must be one
    // of the options, a confirm must arrive as the confirmed boolean flag,
    // and an input must be a string. Anything else is ignored (logged) so a
    // crafted or stale browser message can never inject an unoffered choice
    // into an enforcement decision.
    const unsubscribe = pi.events?.on?.("pidash:ui-response", (data: unknown) => {
      const resp = data as any;
      if (!resp || resp.id !== id || !externalDone) return;
      log.debug("bridged prompt answered from browser", { id, method });
      if (resp.cancelled) {
        externalDone(undefined);
        return;
      }
      if (method === "confirm") {
        if (typeof resp.confirmed === "boolean") {
          externalDone(resp.confirmed ? "__confirmed__" : "__denied__");
        } else {
          log.warn("bridged confirm answer malformed — ignored", { id });
        }
        return;
      }
      if (typeof resp.value !== "string") {
        log.warn("bridged answer not a string — ignored", { id, method });
        return;
      }
      if (method === "select" && !options.includes(resp.value)) {
        log.warn("bridged select answer not an offered option — ignored", { id });
        return;
      }
      externalDone(resp.value);
    });

    // Report "blocked on user input" (OSC 7501) while the dialog is visible.
    const blocked = { kind: "question" as const, message: message ? `${title} — ${message}` : title };
    log.debug("bridged prompt opened with blocked status", { id, method, kind: blocked.kind });

    try {
      const result = (await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (v: any) => void) => {
        let resolved = false;

        const resolve = (value: any) => {
          if (resolved) return;
          resolved = true;
          externalDone = null;
          // Dismiss the browser dialog if the TUI answered
          pi.events?.emit?.("pidash:ui-dismiss", { type: "ui-dismiss", id });
          done(value);
        };

        // Route browser answers through resolve (first-answer-wins)
        externalDone = resolve;

        const getTermRows = () => tui.terminal?.rows ?? 24;
        const fullTitle = message ? `${title}\n${message}` : title;
        const minimizedBar = createMinimizedBar(theme, "prompt");
        const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
        const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
        let minimized = false;

        if (method === "input") {
          const input = new Input();
          input.onSubmit = (value: string) => { const t = value.trim(); if (t) resolve(t); };
          input.onEscape = () => resolve(undefined);
          const questionViewport = new QuestionViewport(fullTitle, getTermRows, theme, () => false, "accent");
          const label = new Text(
            theme.fg("dim", "Type your response · alt+p peek chat · enter submit · esc cancel"),
            1,
            0,
          );
          const container = new Container();
          let focused = false;
          const syncFocus = () => {
            input.focused = focused && !minimized;
          };
          const syncContainer = () => {
            container.clear();
            if (minimized) {
              container.addChild(minimizedBar);
              container.invalidate();
              return;
            }
            container.addChild(topBorder);
            container.addChild(questionViewport);
            container.addChild(input);
            container.addChild(label);
            container.addChild(bottomBorder);
            container.invalidate();
          };
          syncContainer();
          return {
            set focused(value: boolean) { focused = value; syncFocus(); },
            get focused(): boolean { return focused; },
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              if (resolved) return;
              if (matchesKey(data, Key.ctrl("c"))) {
                resolve(undefined);
                return;
              }
              if (matchesKey(data, Key.alt("p")) || (minimized && matchesKey(data, Key.tab))) {
                minimized = !minimized;
                log.debug("bridged prompt minimized toggled", { id, method, minimized });
                syncFocus();
                syncContainer();
                tui.requestRender();
                return;
              }
              if (minimized) {
                if (matchesKey(data, Key.escape)) resolve(undefined);
                return;
              }
              if (matchesKey(data, Key.escape)) {
                resolve(undefined);
                return;
              }
              if (matchesKey(data, Key.shift("up"))) {
                if (questionViewport.isOverflowed() && !questionViewport.isExpanded()) {
                  if (questionViewport.scrollBy(-1)) container.invalidate();
                  tui.requestRender();
                  return;
                }
              }
              if (matchesKey(data, Key.shift("down"))) {
                if (questionViewport.isOverflowed() && !questionViewport.isExpanded()) {
                  if (questionViewport.scrollBy(1)) container.invalidate();
                  tui.requestRender();
                  return;
                }
              }
              input.handleInput(data);
              container.invalidate();
              tui.requestRender();
            },
          };
        }

        // select / confirm — SelectList with bounded question viewport and on-demand fuzzy filter (ask_user parity).
        // confirm prompts carry their own Yes/No options; callers pass none.
        const tuiOptions = method === "confirm" ? ["Yes", "No"] : options;
        const allItems: SelectItem[] = tuiOptions.map((opt) => ({ value: opt, label: opt }));
        let currentItems: SelectItem[] = allItems;
        const alwaysShowFilter = tuiOptions.length >= FILTER_AUTO_SHOW_THRESHOLD;
        let filterVisible = alwaysShowFilter;
        let lastRenderWidth = 0;
        let currentSelectMaxVisible = 0;
        const selectTheme = {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        };
        const questionViewport = new QuestionViewport(fullTitle, getTermRows, theme, () => true, "accent");
        const searchInput = new Input();
        const help = new Text("", 1, 0);
        const updateHelp = () => {
          help.setText(
            theme.fg(
              "dim",
              filterVisible
                ? `tab peek chat · type to filter · ↑↓ · enter · esc ${alwaysShowFilter ? "cancel" : "close"}`
                : "tab peek chat · / filter · ↑↓ navigate · enter select · esc cancel",
            ),
          );
        };
        updateHelp();

        const getSelectMaxVisible = (itemCount: number, width = lastRenderWidth): number => {
          const termRows = getTermRows();
          if (width <= 0) return computeSelectMaxVisible(itemCount, termRows);
          const questionLines = questionViewport.render(width).length;
          const helpLines = help.render(width).length;
          const reservedRows = 2 + questionLines + (filterVisible ? 1 : 0) + helpLines;
          return computeSelectMaxVisible(itemCount, termRows, reservedRows);
        };

        const makeSelectList = (items: SelectItem[], maxVisible: number) => {
          currentSelectMaxVisible = maxVisible;
          const sl = new SelectList(items, Math.max(1, maxVisible), selectTheme);
          sl.onSelect = (item: SelectItem) => { if (item.value !== "__no_match__") resolve(item.value); };
          sl.onCancel = () => resolve(undefined);
          return sl;
        };
        let selectList = makeSelectList(currentItems, computeSelectMaxVisible(currentItems.length, getTermRows()));
        let lastQuery = "";
        searchInput.onSubmit = () => {
          const selected = selectList.getSelectedItem();
          if (selected && selected.value !== "__no_match__") resolve(selected.value);
        };
        searchInput.onEscape = () => resolve(undefined);

        const container = new Container();
        let focused = false;
        const syncFocus = () => {
          searchInput.focused = focused && !minimized && filterVisible;
        };
        const syncContainer = () => {
          container.clear();
          if (minimized) {
            container.addChild(minimizedBar);
            container.invalidate();
            return;
          }
          container.addChild(topBorder);
          container.addChild(questionViewport);
          if (filterVisible) container.addChild(searchInput);
          container.addChild(selectList);
          container.addChild(help);
          container.addChild(bottomBorder);
          container.invalidate();
        };
        syncContainer();
        return {
          set focused(value: boolean) { focused = value; syncFocus(); },
          get focused(): boolean { return focused; },
          render: (w: number) => {
            lastRenderWidth = w;
            if (!minimized) {
              const nextMaxVisible = getSelectMaxVisible(currentItems.length, w);
              if (nextMaxVisible !== currentSelectMaxVisible) {
                const prevSelected = selectList.getSelectedItem();
                selectList = makeSelectList(currentItems, nextMaxVisible);
                if (prevSelected) {
                  const idx = currentItems.findIndex((item) => item.value === prevSelected.value);
                  if (idx >= 0) selectList.setSelectedIndex(idx);
                }
                syncContainer();
              }
            }
            return container.render(w);
          },
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            if (resolved) return;
            if (matchesKey(data, Key.ctrl("c"))) {
              resolve(undefined);
              return;
            }
            if (matchesKey(data, Key.alt("p")) || matchesKey(data, Key.tab)) {
              minimized = !minimized;
              log.debug("bridged prompt minimized toggled", { id, method, minimized });
              syncFocus();
              syncContainer();
              tui.requestRender();
              return;
            }
            if (minimized) {
              if (matchesKey(data, Key.escape)) resolve(undefined);
              return;
            }
            if (matchesKey(data, Key.shift("up"))) {
              if (questionViewport.isOverflowed() && !questionViewport.isExpanded()) {
                if (questionViewport.scrollBy(-1)) container.invalidate();
                tui.requestRender();
              }
              return;
            }
            if (matchesKey(data, Key.shift("down"))) {
              if (questionViewport.isOverflowed() && !questionViewport.isExpanded()) {
                if (questionViewport.scrollBy(1)) container.invalidate();
                tui.requestRender();
              }
              return;
            }
            if (matchesKey(data, Key.ctrl("e")) && questionViewport.toggleExpanded()) {
              container.invalidate();
              tui.requestRender();
              return;
            }
            if (
              matchesKey(data, Key.pageUp) &&
              questionViewport.isOverflowed() &&
              !questionViewport.isExpanded()
            ) {
              if (questionViewport.scrollPage(-1)) container.invalidate();
              tui.requestRender();
              return;
            }
            if (
              matchesKey(data, Key.pageDown) &&
              questionViewport.isOverflowed() &&
              !questionViewport.isExpanded()
            ) {
              if (questionViewport.scrollPage(1)) container.invalidate();
              tui.requestRender();
              return;
            }
            if (matchesKey(data, Key.escape)) {
              if (filterVisible && !alwaysShowFilter) {
                filterVisible = false;
                const hadQuery = searchInput.getValue().length > 0;
                searchInput.setValue("");
                lastQuery = "";
                if (hadQuery) {
                  currentItems = allItems;
                  selectList = makeSelectList(currentItems, getSelectMaxVisible(currentItems.length));
                }
                updateHelp();
                syncFocus();
                syncContainer();
                tui.requestRender();
                return;
              }
              resolve(undefined);
              return;
            }

            const isNavKey =
              matchesKey(data, Key.up) ||
              matchesKey(data, Key.down) ||
              matchesKey(data, Key.enter) ||
              matchesKey(data, Key.return) ||
              matchesKey(data, Key.pageUp) ||
              matchesKey(data, Key.pageDown);

            if (!filterVisible) {
              if (matchesKey(data, Key.slash)) {
                filterVisible = true;
                updateHelp();
                syncFocus();
                syncContainer();
                tui.requestRender();
                return;
              }
              if (isNavKey) {
                selectList.handleInput(data);
                container.invalidate();
                tui.requestRender();
              }
              return;
            }

            if (isNavKey) {
              selectList.handleInput(data);
              container.invalidate();
            } else {
              searchInput.handleInput(data);
              const query = searchInput.getValue();
              if (query !== lastQuery) {
                lastQuery = query;
                if (query) {
                  const filtered = fuzzyFilter(allItems, query, (item) => item.label);
                  currentItems =
                    filtered.length > 0
                      ? filtered
                      : [{ value: "__no_match__", label: "No matches", description: "clear search to see all" }];
                } else {
                  currentItems = allItems;
                }
                selectList = makeSelectList(currentItems, getSelectMaxVisible(currentItems.length));
                syncContainer();
              } else {
                container.invalidate();
              }
            }
            tui.requestRender();
          },
        };
      }, { blocked })) as T | undefined;
      return result;
    } finally {
      unsubscribe?.();
    }
  }

  return {
    select: (ctx, title, options) => bridged<string>(ctx, "select", title, options),
    confirm: (ctx, title, message) => bridged<string>(ctx, "confirm", title, ["Yes", "No"], message).then(
      (v) => v === "__confirmed__" || v === "Yes",
    ),
    input: (ctx, title) => bridged<string>(ctx, "input", title),
  };
}
