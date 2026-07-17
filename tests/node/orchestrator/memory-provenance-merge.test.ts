/**
 * Live provenance sidecar merge tests.
 * Run: npx tsx --test tests/node/orchestrator/memory-provenance-merge.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  mergeProvenancePending,
  writeProvenancePending,
  getProvenancePendingPath,
} from "../../../extensions/orchestrator/memory-provenance.js";
import {
  entryHash,
  loadScores,
  saveScores,
  type ScoredEntry,
} from "../../../extensions/orchestrator/memory-scoring.js";

describe("mergeProvenancePending", () => {
  it("merges sidecar into scores and deletes pending file", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "prov-merge-"));
    try {
      const topicsDir = path.join(cwd, ".pi", "memory", "topics");
      fs.mkdirSync(topicsDir, { recursive: true });
      const text = "Never use `git add .`";
      fs.writeFileSync(
        path.join(topicsDir, "lessons.md"),
        `# Lessons\n\n- [lesson] ${text}\n`,
      );

      const hash = entryHash(`- [lesson] ${text}`);
      const entry: ScoredEntry = {
        class: "lesson",
        score: 1,
        evidenceCount: 1,
        cue: "explicit",
        firstSeen: new Date().toISOString(),
        lastReinforced: new Date().toISOString(),
        userState: "auto",
        lifecycle: "active",
      };
      saveScores(cwd, { entries: { [hash]: entry }, lastRebuild: new Date().toISOString() });

      writeProvenancePending(cwd, [
        {
          category: "lesson",
          text,
          sourceSession: "dream-session-9",
          derivedFrom: "weekly review",
          informs: ["git"],
        },
      ]);
      assert.ok(fs.existsSync(getProvenancePendingPath(cwd)));

      const updated = mergeProvenancePending(cwd);
      assert.equal(updated, 1);
      assert.equal(fs.existsSync(getProvenancePendingPath(cwd)), false);

      const after = loadScores(cwd).entries[hash]!;
      assert.equal(after.sourceSession, "dream-session-9");
      assert.equal(after.derivedFrom, "weekly review");
      assert.deepEqual(after.informs, ["git"]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("is a no-op when sidecar missing", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "prov-empty-"));
    try {
      assert.equal(mergeProvenancePending(cwd), 0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
