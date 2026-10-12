/**
 * Score-key migration and stable-id binding tests (issue #915).
 * Run: npx tsx --test tests/node/orchestrator/memory-scoring-migration.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonlStateStore } from "../../../extensions/orchestrator/state-jsonl.js";
import {
  entryHash,
  legacyFnvHash,
  loadScores,
  rebuild,
  type ScoredEntry,
} from "../../../extensions/orchestrator/memory-scoring.js";
import { readAllTopicEntries } from "../../../extensions/orchestrator/memory-tree.js";

function makeCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memory-migrate-"));
}

function seedLegacyScores(
  cwd: string,
  entries: Record<string, ScoredEntry>,
): void {
  const store = new JsonlStateStore<{ entries: Record<string, ScoredEntry>; lastRebuild: string }>(
    path.join(cwd, ".pi", "memory", "memory-scores.jsonl"),
  );
  // No hashAlgo marker — exactly like a pre-#915 store
  store.write({ entries, lastRebuild: new Date().toISOString() });
}

function baseEntry(overrides: Partial<ScoredEntry> = {}): ScoredEntry {
  return {
    class: "lesson",
    score: 1,
    evidenceCount: 2,
    cue: "explicit",
    firstSeen: new Date().toISOString(),
    lastReinforced: new Date().toISOString(),
    userState: "auto",
    lifecycle: "active",
    ...overrides,
  };
}

describe("score key migration (FNV-1a → SHA-256)", () => {
  it("re-keys entries with topic lines, drops non-enforced orphans, marks hashAlgo", () => {
    const cwd = makeCwd();
    try {
      const topicsDir = path.join(cwd, ".pi", "memory", "topics");
      fs.mkdirSync(topicsDir, { recursive: true });
      const kept = "- [lesson] Keep tests fast";
      fs.writeFileSync(path.join(topicsDir, "lessons.md"), `# Lessons\n\n${kept}\n`);

      const keptLegacyKey = legacyFnvHash(kept);
      const orphanLegacyKey = legacyFnvHash("- [lesson] Orphaned entry with no topic line");
      seedLegacyScores(cwd, {
        [keptLegacyKey]: baseEntry(),
        [orphanLegacyKey]: baseEntry(),
      });

      const scores = loadScores(cwd);
      assert.equal(scores.hashAlgo, "sha256-16");
      // Kept entry is re-keyed to the SHA-256 of its canonical line
      assert.ok(scores.entries[entryHash(kept)], "kept entry re-keyed to sha key");
      assert.equal(scores.entries[entryHash(kept)]!.evidenceCount, 2);
      // Non-enforced orphan is dropped — the rebuild would delete it anyway
      assert.ok(!scores.entries[orphanLegacyKey], "non-enforced orphan dropped");
      // No legacy keys remain
      for (const key of Object.keys(scores.entries)) {
        assert.match(key, /^[0-9a-f]{16}$|^id:[0-9a-f]{8}$/, `clean key format: ${key}`);
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("re-keys enforced orphans to id-based keys so they keep enforcing", () => {
    const cwd = makeCwd();
    try {
      const enforcedOrphan = baseEntry({
        trigger: "bash_contains git push --force" as any,
        action: "block",
      });
      const legacyKey = legacyFnvHash("- [lesson] Old text that was reworded away");
      seedLegacyScores(cwd, { [legacyKey]: enforcedOrphan });

      const scores = loadScores(cwd);
      const keys = Object.keys(scores.entries);
      assert.equal(keys.length, 1);
      assert.match(keys[0]!, /^id:[0-9a-f]{8}$/);
      // Enforcement fields survive the migration
      assert.equal(scores.entries[keys[0]!]!.action, "block");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("is idempotent — a second load does not re-migrate", () => {
    const cwd = makeCwd();
    try {
      const topicsDir = path.join(cwd, ".pi", "memory", "topics");
      fs.mkdirSync(topicsDir, { recursive: true });
      const line = "- [lesson] Stable entry";
      fs.writeFileSync(path.join(topicsDir, "lessons.md"), `# Lessons\n\n${line}\n`);
      seedLegacyScores(cwd, { [legacyFnvHash(line)]: baseEntry() });

      const first = loadScores(cwd);
      const firstKey = entryHash(line);
      assert.ok(first.entries[firstKey]);
      // Second load — no change, no duplicate writes
      const second = loadScores(cwd);
      assert.deepEqual(Object.keys(second.entries), [firstKey]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("stable-id enforcement binding", () => {
  it("re-binds an enforced score entry to a reworded topic line via {#id} marker", () => {
    const cwd = makeCwd();
    try {
      const topicsDir = path.join(cwd, ".pi", "memory", "topics");
      fs.mkdirSync(topicsDir, { recursive: true });
      // Dream reworded the line — the id marker survived
      fs.writeFileSync(
        path.join(topicsDir, "lessons.md"),
        `# Lessons\n\n- [lesson] Never force-push to main *(enforced)* {#deadbeef}\n`,
      );

      // Score entry still keyed by the OLD text hash, carrying the same id
      const oldHash = entryHash("- [lesson] Never force-push (old wording)");
      const enforced = baseEntry({
        id: "deadbeef",
        trigger: "bash_contains push --force" as any,
        action: "block",
      });
      const store = new JsonlStateStore<{ entries: Record<string, ScoredEntry>; lastRebuild: string; hashAlgo?: string }>(
        path.join(cwd, ".pi", "memory", "memory-scores.jsonl"),
      );
      store.write({ entries: { [oldHash]: enforced }, lastRebuild: new Date().toISOString(), hashAlgo: "sha256-16" });

      // Rebuild should self-heal the binding via the id marker
      rebuild(cwd, readAllTopicEntries(cwd));

      const scores = loadScores(cwd);
      const newHash = entryHash("- [lesson] Never force-push to main");
      const reBound = scores.entries[newHash];
      assert.ok(reBound, "enforced entry re-bound to the reworded line's hash");
      assert.equal(reBound!.action, "block");
      assert.equal(reBound!.id, "deadbeef");
      assert.ok(!scores.entries[oldHash], "old orphan key removed");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
