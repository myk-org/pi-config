/**
 * Tests for open-PR refresh staleness guard used by the status line.
 * Run with: npx tsx --test tests/node/orchestrator/status-line-open-pr-refresh.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldApplyOpenPrRefresh } from "../../../extensions/orchestrator/status-line.js";

describe("shouldApplyOpenPrRefresh", () => {
  it("returns false when lastCtx is missing", () => {
    assert.equal(shouldApplyOpenPrRefresh(null, "main", "/repo:main"), false);
  });

  it("returns false when lastBranch is null", () => {
    assert.equal(
      shouldApplyOpenPrRefresh({ cwd: "/repo" }, null, "/repo:main"),
      false,
    );
  });

  it("returns false after branch switch", () => {
    assert.equal(
      shouldApplyOpenPrRefresh({ cwd: "/repo" }, "feat", "/repo:main"),
      false,
    );
  });

  it("returns false after cwd switch", () => {
    assert.equal(
      shouldApplyOpenPrRefresh({ cwd: "/other" }, "main", "/repo:main"),
      false,
    );
  });

  it("returns true when cwd and branch still match", () => {
    assert.equal(
      shouldApplyOpenPrRefresh({ cwd: "/repo" }, "main", "/repo:main"),
      true,
    );
  });
});
