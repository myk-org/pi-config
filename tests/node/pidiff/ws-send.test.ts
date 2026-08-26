/**
 * WebSocket send drop path and reconnect watch restore.
 * Run with: npx tsx --test tests/node/pidiff/ws-send.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../../../extensions/pidiff/pidiff-ui/src/lib/create-logger.ts";
import {
  appReconnectEffect,
  handleWsClose,
  restoreWatchMessages,
  runReconnectWatch,
  trySendWs,
  wsEffectCleanup,
} from "../../../extensions/pidiff/pidiff-ui/src/lib/ws-send.ts";

const log = createLogger("pidiff-ui");

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
    log.info("restoreWatchMessages session only");
    assert.deepEqual(restoreWatchMessages(undefined, "sess"), [
      { type: "watch", sessionId: "sess" },
    ]);
  });

  it("restores session watch before worktree watch", () => {
    log.info("restoreWatchMessages session then worktree");
    assert.deepEqual(restoreWatchMessages("/tmp/wt", "sess"), [
      { type: "watch", sessionId: "sess" },
      { type: "watch-worktree", worktreePath: "/tmp/wt" },
    ]);
  });
});

describe("runReconnectWatch", () => {
  it("sends nothing while disconnected", () => {
    log.info("runReconnectWatch disconnected");
    const sent: object[] = [];
    runReconnectWatch(false, "/tmp/wt", "sess", (m) => sent.push(m));
    assert.deepEqual(sent, []);
  });

  it("App reconnect sends session watch before worktree watch", () => {
    log.info("runReconnectWatch connected");
    const sent: object[] = [];
    runReconnectWatch(true, "/tmp/wt", "sess", (m) => sent.push(m));
    assert.deepEqual(sent, [
      { type: "watch", sessionId: "sess" },
      { type: "watch-worktree", worktreePath: "/tmp/wt" },
    ]);
  });
});

describe("appReconnectEffect", () => {
  it("App effect skips watch while disconnected", () => {
    log.info("appReconnectEffect disconnected");
    const sent: object[] = [];
    appReconnectEffect(false, "/tmp/wt", "sess", (m) => sent.push(m));
    assert.deepEqual(sent, []);
  });

  it("App effect restores watches after reconnect", () => {
    log.info("appReconnectEffect reconnect");
    const sent: object[] = [];
    appReconnectEffect(false, "/tmp/wt", "sess", (m) => sent.push(m));
    appReconnectEffect(true, "/tmp/wt", "sess", (m) => sent.push(m));
    assert.deepEqual(sent, [
      { type: "watch", sessionId: "sess" },
      { type: "watch-worktree", worktreePath: "/tmp/wt" },
    ]);
  });
});

describe("handleWsClose", () => {
  it("cleanup close does not schedule reconnect", () => {
    log.info("handleWsClose teardown");
    const tearingDown = { current: false };
    let closed = 0;
    let reconnects = 0;
    wsEffectCleanup(tearingDown, { close: () => { closed += 1; } });
    const scheduled = handleWsClose(tearingDown.current, () => { reconnects += 1; });
    assert.equal(tearingDown.current, true);
    assert.equal(closed, 1);
    assert.equal(scheduled, false);
    assert.equal(reconnects, 0);
  });

  it("unexpected close schedules reconnect", () => {
    log.info("handleWsClose unexpected");
    let reconnects = 0;
    const scheduled = handleWsClose(false, () => { reconnects += 1; });
    assert.equal(scheduled, true);
    assert.equal(reconnects, 1);
  });
});
