/**
 * Cross-session Discord prompts: where a question goes, when to nudge, and which thread mappings
 * may be evicted. Pure decisions, asserted without a Discord client.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evictableSessions, fallbackPromptTarget, nudgeDue, planPromptTarget, promptById, shouldNudge } from "../../../extensions/pidash/discord-prompt-targets.ts";

describe("planPromptTarget", () => {
  const base = { existingChannelId: null, threadParentChannelId: "chan", dmChannelId: "dm-1", plainChannelId: "chan" };

  it("reuses the target a watched session already has", () => {
    assert.deepEqual(planPromptTarget({ ...base, existingChannelId: "thread-1" }),
      { action: "existing", channelId: "thread-1" });
  });

  it("creates a thread for a session the user never picked", () => {
    // Case 1/2: nothing exists for this session yet, so the question gets its own home and the
    // answer has a route back.
    assert.deepEqual(planPromptTarget(base), { action: "create-thread", parentChannelId: "chan" });
  });

  it("prefers the DM when no guild channel can hold a thread", () => {
    assert.deepEqual(planPromptTarget({ ...base, threadParentChannelId: null }),
      { action: "use-dm", channelId: "dm-1" });
  });

  it("falls back to a plain channel, then reports nowhere", () => {
    assert.deepEqual(planPromptTarget({ ...base, threadParentChannelId: null, dmChannelId: null }),
      { action: "use-channel", channelId: "chan" });
    assert.deepEqual(planPromptTarget({ existingChannelId: null, threadParentChannelId: null, dmChannelId: null, plainChannelId: null }),
      { action: "nowhere" });
  });
});

describe("fallbackPromptTarget", () => {
  const input = {
    existingChannelId: null,
    threadParentChannelId: "chan",
    dmChannelId: "dm-1",
    plainChannelId: "chan",
  };

  it("moves to the DM when a thread cannot be created", () => {
    // A permission failure must not drop the question when a DM exists.
    assert.deepEqual(fallbackPromptTarget(input, "thread"), { action: "use-dm", channelId: "dm-1" });
  });

  it("moves to a plain channel when neither thread nor DM works", () => {
    assert.deepEqual(fallbackPromptTarget({ ...input, dmChannelId: null }, "thread"), { action: "use-channel", channelId: "chan" });
    assert.deepEqual(fallbackPromptTarget(input, "dm"), { action: "use-channel", channelId: "chan" });
  });

  it("reports nowhere when nothing is left", () => {
    const bare = { existingChannelId: null, threadParentChannelId: null, dmChannelId: null, plainChannelId: null };
    assert.deepEqual(fallbackPromptTarget(bare, "thread"), { action: "nowhere" });
    assert.deepEqual(fallbackPromptTarget({ ...bare, plainChannelId: null }, "dm"), { action: "nowhere" });
  });
});

describe("nudgeDue", () => {
  it("allows the first nudge and then throttles", () => {
    assert.equal(nudgeDue(undefined, 1_000), true);
    assert.equal(nudgeDue(1_000, 30_000), false, "inside the window");
    assert.equal(nudgeDue(1_000, 61_000), true, "after it");
  });
});

describe("promptById", () => {
  const prompts = {
    A: { id: "q1", sessionId: "A" },
    B: { id: "q2", sessionId: "B" },
  };

  it("finds a prompt in another session", () => {
    assert.equal(promptById(prompts, "q2")?.sessionId, "B");
  });

  it("returns null for an unknown id", () => {
    assert.equal(promptById(prompts, "nope"), null);
    assert.equal(promptById(undefined, "q1"), null);
  });

  it("lets the thread decide when two sessions share a prompt id", () => {
    const collided = { A: { id: "same", sessionId: "A" }, B: { id: "same", sessionId: "B" } };
    assert.equal(promptById(collided, "same", "B")?.sessionId, "B");
    // Without a thread context an ambiguous id is refused rather than answering the wrong agent.
    assert.equal(promptById(collided, "same"), null);
  });
});
