/**
 * WebSocket send drop path and reconnect watch restore.
 * Run with: npx tsx --test tests/node/pidiff/ws-send.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { restoreWatchMessages, runReconnectWatch, trySendWs } from "../../../extensions/pidiff/pidiff-ui/src/lib/ws-send.ts";

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

describe("restoreWatchMessages", () => {
  it("restores a session watch when no worktree is selected", () => {
    assert.deepEqual(restoreWatchMessages(undefined, "sess"), [
      { type: "watch", sessionId: "sess" },
    ]);
  });

  it("restores session watch before worktree watch", () => {
    assert.deepEqual(restoreWatchMessages("/tmp/wt", "sess"), [
      { type: "watch", sessionId: "sess" },
      { type: "watch-worktree", worktreePath: "/tmp/wt" },
    ]);
  });
});

describe("runReconnectWatch", () => {
  it("sends nothing while disconnected", () => {
    const sent: object[] = [];
    runReconnectWatch(false, "/tmp/wt", "sess", (m) => sent.push(m));
    assert.deepEqual(sent, []);
  });

  it("App reconnect sends session watch before worktree watch", () => {
    const sent: object[] = [];
    runReconnectWatch(true, "/tmp/wt", "sess", (m) => sent.push(m));
    assert.deepEqual(sent, [
      { type: "watch", sessionId: "sess" },
      { type: "watch-worktree", worktreePath: "/tmp/wt" },
    ]);
  });
});
