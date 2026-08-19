/**
 * Cursor CLI driver — per-cwd history reseed (#768 Qodo).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cursorTurnNeedsHistorySeed } from "../../../extensions/providers/cursor-cli-driver.js";

describe("cursorTurnNeedsHistorySeed", () => {
  it("does not reseed another cwd when only job-a is listed", () => {
    const listed = new Set(["/tmp/job-a"]);
    assert.equal(cursorTurnNeedsHistorySeed("/tmp/job-a", listed, false), true);
    assert.equal(cursorTurnNeedsHistorySeed("/tmp/job-b", listed, false), false);
  });

  it("global setForceHistorySeed override reseeds every cwd", () => {
    const listed = new Set<string>();
    assert.equal(cursorTurnNeedsHistorySeed("/tmp/job-b", listed, true), true);
  });
});
