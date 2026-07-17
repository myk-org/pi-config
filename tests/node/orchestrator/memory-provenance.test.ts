/**
 * Tests for provenance fields on ScoredEntry surviving rebuild.
 * Run with: npx tsx --test tests/node/orchestrator/memory-provenance.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  entryHash,
  loadScores,
  rebuild,
  saveScores,
  type ScoredEntry,
} from "../../../extensions/orchestrator/memory-scoring.js";

describe("provenance fields", () => {
  it("rebuild preserves sourceSession/derivedFrom/informs", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mem-prov-"));
    try {
      const topicsDir = path.join(cwd, ".pi", "memory", "topics");
      fs.mkdirSync(topicsDir, { recursive: true });
      const text = "Prefer uv run for Python";
      fs.writeFileSync(
        path.join(topicsDir, "preferences.md"),
        `# Preferences\n\n- [preference] ${text}\n`,
        "utf-8",
      );

      const hash = entryHash(`- [preference] ${text}`);
      const entry: ScoredEntry = {
        class: "preference",
        score: 2,
        evidenceCount: 2,
        cue: "explicit",
        firstSeen: new Date().toISOString(),
        lastReinforced: new Date().toISOString(),
        userState: "auto",
        lifecycle: "active",
        sourceSession: "2026-07-17-abc",
        derivedFrom: "user said prefer uv",
        informs: ["python", "tooling"],
      };
      saveScores(cwd, { entries: { [hash]: entry }, lastRebuild: new Date().toISOString() });

      rebuild(cwd, [{ category: "preference", text, pinned: false }]);

      const after = loadScores(cwd).entries[hash];
      assert.ok(after);
      assert.equal(after!.sourceSession, "2026-07-17-abc");
      assert.equal(after!.derivedFrom, "user said prefer uv");
      assert.deepEqual(after!.informs, ["python", "tooling"]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
