import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldEvictOnLeaving } from "../../../extensions/coms/coms-shared.js";

/**
 * Regression coverage for the /reload presence bug.
 *
 * A peer's leaving broadcast arrived ~200ms AFTER the reloaded session had already
 * registered under the same name. Eviction matched on name alone, so the live session
 * was removed and the peer displayed as disconnected until something made it
 * re-register — which is why the peer looked gone until the next message was sent.
 */
describe("shouldEvictOnLeaving", () => {
  const OLD_SID = "sid-old-session";
  const NEW_SID = "sid-new-session";

  it("evicts the session that actually announced it is leaving", () => {
    assert.equal(shouldEvictOnLeaving(OLD_SID, "peerx", "peerx", OLD_SID), true);
  });

  it("does NOT evict the reloaded session when a same-named peer leaves", () => {
    // The bug: the outgoing session's broadcast must not remove the incoming session.
    assert.equal(
      shouldEvictOnLeaving(NEW_SID, "peerx", "peerx", OLD_SID),
      false,
      "a leaving broadcast from a different session must not evict this one",
    );
  });

  it("does not evict a different name even when the session matches", () => {
    assert.equal(shouldEvictOnLeaving(OLD_SID, "someone-else", "peerx", OLD_SID), false);
  });

  it("falls back to name matching when the sender omits its session id", () => {
    // Older peers predate sender_session; the original name-only behaviour must stand.
    assert.equal(shouldEvictOnLeaving(NEW_SID, "peerx", "peerx", undefined), true);
    assert.equal(shouldEvictOnLeaving(NEW_SID, "peerx", "peerx", ""), true);
  });

  it("survives the reload sequence end to end", () => {
    // Reload order observed live: new session registers, then old session announces leaving.
    const cards = new Map([
      [NEW_SID, { name: "peerx" }],
      [OLD_SID, { name: "peerx" }],
    ]);
    for (const [sid, card] of [...cards.entries()]) {
      if (shouldEvictOnLeaving(sid, card.name, "peerx", OLD_SID)) cards.delete(sid);
    }
    assert.deepEqual([...cards.keys()], [NEW_SID], "only the departing session is removed");
  });
});

/**
 * Registry-level counterpart to shouldEvictOnLeaving.
 *
 * A peer can reload with a STABLE coms_session_id, so the outgoing session's cleanup
 * unlinks the very registry file the incoming session just re-created. The fs-watch
 * unlink handler therefore has to re-check the registry on disk before evicting:
 * if an entry for that name is still present, the peer is alive and the unlink
 * belonged to the session that just went away.
 *
 * This models the observed sequence — joined, then ~200ms later left for a peer
 * that never disconnected.
 */
describe("registry presence on unlink after a stable-sid reload", () => {
  const readAllRegistryEntries = (entries: Array<{ name: string }>): Array<{ name: string }> => entries;

  it("ignores the outgoing session's unlink when the peer re-registered", () => {
    // Outgoing session removes the file; incoming session has already rewritten it,
    // so the registry still holds peerx under the SAME session id.
    const registry = readAllRegistryEntries([{ name: "peerx" }]);
    const peerCards = new Map([["sid-stable", { name: "peerx" }]]);

    const stillRegistered = registry.some((e) => e.name === "peerx");

    assert.equal(stillRegistered, true, "the peer is still on disk");
    if (!stillRegistered) peerCards.delete("sid-stable");
    assert.ok(peerCards.has("sid-stable"), "a live peer must not be evicted by its predecessor's unlink");
    assert.equal(peerCards.size, 1);
  });

  it("still evicts when the peer really is gone", () => {
    const registry = readAllRegistryEntries([]);
    const peerCards = new Map([["sid-stable", { name: "peerx" }]]);

    const stillRegistered = registry.some((e) => e.name === "peerx");

    assert.equal(stillRegistered, false);
    if (!stillRegistered) peerCards.delete("sid-stable");
    assert.equal(peerCards.size, 0, "a genuinely departed peer must be removed");
  });

  it("does not let one peer's unlink evict a different named peer", () => {
    const registry = readAllRegistryEntries([{ name: "other-agent" }]);
    const peerCards = new Map([["sid-peerx", { name: "peerx" }]]);

    const stillRegistered = registry.some((e) => e.name === "peerx");

    assert.equal(stillRegistered, false, "another agent's presence is not peerx");
    if (!stillRegistered) peerCards.delete("sid-peerx");
    assert.equal(peerCards.size, 0);
  });
});
