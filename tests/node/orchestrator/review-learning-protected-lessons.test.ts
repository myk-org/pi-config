/**
 * The protection input for the dream guard (issue #1010).
 *
 * `distilledLessonTextList` decides which topic lines a dream may not delete, so it is
 * tested directly: the bounded per-review map alone would stop protecting lessons from
 * reviews older than the tracking window.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  distilledLessonTextList,
  recordReviewLessons,
} from "../../../extensions/orchestrator/review-learning.js";
import { makeTempDir, removeTempDirs } from "../helpers/temp-dirs.js";

after(removeTempDirs);

const STATE = "review-learning-state.json";

function dataDir(state: unknown): { dir: string; cleanup: () => void } {
  const dir = makeTempDir("review-lessons-");
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
    const missing = makeTempDir("review-lessons-none-");
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

  it("persists the protection list when lessons are recorded", () => {
    const { dir, cleanup } = dataDir({ distilledReviews: [], reviewLessons: {} });
    try {
      recordReviewLessons(dir, 42, ["persisted.ts: written through the state writer"]);
      const state = JSON.parse(readFileSync(join(dir, STATE), "utf-8"));
      assert.deepEqual(state.protectedLessonTexts, ["persisted.ts: written through the state writer"]);
      assert.ok(distilledLessonTextList(dir).includes("persisted.ts: written through the state writer"));
    } finally {
      cleanup();
    }
  });

  it("keeps an old lesson protected after the per-review window rotates it out", () => {
    const { dir, cleanup } = dataDir({ distilledReviews: [], reviewLessons: {} });
    try {
      recordReviewLessons(dir, 1, ["oldest.ts: the first lesson ever written"]);
      for (let id = 2; id <= 260; id += 1) recordReviewLessons(dir, id, [`review-${id}.ts: lesson ${id}`]);
      const state = JSON.parse(readFileSync(join(dir, STATE), "utf-8"));
      assert.equal(Object.keys(state.reviewLessons).length, 200, "the per-review map is bounded");
      assert.ok(
        state.protectedLessonTexts.includes("oldest.ts: the first lesson ever written"),
        "the long-lived list outlives the rotation",
      );
      assert.ok(distilledLessonTextList(dir).includes("oldest.ts: the first lesson ever written"));
    } finally {
      cleanup();
    }
  });
});
