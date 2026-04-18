/**
 * ask_user tool — presents questions to the user with selectable options.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  Container,
  Input,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@mariozechner/pi-tui";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

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
      const result = await ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
          let mode: "select" | "input" = params.options?.length
            ? "select"
            : "input";
          let resolved = false;

          const resolve = (value: string | null) => {
            if (resolved) return;
            resolved = true;
            done(value);
          };

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
          if (params.options && params.options.length > 0) {
            const items: SelectItem[] = [
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
            selectList = new SelectList(items, Math.min(items.length + 1, 15), {
              selectedPrefix: (t: string) => theme.fg("accent", t),
              selectedText: (t: string) => theme.fg("accent", t),
              description: (t: string) => theme.fg("muted", t),
              scrollInfo: (t: string) => theme.fg("dim", t),
              noMatch: (t: string) => theme.fg("warning", t),
            });
            selectList.onSelect = (item: SelectItem) => {
              if (item.value === "__free_input__") {
                mode = "input";
                tui.requestRender();
              } else {
                resolve(item.value);
              }
            };
            selectList.onCancel = () => resolve(null);
          }

          const selectHelp = new Text(
            theme.fg("dim", "↑↓ navigate • enter select • esc cancel"),
            1,
            0,
          );
          const topBorder = new DynamicBorder((s: string) =>
            theme.fg("accent", s),
          );
          const question = new Text(
            theme.fg("accent", theme.bold(params.question)),
            1,
            0,
          );
          const spacer = new Spacer(1);
          const bottomBorder = new DynamicBorder((s: string) =>
            theme.fg("accent", s),
          );

          // Build container for each mode without recreating components
          const buildContainer = () => {
            const c = new Container();
            c.addChild(topBorder);
            c.addChild(question);
            c.addChild(spacer);
            if (mode === "select" && selectList) {
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
            // Focusable interface — propagate to Input for IME cursor positioning
            set focused(value: boolean) {
              _focused = value;
              input.focused = value;
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
                selectList.handleInput(data);
              } else {
                input.handleInput(data);
              }
              tui.requestRender();
            },
          };
        },
        { overlay: true },
      );

      if (result === null) {
        return { content: [{ type: "text", text: "User cancelled" }] };
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
