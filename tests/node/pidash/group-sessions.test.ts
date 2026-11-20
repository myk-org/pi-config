/**
 * Verify groupAndSortSessions groups by project name, places active groups and
 * active sessions first, and sorts groups alphabetically within each tier (#1176).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupAndSortSessions } from "../../../extensions/pidash/pidash-ui/src/lib/group-sessions.ts";
import type { SessionInfo } from "../../../extensions/shared/types.ts";

function makeSession(sessionId: string, cwd: string, active: boolean): SessionInfo {
  return {
    sessionId,
    pid: 1,
    cwd,
    branch: "main",
    model: "m",
    startedAt: "2026-01-01T00:00:00Z",
    lastActivity: 0,
    active,
  };
}

describe("groupAndSortSessions", () => {
  it("orders active groups first, then alphabetical, and active sessions first within groups", () => {
    const groups = groupAndSortSessions([
      makeSession("z-idle", "/work/zebra", false),
      makeSession("b-idle", "/work/beta", false),
      makeSession("b-active", "/work/beta", true),
      makeSession("a-active", "/work/alpha", true),
      makeSession("y-idle", "/work/aardvark", false),
    ]);

    assert.deepEqual(groups.map(g => g.name), ["alpha", "beta", "aardvark", "zebra"]);
    assert.deepEqual(groups[1].sessions.map(s => s.sessionId), ["b-active", "b-idle"]);
  });

  it("handles empty session lists", () => {
    assert.deepEqual(groupAndSortSessions([]), []);
  });
});
