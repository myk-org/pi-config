/**
 * Situation report query-class budget / ordering shifts.
 * Run: npx tsx --test tests/node/orchestrator/situation-report-query-class.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSituationReport } from "../../../extensions/orchestrator/situation-report.js";
import {
  entryHash,
  saveScores,
  type ScoredEntry,
} from "../../../extensions/orchestrator/memory-scoring.js";
import { writePromotions, promotionId } from "../../../extensions/orchestrator/promotion-queue.js";

function seed(cwd: string): void {
  const topicsDir = path.join(cwd, ".pi", "memory", "topics");
  fs.mkdirSync(topicsDir, { recursive: true });

  const rows: { cat: ScoredEntry["class"]; file: string; text: string }[] = [
    { cat: "preference", file: "preferences.md", text: "Prefer uv run for Python" },
    { cat: "lesson", file: "lessons.md", text: "Always ask before force push" },
    { cat: "mistake", file: "mistakes.md", text: "Do not swallow stack traces" },
    { cat: "pattern", file: "patterns.md", text: "Review PRs with checklist" },
    { cat: "decision", file: "decisions.md", text: "Use tox for full verify" },
  ];

  const scores: Record<string, ScoredEntry> = {};
  for (const r of rows) {
    fs.writeFileSync(
      path.join(topicsDir, r.file),
      `# ${r.file}\n\n- [${r.cat}] ${r.text}\n`,
    );
    const hash = entryHash(`- [${r.cat}] ${r.text}`);
    scores[hash] = {
      class: r.cat,
      score: 3,
      evidenceCount: 3,
      cue: "explicit",
      firstSeen: new Date().toISOString(),
      lastReinforced: new Date().toISOString(),
      userState: "auto",
      lifecycle: "active",
    };
  }
  saveScores(cwd, { entries: scores, lastRebuild: new Date().toISOString() });

  writePromotions(cwd, [
    {
      id: promotionId("project_rule", "lesson", "Always ask before force push"),
      destination: "project_rule",
      status: "proposed",
      category: "lesson",
      text: "Always ask before force push",
      reason: "test",
      createdAt: new Date().toISOString(),
    },
  ]);
}

describe("buildSituationReport queryClass", () => {
  it("includes promotion candidates with query-class hint for git_release", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sitrep-qc-"));
    try {
      seed(cwd);
      const report = buildSituationReport(cwd, 1700, { queryClass: "git_release" });
      assert.match(report, /Promotion Candidates/);
      assert.match(report, /Query class: `git_release`/);
      // Lessons should appear (boosted for git_release)
      assert.match(report, /Always ask before force push/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("boosts mistakes earlier for debug vs general", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sitrep-dbg-"));
    try {
      seed(cwd);
      const debug = buildSituationReport(cwd, 1700, { queryClass: "debug" });
      const general = buildSituationReport(cwd, 1700, { queryClass: "general" });

      assert.match(debug, /Do not swallow stack traces/);
      assert.match(debug, /Query class: `debug`/);
      assert.doesNotMatch(general, /Query class:/);

      const debugMistakeIdx = debug.indexOf("Vetoes & Mistakes");
      const debugPrefIdx = debug.indexOf("Active Preferences");
      // With boost, mistakes can appear before preferences in debug class
      assert.ok(debugMistakeIdx >= 0);
      assert.ok(debugPrefIdx >= 0);
      assert.ok(
        debugMistakeIdx < debugPrefIdx,
        `expected mistakes before preferences in debug report\n${debug}`,
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("pr_review hint points at review-guidelines", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sitrep-pr-"));
    try {
      seed(cwd);
      const report = buildSituationReport(cwd, 1700, { queryClass: "pr_review" });
      assert.match(report, /review-guidelines/);
      assert.match(report, /Query class: `pr_review`/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns empty string when tokenBudget is zero", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sitrep-zero-"));
    try {
      seed(cwd);
      assert.equal(buildSituationReport(cwd, 0, { queryClass: "git_release" }), "");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
