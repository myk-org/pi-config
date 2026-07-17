/**
 * Full live smoke for all 5 memory-promotion plan phases.
 * Usage: LIVE_CWD=/tmp/proj npx tsx scripts/live-memory-all5-check.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  entryHash,
  loadScores,
  saveScores,
  reinforce,
} from "../extensions/orchestrator/memory-scoring.ts";
import { runPromotionPass } from "../extensions/orchestrator/memory-promotion.ts";
import {
  loadEnforcedEntries,
  matchBashCommand,
} from "../extensions/orchestrator/enforcement-rules.ts";
import { buildSituationReport } from "../extensions/orchestrator/situation-report.ts";
import { loadPromotions } from "../extensions/orchestrator/promotion-queue.ts";
import {
  writeProvenancePending,
  mergeProvenancePending,
} from "../extensions/orchestrator/memory-provenance.ts";
import { classifyQueryClass } from "../extensions/orchestrator/memory-query-class.ts";

const cwd = process.env.LIVE_CWD;
if (!cwd) {
  console.error("LIVE_CWD required");
  process.exit(2);
}

function ensureScore(
  category: "lesson" | "preference" | "pattern",
  text: string,
): void {
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
const pattern = "Deploy workflow: build → test → tag → push";

// Topics may already exist from CLI; ensure score rows
ensureScore("lesson", lesson);
ensureScore("preference", pref);

const topicsDir = path.join(cwd, ".pi", "memory", "topics");
fs.mkdirSync(topicsDir, { recursive: true });
const patternPath = path.join(topicsDir, "patterns.md");
if (!fs.existsSync(patternPath) || !fs.readFileSync(patternPath, "utf-8").includes(pattern)) {
  const header = fs.existsSync(patternPath)
    ? fs.readFileSync(patternPath, "utf-8")
    : "# Patterns\n";
  fs.writeFileSync(patternPath, header.trimEnd() + `\n- [pattern] ${pattern}\n`);
}
ensureScore("pattern", pattern);

const lessonLine = `- [lesson] ${lesson}`;
reinforce(cwd, lessonLine);
reinforce(cwd, lessonLine);

const prefLine = `- [preference] ${pref}`;
for (let i = 0; i < 4; i++) reinforce(cwd, prefLine);

const patternLine = `- [pattern] ${pattern}`;
for (let i = 0; i < 3; i++) reinforce(cwd, patternLine);

// Phase 3 provenance sidecar
writeProvenancePending(cwd, [
  {
    category: "lesson",
    text: lesson,
    sourceSession: "live-all5",
    derivedFrom: "cli-smoke",
    informs: ["git"],
  },
]);
const provMerged = mergeProvenancePending(cwd);
if (provMerged !== 1) {
  throw new Error(`provenance merge expected 1, got ${provMerged}`);
}

// Phase 1–2 promotion
const pass = runPromotionPass(cwd);
console.log("[all5] promotion", pass);

const enforced = loadEnforcedEntries(cwd);
const hits = matchBashCommand(enforced, "git add . && true");
const miss = matchBashCommand(enforced, "git add src/foo.ts");
console.log("[all5] enforce hits", hits.length, "miss", miss.length);
if (hits.length !== 1 || hits[0]!.rule.action !== "block") {
  throw new Error("expected block on git add .");
}
if (miss.length !== 0) {
  throw new Error("path-scoped git add should not match");
}

const entry = loadScores(cwd).entries[entryHash(lessonLine)];
if (!entry?.trigger || entry.sourceSession !== "live-all5") {
  throw new Error(`lesson entry incomplete: ${JSON.stringify(entry)}`);
}

const queue = loadPromotions(cwd);
if (!queue.some((c) => c.destination === "project_rule" && c.status === "proposed")) {
  throw new Error("expected proposed project_rule");
}
if (!queue.some((c) => c.destination === "skill" && c.status === "proposed")) {
  throw new Error("expected proposed skill");
}
if (fs.existsSync(path.join(cwd, "rules")) || fs.existsSync(path.join(cwd, ".pi", "rules"))) {
  throw new Error("rules were auto-written");
}

// Phase 4 query-class
if (classifyQueryClass("review this PR") !== "pr_review") {
  throw new Error("pr_review classify failed");
}
const report = buildSituationReport(cwd, 1700, { queryClass: "git_release" });
if (!report.includes("Promotion Candidates") || !report.includes("Query class: `git_release`")) {
  throw new Error("situation report missing query-class content\n" + report);
}

const lessons = fs.readFileSync(path.join(topicsDir, "lessons.md"), "utf-8");
if (!lessons.includes("*(enforced)*")) {
  throw new Error("lessons.md missing enforced marker");
}

console.log("[all5] phases 1-4 LIVE PASS");
console.log("[all5] report head:\n" + report.split("\n").slice(0, 18).join("\n"));
