/**
 * Tests for memory promotion scan + safe apply.
 * Run with: npx tsx --test tests/node/orchestrator/memory-promotion.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applySafePromotions,
  inferMechanicalEnforcement,
  markTopicEntryEnforced,
  scanPromotionCandidates,
  EVIDENCE_ENFORCEMENT,
} from "../../../extensions/orchestrator/memory-promotion.js";
import {
  entryHash,
  loadScores,
  saveScores,
  type ScoredEntry,
} from "../../../extensions/orchestrator/memory-scoring.js";
import { loadPromotions } from "../../../extensions/orchestrator/promotion-queue.js";

function seedMemory(
  cwd: string,
  text: string,
  category: "lesson" | "mistake" | "preference" | "pattern" = "lesson",
  evidenceCount: number,
): void {
  const topicsDir = path.join(cwd, ".pi", "memory", "topics");
  fs.mkdirSync(topicsDir, { recursive: true });
  const topic =
    category === "lesson"
      ? "lessons"
      : category === "mistake"
        ? "mistakes"
        : category === "preference"
          ? "preferences"
          : "patterns";
  const topicPath = path.join(topicsDir, `${topic}.md`);
  const header = `# ${topic}\n\n`;
  const prev = fs.existsSync(topicPath) ? fs.readFileSync(topicPath, "utf-8") : header;
  fs.writeFileSync(topicPath, prev.trimEnd() + `\n- [${category}] ${text}\n`, "utf-8");

  const scores = loadScores(cwd);
  const hash = entryHash(`- [${category}] ${text}`);
  const entry: ScoredEntry = {
    class: category,
    score: 2.0,
    evidenceCount,
    cue: "explicit",
    firstSeen: new Date().toISOString(),
    lastReinforced: new Date().toISOString(),
    userState: "auto",
    lifecycle: "active",
  };
  scores.entries[hash] = entry;
  saveScores(cwd, scores);
}

describe("inferMechanicalEnforcement", () => {
  it("extracts bash_contains for never use `git add .`", () => {
    const inf = inferMechanicalEnforcement('Never use `git add .`');
    assert.ok(inf);
    assert.equal(inf!.trigger, "bash_contains git add .");
    assert.equal(inf!.action, "block");
    assert.equal(inf!.confidence, "high");
  });

  it("extracts git add . without backticks", () => {
    const inf = inferMechanicalEnforcement("Never run git add . in this repo");
    assert.ok(inf);
    assert.equal(inf!.trigger, "bash_contains git add .");
  });

  it("extracts ask_user verifier", () => {
    const inf = inferMechanicalEnforcement("Always ask_user before gh pr merge");
    assert.ok(inf);
    assert.equal(inf!.verifier, "tool_called ask_user before gh pr merge");
  });

  it("returns null for non-mechanical knowledge", () => {
    assert.equal(
      inferMechanicalEnforcement("buildah chown breaks cache mounts"),
      null,
    );
  });
});

describe("scanPromotionCandidates + applySafePromotions", () => {
  it("auto-applies high-confidence enforcement and never writes rules/", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "promo-m-"));
    try {
      seedMemory(cwd, 'Never use `git add .`', "lesson", EVIDENCE_ENFORCEMENT);
      seedMemory(
        cwd,
        "Always follow the project release convention",
        "preference",
        5,
      );

      const scanned = scanPromotionCandidates(cwd);
      assert.ok(scanned.some((c) => c.destination === "enforcement"));
      assert.ok(scanned.some((c) => c.destination === "project_rule"));

      const result = applySafePromotions(cwd);
      assert.ok(result.applied >= 1);

      const scores = loadScores(cwd);
      const hash = entryHash("- [lesson] Never use `git add .`");
      assert.equal(scores.entries[hash]?.trigger, "bash_contains git add .");
      assert.equal(scores.entries[hash]?.action, "block");

      const lessons = fs.readFileSync(
        path.join(cwd, ".pi", "memory", "topics", "lessons.md"),
        "utf-8",
      );
      assert.match(lessons, /\*\(enforced\)\*/);

      assert.equal(fs.existsSync(path.join(cwd, "rules")), false);
      assert.equal(fs.existsSync(path.join(cwd, ".pi", "rules")), false);

      const queue = loadPromotions(cwd);
      const enforced = queue.find((c) => c.text.includes("git add"));
      assert.equal(enforced?.status, "applied");
      const rule = queue.find((c) => c.destination === "project_rule");
      assert.equal(rule?.status, "proposed");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("markTopicEntryEnforced is idempotent", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "promo-mark-"));
    try {
      seedMemory(cwd, "Never use `npm publish`", "lesson", 1);
      assert.equal(markTopicEntryEnforced(cwd, "lesson", "Never use `npm publish`"), true);
      assert.equal(markTopicEntryEnforced(cwd, "lesson", "Never use `npm publish`"), true);
      const content = fs.readFileSync(
        path.join(cwd, ".pi", "memory", "topics", "lessons.md"),
        "utf-8",
      );
      assert.equal((content.match(/\*\(enforced\)\*/g) || []).length, 1);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
