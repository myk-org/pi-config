/**
 * Cross-session Discord prompts: where a question goes, when to nudge, and which thread mappings
 * may be evicted. Pure decisions, asserted without a Discord client.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evictableSessions, fallbackPromptTarget, nudgeDue, planPromptTarget, promptById, resolvePromptTarget, shouldNudge } from "../../../extensions/pidash/discord-prompt-targets.ts";

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

describe("resolvePromptTarget (the router, with an injected thread creator)", () => {
  const input = { existingChannelId: null, threadParentChannelId: "chan", dmChannelId: "dm-1", plainChannelId: "chan" };

  it("uses a thread when Discord creates one", async () => {
    const resolved = await resolvePromptTarget(input, async () => "thread-9");
    assert.deepEqual(resolved, { target: { channelId: "thread-9", threadId: "thread-9" }, used: "thread", firstFailure: null });
  });

  it("falls back to the DM when thread creation fails, and says why", async () => {
    // The case that used to drop the question: a permission error on threads.create.
    const resolved = await resolvePromptTarget(input, async () => { throw new Error("Missing Permissions"); });
    assert.deepEqual(resolved.target, { channelId: "dm-1", threadId: null });
    assert.equal(resolved.used, "dm");
    assert.match(String(resolved.firstFailure), /Missing Permissions/);
  });

  it("falls back past the DM to a plain channel", async () => {
    const resolved = await resolvePromptTarget({ ...input, dmChannelId: null }, async () => { throw new Error("nope"); });
    assert.deepEqual(resolved.target, { channelId: "chan", threadId: null });
    assert.equal(resolved.used, "channel");
  });

  it("reports nowhere instead of pretending a delivery happened", async () => {
    const resolved = await resolvePromptTarget(
      { existingChannelId: null, threadParentChannelId: "chan", dmChannelId: null, plainChannelId: null },
      async () => { throw new Error("nope"); },
    );
    assert.equal(resolved.target, null);
    assert.equal(resolved.used, "nowhere");
  });

  it("reuses an existing target without touching Discord", async () => {
    let calls = 0;
    const resolved = await resolvePromptTarget({ ...input, existingChannelId: "thread-1" }, async () => { calls++; return "x"; });
    assert.deepEqual(resolved.target, { channelId: "thread-1", threadId: null });
    assert.equal(resolved.used, "existing");
    assert.equal(calls, 0);
  });
});
