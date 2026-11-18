/**
 * The action rows a Discord question gets.
 *
 * A free-text control is offered ONLY when the asking side accepts an answer outside its options
 * (`freeText`, set by `ask_user`). A bridged prompt — an approval, a task confirmation — ignores
 * an unoffered select answer, so a modal there claimed success and stranded the prompt.
 *
 * The decisions are logged; the log assertions read the same file the writer resolved.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildPromptControls, type PromptControlInput } from "../../../extensions/pidash/discord-prompt-controls.ts";
import { getPiLogPath, setGlobalSessionId, setLogLevelPin } from "../../../extensions/shared/file-logger.ts";

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
  it("gives a free-text option prompt a select row and a free-text row", () => {
    const [first, second, ...rest] = rows({ id: "p1", method: "select", options: ["A", "B", "C"], freeText: true });
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

  it("keeps an approval to its select menu alone", () => {
    // A bridged approval ignores an answer that is not one of its options (ui-bridge), so a
    // modal button here would claim success and leave the agent blocked.
    const all = rows({ id: "a1", method: "select", options: ["Approve", "Deny"] });
    assert.equal(all.length, 1, "one row");
    assert.deepStrictEqual(all[0].components.map((c: any) => c.type), [SELECT]);
    assert.equal(all[0].components[0].custom_id, "answer:a1:select");
    assert.ok(!all.some((row: any) => row.components.some((c: any) => String(c.custom_id).startsWith("answer-modal:"))));
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
    const all = rows({ id: "p3", method: "input", options: [], freeText: true });
    assert.equal(all.length, 1);
    assert.deepStrictEqual(all[0].components.map((c: any) => c.type), [BUTTON]);
    assert.equal(all[0].components[0].custom_id, "answer-modal:p3");
    assert.equal(all[0].components[0].label, "Answer");
  });

  it("truncates an approval with more options than a menu allows instead of stranding it", () => {
    // The select value is the index into the prompt options, so the first 25 are still valid
    // answers — a modal-only row left a bridged approval unanswerable.
    const many = Array.from({ length: 26 }, (_, i) => `option ${i}`);
    const all = rows({ id: "p4", method: "select", options: many });
    assert.equal(all.length, 1, "one row");
    assert.deepStrictEqual(all[0].components.map((c: any) => c.type), [SELECT]);
    assert.deepStrictEqual(
      all[0].components[0].options.map((o: any) => o.value),
      Array.from({ length: 25 }, (_, i) => String(i)),
    );
    assert.ok(!all.some((row: any) => row.components.some((c: any) => String(c.custom_id).startsWith("answer-modal:"))));
  });

  it("keeps the free-text row for a truncated option prompt", () => {
    const many = Array.from({ length: 26 }, (_, i) => `option ${i}`);
    const all = rows({ id: "p5", method: "select", options: many, freeText: true });
    assert.equal(all.length, 2, "truncated select plus modal");
    assert.deepStrictEqual(all[0].components.map((c: any) => c.type), [SELECT]);
    assert.equal(all[0].components[0].options.length, 25);
    assert.equal(all[1].components[0].custom_id, "answer-modal:p5");
  });
});

describe("buildPromptControls decisions are logged", () => {
  const LOG_NAME = "pidash-prompt-controls";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-controls-"));
  const savedHome = process.env.HOME;

  before(() => {
    process.env.HOME = tmp;
    setGlobalSessionId("prompt-controls-test");
    setLogLevelPin(LOG_NAME, "debug");
  });
  after(() => {
    setLogLevelPin(LOG_NAME, null);
    process.env.HOME = savedHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("names the control set, the option count and whether free text was offered", () => {
    const logPath = getPiLogPath(LOG_NAME);
    assert.ok(logPath, "no session id set: nothing is written");
    const offset = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").length : 0;

    rows({ id: "log-select", method: "select", options: ["A", "B"], freeText: true });
    rows({ id: "log-approval", method: "select", options: ["Approve", "Deny"] });
    rows({ id: "log-truncated", method: "select", options: Array.from({ length: 26 }, (_, i) => `o${i}`) });
    rows({ id: "log-confirm", method: "confirm", options: ["Yes", "No"] });
    rows({ id: "log-modal", method: "input", options: [], freeText: true });

    const lines = fs.readFileSync(logPath, "utf8").slice(offset).split("\n").filter(Boolean);
    assert.equal(lines.length, 5, `one line per decision, got:\n${lines.join("\n")}`);
    assert.match(lines[0], /select\+modal/);
    assert.match(lines[0], /"optionCount":2/);
    assert.match(lines[0], /"freeText":true/);
    assert.match(lines[1], /"set":"select"/);
    assert.match(lines[1], /"freeText":false/);
    assert.match(lines[2], /"optionCount":26/);
    assert.match(lines[2], /"shown":25/);
    assert.match(lines[2], /"truncated":true/);
    assert.match(lines[3], /"set":"confirm"/);
    assert.match(lines[4], /"set":"modal-only"/);
  });
});
