/**
 * Cross-session Discord prompts: where a question goes, when to nudge, and which thread mappings
 * may be evicted. Pure decisions, asserted without a Discord client.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evictableSessions, planPromptTarget, shouldNudge } from "../../../extensions/pidash/discord-prompt-targets.ts";

describe("planPromptTarget", () => {
  it("reuses the target a watched session already has", () => {
    assert.deepEqual(planPromptTarget({
      existingChannelId: "thread-1", parentChannelId: "chan", parentSupportsThreads: true,
      hasDm: true, fallbackChannelId: "current",
    }), { action: "existing", channelId: "thread-1" });
  });

  it("creates a thread for a session the user never picked", () => {
    // Case 1/2: nothing exists for this session yet, so the question gets its own home and the
    // answer has a route back.
    assert.deepEqual(planPromptTarget({
      existingChannelId: null, parentChannelId: "chan", parentSupportsThreads: true,
      hasDm: true, fallbackChannelId: "current",
    }), { action: "create-thread", parentChannelId: "chan" });
  });

  it("falls back to the DM when threads are unavailable", () => {
    assert.deepEqual(planPromptTarget({
      existingChannelId: null, parentChannelId: "forum-channel", parentSupportsThreads: false,
      hasDm: true, fallbackChannelId: "current",
    }), { action: "use-dm" });
  });

  it("falls back to a channel, then reports nowhere", () => {
    assert.deepEqual(planPromptTarget({
      existingChannelId: null, parentChannelId: "chan", parentSupportsThreads: false,
      hasDm: false, fallbackChannelId: "current",
    }), { action: "use-channel", channelId: "chan" });
    assert.deepEqual(planPromptTarget({
      existingChannelId: null, parentChannelId: null, parentSupportsThreads: false,
      hasDm: false, fallbackChannelId: "current",
    }), { action: "use-channel", channelId: "current" });
    assert.deepEqual(planPromptTarget({
      existingChannelId: null, parentChannelId: null, parentSupportsThreads: false,
      hasDm: false, fallbackChannelId: null,
    }), { action: "nowhere" });
  });
});

describe("shouldNudge", () => {
  it("nudges only when another session asks", () => {
    assert.equal(shouldNudge({ watchedSessionId: "a", askedSessionId: "b", askedChannelId: "t" }), true);
  });

  it("stays quiet when the user is watching the asking session", () => {
    // Case 3: the prompt appears in front of them; a nudge would be noise.
    assert.equal(shouldNudge({ watchedSessionId: "a", askedSessionId: "a", askedChannelId: "t" }), false);
  });

  it("stays quiet with no watched session or no channel to point at", () => {
    assert.equal(shouldNudge({ watchedSessionId: null, askedSessionId: "b", askedChannelId: "t" }), false);
    assert.equal(shouldNudge({ watchedSessionId: "a", askedSessionId: "b", askedChannelId: null }), false);
  });
});

describe("evictableSessions", () => {
  const threads = { a: "t1", b: "t2", c: "t3" };

  it("returns nothing while under the cap", () => {
    assert.deepEqual(evictableSessions(threads, [], 5), []);
  });

  it("evicts the oldest mappings first", () => {
    assert.deepEqual(evictableSessions(threads, [], 2), ["a"]);
    assert.deepEqual(evictableSessions(threads, [], 1), ["a", "b"]);
  });

  it("never evicts a session that is waiting on an answer", () => {
    // Evicting it would leave a question the user can no longer reach.
    // Cap 1 of 3 threads: two must go, and `a` is the one waiting on an answer.
    assert.deepEqual(evictableSessions(threads, ["a"], 1), ["b", "c"]);
    assert.deepEqual(evictableSessions(threads, ["a", "b"], 1), ["c"]);
  });
});
