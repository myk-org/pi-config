/**
 * The protection input for the dream guard (issue #1010).
 *
 * `distilledLessonTextList` decides which topic lines a dream may not delete, so it is
 * tested directly: the bounded per-review map alone would stop protecting lessons from
 * reviews older than the tracking window.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { distilledLessonTextList } from "../../../extensions/orchestrator/review-learning.js";

const STATE = "review-learning-state.json";

function dataDir(state: unknown): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "review-lessons-"));
  writeFileSync(join(dir, STATE), JSON.stringify(state), "utf-8");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("distilledLessonTextList", () => {
  it("flattens the per-review lesson texts", () => {
    const { dir, cleanup } = dataDir({
      distilledReviews: [1, 2],
      reviewLessons: { "1": ["a.ts: first lesson"], "2": ["b.ts: second lesson", "c.ts: third"] },
    });
    try {
      assert.deepEqual(distilledLessonTextList(dir).sort(), [
        "a.ts: first lesson",
        "b.ts: second lesson",
        "c.ts: third",
      ]);
    } finally {
      cleanup();
    }
  });

  it("includes lessons that outlived the per-review tracking window", () => {
    const { dir, cleanup } = dataDir({
      distilledReviews: [500],
      reviewLessons: { "500": ["recent.ts: recent lesson"] },
      protectedLessonTexts: ["old.ts: lesson from review 1"],
    });
    try {
      const texts = distilledLessonTextList(dir);
      assert.ok(texts.includes("old.ts: lesson from review 1"), "long-lived protection survives rotation");
      assert.ok(texts.includes("recent.ts: recent lesson"));
    } finally {
      cleanup();
    }
  });

  it("deduplicates a lesson recorded in both places", () => {
    const { dir, cleanup } = dataDir({
      distilledReviews: [1],
      reviewLessons: { "1": ["same.ts: once"] },
      protectedLessonTexts: ["same.ts: once"],
    });
    try {
      assert.deepEqual(distilledLessonTextList(dir), ["same.ts: once"]);
    } finally {
      cleanup();
    }
  });

  it("returns an empty list for a missing or malformed state file", () => {
    const missing = mkdtempSync(join(tmpdir(), "review-lessons-none-"));
    try {
      assert.deepEqual(distilledLessonTextList(missing), []);
    } finally {
      rmSync(missing, { recursive: true, force: true });
    }
    const { dir, cleanup } = dataDir({ reviewLessons: "not-an-object", protectedLessonTexts: [1, null] });
    try {
      assert.deepEqual(distilledLessonTextList(dir), []);
    } finally {
      cleanup();
    }
  });
});
