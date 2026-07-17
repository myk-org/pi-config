/**
 * LIVE end-to-end test — real filesystem, real scores, real enforcement loaders.
 *
 * Simulates a project that accumulates evidence, crosses promotion thresholds,
 * gets auto-enforced, and injects promotion candidates into the situation report.
 *
 * Run: npx tsx --test tests/node/orchestrator/memory-promotion.live.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { entryHash, loadScores, reinforce, saveScores, type ScoredEntry } from "../../../extensions/orchestrator/memory-scoring.js";
import { runPromotionPass, maybePromoteAfterReinforce } from "../../../extensions/orchestrator/memory-promotion.js";
import { loadPromotions } from "../../../extensions/orchestrator/promotion-queue.js";
import { buildSituationReport } from "../../../extensions/orchestrator/situation-report.js";
import { classifyQueryClass } from "../../../extensions/orchestrator/memory-query-class.js";
import {
  loadEnforcedEntries,
  matchBashCommand,
  executeAction,
} from "../../../extensions/orchestrator/enforcement-rules.js";

const LESSON = "Never use `git add .`";
const CONVENTION = "Always follow the project release convention in this repo";
const PATTERN = "Deploy workflow: build → test → tag → push";

let cwd = "";

function writeTopic(category: string, topicFile: string, text: string): void {
  const topicsDir = path.join(cwd, ".pi", "memory", "topics");
  fs.mkdirSync(topicsDir, { recursive: true });
  const p = path.join(topicsDir, topicFile);
  const header = `# ${topicFile.replace(/\.md$/, "")}\n\n`;
  const prev = fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : header;
  if (!prev.includes(text)) {
    fs.writeFileSync(p, prev.trimEnd() + `\n- [${category}] ${text}\n`, "utf-8");
  }
}

function seedEntry(
  category: ScoredEntry["class"],
  text: string,
  evidenceCount: number,
): void {
  const scores = loadScores(cwd);
  const hash = entryHash(`- [${category}] ${text}`);
  scores.entries[hash] = {
    class: category,
    score: 1.0,
    evidenceCount,
    cue: "explicit",
    firstSeen: new Date().toISOString(),
    lastReinforced: new Date().toISOString(),
    userState: "auto",
    lifecycle: "active",
    sourceSession: "live-test-session-1",
    informs: ["git", "live-test"],
  };
  saveScores(cwd, scores);
}

describe("LIVE memory promotion e2e", () => {
  before(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-live-"));
    writeTopic("lesson", "lessons.md", LESSON);
    writeTopic("preference", "preferences.md", CONVENTION);
    writeTopic("pattern", "patterns.md", PATTERN);
    seedEntry("lesson", LESSON, 1);
    seedEntry("preference", CONVENTION, 1);
    seedEntry("pattern", PATTERN, 1);
    console.log(`[live] project root: ${cwd}`);
  });

  after(() => {
    if (cwd && fs.existsSync(cwd)) {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("step 1: reinforce lesson until evidence crosses enforcement threshold", () => {
    const line = `- [lesson] ${LESSON}`;
    // evidence starts at 1; reinforce twice → 3
    assert.equal(reinforce(cwd, line), true);
    assert.equal(reinforce(cwd, line), true);
    const entry = loadScores(cwd).entries[entryHash(line)];
    assert.ok(entry);
    assert.equal(entry!.evidenceCount, 3);
    console.log(`[live] lesson evidenceCount=${entry!.evidenceCount}`);
  });

  it("step 2: maybePromoteAfterReinforce auto-applies enforcement on disk", () => {
    const line = `- [lesson] ${LESSON}`;
    // evidence is already 3 from step 1 — threshold crossing should fire
    const result = maybePromoteAfterReinforce(cwd, line);
    assert.ok(result, "expected promotion pass to run at evidenceCount=3");
    console.log(`[live] promote result: applied=${result!.applied} queued=${result!.queued}`, result!.details);

    const scores = loadScores(cwd);
    const entry = scores.entries[entryHash(line)];
    assert.ok(entry?.trigger, "trigger should be written to memory-scores.json");
    assert.equal(entry!.trigger, "bash_contains git add .");
    assert.equal(entry!.action, "block");

    const lessonsPath = path.join(cwd, ".pi", "memory", "topics", "lessons.md");
    const lessons = fs.readFileSync(lessonsPath, "utf-8");
    assert.match(lessons, /\*\(enforced\)\*/);
    console.log(`[live] lessons.md:\n${lessons}`);
    console.log(`[live] scores entry:`, JSON.stringify(entry, null, 2));
  });

  it("step 3: loadEnforcedEntries + matchBashCommand blocks git add . live", () => {
    const enforced = loadEnforcedEntries(cwd);
    assert.ok(enforced.length >= 1, `expected enforced entries, got ${enforced.length}`);
    console.log(
      `[live] enforced rules:`,
      enforced.map((e) => ({ text: e.text, trigger: e.trigger, action: e.action })),
    );

    const hits = matchBashCommand(enforced, "git add . && git commit -m x");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.rule.action, "block");
    assert.equal(hits[0]!.matched, "git add .");

    const miss = matchBashCommand(enforced, "git add src/foo.ts");
    assert.equal(miss.length, 0, "should not match path-scoped git add");
    console.log(`[live] bash match OK; non-match OK`);
  });

  it("step 4: reinforce convention to project_rule propose-only (no rules/ write)", () => {
    const line = `- [preference] ${CONVENTION}`;
    for (let i = 0; i < 4; i++) assert.equal(reinforce(cwd, line), true);
    const pass = runPromotionPass(cwd);
    console.log(`[live] convention pass: applied=${pass.applied} queued=${pass.queued}`);

    const queuePath = path.join(cwd, ".pi", "memory", "promotions.md");
    assert.ok(fs.existsSync(queuePath), "promotions.md must exist on disk");
    const queueMd = fs.readFileSync(queuePath, "utf-8");
    console.log(`[live] promotions.md:\n${queueMd}`);

    const queue = loadPromotions(cwd);
    const rule = queue.find((c) => c.destination === "project_rule");
    assert.ok(rule, "expected project_rule candidate");
    assert.equal(rule!.status, "proposed");

    assert.equal(fs.existsSync(path.join(cwd, "rules")), false);
    assert.equal(fs.existsSync(path.join(cwd, ".pi", "rules")), false);
  });

  it("step 5: reinforce procedural pattern → skill candidate in queue", () => {
    const line = `- [pattern] ${PATTERN}`;
    for (let i = 0; i < 3; i++) assert.equal(reinforce(cwd, line), true);
    runPromotionPass(cwd);
    const skill = loadPromotions(cwd).find((c) => c.destination === "skill");
    assert.ok(skill, "expected skill candidate");
    assert.equal(skill!.status, "proposed");
    console.log(`[live] skill candidate:`, skill);
  });

  it("step 6: situation report injects promotion candidates + query-class bias", () => {
    const report = buildSituationReport(cwd, 1700, { queryClass: "git_release" });
    assert.ok(report.length > 0, "report should not be empty");
    assert.match(report, /Promotion Candidates/);
    assert.match(report, /Query class: `git_release`/);
    assert.match(report, /git add/);
    console.log(`[live] situation report:\n${report}`);

    assert.equal(classifyQueryClass("please review this PR"), "pr_review");
    assert.equal(classifyQueryClass("git push and tag release"), "git_release");
  });

  it("step 7: provenance survives on disk after promotion", () => {
    const entry = loadScores(cwd).entries[entryHash(`- [lesson] ${LESSON}`)];
    assert.equal(entry?.sourceSession, "live-test-session-1");
    assert.deepEqual(entry?.informs, ["git", "live-test"]);
  });

  it("step 8: executeAction still respects allowlist (sanity of enforcement runtime)", () => {
    process.env.PI_ENFORCEMENT_ALLOWED_COMMANDS = "echo live-ok";
    try {
      const ok = executeAction("echo live-ok", cwd);
      assert.equal(ok.success, true);
      assert.match(ok.output, /live-ok/);
      const blocked = executeAction("rm -rf /", cwd);
      assert.equal(blocked.success, false);
      console.log(`[live] executeAction allowlist OK`);
    } finally {
      delete process.env.PI_ENFORCEMENT_ALLOWED_COMMANDS;
    }
  });
});
