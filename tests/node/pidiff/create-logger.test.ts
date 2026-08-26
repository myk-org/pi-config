/**
 * Browser-safe pidiff-ui createLogger.
 * Run with: npx tsx --test tests/node/pidiff/create-logger.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../../../extensions/pidiff/pidiff-ui/src/lib/create-logger.ts";

type Bag = { __pidiffUiLogs?: Array<{ name: string; level: string; msg: string }>; __PIDIFF_DEBUG?: boolean };

function bag(): Bag {
  return globalThis as Bag;
}

beforeEach(() => {
  bag().__pidiffUiLogs = [];
  bag().__PIDIFF_DEBUG = false;
});

describe("createLogger", () => {
  it("stores info warn error lines on globalThis", () => {
    const log = createLogger("pidiff-ui");
    log.info("hello", { n: 1 });
    log.warn("careful");
    log.error("boom");
    const lines = bag().__pidiffUiLogs ?? [];
    assert.equal(lines.length, 3);
    assert.equal(lines[0].name, "pidiff-ui");
    assert.equal(lines[0].level, "info");
    assert.match(lines[0].msg, /hello/);
    assert.equal(lines[1].level, "warn");
    assert.equal(lines[2].level, "error");
  });

  it("omits debug lines unless __PIDIFF_DEBUG is set", () => {
    const log = createLogger("pidiff-ui");
    log.debug("hidden");
    assert.equal((bag().__pidiffUiLogs ?? []).length, 0);
    assert.equal(log.isDebugEnabled(), false);
    bag().__PIDIFF_DEBUG = true;
    const debugLog = createLogger("pidiff-ui");
    debugLog.debug("shown");
    assert.equal(debugLog.isDebugEnabled(), true);
    assert.equal((bag().__pidiffUiLogs ?? []).at(-1)?.level, "debug");
  });

  it("falls back to String when JSON.stringify throws", () => {
    const log = createLogger("pidiff-ui");
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    log.info(cyclic);
    const msg = (bag().__pidiffUiLogs ?? [])[0]?.msg ?? "";
    assert.ok(msg.includes("[object Object]") || msg.length > 0);
  });
});
