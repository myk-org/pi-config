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
});
