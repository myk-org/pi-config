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
import { createLogger } from "../shared/logger.js";

const log = createLogger("ask-user");

/** Sentinel value returned when the user asks to discuss in plain chat first. */
export const DISCUSS_VALUE = "__discuss__";
export const DISCUSS_LABEL = "💬 Discuss with AI first";
const FREE_INPUT_VALUE = "__free_input__";

/** Emoji/punctuation-free, lowercased form so a caller's plain label still matches. */
const normalizeOption = (s: string): string =>
  s.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();

/** A caller option that already is the discuss row: its plain label or the bare sentinel. */
const isDiscussRow = (option: string): boolean =>
  option.trim().toLowerCase() === DISCUSS_VALUE ||
  normalizeOption(option) === normalizeOption(DISCUSS_LABEL);

export function buildAskOptions(
  options: string[] | undefined,
  allowDiscuss: boolean,
): SelectItem[] {
  // Free-input-only mode: no list, no discuss item.
  if (!options || options.length === 0) return [];

  let callerSuppliedDiscuss = false;
  const items: SelectItem[] = [];
  for (const opt of options) {
    if (!isDiscussRow(opt)) {
      items.push({ value: opt, label: opt });
      continue;
    }
    // Opted out: a caller's discuss row must disappear, not merely go unappended.
    if (!allowDiscuss) continue;
    // Caller's label stays for display; the sentinel makes selecting it pause.
    callerSuppliedDiscuss = true;
    items.push({ value: DISCUSS_VALUE, label: opt, description: "chat first" });
  }
  if (!allowDiscuss) {
    log.debug("ask_user discuss option suppressed", { optionCount: options.length });
  } else if (callerSuppliedDiscuss) {
    log.debug("ask_user discuss option deduped", { optionCount: options.length });
  } else {
    items.push({ value: DISCUSS_VALUE, label: DISCUSS_LABEL, description: "chat first" });
    log.debug("ask_user discuss option offered", { optionCount: options.length });
  }
  items.push({
    value: FREE_INPUT_VALUE,
    label: "✎  Other (type custom answer)",
    description: "free-text",
  });
  return items;
}

/**
 * Browser/discord renders options as buttons labelled with the raw string, so the
 * discuss row travels as its label and comes back mapped to the sentinel. The
 * free-input row is a TUI control, not an answer — it is never offered remotely.
 */
export function browserAskOptions(items: SelectItem[]): string[] {
  return items
    .filter((item) => item.value !== FREE_INPUT_VALUE)
    .map((item) => (item.value === DISCUSS_VALUE ? DISCUSS_LABEL : item.value));
}

export function answerToValue(answer: string): string {
  return answer === DISCUSS_LABEL ? DISCUSS_VALUE : answer;
}

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
      `If ask_user returns exactly "${DISCUSS_VALUE}", the user has NOT answered — they want to talk about this decision first. Open by addressing the decision itself: the trade-offs, the information you are missing, or the alternatives. Never answer with a status report about what you built or verified. Re-call ask_user with the SAME question and options only once the discussion resolves.`,
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
      allowDiscuss: Type.Optional(
        Type.Boolean({
          description:
            "Offer a 'Discuss with AI first' option that returns the __discuss__ sentinel without answering (default true).",
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

      const assembled = buildAskOptions(params.options, params.allowDiscuss !== false);

      // Emit ask request for pidash browser clients
      const askId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      pi.events.emit("pidash:ui-request", {
        id: askId,
        type: "extension_ui_request",
        method: assembled.length ? "select" : "input",
        title: params.question,
        options: assembled.length ? browserAskOptions(assembled) : undefined,
      });

      // Track if resolved (from TUI or browser)
      let externalDone: ((value: string | null) => void) | null = null;

      // Listen for browser response
      const unsubscribe = pi.events.on("pidash:ui-response", (data: unknown) => {
        const resp = data as any;
        if (resp.id === askId && externalDone) {
          if (resp.cancelled) externalDone(null);
          else if (resp.value) {
            const value = answerToValue(resp.value);
            log.debug("ask_user browser answer received", { askId, isDiscuss: value === DISCUSS_VALUE });
            externalDone(value);
          } else if (resp.confirmed !== undefined) externalDone(resp.confirmed ? "Yes" : "No");
        }
      });

      log.debug("ask_user prompt opened with blocked status", { askId, mode: assembled.length ? "select" : "input" });
      const result = await ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
          // Allow browser to resolve this dialog
          externalDone = done;

          let mode: "select" | "input" = assembled.length ? "select" : "input";
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
              } else if (item.value === FREE_INPUT_VALUE) {
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

          if (assembled.length > 0) {
            allItems = assembled;
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
                } else if (selected.value === FREE_INPUT_VALUE) {
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
        { blocked: { kind: "question", message: params.question } },
      );

      unsubscribe();

      if (result === null) {
        return { content: [{ type: "text", text: "User cancelled" }], details: undefined, terminate: true };
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
      if (value === DISCUSS_VALUE) {
        return new Text(theme.fg("dim", "💬 Discussion requested"), 0, 0);
      }
      const icon =
        value === "User cancelled"
          ? theme.fg("warning", "✗")
          : theme.fg("success", "✓");
      return new Text(`${icon} ${theme.fg("toolOutput", value)}`, 0, 0);
    },
  });
}
