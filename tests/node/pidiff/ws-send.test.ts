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
  scheduleWsReconnect,
  trySendWs,
  wsEffectCleanup,
} from "../../../extensions/pidiff/pidiff-ui/src/lib/ws-send.ts";
import { AppReconnectWatch } from "../../../extensions/pidiff/pidiff-ui/src/lib/app-reconnect-watch.tsx";

(globalThis as { __PIDIFF_DEBUG?: boolean }).__PIDIFF_DEBUG = true;

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
    log.debug("restoreWatchMessages session only");
    assert.deepEqual(restoreWatchMessages(undefined, "sess"), [
      { type: "watch", sessionId: "sess" },
    ]);
  });

  it("restores session watch before worktree watch", () => {
    log.debug("restoreWatchMessages session then worktree");
    assert.deepEqual(restoreWatchMessages("/tmp/wt", "sess"), [
      { type: "watch", sessionId: "sess" },
      { type: "watch-worktree", worktreePath: "/tmp/wt" },
    ]);
  });
});

describe("runReconnectWatch", () => {
  it("sends nothing while disconnected", () => {
    log.debug("runReconnectWatch disconnected");
    const sent: object[] = [];
    runReconnectWatch(false, "/tmp/wt", "sess", (m) => sent.push(m));
    assert.deepEqual(sent, []);
  });

  it("App reconnect sends session watch before worktree watch", () => {
    log.debug("runReconnectWatch connected");
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
    log.debug("appReconnectEffect disconnected");
    const sent: object[] = [];
    appReconnectEffect(false, "/tmp/wt", "sess", (m) => sent.push(m));
    assert.deepEqual(sent, []);
  });

  it("App effect restores watches after reconnect", () => {
    log.debug("appReconnectEffect reconnect");
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
    log.debug("handleWsClose teardown");
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
    log.debug("handleWsClose unexpected");
    let reconnects = 0;
    const scheduled = handleWsClose(false, () => { reconnects += 1; });
    assert.equal(scheduled, true);
    assert.equal(reconnects, 1);
  });
});

describe("scheduleWsReconnect", () => {
  it("cleanup cancels a pending reconnect", async () => {
    log.debug("scheduleWsReconnect cleanup");
    const tearingDown = { current: false };
    const timer: { current: ReturnType<typeof setTimeout> | null } = { current: null };
    let connects = 0;
    scheduleWsReconnect(tearingDown, timer, () => { connects += 1; }, 30);
    wsEffectCleanup(tearingDown, { close() {} }, timer);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(connects, 0);
    assert.equal(timer.current, null);
  });

  it("unexpected close still reconnects when mounted", async () => {
    log.debug("scheduleWsReconnect fire");
    const tearingDown = { current: false };
    const timer: { current: ReturnType<typeof setTimeout> | null } = { current: null };
    let connects = 0;
    handleWsClose(false, () => {
      scheduleWsReconnect(tearingDown, timer, () => { connects += 1; }, 0);
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(connects, 1);
  });
});

describe("AppReconnectWatch", () => {
  it("App effect skips watch while disconnected", () => {
    log.debug("AppReconnectWatch disconnected");
    const sent: object[] = [];
    AppReconnectWatch({
      connected: false,
      worktreePath: "/tmp/wt",
      sessionId: "sess",
      send: (m) => sent.push(m),
      effectHook: (fn) => { fn(); },
    });
    assert.deepEqual(sent, []);
  });

  it("App effect restores watches after reconnect", () => {
    log.debug("AppReconnectWatch reconnect");
    const sent: object[] = [];
    const effectHook = (fn: () => void) => { fn(); };
    AppReconnectWatch({
      connected: false,
      worktreePath: "/tmp/wt",
      sessionId: "sess",
      send: (m) => sent.push(m),
      effectHook,
    });
    AppReconnectWatch({
      connected: true,
      worktreePath: "/tmp/wt",
      sessionId: "sess",
      send: (m) => sent.push(m),
      effectHook,
    });
    assert.deepEqual(sent, [
      { type: "watch", sessionId: "sess" },
      { type: "watch-worktree", worktreePath: "/tmp/wt" },
    ]);
  });
});
