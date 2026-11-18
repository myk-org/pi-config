/**
 * The action rows a question gets in Discord.
 *
 * Discord forbids a select menu and buttons in the same row, so an option prompt needs two.
 *
 * The free-text control is offered ONLY when the asking side accepts an answer outside its
 * options (`prompt.freeText`, i.e. `ask_user`). A bridged prompt validates the answer against
 * what it offered and ignores anything else (`extensions/shared/ui-bridge.ts`), so a modal there
 * reported success and stranded the approval.
 *
 * Pure except for the log line — the discord.js builders are injected — so the rows are asserted
 * without a Discord client.
 */

import { createLogger } from "../shared/logger.ts";
import type { PendingPrompt } from "../shared/chat/chat-prompts.ts";
import { truncateLine } from "./discord-format.ts";

const log = createLogger("pidash-prompt-controls");

/** The discord.js constructors this module touches (`any`: the shape is the builder chain). */
export interface PromptControlBuilders {
  ActionRowBuilder: any;
  ButtonBuilder: any;
  ButtonStyle: any;
  StringSelectMenuBuilder: any;
}

/** What the rows need from a prompt. */
export type PromptControlInput = Pick<PendingPrompt, "id" | "method" | "options" | "freeText">;

/** Discord caps a select menu at 25 options. The select value is the index into
 *  `prompt.options`, so showing the first 25 keeps them valid answers for the rest. */
const MAX_OPTIONS = 25;

/** Approve/Deny for a confirm, a select (truncated to what Discord allows) plus, only for a
 *  free-text prompt, "type it yourself"; a modal button alone when there is nothing to pick. */
export function buildPromptControls(prompt: PromptControlInput, builders: PromptControlBuilders): any[] {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = builders;
  const optionCount = prompt.options.length;
  const freeText = prompt.freeText === true;
  const decided = (set: string, extra: Record<string, unknown> = {}) =>
    log.debug("prompt controls chosen", { id: prompt.id, set, optionCount, freeText, ...extra });
  const modalRow = (label: string) => new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`answer-modal:${prompt.id}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Primary),
  );

  if (prompt.method === "confirm") {
    decided("confirm");
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`answer:${prompt.id}:yes`).setLabel("Approve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`answer:${prompt.id}:no`).setLabel("Deny").setStyle(ButtonStyle.Danger),
    )];
  }
  if (optionCount > 0) {
    const shown = Math.min(optionCount, MAX_OPTIONS);
    const truncation = optionCount > MAX_OPTIONS ? { shown, truncated: true } : {};
    const menu = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`answer:${prompt.id}:select`)
        .setPlaceholder("Choose an option")
        .addOptions(prompt.options.slice(0, shown).map((option: string, i: number) => ({
          label: truncateLine(option, 100), value: String(i),
        }))),
    );
    if (!freeText) {
      decided("select", truncation);
      return [menu];
    }
    decided("select+modal", truncation);
    return [menu, modalRow("✎ Type answer")];
  }
  // Nothing to pick (a free-text question): a modal beats "type your answer as a chat message".
  decided("modal-only");
  return [modalRow("Answer")];
}
