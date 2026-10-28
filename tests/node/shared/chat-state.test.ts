/**
 * Discord watch state on disk.
 *
 * The state file is attacker-adjacent input (a user-writable JSON) and a restart
 * depends on it, so everything read back is coerced: wrong types are dropped
 * instead of reaching the bot.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { migrateState, MAX_LAST_PROMPT_CHARS } from "../../../extensions/shared/chat/chat-state.ts";

const NOW = 1_767_000_000_000;

function stateWith(lastPrompts: unknown) {
  return migrateState({
    version: 2,
    users: {
      u1: { watchedSessionId: "1:/repo", responseChannelId: null, lastPrompts, updatedAt: NOW },
    },
  }, NOW);
}

describe("remembered prompts", () => {
  it("round-trips the last prompt per session", () => {
    const stored = stateWith({ "1:/repo": { text: "fix the build", hadImages: false, truncated: false } });
    assert.equal(stored.users.u1?.lastPrompts?.["1:/repo"]?.text, "fix the build");
  });

  it("keeps several sessions apart", () => {
    const stored = stateWith({
      "1:/a": { text: "first", hadImages: false, truncated: false },
      "2:/b": { text: "second", hadImages: true, truncated: false },
    }).users.u1?.lastPrompts;
    assert.equal(stored?.["1:/a"]?.text, "first");
    assert.equal(stored?.["2:/b"]?.text, "second");
    assert.equal(stored?.["2:/b"]?.hadImages, true);
  });

  it("accepts the older bare-string shape", () => {
    const entry = stateWith({ "1:/repo": "legacy" }).users.u1?.lastPrompts?.["1:/repo"];
    assert.deepEqual(entry, { text: "legacy", hadImages: false, truncated: false });
  });

  it("drops a non-numeric value", () => {
    assert.equal(stateWith({ a: 42 }).users.u1?.lastPrompts?.a, undefined);
  });

  it("drops a null value", () => {
    assert.equal(stateWith({ b: null }).users.u1?.lastPrompts?.b, undefined);
  });

  it("drops an entry whose text is not a string", () => {
    assert.equal(stateWith({ c: { text: 7 } }).users.u1?.lastPrompts?.c, undefined);
  });

  it("drops an entry without text", () => {
    assert.equal(stateWith({ d: {} }).users.u1?.lastPrompts?.d, undefined);
  });

  it("caps an oversized prompt", () => {
    const long = "x".repeat(MAX_LAST_PROMPT_CHARS * 3);
    const entry = stateWith({ "1:/repo": { text: long, hadImages: false, truncated: false } }).users.u1?.lastPrompts?.["1:/repo"];
    assert.equal(entry?.text.length, MAX_LAST_PROMPT_CHARS);
  });

  it("marks a capped prompt as truncated", () => {
    const long = "x".repeat(MAX_LAST_PROMPT_CHARS * 3);
    const entry = stateWith({ "1:/repo": { text: long, hadImages: false, truncated: false } }).users.u1?.lastPrompts?.["1:/repo"];
    assert.equal(entry?.truncated, true, "a retry must know it cannot reproduce the original");
  });

  it("keeps an explicit truncated flag", () => {
    const entry = stateWith({ "1:/repo": { text: "short", hadImages: false, truncated: true } }).users.u1?.lastPrompts?.["1:/repo"];
    assert.equal(entry?.truncated, true);
  });

  it("survives a missing lastPrompts field", () => {
    assert.deepEqual(stateWith(undefined).users.u1?.lastPrompts, {});
  });
});
