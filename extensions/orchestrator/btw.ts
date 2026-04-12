/**
 * /btw command — quick side questions without polluting conversation history.
 */

import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  BorderedLoader,
  convertToLlm,
  serializeConversation,
} from "@mariozechner/pi-coding-agent";
import {
  Key,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

export function registerBtw(pi: ExtensionAPI): void {
  pi.registerCommand("btw", {
    description: "Ask a quick side question without polluting conversation history",
    handler: async (args, ctx) => {
      const question = args?.trim();
      if (!question) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /btw <question>", "error");
        return;
      }

      if (!ctx.model) {
        if (ctx.hasUI) ctx.ui.notify("No model selected. Use /model to select one first.", "error");
        return;
      }

      // Build conversation context
      const branch = ctx.sessionManager.getBranch();
      const messages = branch
        .filter((e: any) => e.type === "message")
        .map((e: any) => e.message);
      let conversationText = "";
      if (messages.length > 0) {
        const llmMessages = convertToLlm(messages);
        conversationText = serializeConversation(llmMessages);
      }

      const systemPrompt = `You are answering a quick "by the way" side question during a coding session.

Rules:
- Answer concisely and directly based on the conversation context provided.
- You have NO tool access — you cannot read files, run commands, or make changes.
- Only answer based on information already present in the conversation.
- Keep your response brief and to the point.
- Use markdown formatting where helpful (code blocks, lists, bold).
- If the conversation context doesn't contain enough information to answer, say so honestly.`;

      const userMessage: UserMessage = {
        role: "user",
        content: [{
          type: "text",
          text: `<conversation_context>\n${conversationText}\n</conversation_context>\n\n<side_question>\n${question}\n</side_question>\n\nAnswer the side question above based on the conversation context. Be concise.`,
        }],
        timestamp: Date.now(),
      };

      // Step 1: Get the answer with a loading spinner
      const answerResult = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, `Thinking (${ctx.model!.id})...`);
        loader.onAbort = () => done(null);

        const doQuery = async () => {
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
          if (!auth.ok || !auth.apiKey) {
            throw new Error(auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error);
          }
          const response = await complete(
            ctx.model!,
            { systemPrompt, messages: [userMessage] },
            { apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
          );
          if (response.stopReason === "aborted") return null;
          if (response.stopReason === "error") return null;
          return response.content
            .filter((c: any) => c.type === "text" && typeof c.text === "string")
            .map((c: any) => c.text)
            .join("\n");
        };

        doQuery().then(done).catch(() => done(null));
        return loader;
      });

      if (answerResult === null) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }
      if (answerResult.trim() === "") {
        ctx.ui.notify("No answer received", "warning");
        return;
      }

      // Step 2: Show answer in a scrollable overlay
      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        let scrollOffset = 0;
        let cachedWidth: number | undefined;
        let cachedLines: string[] | undefined;

        return {
          handleInput(data: string) {
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === " " || data.toLowerCase() === "q") {
              done(undefined);
              return;
            }
            if (matchesKey(data, Key.up) || data === "k") {
              if (scrollOffset > 0) { scrollOffset--; cachedWidth = undefined; tui.requestRender(); }
              return;
            }
            if (matchesKey(data, Key.down) || data === "j") {
              scrollOffset++; cachedWidth = undefined; tui.requestRender();
              return;
            }
            if (matchesKey(data, Key.pageUp)) {
              scrollOffset = Math.max(0, scrollOffset - 10); cachedWidth = undefined; tui.requestRender();
              return;
            }
            if (matchesKey(data, Key.pageDown)) {
              scrollOffset += 10; cachedWidth = undefined; tui.requestRender();
              return;
            }
          },

          invalidate() { cachedWidth = undefined; cachedLines = undefined; },

          render(width: number): string[] {
            if (cachedLines && cachedWidth === width) return cachedLines;

            const boxWidth = Math.min(width - 2, 120);
            const contentWidth = boxWidth - 6;
            const hLine = "─".repeat(boxWidth - 2);

            const boxLine = (content: string, pad = 2): string => {
              const padded = " ".repeat(pad) + content;
              const right = Math.max(0, boxWidth - visibleWidth(padded) - 2);
              return theme.fg("border", "│") + padded + " ".repeat(right) + theme.fg("border", "│");
            };
            const emptyLine = () => theme.fg("border", "│") + " ".repeat(boxWidth - 2) + theme.fg("border", "│");
            const pad = (line: string) => { const len = visibleWidth(line); return line + " ".repeat(Math.max(0, width - len)); };

            const lines: string[] = [];

            // Header
            lines.push(pad(theme.fg("accent", "╭" + hLine + "╮")));
            lines.push(pad(boxLine(theme.fg("accent", theme.bold("btw")))));
            lines.push(pad(theme.fg("accent", "├" + hLine + "┤")));

            // Question
            const qLabel = theme.fg("muted", "Q: ") + theme.fg("text", question);
            for (const l of wrapTextWithAnsi(qLabel, contentWidth)) lines.push(pad(boxLine(l)));
            lines.push(pad(emptyLine()));
            lines.push(pad(theme.fg("border", "├" + hLine + "┤")));
            lines.push(pad(emptyLine()));

            // Answer lines
            const answerLines: string[] = [];
            for (const paragraph of answerResult.split("\n")) {
              if (paragraph.trim() === "") { answerLines.push(""); }
              else { answerLines.push(...wrapTextWithAnsi(paragraph, contentWidth)); }
            }

            // Scrolling
            const termHeight = tui.height ?? 24;
            const headerCount = lines.length;
            const footerCount = 3;
            const maxVisible = Math.max(1, termHeight - headerCount - footerCount - 2);
            if (scrollOffset > Math.max(0, answerLines.length - maxVisible)) {
              scrollOffset = Math.max(0, answerLines.length - maxVisible);
            }
            const visible = answerLines.slice(scrollOffset, scrollOffset + maxVisible);
            for (const l of visible) lines.push(pad(boxLine(l)));

            if (answerLines.length > maxVisible) {
              const info = theme.fg("dim", `[${scrollOffset + 1}-${Math.min(scrollOffset + maxVisible, answerLines.length)}/${answerLines.length}]`);
              lines.push(pad(boxLine(info)));
            }

            lines.push(pad(emptyLine()));
            lines.push(pad(theme.fg("accent", "├" + hLine + "┤")));
            lines.push(pad(boxLine(theme.fg("dim", "Esc/Space/q dismiss · ↑↓/j/k scroll · PgUp/PgDn"))));
            lines.push(pad(theme.fg("accent", "╰" + hLine + "╯")));

            cachedWidth = width;
            cachedLines = lines;
            return lines;
          },
        };
      });
    },
  });
}
