/**
 * ask_user tool — presents questions to the user with selectable options.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Editor,
  type EditorTheme,
  Input,
  Key,
  type SelectItem,
  SelectList,
  Text,
  fuzzyFilter,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createLogger } from "../shared/logger.js";
import {
  FILTER_AUTO_SHOW_THRESHOLD,
  QuestionViewport,
  computeBoxHeightBudget,
  computeQuestionViewportCap,
  computeSelectMaxVisible,
  createMinimizedBar,
} from "../shared/ui-bridge.js";

export {
  computeBoxHeightBudget,
  computeQuestionViewportCap,
  computeSelectMaxVisible,
};

const log = createLogger("ask-user");

const FREE_INPUT_VALUE = "__free_input__";

class OptionPreview implements Component {
  private selectedItem: SelectItem | null = null;
  private cachedWidth = -1;
  private cachedLabel: string | undefined;
  private cachedLines: string[] | undefined;

  constructor(private readonly theme: Theme) {}

  setSelectedItem(item: SelectItem | null): void {
    if (
      item?.value === this.selectedItem?.value &&
      item?.label === this.selectedItem?.label
    ) {
      return;
    }
    this.selectedItem = item;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedLabel = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    const item = this.selectedItem;
    const label = item?.label;
    if (
      this.cachedLines !== undefined &&
      this.cachedWidth === width &&
      this.cachedLabel === label
    ) {
      return this.cachedLines;
    }

    if (
      !item ||
      item.value === "__no_match__" ||
      item.value === FREE_INPUT_VALUE
    ) {
      this.cachedWidth = width;
      this.cachedLabel = label;
      this.cachedLines = [];
      return this.cachedLines;
    }

    // SelectList renders a 2-col prefix ("→ ") and reserves 2 cols on the right.
    const availableSingleLine = Math.max(1, width - 4);
    const overflows = /[\r\n]/.test(item.label) || visibleWidth(item.label) > availableSingleLine;
    if (!overflows) {
      this.cachedWidth = width;
      this.cachedLabel = label;
      this.cachedLines = [];
      return this.cachedLines;
    }

    const pad = Math.min(1, Math.max(0, Math.floor((width - 1) / 2)));
    const contentWidth = Math.max(1, width - pad * 2);
    const prefix = "↳ ";
    const prefixWidth = visibleWidth(prefix);
    const wrapWidth = Math.max(1, contentWidth - prefixWidth);
    const wrapped = wrapTextWithAnsi(item.label.replace(/\t/g, "   "), wrapWidth);
    const leftPad = " ".repeat(pad);
    const contPad = " ".repeat(pad + prefixWidth);
    const lines = wrapped.map((line, i) =>
      i === 0
        ? leftPad + this.theme.fg("accent", prefix) + this.theme.fg("muted", line)
        : contPad + this.theme.fg("muted", line),
    );

    this.cachedWidth = width;
    this.cachedLabel = label;
    this.cachedLines = lines;
    return lines;
  }
}

export function buildAskOptions(options: string[] | undefined): SelectItem[] {
  // Free-input-only mode: no list, no Other row.
  if (!options || options.length === 0) return [];
  return [
    ...options.map((opt) => ({ value: opt, label: opt })),
    {
      value: FREE_INPUT_VALUE,
      label: "✎  Other (type custom answer)",
      description: "free-text",
    },
  ];
}

/**
 * Browser/discord renders options as labels, so they travel as the raw strings. The
 * free-input row is a TUI control, not an answer — it is never offered remotely.
 */
export function browserAskOptions(items: SelectItem[]): string[] {
  return items.filter((item) => item.value !== FREE_INPUT_VALUE).map((item) => item.value);
}

export function registerAskUser(
  pi: ExtensionAPI,
  terminalNotify: (title: string, body: string) => void,
): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user a question with selectable options or free-text input. Never ask via plain text.",
    executionMode: "sequential",
    promptSnippet: "Ask the user a question with selectable options",
    promptGuidelines: [
      "Use ask_user for approvals, selections, or confirmations — never ask via plain text.",
      "Include clear options and a 'no'/'cancel' choice when appropriate.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description: "Question to display",
      }),
      options: Type.Optional(
        Type.Array(Type.String(), {
          description: "Selectable options (omitted = free-text input only)",
        }),
      ),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        // A headless session (a spawned coms peer, a print/rpc run) has no human attached. A bare
        // "no UI" left it guessing — so name the route that does exist: its manager, over coms.
        log.info("ask_user_unattended", { reason: "no_ui" });
        return {
          content: [
            {
              type: "text",
              text:
                "No UI is attached to this session, so no human can answer here. " +
                "You are running unattended: send the question to your manager over coms " +
                "(coms_send if coms is active) and continue with what does not depend on the answer, " +
                "or stop and report the blocker. Never invent an approval.",
            },
          ],
          details: undefined,
          isError: true,
        };
      }

      terminalNotify("pi", "Action required");

      const assembled = buildAskOptions(params.options);

      // Emit ask request for pidash browser clients
      const askId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      pi.events.emit("pidash:ui-request", {
        id: askId,
        type: "extension_ui_request",
        method: assembled.length ? "select" : "input",
        title: params.question,
        options: assembled.length ? browserAskOptions(assembled) : undefined,
        // This prompt accepts ANY answer (the response value is taken verbatim), so a chat
        // surface may offer a free-text control. Bridged prompts must not — see chat-prompts.
        freeText: true,
      });

      // Track if resolved (from TUI or browser)
      let externalDone: ((value: string | null) => void) | null = null;

      // Listen for browser response
      const unsubscribe = pi.events.on("pidash:ui-response", (data: unknown) => {
        const resp = data as any;
        if (resp.id === askId && externalDone) {
          if (resp.cancelled) externalDone(null);
          else if (resp.value) externalDone(resp.value);
          else if (resp.confirmed !== undefined) externalDone(resp.confirmed ? "Yes" : "No");
        }
      });

      log.debug("ask_user prompt opened with blocked status", { askId, mode: assembled.length ? "select" : "input" });
      const result = await ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
          // Allow browser to resolve this dialog
          externalDone = done;

          let mode: "select" | "input" = assembled.length ? "select" : "input";
          let minimized = false;
          let lastRenderWidth = 0;
          let resolved = false;

          const resolve = (value: string | null) => {
            if (resolved) return;
            resolved = true;
            externalDone = null;
            // Dismiss browser dialog if TUI answered
            pi.events.emit("pidash:ui-dismiss", { type: "ui-dismiss", id: askId });
            done(value);
          };

          // Override externalDone to use resolve (prevents double-resolve)
          externalDone = resolve;

          const getTermRows = () => tui.terminal?.rows ?? 24;
          const alwaysShowFilter = (params.options?.length ?? 0) >= FILTER_AUTO_SHOW_THRESHOLD;
          let filterVisible = alwaysShowFilter;

          const selectTheme = {
            selectedPrefix: (t: string) => theme.fg("accent", t),
            selectedText: (t: string) => theme.fg("accent", t),
            description: (t: string) => theme.fg("muted", t),
            scrollInfo: (t: string) => theme.fg("dim", t),
            noMatch: (t: string) => theme.fg("warning", t),
          };

          const editorTheme: EditorTheme = {
            borderColor: (s: string) => theme.fg("dim", s),
            selectList: selectTheme,
          };

          // Multi-line wrapping editor for free-text responses (guard minimal test mocks without terminal)
          const editorTui = tui?.terminal
            ? tui
            : ({ ...tui, terminal: { rows: 24, columns: 80 } } as typeof tui);
          const editor = new Editor(editorTui, editorTheme, { paddingX: 1 });
          editor.onSubmit = (value: string) => {
            const text = value.trim();
            if (text) resolve(text);
          };

          const questionViewport = new QuestionViewport(
            params.question,
            getTermRows,
            theme,
            () => mode === "select",
          );
          const optionPreview = new OptionPreview(theme);

          const inputLabel = new Text(
            theme.fg(
              "dim",
              assembled.length > 0
                ? "Type your response · alt+p peek chat · enter submit · shift+enter newline · esc back"
                : "Type your response · alt+p peek chat · enter submit · shift+enter newline · esc cancel",
            ),
            1,
            0,
          );

          const minimizedBar = createMinimizedBar(theme, "ask_user");

          // SelectList (only if options provided)
          let selectList: SelectList | null = null;
          let allItems: SelectItem[] = [];
          let currentItems: SelectItem[] = [];
          let currentSelectMaxVisible = 0;
          let lastQuery = "";

          // Search input for fuzzy filtering the select list
          const searchInput = new Input();
          const selectHelp = new Text("", 1, 0);
          const updateSelectHelp = () => {
            selectHelp.setText(
              theme.fg(
                "dim",
                filterVisible
                  ? `tab peek chat · type to filter · ↑↓ · enter · esc ${alwaysShowFilter ? "cancel" : "close"}`
                  : "tab peek chat · / filter · ↑↓ navigate · enter select · esc cancel",
              ),
            );
          };
          updateSelectHelp();

          const topBorder = new DynamicBorder((s: string) =>
            theme.fg("accent", s),
          );
          const bottomBorder = new DynamicBorder((s: string) =>
            theme.fg("accent", s),
          );

          const container = new Container();
          let _focused = false;

          const syncFocus = () => {
            editor.focused = _focused && !minimized && mode === "input";
            searchInput.focused = _focused && !minimized && mode === "select" && filterVisible;
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
            if (mode === "select" && selectList) {
              if (filterVisible) container.addChild(searchInput);
              container.addChild(selectList);
              container.addChild(optionPreview);
              container.addChild(selectHelp);
            } else {
              container.addChild(editor);
              container.addChild(inputLabel);
            }
            container.addChild(bottomBorder);
            container.invalidate();
          };

          const toggleMinimized = () => {
            minimized = !minimized;
            log.debug("ask_user_minimized_toggled", { askId, minimized, mode });
            syncFocus();
            syncContainer();
            tui.requestRender();
          };

          const getSelectMaxVisible = (itemCount: number, width = lastRenderWidth): number => {
            const termRows = getTermRows();
            if (width <= 0) return computeSelectMaxVisible(itemCount, termRows);
            const questionLines = questionViewport.render(width).length;
            const helpLines = selectHelp.render(width).length;
            const reservedRows = 2 + questionLines + (filterVisible ? 1 : 0) + helpLines;
            return computeSelectMaxVisible(itemCount, termRows, reservedRows);
          };

          const enterInputMode = () => {
            mode = "input";
            searchInput.setValue("");
            if (lastQuery) {
              lastQuery = "";
              currentItems = allItems;
              selectList = makeSelectList(currentItems, getSelectMaxVisible(currentItems.length));
              optionPreview.setSelectedItem(selectList.getSelectedItem());
            }
            if (!alwaysShowFilter && filterVisible) {
              filterVisible = false;
              updateSelectHelp();
            }
            syncFocus();
            syncContainer();
            tui.requestRender();
          };

          const handleSelectItem = (item: SelectItem) => {
            if (item.value === "__no_match__") {
              // Ignore — not a real option
            } else if (item.value === FREE_INPUT_VALUE) {
              enterInputMode();
            } else {
              resolve(item.value);
            }
          };

          const makeSelectList = (items: SelectItem[], maxVisible: number) => {
            currentSelectMaxVisible = maxVisible;
            const sl = new SelectList(items, Math.max(1, maxVisible), selectTheme);
            sl.onSelect = handleSelectItem;
            sl.onCancel = () => resolve(null);
            sl.onSelectionChange = (item: SelectItem) => {
              optionPreview.setSelectedItem(item);
            };
            return sl;
          };

          if (assembled.length > 0) {
            allItems = assembled;
            currentItems = assembled;
            selectList = makeSelectList(
              currentItems,
              computeSelectMaxVisible(currentItems.length, getTermRows()),
            );
            optionPreview.setSelectedItem(selectList.getSelectedItem());
          }

          searchInput.onSubmit = () => {
            const selected = selectList?.getSelectedItem();
            if (selected) handleSelectItem(selected);
          };
          searchInput.onEscape = () => resolve(null);

          syncContainer();

          return {
            // Focusable interface — propagate to active input for IME cursor positioning
            set focused(value: boolean) {
              _focused = value;
              syncFocus();
            },
            get focused(): boolean {
              return _focused;
            },

            render: (w: number) => {
              lastRenderWidth = w;
              if (!minimized && mode === "select" && selectList) {
                const nextMaxVisible = getSelectMaxVisible(currentItems.length, w);
                if (nextMaxVisible !== currentSelectMaxVisible) {
                  const prevSelected = selectList.getSelectedItem();
                  selectList = makeSelectList(currentItems, nextMaxVisible);
                  if (prevSelected) {
                    const idx = currentItems.findIndex((item) => item.value === prevSelected.value);
                    if (idx >= 0) selectList.setSelectedIndex(idx);
                  }
                  optionPreview.setSelectedItem(selectList.getSelectedItem());
                  syncContainer();
                }
              }
              return container.render(w);
            },
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              if (resolved) return;

              // Ctrl+C always cancels immediately regardless of mode or minimized state.
              if (matchesKey(data, Key.ctrl("c"))) {
                resolve(null);
                return;
              }

              // Peek / minimize toggle: Tab in select mode or while minimized; Alt+P in all modes.
              const isPeekToggle =
                matchesKey(data, Key.alt("p")) ||
                ((minimized || mode === "select") && matchesKey(data, Key.tab));
              if (isPeekToggle) {
                toggleMinimized();
                return;
              }
              if (minimized) {
                if (matchesKey(data, Key.escape)) {
                  resolve(null);
                }
                return;
              }

              // Question viewport scroll (Shift+↑/↓ in all modes; Ctrl+E & PgUp/PgDn in select mode so Editor keeps them in input mode)
              if (matchesKey(data, Key.shift("up"))) {
                if (questionViewport.isOverflowed() && !questionViewport.isExpanded()) {
                  if (questionViewport.scrollBy(-1)) container.invalidate();
                  tui.requestRender();
                  return;
                }
                if (mode === "select") return;
              }
              if (matchesKey(data, Key.shift("down"))) {
                if (questionViewport.isOverflowed() && !questionViewport.isExpanded()) {
                  if (questionViewport.scrollBy(1)) container.invalidate();
                  tui.requestRender();
                  return;
                }
                if (mode === "select") return;
              }
              if (mode === "select") {
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
              }

              if (mode === "select" && selectList) {
                // Direct Esc handling (covers both legacy "\x1b" and Kitty "\x1b[27u") — never rely on SelectList.onCancel
                if (matchesKey(data, Key.escape)) {
                  if (filterVisible && !alwaysShowFilter) {
                    filterVisible = false;
                    const hadQuery = searchInput.getValue().length > 0;
                    searchInput.setValue("");
                    lastQuery = "";
                    if (hadQuery) {
                      currentItems = allItems;
                      selectList = makeSelectList(
                        currentItems,
                        getSelectMaxVisible(currentItems.length),
                      );
                      optionPreview.setSelectedItem(selectList.getSelectedItem());
                    }
                    updateSelectHelp();
                    syncFocus();
                    syncContainer();
                    tui.requestRender();
                    return;
                  }
                  resolve(null);
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
                    updateSelectHelp();
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

                // Filter is visible
                if (isNavKey) {
                  selectList.handleInput(data);
                  container.invalidate();
                } else {
                  searchInput.handleInput(data);
                  const query = searchInput.getValue();
                  if (query !== lastQuery) {
                    lastQuery = query;
                    if (query) {
                      const filtered = fuzzyFilter(
                        allItems,
                        query,
                        (item) => `${item.label} ${item.description || ""}`,
                      );
                      currentItems =
                        filtered.length > 0
                          ? filtered
                          : [{ value: "__no_match__", label: "No matches", description: "clear search to see all" }];
                    } else {
                      currentItems = allItems;
                    }
                    selectList = makeSelectList(
                      currentItems,
                      getSelectMaxVisible(currentItems.length),
                    );
                    optionPreview.setSelectedItem(selectList.getSelectedItem());
                    syncContainer();
                  } else {
                    container.invalidate();
                  }
                }
              } else {
                // Free-text Editor mode
                if (matchesKey(data, Key.escape)) {
                  if (selectList) {
                    editor.setText("");
                    mode = "select";
                    syncFocus();
                    syncContainer();
                    tui.requestRender();
                  } else {
                    resolve(null);
                  }
                  return;
                }
                editor.handleInput(data);
                container.invalidate();
              }
              tui.requestRender();
            },
          };
        },
        { blocked: { kind: "question", message: params.question } },
      );

      unsubscribe();

      if (result === null) {
        return {
          content: [
            {
              type: "text",
              text:
                "User cancelled (Esc pressed) — STOP immediately and wait for the user's next message. " +
                "Do NOT assume any option was selected.",
            },
          ],
          details: undefined,
          isError: true,
          terminate: true,
        };
      }
      return { content: [{ type: "text", text: result }], details: undefined };
    },

    renderCall(args, theme) {
      let t =
        theme.fg("toolTitle", theme.bold("ask_user ")) +
        theme.fg("accent", args.question || "...");
      if ((args.options?.length ?? 0) > 0) {
        t += `\n  ${theme.fg("dim", args.options!.join(" • "))}`;
      }
      return new Text(t, 0, 0);
    },

    renderResult(result, _options, theme) {
      const text = result.content[0];
      const value = text?.type === "text" ? text.text : "(no response)";
      const icon =
        value.startsWith("User cancelled")
          ? theme.fg("warning", "✗")
          : theme.fg("success", "✓");
      return new Text(`${icon} ${theme.fg("toolOutput", value)}`, 0, 0);
    },
  });
}
