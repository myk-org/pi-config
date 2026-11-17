/**
 * The action rows a Discord question gets.
 *
 * An option prompt must offer BOTH the select menu and a way to answer in your own words — the
 * answer path already accepted free text for a select prompt, only the affordance was missing.
 * Discord forbids a select and a button in one row, so it takes two.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { buildPromptControls, type PromptControlInput } from "../../../extensions/pidash/discord-prompt-controls.ts";

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } =
  createRequire(import.meta.url)("discord.js");
const builders = { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder };

/** The serialized rows, so nothing here depends on a Discord client. */
function rows(prompt: PromptControlInput): any[] {
  return buildPromptControls(prompt, builders).map((row: any) => row.toJSON());
}

const BUTTON = 2;
const SELECT = 3;

describe("buildPromptControls", () => {
  it("gives an option prompt a select row and a free-text row", () => {
    const [first, second, ...rest] = rows({ id: "p1", method: "select", options: ["A", "B", "C"] });
    assert.deepStrictEqual(rest, [], "exactly two rows");

    assert.deepStrictEqual(first.components.map((c: any) => c.type), [SELECT]);
    const menu = first.components[0];
    assert.equal(menu.custom_id, "answer:p1:select");
    assert.deepStrictEqual(menu.options.map((o: any) => o.label), ["A", "B", "C"]);
    assert.deepStrictEqual(menu.options.map((o: any) => o.value), ["0", "1", "2"]);

    assert.deepStrictEqual(second.components.map((c: any) => c.type), [BUTTON]);
    assert.equal(second.components[0].custom_id, "answer-modal:p1", "the existing modal path, reused");
    assert.equal(second.components[0].label, "✎ Type answer");
  });

  it("keeps a confirm prompt to Approve/Deny", () => {
    const all = rows({ id: "p2", method: "confirm", options: ["Yes", "No"] });
    assert.equal(all.length, 1);
    assert.deepStrictEqual(
      all[0].components.map((c: any) => [c.custom_id, c.label]),
      [["answer:p2:yes", "Approve"], ["answer:p2:no", "Deny"]],
    );
    assert.ok(!all[0].components.some((c: any) => String(c.custom_id).startsWith("answer-modal:")));
  });

  it("gives a no-options prompt the Answer button alone", () => {
    const all = rows({ id: "p3", method: "input", options: [] });
    assert.equal(all.length, 1);
    assert.deepStrictEqual(all[0].components.map((c: any) => c.type), [BUTTON]);
    assert.equal(all[0].components[0].custom_id, "answer-modal:p3");
    assert.equal(all[0].components[0].label, "Answer");
  });

  it("falls back to the modal for more options than a select menu allows", () => {
    const many = Array.from({ length: 26 }, (_, i) => `option ${i}`);
    const all = rows({ id: "p4", method: "select", options: many });
    assert.equal(all.length, 1);
    assert.deepStrictEqual(all[0].components.map((c: any) => c.type), [BUTTON]);
  });
});
