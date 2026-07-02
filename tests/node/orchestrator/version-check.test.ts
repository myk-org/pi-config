/**
 * Tests for pi version check logic.
 * Run with: npx tsx --test tests/node/orchestrator/version-check.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Replicate compareSemver logic from utils.ts for testing
function compareSemver(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

describe("compareSemver", () => {
  it("equal versions return 0", () => {
    assert.strictEqual(compareSemver("0.80.3", "0.80.3"), 0);
  });

  it("a < b returns -1", () => {
    assert.strictEqual(compareSemver("0.79.0", "0.80.3"), -1);
    assert.strictEqual(compareSemver("0.80.2", "0.80.3"), -1);
  });

  it("a > b returns 1", () => {
    assert.strictEqual(compareSemver("0.81.0", "0.80.3"), 1);
    assert.strictEqual(compareSemver("1.0.0", "0.80.3"), 1);
  });

  it("handles prerelease suffix correctly", () => {
    // 0.80.4-beta should compare as 0.80.4 (greater than 0.80.3)
    assert.strictEqual(compareSemver("0.80.4-beta", "0.80.3"), 1);
    // 0.80.3-rc1 should compare as 0.80.3 (equal to 0.80.3)
    assert.strictEqual(compareSemver("0.80.3-rc1", "0.80.3"), 0);
  });

  it("handles build metadata", () => {
    assert.strictEqual(compareSemver("0.80.3-beta.1", "0.80.3"), 0);
  });

  it("handles different length versions", () => {
    assert.strictEqual(compareSemver("1.0", "1.0.0"), 0);
    assert.strictEqual(compareSemver("1.0.1", "1.0"), 1);
  });

  it("major version difference", () => {
    assert.strictEqual(compareSemver("2.0.0", "1.99.99"), 1);
  });
});
