/**
 * Tests for open-PR parsing / cache helpers used by the status line.
 * Run with: npx tsx --test tests/node/orchestrator/git-helpers-open-pr.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearOpenPrCache,
  parseOpenPrJson,
} from "../../../extensions/orchestrator/git-helpers.js";

describe("parseOpenPrJson", () => {
  it("parses number and url", () => {
    const pr = parseOpenPrJson(
      JSON.stringify({
        number: 42,
        url: "https://github.com/org/repo/pull/42",
      }),
    );
    assert.deepEqual(pr, {
      number: 42,
      url: "https://github.com/org/repo/pull/42",
    });
  });

  it("returns null for missing fields", () => {
    assert.equal(parseOpenPrJson(JSON.stringify({ number: 1 })), null);
    assert.equal(parseOpenPrJson(JSON.stringify({ url: "https://x" })), null);
    assert.equal(parseOpenPrJson(JSON.stringify({ number: 1, url: "" })), null);
  });

  it("returns null for invalid JSON", () => {
    assert.equal(parseOpenPrJson("not-json"), null);
  });
});

describe("clearOpenPrCache", () => {
  beforeEach(() => {
    clearOpenPrCache();
  });

  it("is safe to call when empty", () => {
    clearOpenPrCache();
  });
});
