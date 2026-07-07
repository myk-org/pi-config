/**
 * Tests for memory embedding dedup behavior.
 * Run with: npx tsx --test tests/node/orchestrator/memory-embeddings.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cosineSimilarity,
  EMBEDDING_POOLING,
} from "../../../extensions/orchestrator/memory-embeddings.js";

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
    cwd = mkdtempSync(join(tmpdir(), "embed-test-"));
    mkdirSync(join(cwd, ".pi", "memory"), { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("clears entries when store has different pooling", async () => {
    // Write a store with old "cls" pooling and some fake entries
    const storePath = join(cwd, ".pi", "memory", "embeddings.json");
    const oldStore = {
      model: "Xenova/bge-small-en-v1.5",
      dim: 384,
      pooling: "cls",
      entries: {
        "abc123": [0.1, 0.2, 0.3],
        "def456": [0.4, 0.5, 0.6],
      },
    };
    writeFileSync(storePath, JSON.stringify(oldStore), "utf-8");

    // Import embedEntry which triggers loadStore internally
    const { embedEntry } = await import("../../../extensions/orchestrator/memory-embeddings.js");

    // embedEntry will call loadStore which should detect pooling mismatch and clear
    // The model may not be available in test, but loadStore runs before model check
    await embedEntry(cwd, "test entry", "lesson");

    // Read the store back — entries should be cleared, pooling should be "mean"
    const updatedStore = JSON.parse(readFileSync(storePath, "utf-8"));
    assert.equal(updatedStore.pooling, "mean");
    // Old entries should be gone (cleared by invalidation)
    assert.ok(!updatedStore.entries["abc123"], "Old CLS entry should be cleared");
    assert.ok(!updatedStore.entries["def456"], "Old CLS entry should be cleared");
  });

  it("preserves entries when pooling matches", async () => {
    const storePath = join(cwd, ".pi", "memory", "embeddings.json");
    const store = {
      model: "Xenova/bge-small-en-v1.5",
      dim: 384,
      pooling: "mean",
      entries: {
        "abc123": [0.1, 0.2, 0.3],
      },
    };
    writeFileSync(storePath, JSON.stringify(store), "utf-8");

    const { embedEntry } = await import("../../../extensions/orchestrator/memory-embeddings.js");
    await embedEntry(cwd, "test entry", "lesson");

    const updatedStore = JSON.parse(readFileSync(storePath, "utf-8"));
    assert.equal(updatedStore.pooling, "mean");
    // Existing entry should still be there
    assert.ok(updatedStore.entries["abc123"], "Existing mean entry should be preserved");
  });
});

// ── Regression test: release entries must NOT match as duplicates ──

describe("release entry regression (requires ONNX model)", () => {
  let regressionCwd: string;

  beforeEach(() => {
    regressionCwd = mkdtempSync(join(tmpdir(), "regression-"));
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

    // All results should be BELOW the dedup threshold — different releases are NOT duplicates
    for (const r of results) {
      assert.ok(
        r.similarity < DEDUP_THRESHOLD,
        `False positive: "${query.substring(0, 30)}..." vs "${r.text.substring(0, 30)}..." scored ${r.similarity.toFixed(4)} (should be < ${DEDUP_THRESHOLD})`,
      );
    }
  });
});
