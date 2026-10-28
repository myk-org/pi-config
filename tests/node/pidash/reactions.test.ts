/**
 * Reaction shortcuts and session<->channel resolution.
 *
 * A reaction is a one-tap action on a phone, so the mapping must be exact: a
 * stray emoji has to do nothing, and a reaction on an unrelated message must not
 * stop someone else's session.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  reactionAction,
  sessionForChannel,
  sessionIdFromTopic,
} from "../../../extensions/pidash/discord-reactions.ts";

describe("reaction emoji mapping", () => {
  it("maps stop", () => {
    assert.equal(reactionAction("⏹"), "stop");
    assert.equal(reactionAction("🛑"), "stop");
  });

  it("maps retry and delete", () => {
    assert.equal(reactionAction("🔁"), "retry");
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

  it("resolves nothing for an unrelated channel", () => {
    assert.equal(sessionForChannel(targets, "3:/repo-c", "dm-channel", "someone-elses-channel"), null);
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
