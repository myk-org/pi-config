/**
 * Live smoke check: CLI-written topics → reinforce → promote → enforce → inject.
 * Usage: LIVE_CWD=/tmp/proj npx tsx scripts/live-memory-promotion-check.ts
 */
import fs from "node:fs";
import path from "node:path";
import { entryHash, loadScores, saveScores, reinforce } from "../extensions/orchestrator/memory-scoring.ts";
import { runPromotionPass } from "../extensions/orchestrator/memory-promotion.ts";
import { loadEnforcedEntries, matchBashCommand } from "../extensions/orchestrator/enforcement-rules.ts";
import { buildSituationReport } from "../extensions/orchestrator/situation-report.ts";
import { loadPromotions } from "../extensions/orchestrator/promotion-queue.ts";

const cwd = process.env.LIVE_CWD;
if (!cwd) {
  console.error("LIVE_CWD required");
  process.exit(2);
}

function ensureScore(category: "lesson" | "preference", text: string): void {
  const line = `- [${category}] ${text}`;
  const scores = loadScores(cwd);
  const hash = entryHash(line);
  if (!scores.entries[hash]) {
    scores.entries[hash] = {
      class: category,
      score: 1,
      evidenceCount: 1,
      cue: "explicit",
      firstSeen: new Date().toISOString(),
      lastReinforced: new Date().toISOString(),
      userState: "auto",
      lifecycle: "active",
    };
    saveScores(cwd, scores);
  }
}

const lesson = "Never use `git add .`";
const pref = "Always follow the project release convention in this repo";

ensureScore("lesson", lesson);
ensureScore("preference", pref);

const lessonLine = `- [lesson] ${lesson}`;
reinforce(cwd, lessonLine);
reinforce(cwd, lessonLine);

const prefLine = `- [preference] ${pref}`;
for (let i = 0; i < 4; i++) reinforce(cwd, prefLine);

const pass = runPromotionPass(cwd);
console.log("[live-cli] promotion", pass);

const enforced = loadEnforcedEntries(cwd);
const hits = matchBashCommand(enforced, "git add . && true");
console.log(
  "[live-cli] enforced",
  enforced.length,
  "hits",
  hits.length,
  hits[0]?.matched,
  hits[0]?.rule.action,
);
if (hits.length !== 1 || hits[0]!.rule.action !== "block") {
  throw new Error("LIVE FAIL: expected block on git add .");
}

const queue = loadPromotions(cwd);
console.log(
  "[live-cli] promotions",
  queue.map((c) => ({ dest: c.destination, status: c.status, text: c.text.slice(0, 50) })),
);
if (!queue.some((c) => c.destination === "project_rule" && c.status === "proposed")) {
  throw new Error("LIVE FAIL: expected proposed project_rule");
}
if (fs.existsSync(path.join(cwd, "rules")) || fs.existsSync(path.join(cwd, ".pi", "rules"))) {
  throw new Error("LIVE FAIL: rules were written");
}

const report = buildSituationReport(cwd, 1700, { queryClass: "git_release" });
if (!report.includes("Promotion Candidates") || !report.includes("git add")) {
  throw new Error("LIVE FAIL: situation report missing expected content\n" + report);
}
console.log("[live-cli] report excerpt:\n" + report.split("\n").slice(0, 22).join("\n"));
console.log("[live-cli] PASS");
