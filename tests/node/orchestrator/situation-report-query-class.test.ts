/**
 * Situation report query-class budget / ordering shifts.
 * Run: npx tsx --test tests/node/orchestrator/situation-report-query-class.test.ts
 */
import { describe, it, afterEach } from "node:test";
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
import { makeTempDir } from "../helpers/temp-dirs.js";


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
    const cwd = makeTempDir("sitrep-qc-");
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
    const cwd = makeTempDir("sitrep-dbg-");
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
    const cwd = makeTempDir("sitrep-pr-");
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
    const cwd = makeTempDir("sitrep-zero-");
    try {
      seed(cwd);
      assert.equal(buildSituationReport(cwd, 0, { queryClass: "git_release" }), "");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("getMemoryTokenBudget — 0 disables the report (Qodo #15 PR #916)", () => {
  it("honors an explicit 0 budget instead of falling back to the default", async () => {
    const { getMemoryTokenBudget, buildSituationReport } = await import(
      "../../../extensions/orchestrator/situation-report.js"
    );
    const cwd = makeTempDir("situation-budget-");
    try {
      fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, ".pi", "pi-config-settings.json"),
        JSON.stringify({ memory_token_budget: 0 }),
      );
      assert.equal(getMemoryTokenBudget(cwd), 0);
      // A 0 budget produces no report at all
      assert.equal(buildSituationReport(cwd, 0), "");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("situation report truncation, emittedKeys, and warning guards (#1199, #1204)", () => {
  it("truncates promotion candidates on line boundaries without slicing mid-word", () => {
    const cwd = makeTempDir("sitrep-promo-trunc-");
    try {
      const items = Array.from({ length: 6 }, (_, i) => ({
        id: promotionId("project_rule", "lesson", `Rule item number ${i} with descriptive text`),
        destination: "project_rule" as const,
        status: "proposed" as const,
        category: "lesson",
        text: `Rule item number ${i} with descriptive text that fills the budget`,
        reason: "test",
        createdAt: new Date().toISOString(),
      }));
      writePromotions(cwd, items);

      // Tight budget (120 tokens = 480 chars, minus headerReserve ~145 chars = ~335 chars for promo)
      const report = buildSituationReport(cwd, 120);
      assert.match(report, /Promotion Candidates/);
      assert.match(report, /apply safe ones/);
      const promoLines = report
        .split("\n")
        .filter((l) => l.startsWith("- [project_rule (propose only)]"));
      assert.ok(promoLines.length >= 1, "at least one full promotion line fits");
      for (const line of promoLines) {
        assert.ok(
          line.endsWith("that fills the budget"),
          `promotion line must not be sliced mid-word: ${line}`,
        );
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("populates emittedKeys only for emitted entries", () => {
    const cwd = makeTempDir("sitrep-emitted-keys-");
    try {
      const topicsDir = path.join(cwd, ".pi", "memory", "topics");
      fs.mkdirSync(topicsDir, { recursive: true });
      const p1 = "Always preserve pinned rules across turns";
      const omitted = "Low-priority non-pinned entry that does not fit the tight budget";
      fs.writeFileSync(
        path.join(topicsDir, "preferences.md"),
        `# Preferences\n\n- [preference] ${p1} *(pinned)*\n- [preference] ${omitted}\n`,
      );
      const now = new Date().toISOString();
      saveScores(cwd, {
        entries: {
          [entryHash(`- [preference] ${p1}`)]: {
            class: "preference",
            score: 100,
            evidenceCount: 1,
            cue: "explicit",
            firstSeen: now,
            lastReinforced: now,
            userState: "pinned",
            lifecycle: "active",
          },
          [entryHash(`- [preference] ${omitted}`)]: {
            class: "preference",
            score: 1,
            evidenceCount: 1,
            cue: "explicit",
            firstSeen: now,
            lastReinforced: now,
            userState: "auto",
            lifecycle: "active",
          },
        },
        lastRebuild: now,
      });

      const emittedKeys = new Set<string>();
      buildSituationReport(cwd, 75, { emittedKeys });
      assert.equal(emittedKeys.has(`- [preference] ${p1}`), true);
      assert.equal(emittedKeys.has(`- [preference] ${omitted}`), false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("skips memory_remove warning when only pinned entries exist", () => {
    const cwd = makeTempDir("sitrep-pinned-warn-");
    try {
      const topicsDir = path.join(cwd, ".pi", "memory", "topics");
      fs.mkdirSync(topicsDir, { recursive: true });
      const p1 = "Always preserve pinned rules across turns";
      const p2 = "Never mutate enforced entries without consent";
      fs.writeFileSync(
        path.join(topicsDir, "preferences.md"),
        `# Preferences\n\n- [preference] ${p1} *(pinned)*\n- [preference] ${p2} *(pinned)*\n`,
      );
      const now = new Date().toISOString();
      saveScores(cwd, {
        entries: {
          [entryHash(`- [preference] ${p1}`)]: {
            class: "preference",
            score: 100,
            evidenceCount: 1,
            cue: "explicit",
            firstSeen: now,
            lastReinforced: now,
            userState: "pinned",
            lifecycle: "active",
          },
          [entryHash(`- [preference] ${p2}`)]: {
            class: "preference",
            score: 100,
            evidenceCount: 1,
            cue: "explicit",
            firstSeen: now,
            lastReinforced: now,
            userState: "pinned",
            lifecycle: "active",
          },
        },
        lastRebuild: now,
      });

      const report = buildSituationReport(cwd, 60);
      assert.doesNotMatch(report, /memory_remove/, "pinned-only report should not emit memory_remove warning");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("stays within requested tokenBudget when non-pinned entries trigger the 80% warning", () => {
    const cwd = makeTempDir("sitrep-budget-cap-");
    try {
      const topicsDir = path.join(cwd, ".pi", "memory", "topics");
      fs.mkdirSync(topicsDir, { recursive: true });
      const now = new Date().toISOString();
      const lines: string[] = ["# Lessons", ""];
      const scores: Record<string, ScoredEntry> = {};
      for (let i = 0; i < 16; i++) {
        const text = `Always verify boundary invariant number ${i} with descriptive text`;
        lines.push(`- [lesson] ${text}`);
        scores[entryHash(`- [lesson] ${text}`)] = {
          class: "lesson",
          score: 16 - i,
          evidenceCount: 2,
          cue: "explicit",
          firstSeen: now,
          lastReinforced: now,
          userState: "auto",
          lifecycle: "active",
        };
      }
      fs.writeFileSync(path.join(topicsDir, "lessons.md"), lines.join("\n") + "\n");
      saveScores(cwd, { entries: scores, lastRebuild: now });

      const budget = 300;
      const report = buildSituationReport(cwd, budget);
      assert.match(report, /memory_remove/, "80% warning triggers for non-pinned entries");
      const match = report.match(/# Project Memory \[(\d+)% — (\d+)\/(\d+) tokens\]/);
      assert.ok(match, "capacity header present");
      const reportedTokens = Number(match![2]);
      assert.ok(reportedTokens <= budget, `expected ${reportedTokens} <= ${budget}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
