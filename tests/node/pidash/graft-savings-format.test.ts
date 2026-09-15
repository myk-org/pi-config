import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatCompactTotal, formatExactTotal } from "../../../extensions/pidash/pidash-ui/src/lib/format-total.ts";

describe("Graft savings formatting", () => {
  it("keeps small totals exact and rounds thousands and millions compactly", () => {
    assert.equal(formatCompactTotal(0), "0");
    assert.equal(formatCompactTotal(999), "999");
    assert.equal(formatCompactTotal(1_000), "1k");
    assert.equal(formatCompactTotal(1_250), "1.3k");
    assert.equal(formatCompactTotal(1_098_359), "1.1M");
  });

  it("keeps the detail exact and preserves absent values", () => {
    assert.equal(formatCompactTotal(undefined), undefined);
    assert.equal(formatExactTotal(undefined), undefined);
    assert.equal(formatExactTotal(1_098_359), "1,098,359");
  });

  it("records debug formatter paths without values in the browser", () => {
    const state = globalThis as typeof globalThis & {
      __PIDASH_DEBUG?: boolean;
      __pidashUiLogs?: Array<{ msg: string }>;
    };
    state.__PIDASH_DEBUG = true;
    state.__pidashUiLogs = [];
    formatCompactTotal(1_234);
    formatExactTotal(5_678);
    assert.deepEqual(state.__pidashUiLogs.map(({ msg }) => msg), ["formatCompactTotal compact", "formatExactTotal present"]);
    assert.doesNotMatch(JSON.stringify(state.__pidashUiLogs), /1234|5678/);
    delete state.__PIDASH_DEBUG;
    delete state.__pidashUiLogs;
  });
});
