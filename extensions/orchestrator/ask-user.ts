/**
 * ask_user tool — presents questions to the user with selectable options.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
  fuzzyFilter,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function registerAskUser(
  pi: ExtensionAPI,
  terminalNotify: (title: string, body: string) => void,
): void {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Present a question to the user with selectable options. Returns the user's choice or free-text input. Use this whenever a workflow needs user input — never ask via plain text.",
    promptSnippet: "Ask the user a question with selectable options",
    promptGuidelines: [
      "Use ask_user when you need user input during a workflow (approvals, selections, confirmations).",
      "Do NOT ask users questions via plain text — always use this tool for structured choices.",
      "Provide clear, concise options. Include a 'no' or 'cancel' option when appropriate.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description: "The question to display to the user",
      }),
      options: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "List of selectable options. If omitted, only free-text input is shown.",
        }),
      ),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [
            { type: "text", text: "No UI available for user interaction" },
          ],
          isError: true,
        };
      }

      terminalNotify("pi", "Action required");

      // Emit ask request for pidash browser clients
      const askId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      pi.events.emit("pidash:ui-request", {
        id: askId,
        type: "extension_ui_request",
        method: params.options?.length ? "select" : "input",
        title: params.question,
        options: params.options,
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

      const result = await ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
          // Allow browser to resolve this dialog
          externalDone = done;

          let mode: "select" | "input" = params.options?.length
            ? "select"
            : "input";
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

          // Free-text input with built-in callbacks
          const input = new Input();
          input.onSubmit = (value: string) => {
            const text = value.trim();
            if (text) resolve(text);
          };
          input.onEscape = () => {
            if (selectList) {
              mode = "select";
              tui.requestRender();
            } else {
              resolve(null);
            }
          };

          const inputLabel = new Text(
            theme.fg("dim", "Type your response • enter submit • esc back"),
            1,
            0,
          );

          // SelectList (only if options provided)
          let selectList: SelectList | null = null;
          let allItems: SelectItem[] = [];
          const selectTheme = {
            selectedPrefix: (t: string) => theme.fg("accent", t),
            selectedText: (t: string) => theme.fg("accent", t),
            description: (t: string) => theme.fg("muted", t),
            scrollInfo: (t: string) => theme.fg("dim", t),
            noMatch: (t: string) => theme.fg("warning", t),
          };

          const makeSelectList = (items: SelectItem[]) => {
            const sl = new SelectList(items, Math.min(items.length + 1, 15), selectTheme);
            sl.onSelect = (item: SelectItem) => {
              if (item.value === "__no_match__") {
                // Ignore — not a real option
              } else if (item.value === "__free_input__") {
                mode = "input";
                searchInput.setValue("");
                tui.requestRender();
              } else {
                resolve(item.value);
              }
            };
            sl.onCancel = () => resolve(null);
            return sl;
          };

          if (params.options && params.options.length > 0) {
            allItems = [
              ...params.options.map((opt: string) => ({
                value: opt,
                label: opt,
              })),
              {
                value: "__free_input__",
                label: "✎  Other (type custom answer)",
                description: "free-text",
              },
            ];
            selectList = makeSelectList(allItems);
          }

          // Search input for fuzzy filtering the select list
          const searchInput = new Input();
          searchInput.onSubmit = () => {
            if (selectList) {
              const selected = selectList.getSelectedItem();
              if (selected) {
                if (selected.value === "__no_match__") {
                  // Ignore
                } else if (selected.value === "__free_input__") {
                  mode = "input";
                  searchInput.setValue("");
                } else {
                  resolve(selected.value);
                }
              }
            }
          };
          searchInput.onEscape = () => resolve(null);

          const selectHelp = new Text(
            theme.fg("dim", "type to filter • ↑↓ navigate • enter select • esc cancel"),
            1,
            0,
          );
          const topBorder = new DynamicBorder((s: string) =>
            theme.fg("accent", s),
          );
          const bottomBorder = new DynamicBorder((s: string) =>
            theme.fg("accent", s),
          );

          // Build container — question is already in the main chat,
          // overlay shows only the selectable options / input
          const buildContainer = () => {
            const c = new Container();
            c.addChild(topBorder);
            if (mode === "select" && selectList) {
              c.addChild(searchInput);
              c.addChild(selectList);
              c.addChild(selectHelp);
            } else {
              c.addChild(input);
              c.addChild(inputLabel);
            }
            c.addChild(bottomBorder);
            return c;
          };

          let container = buildContainer();

          let _focused = false;

          return {
            // Focusable interface — propagate to active Input for IME cursor positioning
            set focused(value: boolean) {
              _focused = value;
              input.focused = value;
              searchInput.focused = value;
            },
            get focused(): boolean {
              return _focused;
            },

            render: (w: number) => {
              container = buildContainer();
              return container.render(w);
            },
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              if (resolved) return;
              if (mode === "select" && selectList) {
                // Arrow keys and enter/escape go to selectList
                // Printable chars go to searchInput for filtering
                const isNavKey = data === "\x1b[A" || data === "\x1b[B" // up/down
                  || data === "\r" || data === "\n" // enter
                  || data === "\x1b" // escape
                  || data === "\x1b[5~" || data === "\x1b[6~"; // page up/down
                if (isNavKey) {
                  selectList.handleInput(data);
                } else {
                  searchInput.handleInput(data);
                  const query = searchInput.getValue();
                  if (query) {
                    const filtered = fuzzyFilter(allItems, query, (item) => `${item.label} ${item.description || ""}`);
                    selectList = makeSelectList(filtered.length > 0 ? filtered : [{ value: "__no_match__", label: "No matches", description: "clear search to see all" }]);
                  } else {
                    selectList = makeSelectList(allItems);
                  }
                }
              } else {
                input.handleInput(data);
              }
              tui.requestRender();
            },
          };
        },

      );

      unsubscribe();

      if (result === null) {
        return { content: [{ type: "text", text: "User cancelled" }], terminate: true };
      }
      return { content: [{ type: "text", text: result }] };
    },

    renderCall(args, theme) {
      let t =
        theme.fg("toolTitle", theme.bold("ask_user ")) +
        theme.fg("accent", args.question || "...");
      if (args.options?.length > 0) {
        t += `\n  ${theme.fg("dim", args.options.join(" • "))}`;
      }
      return new Text(t, 0, 0);
    },

    renderResult(result, _options, theme) {
      const text = result.content[0];
      const value = text?.type === "text" ? text.text : "(no response)";
      const icon =
        value === "User cancelled"
          ? theme.fg("warning", "✗")
          : theme.fg("success", "✓");
      return new Text(`${icon} ${theme.fg("toolOutput", value)}`, 0, 0);
    },
  });
}
