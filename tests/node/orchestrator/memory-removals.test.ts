/**
 * Removal tombstones (issue #1010).
 *
 * The dream guard must distinguish "the user deleted this" from "a dream deleted this".
 * Score absence cannot tell them apart, because the scheduled rebuild prunes scores for
 * lines missing from topic files — including lines a dream removed. So removals are
 * recorded, and the guard reads that log.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { recordRemoval, removalsSince } from "../../../extensions/orchestrator/memory-tree.js";
import { entryHash } from "../../../extensions/orchestrator/memory-scoring.js";
import { makeTempDir } from "../helpers/temp-dirs.js";


const LINE = "- [lesson] A memory the user deleted on purpose";

function project(): { cwd: string; cleanup: () => void } {
  const cwd = makeTempDir("memory-removals-");
  mkdirSync(join(cwd, ".pi", "memory"), { recursive: true });
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

describe("removal tombstones", () => {
  it("records the canonical hash of a removed entry", () => {
    const { cwd, cleanup } = project();
    try {
      const startedAt = Date.now();
      recordRemoval(cwd, LINE);
      assert.ok(removalsSince(cwd, startedAt).has(entryHash(LINE)));
    } finally {
      cleanup();
    }
  });

  it("ignores removals older than the window asked about", () => {
    const { cwd, cleanup } = project();
    try {
      recordRemoval(cwd, LINE);
      assert.equal(removalsSince(cwd, Date.now() + 60_000).size, 0, "a future window sees nothing");
    } finally {
      cleanup();
    }
  });

  it("returns an empty set when no removal was ever recorded", () => {
    const { cwd, cleanup } = project();
    try {
      assert.equal(removalsSince(cwd, Date.now() - 60_000).size, 0);
    } finally {
      cleanup();
    }
  });

  it("skips malformed rows without losing the good ones", () => {
    const { cwd, cleanup } = project();
    try {
      const file = join(cwd, ".pi", "memory", "removals.jsonl");
      const good = JSON.stringify({ hash: entryHash(LINE), at: new Date().toISOString() });
      writeFileSync(file, `not-json\n{"hash":42}\n${good}\n`, "utf-8");
      const hashes = removalsSince(cwd, Date.now() - 60_000);
      assert.equal(hashes.size, 1);
      assert.ok(hashes.has(entryHash(LINE)));
    } finally {
      cleanup();
    }
  });

  it("appends rather than overwriting", () => {
    const { cwd, cleanup } = project();
    try {
      recordRemoval(cwd, LINE);
      recordRemoval(cwd, "- [done] Another removed memory");
      const rows = readFileSync(join(cwd, ".pi", "memory", "removals.jsonl"), "utf-8")
        .split("\n")
        .filter(Boolean);
      assert.equal(rows.length, 2);
    } finally {
      cleanup();
    }
  });
});
