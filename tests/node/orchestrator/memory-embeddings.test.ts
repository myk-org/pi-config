/**
 * Tests for memory embedding dedup behavior.
 * Run with: npx tsx --test tests/node/orchestrator/memory-embeddings.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  cosineSimilarity,
  EMBEDDING_POOLING,
} from "../../../extensions/orchestrator/memory-embeddings.js";
import { makeTempDir } from "../helpers/temp-dirs.js";


// Hardcoded to match NEAR_DUPLICATE_THRESHOLD in memory-tools.ts (0.90).
// Can't import directly because memory-tools.ts pulls in typebox/pi-agent deps.
// Hardcoding is intentional for regression tests — the test should fail if the
// threshold is lowered, alerting to a potential regression.
const DEDUP_THRESHOLD = 0.90;

// ── cosineSimilarity ──

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = [1, 2, 3, 4, 5];
    const sim = cosineSimilarity(v, v);
    assert.ok(Math.abs(sim - 1.0) < 0.0001);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    assert.ok(Math.abs(cosineSimilarity(a, b)) < 0.0001);
  });

  it("returns -1 for opposite vectors", () => {
    const a = [1, 0];
    const b = [-1, 0];
    assert.ok(Math.abs(cosineSimilarity(a, b) - (-1.0)) < 0.0001);
  });

  it("returns 0 for empty vectors", () => {
    assert.equal(cosineSimilarity([], []), 0);
  });

  it("returns 0 when one vector is all zeros", () => {
    assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
  });

  it("handles vectors of different lengths (uses min)", () => {
    const a = [1, 0, 0];
    const b = [1, 0];
    // Should use min length (2) — both have [1, 0] prefix
    const sim = cosineSimilarity(a, b);
    assert.ok(Math.abs(sim - 1.0) < 0.0001);
  });

  it("returns high similarity for similar vectors", () => {
    const a = [1.0, 2.0, 3.0];
    const b = [1.1, 2.1, 3.1];
    const sim = cosineSimilarity(a, b);
    assert.ok(sim > 0.99, `Expected > 0.99, got ${sim}`);
  });
});

// ── EMBEDDING_POOLING constant ──

describe("EMBEDDING_POOLING", () => {
  it("is set to mean", () => {
    assert.equal(EMBEDDING_POOLING, "mean");
  });
});

// ── Cache invalidation on pooling change ──

describe("embeddings cache invalidation", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTempDir("embed-test-");
    mkdirSync(join(cwd, ".pi", "memory"), { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("clears entries when store has different pooling", async () => {
    // Write a store with old "cls" pooling and some fake entries
    const storePath = join(cwd, ".pi", "memory", "embeddings.jsonl");
    const oldStore = {
      model: "Xenova/bge-small-en-v1.5",
      dim: 384,
      pooling: "cls",
      entries: {
        "abc123": [0.1, 0.2, 0.3],
        "def456": [0.4, 0.5, 0.6],
      },
    };
    writeFileSync(storePath, JSON.stringify(oldStore) + "\n", "utf-8");

    // Import embedEntry which triggers loadStore internally
    const { embedEntry } = await import("../../../extensions/orchestrator/memory-embeddings.js");

    // embedEntry will call loadStore which should detect pooling mismatch and clear
    // The model may not be available in test, but loadStore runs before model check
    await embedEntry(cwd, "test entry", "lesson");

    // Read the store back — last valid JSONL line has the updated state
    const raw = readFileSync(storePath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const updatedStore = JSON.parse(lines[lines.length - 1]);
    assert.equal(updatedStore.pooling, "mean");
    // Old entries should be gone (cleared by invalidation)
    assert.ok(!updatedStore.entries["abc123"], "Old CLS entry should be cleared");
    assert.ok(!updatedStore.entries["def456"], "Old CLS entry should be cleared");
  });

  it("preserves entries when pooling matches", async () => {
    const storePath = join(cwd, ".pi", "memory", "embeddings.jsonl");
    const store = {
      model: "Xenova/bge-small-en-v1.5",
      dim: 384,
      pooling: "mean",
      entries: {
        "abc123": [0.1, 0.2, 0.3],
      },
    };
    writeFileSync(storePath, JSON.stringify(store) + "\n", "utf-8");

    const { embedEntry } = await import("../../../extensions/orchestrator/memory-embeddings.js");
    await embedEntry(cwd, "test entry", "lesson");

    const raw = readFileSync(storePath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const updatedStore = JSON.parse(lines[lines.length - 1]);
    assert.equal(updatedStore.pooling, "mean");
    // Existing entry should still be there
    assert.ok(updatedStore.entries["abc123"], "Existing mean entry should be preserved");
  });
});

// ── Regression test: release entries must NOT match as duplicates ──

describe("release entry regression (requires ONNX model)", () => {
  let regressionCwd: string;

  beforeEach(() => {
    regressionCwd = makeTempDir("regression-");
    mkdirSync(join(regressionCwd, ".pi", "memory"), { recursive: true });
  });

  afterEach(() => {
    rmSync(regressionCwd, { recursive: true, force: true });
  });

  it("different release entries score below threshold with mean pooling", async () => {
    const { isVectorSearchAvailable, vectorSearch, embedEntry, embedMissing } = await import(
      "../../../extensions/orchestrator/memory-embeddings.js"
    );

    const available = await isVectorSearchAvailable();
    if (!available) {
      // Skip gracefully when ONNX model is not available (CI without model download)
      console.log("  ℹ Skipping: ONNX model not available");
      return;
    }

    const entries = [
      { text: "v3.12.4 released — 4th docs reviewer, PR review improvements", category: "done", pinned: false },
      { text: "v3.12.0 released — memory enforcement, review guidelines, suggestion blocks", category: "done", pinned: false },
    ];

    await embedMissing(regressionCwd, entries);

    const query = "v3.13.1 released — per-worktree review state, author question detection, two-way review process";
    await embedEntry(regressionCwd, query, "done");
    const results = await vectorSearch(regressionCwd, query, entries, 5);

    // Must have results — empty array would make the loop a vacuous pass
    assert.ok(results.length > 0, `vectorSearch returned no results — embeddings may have failed`);

    // All results should be BELOW the dedup threshold — different releases are NOT duplicates
    for (const r of results) {
      assert.ok(
        r.similarity < DEDUP_THRESHOLD,
        `False positive: "${query.substring(0, 30)}..." vs "${r.text.substring(0, 30)}..." scored ${r.similarity.toFixed(4)} (should be < ${DEDUP_THRESHOLD})`,
      );
    }
  });
});

// ── Orphan pruning, expiry cleanup, and snapshot compaction (#1202) ──

describe("embedding pruning and compaction (#1202)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTempDir("embed-prune-");
    mkdirSync(join(cwd, ".pi", "memory", "topics"), { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("pruneEmbeddings drops orphan keys and keeps live entries", async () => {
    const { createHash } = await import("node:crypto");
    const key = (text: string, cat: string) =>
      createHash("sha256").update(`[${cat}] ${text}`).digest("hex").slice(0, 16);

    const liveKey = key("Keep me", "lesson");
    const storePath = join(cwd, ".pi", "memory", "embeddings.jsonl");
    writeFileSync(
      storePath,
      JSON.stringify({
        model: "Xenova/bge-small-en-v1.5",
        dim: 384,
        pooling: "mean",
        entries: {
          [liveKey]: [1, 0, 0],
          orphan_one: [0, 1, 0],
          orphan_two: [0, 0, 1],
        },
      }) + "\n",
      "utf-8",
    );

    const { pruneEmbeddings } = await import("../../../extensions/orchestrator/memory-embeddings.js");
    const pruned = pruneEmbeddings(cwd, [{ text: "Keep me", category: "lesson" }]);
    assert.equal(pruned, 2);

    const raw = readFileSync(storePath, "utf-8").trim().split("\n");
    const latest = JSON.parse(raw[raw.length - 1]!);
    assert.deepEqual(Object.keys(latest.entries), [liveKey]);
  });

  it("rebuildAndOrganize prunes orphaned embeddings and expired entries remove their embeddings", async () => {
    const { createHash } = await import("node:crypto");
    const key = (text: string, cat: string) =>
      createHash("sha256").update(`[${cat}] ${text}`).digest("hex").slice(0, 16);

    const liveText = "Live rule";
    const expiredText = "Expired session rule";
    const liveKey = key(liveText, "lesson");
    const expiredKey = key(expiredText, "lesson");

    writeFileSync(
      join(cwd, ".pi", "memory", "topics", "lessons.md"),
      `# Lessons\n\n- [lesson] ${liveText}\n- [lesson] ${expiredText}\n`,
      "utf-8",
    );

    const { entryHash, saveScores } = await import("../../../extensions/orchestrator/memory-scoring.js");
    saveScores(cwd, {
      entries: {
        [entryHash(`- [lesson] ${liveText}`)]: {
          class: "lesson",
          score: 1,
          evidenceCount: 1,
          cue: "explicit",
          firstSeen: new Date().toISOString(),
          lastReinforced: new Date().toISOString(),
          userState: "auto",
          lifecycle: "active",
        },
        [entryHash(`- [lesson] ${expiredText}`)]: {
          class: "lesson",
          score: 1,
          evidenceCount: 1,
          cue: "explicit",
          firstSeen: new Date().toISOString(),
          lastReinforced: new Date().toISOString(),
          userState: "auto",
          lifecycle: "active",
          scope: "session",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
      },
      lastRebuild: new Date().toISOString(),
    });

    const storePath = join(cwd, ".pi", "memory", "embeddings.jsonl");
    writeFileSync(
      storePath,
      JSON.stringify({
        model: "Xenova/bge-small-en-v1.5",
        dim: 384,
        pooling: "mean",
        entries: {
          [liveKey]: [1, 0],
          [expiredKey]: [0, 1],
          stale_dream_orphan: [1, 1],
        },
      }) + "\n",
      "utf-8",
    );

    const { rebuildAndOrganize } = await import("../../../extensions/orchestrator/situation-report.js");
    rebuildAndOrganize(cwd);

    const raw = readFileSync(storePath, "utf-8").trim().split("\n");
    const latest = JSON.parse(raw[raw.length - 1]!);
    assert.deepEqual(Object.keys(latest.entries), [liveKey]);
  });

  it("compacts embeddings.jsonl at compactThreshold=3", async () => {
    const { createHash } = await import("node:crypto");
    const key = (text: string) =>
      createHash("sha256").update(`[lesson] ${text}`).digest("hex").slice(0, 16);

    const storePath = join(cwd, ".pi", "memory", "embeddings.jsonl");
    const initialEntries: Record<string, number[]> = {};
    for (let i = 0; i < 5; i++) initialEntries[key(`item-${i}`)] = [i, 1];
    writeFileSync(
      storePath,
      JSON.stringify({
        model: "Xenova/bge-small-en-v1.5",
        dim: 384,
        pooling: "mean",
        entries: initialEntries,
      }) + "\n",
      "utf-8",
    );

    const { removeEmbedding } = await import("../../../extensions/orchestrator/memory-embeddings.js");
    // Initial file has 1 line; 2 removals reach compactThreshold=3 -> compacts to 1 line
    removeEmbedding(cwd, "item-0", "lesson");
    assert.equal(readFileSync(storePath, "utf-8").trim().split("\n").length, 2);
    removeEmbedding(cwd, "item-1", "lesson");
    const linesAfterCompact = readFileSync(storePath, "utf-8").trim().split("\n");
    assert.equal(linesAfterCompact.length, 1, `expected compacted single line, got ${linesAfterCompact.length}`);
    // Subsequent removals stay bounded below compactThreshold
    removeEmbedding(cwd, "item-2", "lesson");
    assert.equal(readFileSync(storePath, "utf-8").trim().split("\n").length, 2);
  });
});
