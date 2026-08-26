/**
 * WebSocket send drop path and reconnect watch restore.
 * Run with: npx tsx --test tests/node/pidiff/ws-send.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { restoreWatchMessage, trySendWs } from "../../../extensions/pidiff/pidiff-ui/src/lib/ws-send.ts";

describe("trySendWs", () => {
  it("returns false when the socket is missing", () => {
    assert.equal(trySendWs(null, { type: "request-diffs" }, 1), false);
  });

  it("returns false when the socket is not open", () => {
    const sent: string[] = [];
    const ws = { readyState: 0, send: (s: string) => { sent.push(s); } };
    assert.equal(trySendWs(ws, { type: "request-diffs" }, 1), false);
    assert.deepEqual(sent, []);
  });

  it("serializes the payload when the socket is open", () => {
    const sent: string[] = [];
    const ws = { readyState: 1, send: (s: string) => { sent.push(s); } };
    assert.equal(trySendWs(ws, { type: "request-diffs", mode: "branch" }, 1), true);
    assert.deepEqual(sent, [JSON.stringify({ type: "request-diffs", mode: "branch" })]);
  });
});

describe("restoreWatchMessage", () => {
  it("restores a worktree watch when a worktree is selected", () => {
    assert.deepEqual(restoreWatchMessage("/tmp/wt", "sess"), {
      type: "watch-worktree",
      worktreePath: "/tmp/wt",
    });
  });

  it("restores a session watch when no worktree is selected", () => {
    assert.deepEqual(restoreWatchMessage(undefined, "sess"), {
      type: "watch",
      sessionId: "sess",
    });
  });
});
