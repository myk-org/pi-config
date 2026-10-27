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
import { Container, Input, SelectList, Text, type SelectItem, fuzzyFilter } from "@earendil-works/pi-tui";
import { createLogger } from "./logger.js";

const log = createLogger("ui-bridge");

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
      if (method === "confirm") return (await ctx.ui.confirm(title, message)) as T | undefined;
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

        if (method === "input") {
          const input = new Input();
          input.onSubmit = (value: string) => { const t = value.trim(); if (t) resolve(t); };
          input.onEscape = () => resolve(undefined);
          const header = new Text(theme.fg("accent", title) + (message ? theme.fg("muted", `\n${message}`) : ""), 1, 0);
          const label = new Text(theme.fg("dim", "Type your response • enter submit • esc cancel"), 1, 0);
          const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
          const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
          const container = new Container();
          container.addChild(topBorder);
          container.addChild(header);
          container.addChild(input);
          container.addChild(label);
          container.addChild(bottomBorder);
          let focused = false;
          return {
            set focused(value: boolean) { focused = value; input.focused = value; },
            get focused(): boolean { return focused; },
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => { if (resolved) return; input.handleInput(data); tui.requestRender(); },
          };
        }

        // select / confirm — SelectList with fuzzy filtering (ask_user parity).
        // confirm prompts carry their own Yes/No options; callers pass none.
        const tuiOptions = method === "confirm" ? ["Yes", "No"] : options;
        const allItems: SelectItem[] = tuiOptions.map((opt) => ({ value: opt, label: opt }));
        const selectTheme = {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        };
        const searchInput = new Input();
        let selectList = new SelectList(allItems, Math.min(allItems.length + 1, 15), selectTheme);
        const makeSelectList = (items: SelectItem[]) => {
          const sl = new SelectList(items, Math.min(items.length + 1, 15), selectTheme);
          sl.onSelect = (item: SelectItem) => { if (item.value !== "__no_match__") resolve(item.value); };
          sl.onCancel = () => resolve(undefined);
          return sl;
        };
        selectList = makeSelectList(allItems);
        searchInput.onSubmit = () => {
          const selected = selectList.getSelectedItem();
          if (selected && selected.value !== "__no_match__") resolve(selected.value);
        };
        searchInput.onEscape = () => resolve(undefined);
        const help = new Text(theme.fg("dim", "type to filter • ↑↓ navigate • enter select • esc cancel"), 1, 0);
        const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
        const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
        // Rebuilt on every render — selectList is replaced when filtering (ask_user pattern)
        const buildContainer = () => {
          const c = new Container();
          c.addChild(topBorder);
          c.addChild(new Text(theme.fg("accent", title) + (message ? theme.fg("muted", `\n${message}`) : ""), 1, 0));
          c.addChild(searchInput);
          c.addChild(selectList);
          c.addChild(help);
          c.addChild(bottomBorder);
          return c;
        };
        let container = buildContainer();
        let focused = false;
        return {
          set focused(value: boolean) { focused = value; searchInput.focused = value; },
          get focused(): boolean { return focused; },
          render: (w: number) => { container = buildContainer(); return container.render(w); },
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            if (resolved) return;
            const isNavKey = data === "\x1b[A" || data === "\x1b[B" || data === "\r" || data === "\n"
              || data === "\x1b" || data === "\x1b[5~" || data === "\x1b[6~";
            if (isNavKey) {
              selectList.handleInput(data);
            } else {
              searchInput.handleInput(data);
              const query = searchInput.getValue();
              if (query) {
                const filtered = fuzzyFilter(allItems, query, (item) => item.label);
                selectList = makeSelectList(filtered.length > 0 ? filtered : [{ value: "__no_match__", label: "No matches", description: "clear search to see all" }]);
              } else {
                selectList = makeSelectList(allItems);
              }
            }
            tui.requestRender();
          },
        };
      })) as T | undefined;
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
