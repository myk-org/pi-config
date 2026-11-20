/**
 * Direct unit tests for shared UI WebSocket send and reconnect lifecycle helpers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clearWsReconnect,
  handleWsClose,
  queueWsReconnect,
  scheduleWsReconnect,
  trySendWs,
  wsEffectCleanup,
  type WsTimerRef,
} from "../../../extensions/shared/ui/ws-helpers.ts";
import type { Logger } from "../../../extensions/shared/ui/create-logger.ts";

function fakeLogger(): { logger: Logger; entries: Array<{ level: string; args: unknown[] }> } {
  const entries: Array<{ level: string; args: unknown[] }> = [];
  const push = (level: string) => (...args: unknown[]) => entries.push({ level, args });
  return {
    entries,
    logger: {
      debug: push("debug"),
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
      isDebugEnabled: () => true,
    },
  };
}

describe("ws-helpers", () => {
  it("trySendWs drops missing or non-open sockets and serializes open sends", () => {
    const { logger, entries } = fakeLogger();
    assert.equal(trySendWs(null, { type: "ping" }, 1, logger), false);
    assert.equal(trySendWs({ readyState: 0, send: () => {} }, { type: "ping" }, 1, logger), false);
    assert.equal(entries.filter(e => e.level === "warn").length, 2);

    const sent: string[] = [];
    assert.equal(trySendWs({ readyState: 1, send: (p) => sent.push(p) }, { type: "watch", id: "s1" }, 1, logger), true);
    assert.deepEqual(sent, [JSON.stringify({ type: "watch", id: "s1" })]);
  });

  it("handleWsClose skips reconnect on teardown and invokes reconnect on unexpected close", () => {
    const { logger } = fakeLogger();
    let reconnects = 0;
    assert.equal(handleWsClose(true, () => { reconnects++; }, logger), false);
    assert.equal(reconnects, 0);
    assert.equal(handleWsClose(false, () => { reconnects++; }, logger), true);
    assert.equal(reconnects, 1);
  });

  it("scheduleWsReconnect, queueWsReconnect, clearWsReconnect, and wsEffectCleanup manage timers cleanly", async () => {
    const { logger } = fakeLogger();
    const tearingDown = { current: false };
    const timer: WsTimerRef = { current: null };
    let connects = 0;

    scheduleWsReconnect(tearingDown, timer, () => { connects++; }, 30, logger);
    assert.notEqual(timer.current, null);
    clearWsReconnect(timer, logger);
    assert.equal(timer.current, null);

    queueWsReconnect(tearingDown, timer, () => { connects++; }, 10, logger);
    await new Promise(r => setTimeout(r, 30));
    assert.equal(connects, 1);

    let closed = false;
    queueWsReconnect(tearingDown, timer, () => { connects++; }, 30, logger);
    wsEffectCleanup(tearingDown, { close: () => { closed = true; } }, timer, logger);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(closed, true);
    assert.equal(tearingDown.current, true);
    assert.equal(connects, 1);
  });
});
