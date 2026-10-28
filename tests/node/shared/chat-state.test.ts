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
    assert.equal(stateWith({ "1:/repo": "fix the build" }).users.u1?.lastPrompts?.["1:/repo"], "fix the build");
  });

  it("keeps several sessions apart", () => {
    const prompts = { "1:/a": "first", "2:/b": "second" };
    const stored = stateWith(prompts).users.u1?.lastPrompts;
    assert.equal(stored?.["1:/a"], "first");
    assert.equal(stored?.["2:/b"], "second");
  });

  it("drops non-string values", () => {
    assert.equal(stateWith({ a: 42, b: null, c: { text: "x" } }).users.u1?.lastPrompts?.a, undefined);
  });

  it("caps an oversized prompt", () => {
    const long = "x".repeat(MAX_LAST_PROMPT_CHARS * 3);
    assert.equal((stateWith({ "1:/repo": long }).users.u1?.lastPrompts?.["1:/repo"] ?? "").length, MAX_LAST_PROMPT_CHARS);
  });

  it("survives a missing lastPrompts field", () => {
    assert.deepEqual(stateWith(undefined).users.u1?.lastPrompts, {});
  });
});
