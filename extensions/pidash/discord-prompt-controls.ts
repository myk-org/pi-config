/**
 * The action rows a question gets in Discord.
 *
 * Discord forbids a select menu and buttons in the same row, so an option prompt needs two: the
 * menu, then a button that opens the SAME modal a no-options question uses. Pure — the discord.js
 * builders are injected — so the rows are asserted without a Discord client.
 */

import type { PendingPrompt } from "../shared/chat/chat-prompts.ts";
import { truncateLine } from "./discord-format.ts";

/** The discord.js constructors this module touches (`any`: the shape is the builder chain). */
export interface PromptControlBuilders {
  ActionRowBuilder: any;
  ButtonBuilder: any;
  ButtonStyle: any;
  StringSelectMenuBuilder: any;
}

/** What the rows need from a prompt. */
export type PromptControlInput = Pick<PendingPrompt, "id" | "method" | "options">;

/** Approve/Deny for a confirm, a select plus "type it yourself" for options, a modal button alone
 *  when there is nothing to pick. */
export function buildPromptControls(prompt: PromptControlInput, builders: PromptControlBuilders): any[] {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = builders;
  const modalRow = (label: string) => new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`answer-modal:${prompt.id}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Primary),
  );

  if (prompt.method === "confirm") {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`answer:${prompt.id}:yes`).setLabel("Approve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`answer:${prompt.id}:no`).setLabel("Deny").setStyle(ButtonStyle.Danger),
    )];
  }
  if (prompt.options.length > 0 && prompt.options.length <= 25) {
    return [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`answer:${prompt.id}:select`)
          .setPlaceholder("Choose an option")
          .addOptions(prompt.options.slice(0, 25).map((option: string, i: number) => ({
            label: truncateLine(option, 100), value: String(i),
          }))),
      ),
      // The capability existed (mapAnswer takes a typed answer for a select); this is the affordance.
      modalRow("✎ Type answer"),
    ];
  }
  // Free-text question: a modal beats "type your answer as a chat message".
  return [modalRow("Answer")];
}
