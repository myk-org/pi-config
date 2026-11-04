/**
 * Provenance marker for machine-generated messages (issue #1016 review).
 *
 * A model must be able to tell an extension's notice from the user's own words; without
 * the marker a rejection notice reads as a user message.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SYSTEM_NOTE_MARKER, sendSystemNote } from "../../../extensions/shared/system-note.ts";

function fakePi(): { pi: any; sent: any[] } {
  const sent: any[] = [];
  return { sent, pi: { sendMessage: async (message: any, options: any) => { sent.push({ message, options }); } } };
}

describe("sendSystemNote", () => {
  it("prefixes the marker so the text cannot read as user input", async () => {
    const { pi, sent } = fakePi();
    await sendSystemNote(pi, "Async call was REJECTED", { customType: "test-note" });
    assert.ok(sent[0].message.content.startsWith(SYSTEM_NOTE_MARKER));
    assert.ok(sent[0].message.content.includes("Async call was REJECTED"));
    assert.equal(sent[0].message.customType, "test-note");
    assert.equal(sent[0].message.display, true);
  });

  it("does not double-prefix an already marked message", async () => {
    const { pi, sent } = fakePi();
    await sendSystemNote(pi, `${SYSTEM_NOTE_MARKER}\nalready marked`, { customType: "test-note" });
    assert.equal(sent[0].message.content.match(/\[system message/g)?.length, 1);
  });

  it("forwards turn and delivery options", async () => {
    const { pi, sent } = fakePi();
    await sendSystemNote(pi, "note", { customType: "test-note", triggerTurn: true, deliverAs: "followUp", display: false });
    assert.deepEqual(sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
    assert.equal(sent[0].message.display, false);
  });
});
