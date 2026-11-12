/**
 * The record every refused inbound Discord message leaves behind.
 *
 * A refusal nobody can see is undiagnosable: the user could reproduce "Not watching any session"
 * with no log line naming the branch, the channel or the state that produced it. The record carries
 * ids and state shape only — a refusal that quotes the message would leak content into the log.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inboundRouteRecord } from "../../../extensions/pidash/discord-bot.ts";
import type { InboundSession } from "../../../extensions/pidash/discord-prompt-targets.ts";

const targets = { "sess-a": { channelId: "chan-1", threadId: null } };

describe("inboundRouteRecord", () => {
  it("names a channel the user neither owns as a thread nor as a target", () => {
    const record = inboundRouteRecord({
      reason: "channel-not-owned",
      channelId: "chan-1",
      guildId: "guild-1",
      watchedSessionId: null,
      watchLive: false,
      targets: {},
      ownsTarget: false,
    });
    assert.equal(record.reason, "channel-not-owned");
    assert.equal(record.isDm, false);
    assert.equal(record.ownsTarget, false);
    assert.deepEqual(record.targetKeys, []);
    assert.equal(record.inboundSource, null);
  });

  it("carries the resolver's verdict for a dead watch", () => {
    const inbound: InboundSession = { sessionId: null, source: "none", deadWatch: true };
    const record = inboundRouteRecord({
      reason: "no-target",
      channelId: "dm-1",
      guildId: null,
      watchedSessionId: "sess-gone",
      watchLive: false,
      targets,
      ownsTarget: true,
      inbound,
    });
    assert.equal(record.isDm, true);
    assert.equal(record.watchLive, false);
    assert.equal(record.watchedSessionId, "sess-gone");
    assert.equal(record.deadWatch, true);
    assert.equal(record.inboundSource, "none");
    assert.deepEqual(record.targetKeys, ["sess-a"]);
  });

  it("records a thread-routed message", () => {
    const record = inboundRouteRecord({
      reason: "session-disconnected",
      channelId: "thread-1",
      guildId: "guild-1",
      threadSessionId: "sess-a",
      watchedSessionId: "sess-b",
      watchLive: true,
      targets,
      ownsTarget: true,
      inbound: { sessionId: "sess-a", source: "thread" },
    });
    assert.equal(record.inboundSource, "thread");
    assert.equal(record.inboundSessionId, "sess-a");
    assert.equal(record.threadSessionId, "sess-a");
    assert.equal(record.watchLive, true);
  });

  it("records a target-routed message", () => {
    const record = inboundRouteRecord({
      reason: "ambiguous",
      channelId: "chan-1",
      guildId: "guild-1",
      watchedSessionId: null,
      watchLive: false,
      targets,
      ownsTarget: true,
      inbound: { sessionId: "sess-a", source: "target", deadTarget: true, ambiguous: true },
    });
    assert.equal(record.inboundSource, "target");
    assert.equal(record.deadTarget, true);
    assert.equal(record.ambiguous, true);
    assert.deepEqual(record.targetKeys, ["sess-a"]);
  });

  it("cannot carry message text", () => {
    // The helper takes no content in, so the only strings are ids and the fixed reason label.
    const record = inboundRouteRecord({
      reason: "channel-not-owned",
      channelId: "chan-1",
      guildId: "guild-1",
      watchedSessionId: null,
      watchLive: false,
      targets: {},
      ownsTarget: false,
    });
    assert.deepEqual(Object.keys(record).sort(), [
      "ambiguous", "channelId", "deadTarget", "deadWatch", "guildId", "inboundSessionId", "inboundSource",
      "isDm", "ownsTarget", "reason", "targetKeys", "threadSessionId", "watchLive", "watchedSessionId",
    ]);
    const serialized = JSON.stringify(record);
    assert.doesNotMatch(serialized, /text|body|content|message|attach/i);
  });
});
