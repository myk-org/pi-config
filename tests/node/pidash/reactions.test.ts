/**
 * Reaction shortcuts and session<->channel resolution.
 *
 * A reaction is a one-tap action on a phone, so the mapping must be exact: a
 * stray emoji does nothing, a reaction on an unrelated message touches no
 * session, and a user can only act on their own targets.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ownsChannel,
  ownsSession,
  reactionAction,
  sessionForChannel,
  sessionIdFromTopic,
} from "../../../extensions/pidash/discord-reactions.ts";

describe("reaction emoji mapping", () => {
  it("maps stop", () => {
    assert.equal(reactionAction("⏹"), "stop");
    assert.equal(reactionAction("🛑"), "stop");
  });

  it("maps retry", () => {
    assert.equal(reactionAction("🔁"), "retry");
  });

  it("maps delete", () => {
    assert.equal(reactionAction("🗑"), "delete");
    assert.equal(reactionAction("🗑️"), "delete");
  });

  it("ignores anything else", () => {
    for (const emoji of ["👍", "🎉", "🔥", "", "stop"]) {
      assert.equal(reactionAction(emoji), null, `${emoji} must do nothing`);
    }
  });
});

describe("session for a reacted channel", () => {
  const targets = {
    "1:/repo-a": { channelId: "thread-a", threadId: "thread-a" },
    "2:/repo-b": { channelId: "thread-b", threadId: null },
  };

  it("resolves a retained thread", () => {
    assert.equal(sessionForChannel(targets, null, null, "thread-a"), "1:/repo-a");
  });

  it("resolves a channel without a thread", () => {
    assert.equal(sessionForChannel(targets, null, null, "thread-b"), "2:/repo-b");
  });

  it("falls back to the watched session's current target", () => {
    assert.equal(sessionForChannel({}, "3:/repo-c", "dm-channel", "dm-channel"), "3:/repo-c");
  });

  it("prefers the current watch when two sessions share a DM channel", () => {
    // Qodo 9ee29f3e: retained targets used to win, so ⏹ on the newest message
    // aborted the session the user had already switched away from.
    const shared = { "1:/old": { channelId: "dm", threadId: null } };
    assert.equal(sessionForChannel(shared, "2:/new", "dm", "dm"), "2:/new");
  });

  it("resolves nothing for an unrelated channel", () => {
    assert.equal(sessionForChannel(targets, "3:/repo-c", "dm-channel", "someone-elses-channel"), null);
  });
});

describe("reaction ownership", () => {
  const state = {
    watchedSessionId: "1:/mine",
    target: { channelId: "dm", threadId: null },
    targets: { "2:/other": { channelId: "thread-b", threadId: "thread-b" } },
  };

  it("owns its current channel and its retained threads", () => {
    assert.equal(ownsChannel(state, "dm"), true);
    assert.equal(ownsChannel(state, "thread-b"), true);
  });

  it("does not own a channel belonging to nobody", () => {
    assert.equal(ownsChannel(state, "someone-elses-channel"), false);
  });

  it("owns the watched session and its retained targets only", () => {
    assert.equal(ownsSession(state, "1:/mine"), true);
    assert.equal(ownsSession(state, "2:/other"), true);
    assert.equal(ownsSession(state, "3:/stranger"), false);
  });
});

describe("forum thread topic", () => {
  it("reads the session id", () => {
    assert.equal(sessionIdFromTopic("pi-config · session:123:/home/x/repo"), "123:/home/x/repo");
  });

  it("returns null when the topic carries no session", () => {
    assert.equal(sessionIdFromTopic("just a topic"), null);
    assert.equal(sessionIdFromTopic(undefined), null);
  });
});
