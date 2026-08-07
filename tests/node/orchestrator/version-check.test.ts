import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareSemver, MIN_PI_VERSION } from "../../../extensions/orchestrator/utils.js";

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

describe("MIN_PI_VERSION", () => {
  it("requires 0.84.0 for registerMarkdownTransformer", () => {
    assert.strictEqual(MIN_PI_VERSION, "0.84.0");
  });
});
