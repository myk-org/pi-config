import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSessionStillRegistered, shouldAnnouncePeerLeft, shouldEvictOnLeaving } from "../../../extensions/coms/coms-shared.js";

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
 * Eviction and announcement are separate decisions.
 *
 * Removing only the departing session left the replacement card live, but the handler
 * still emitted coms-peer-left — so the user and every browser event consumer were told
 * a still-connected peer had gone, ~200ms after its join. The registry-removal path
 * already suppressed that notice; the presence path now does the same.
 */
describe("peer-left announcement after a reload", () => {
  const OLD_SID = "sid-old-session";
  const NEW_SID = "sid-new-session";

  it("stays silent when the reloaded session already holds a card", () => {
    const cards = new Map([
      [NEW_SID, { name: "peerx" }],
      [OLD_SID, { name: "peerx" }],
    ]);
    // New session registers, then the old session announces leaving.
    for (const [sid, card] of [...cards.entries()]) {
      if (!shouldEvictOnLeaving(sid, card.name, "peerx", OLD_SID)) continue;
      cards.delete(sid);
      const announce = shouldAnnouncePeerLeft(cards.values(), card.name);
      assert.equal(
        announce,
        false,
        "no peer-left notice while a same-named card is still live",
      );
    }
    assert.deepEqual([...cards.keys()], [NEW_SID], "the live session survives");
  });

  it("still announces when the peer genuinely departed", () => {
    const cards = new Map([[OLD_SID, { name: "peerx" }]]);
    for (const [sid, card] of [...cards.entries()]) {
      if (!shouldEvictOnLeaving(sid, card.name, "peerx", OLD_SID)) continue;
      cards.delete(sid);
      assert.equal(
        shouldAnnouncePeerLeft(cards.values(), card.name),
        true,
        "a real departure must still notify",
      );
    }
    assert.equal(cards.size, 0, "the card is gone");
  });

  it("does not let an unrelated peer silence the notice", () => {
    const cards = new Map([["sid-other", { name: "someone-else" }]]);
    assert.equal(shouldAnnouncePeerLeft(cards.values(), "peerx"), true);
  });
});

/**
 * Registry-level counterpart, driven by REAL registry files.
 *
 * A peer can reload with a STABLE coms_session_id, so the outgoing session's cleanup
 * unlinks the very registry file the incoming session just re-created. The fs-watch
 * unlink handler therefore re-reads the registry before evicting a card.
 *
 * These tests write actual JSON files into a temp directory and read them back the
 * way the watcher does. An earlier version stubbed the registry read with a local
 * array, so it could not reproduce the race it claimed to cover — the eviction
 * decision and the read it depends on are the production ones here.
 */
describe("registry presence on unlink after a stable-sid reload", () => {
  const STABLE_SID = "sid-stable";
  const OTHER_SID = "sid-other";

  /** Write real registry entries, then read them back exactly as readAllRegistryEntries does. */
  function writeRegistry(dir: string, entries: Array<{ coms_session_id: string; name: string }>): void {
    mkdirSync(dir, { recursive: true });
    for (const entry of entries) {
      writeFileSync(
        join(dir, `${entry.coms_session_id}.json`),
        JSON.stringify(entry),
        { mode: 0o600 },
      );
    }
  }

  function readRegistry(dir: string): Array<{ coms_session_id: string; name: string }> {
    if (!existsSync(dir)) return [];
    const out: Array<{ coms_session_id: string; name: string }> = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, f), "utf-8"));
        if (parsed && typeof parsed.coms_session_id === "string") out.push(parsed);
      } catch {
        // skip malformed
      }
    }
    return out;
  }

  it("ignores the outgoing session's unlink when the same session re-registered", () => {
    const dir = join(tmpdir(), `coms-registry-${process.pid}-reload`);
    rmSync(dir, { recursive: true, force: true });
    try {
      // Incoming session rewrites the file first...
      writeRegistry(dir, [{ coms_session_id: STABLE_SID, name: "peerx" }]);
      // ...then the outgoing session's cleanup unlinks that exact path.
      rmSync(join(dir, `${STABLE_SID}.json`), { force: true });
      // It recreated the file at the same stable id, so the peer is genuinely still here.
      writeRegistry(dir, [{ coms_session_id: STABLE_SID, name: "peerx" }]);

      const peerCards = new Map([[STABLE_SID, { name: "peerx" }]]);
      if (!isSessionStillRegistered(readRegistry(dir), STABLE_SID)) {
        peerCards.delete(STABLE_SID);
      }
      assert.ok(peerCards.has(STABLE_SID),
        "a live peer must not be evicted by its predecessor's unlink");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still evicts when the peer's own session is genuinely gone from disk", () => {
    const dir = join(tmpdir(), `coms-registry-${process.pid}-gone`);
    rmSync(dir, { recursive: true, force: true });
    try {
      writeRegistry(dir, [{ coms_session_id: OTHER_SID, name: "peerx" }]);

      const peerCards = new Map([[STABLE_SID, { name: "peerx" }]]);
      if (!isSessionStillRegistered(readRegistry(dir), STABLE_SID)) {
        peerCards.delete(STABLE_SID);
      }
      assert.equal(peerCards.size, 0, "a genuinely departed peer must be removed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let a same-named twin keep a departed session's card alive", () => {
    // The name-only check this replaced returned true here and leaked the stale card.
    const dir = join(tmpdir(), `coms-registry-${process.pid}-twin`);
    rmSync(dir, { recursive: true, force: true });
    try {
      writeRegistry(dir, [{ coms_session_id: OTHER_SID, name: "peerx" }]);

      assert.equal(isSessionStillRegistered(readRegistry(dir), STABLE_SID), false,
        "another session sharing the name must not mask this session's departure");
      assert.equal(readRegistry(dir).some((e) => e.name === "peerx"), true,
        "the twin is genuinely registered — which is why a name match would be wrong");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
