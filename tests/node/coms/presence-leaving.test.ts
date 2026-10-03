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
