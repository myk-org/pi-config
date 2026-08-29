/** Browser-safe pidash UI logger. */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../../../extensions/pidash/pidash-ui/src/lib/create-logger.ts";

type LogLine = { name: string; level: string; msg: string };
type Bag = { __pidashUiLogs?: LogLine[]; __PIDASH_DEBUG?: boolean };

function bag(): Bag {
  return globalThis as Bag;
}

beforeEach(() => {
  bag().__pidashUiLogs = [];
  bag().__PIDASH_DEBUG = false;
});

describe("pidash UI createLogger", () => {
  it("captures formatted info warn and error records", () => {
    const log = createLogger("pidash-ui");
    log.info("connected", { sessionId: "s-1" });
    log.warn("retrying");
    log.error("failed");

    assert.deepEqual(bag().__pidashUiLogs, [
      { name: "pidash-ui", level: "info", msg: 'connected {"sessionId":"s-1"}' },
      { name: "pidash-ui", level: "warn", msg: "retrying" },
      { name: "pidash-ui", level: "error", msg: "failed" },
    ]);
  });

  it("emits debug records only while debug is enabled", () => {
    const log = createLogger("pidash-ui");
    log.debug("hidden");
    assert.equal(bag().__pidashUiLogs?.length, 0);
    assert.equal(log.isDebugEnabled(), false);

    bag().__PIDASH_DEBUG = true;
    log.debug("shown");
    assert.equal(log.isDebugEnabled(), true);
    assert.deepEqual(bag().__pidashUiLogs, [{ name: "pidash-ui", level: "debug", msg: "shown" }]);
  });

  it("keeps only the most recent bounded number of records", () => {
    const log = createLogger("pidash-ui");
    for (let index = 0; index < 201; index++) log.info(`entry-${index}`);

    const logs = bag().__pidashUiLogs ?? [];
    assert.equal(logs.length, 200);
    assert.equal(logs[0]?.msg, "entry-1");
    assert.equal(logs.at(-1)?.msg, "entry-200");
  });
});
