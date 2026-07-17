/**
 * Memory promotion — graduate high-evidence memories into structure.
 *
 * Safe auto-apply: enforcement metadata on existing memories.
 * Propose-only: project_rule (never writes rules files).
 * Skill: queue + dream may auto-create under .pi/skills/.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type EnforcementAction,
  type EnforcementTrigger,
  type MemoryCategory,
  type ScoredEntry,
  entryHash,
  loadScores,
  saveScores,
} from "./memory-scoring.js";
import { CATEGORY_TO_TOPIC, readAllTopicEntries } from "./memory-tree.js";
import {
  type PromotionCandidate,
  appendPromotions,
  formatPromotionsForReport,
  loadPromotions,
  promotionId,
  updatePromotionStatus,
  writePromotions,
} from "./promotion-queue.js";

export const EVIDENCE_ENFORCEMENT = 3;
export const EVIDENCE_SKILL = 3;
export const EVIDENCE_PROJECT_RULE = 5;

export interface InferredEnforcement {
  trigger: EnforcementTrigger;
  action: EnforcementAction;
  actionCommand?: string;
  verifier?: string;
  confidence: "high" | "low";
}

/** Detect unambiguous mechanical enforcement from memory text. */
export function inferMechanicalEnforcement(text: string): InferredEnforcement | null {
  const t = text.trim();

  // never/don't use|run `cmd` or "cmd"
  const neverCmd = t.match(
    /\b(?:never|don'?t|do not)\s+(?:use|run|execute)\s+[`"']([^`"']+)[`"']/i,
  );
  if (neverCmd?.[1]) {
    return {
      trigger: `bash_contains ${neverCmd[1].trim()}` as EnforcementTrigger,
      action: "block",
      confidence: "high",
    };
  }

  // never/don't git add .
  const neverGitAdd = t.match(/\b(?:never|don'?t|do not)\s+.*\bgit\s+add\s+\./i);
  if (neverGitAdd) {
    return {
      trigger: "bash_contains git add ." as EnforcementTrigger,
      action: "block",
      confidence: "high",
    };
  }

  // never use tool X / never call X
  const neverTool = t.match(
    /\b(?:never|don'?t|do not)\s+(?:use|call|invoke)\s+(?:the\s+)?([a-z_][a-z0-9_-]{1,40})\b/i,
  );
  if (neverTool?.[1]) {
    const tool = neverTool[1].toLowerCase();
    // Avoid matching generic words
    if (!["this", "that", "the", "a", "an", "any", "our"].includes(tool)) {
      return {
        trigger: `tool_name ${tool}` as EnforcementTrigger,
        action: "block",
        confidence: "high",
      };
    }
  }

  // always ask_user before <command>
  const askBefore = t.match(
    /\balways\s+(?:call\s+)?ask_user\s+before\s+(.+)$/i,
  );
  if (askBefore?.[1]) {
    const cmd = askBefore[1].replace(/[.!]+$/, "").trim();
    if (cmd.length > 2 && cmd.length < 80) {
      return {
        trigger: "tool_name bash" as EnforcementTrigger,
        action: "warn",
        verifier: `tool_called ask_user before ${cmd}`,
        confidence: "high",
      };
    }
  }

  // warn when modifying <pattern>
  const warnFile = t.match(
    /\bwarn\s+when\s+modifying\s+([^\s,]+)/i,
  );
  if (warnFile?.[1]) {
    return {
      trigger: `file_modified ${warnFile[1].trim()}` as EnforcementTrigger,
      action: "warn",
      confidence: "high",
    };
  }

  // Soft mechanical cue without extractable trigger
  if (
    /\b(?:never|always|don'?t|do not)\b/i.test(t) &&
    /\b(?:git|bash|npm|uv|docker|kubectl|gh|curl)\b/i.test(t)
  ) {
    return null; // mechanical-looking but ambiguous — caller may queue low-confidence
  }

  return null;
}

function looksProcedural(text: string): boolean {
  return (
    /\b(step\s*\d|then\s+|after that|workflow|pipeline)\b/i.test(text) ||
    (text.includes(" → ") || text.includes("->"))
  );
}

function looksProjectConvention(text: string): boolean {
  return /\b(always|never|must|convention|in this (repo|project)|project-wide)\b/i.test(
    text,
  );
}

function hasEnforcement(entry: ScoredEntry): boolean {
  return !!((entry.trigger && entry.action) || entry.verifier);
}

/** Mark *(enforced)* on the topic line for an entry. */
export function markTopicEntryEnforced(
  cwd: string,
  category: MemoryCategory,
  text: string,
): boolean {
  const topicName = CATEGORY_TO_TOPIC[category];
  if (!topicName) return false;
  const topicPath = join(cwd, ".pi", "memory", "topics", `${topicName}.md`);
  if (!existsSync(topicPath)) return false;

  let content = readFileSync(topicPath, "utf-8");
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lineRe = new RegExp(
    `^(- \\[${category}\\] ${escaped})((?: \\*\\(pinned\\)\\*)?)((?: \\*\\(enforced\\)\\*)?)(\\s*)$`,
    "m",
  );
  const m = content.match(lineRe);
  if (!m) return false;
  if (m[3]) return true; // already enforced

  content = content.replace(lineRe, `$1$2 *(enforced)*$4`);
  writeFileSync(topicPath, content, "utf-8");
  return true;
}

export interface TopicScored {
  text: string;
  category: MemoryCategory;
  pinned: boolean;
  hash: string;
  scored: ScoredEntry;
}

function loadTopicScored(cwd: string): TopicScored[] {
  const scores = loadScores(cwd);
  const out: TopicScored[] = [];
  for (const te of readAllTopicEntries(cwd)) {
    const hash = entryHash(`- [${te.category}] ${te.text}`);
    const scored = scores.entries[hash];
    if (!scored) continue;
    out.push({
      text: te.text,
      category: te.category,
      pinned: te.pinned,
      hash,
      scored,
    });
  }
  return out;
}

/**
 * Scan memories for promotion candidates (does not write).
 */
export function scanPromotionCandidates(cwd: string): PromotionCandidate[] {
  const now = new Date().toISOString();
  const candidates: PromotionCandidate[] = [];
  const entries = loadTopicScored(cwd);

  for (const e of entries) {
    const evidence = e.scored.evidenceCount;
    const inferred = inferMechanicalEnforcement(e.text);

    // Enforcement path
    if (
      evidence >= EVIDENCE_ENFORCEMENT &&
      !hasEnforcement(e.scored) &&
      (e.category === "lesson" ||
        e.category === "mistake" ||
        e.category === "preference")
    ) {
      if (inferred && inferred.confidence === "high") {
        candidates.push({
          id: promotionId("enforcement", e.category, e.text),
          destination: "enforcement",
          text: e.text,
          category: e.category,
          reason: `evidenceCount=${evidence} with extractable mechanical trigger`,
          evidenceCount: evidence,
          status: "proposed",
          trigger: inferred.trigger,
          action: inferred.actionCommand
            ? `run_after ${inferred.actionCommand}`
            : inferred.action,
          verifier: inferred.verifier,
          createdAt: now,
        });
      } else if (
        /\b(?:never|always|don'?t|do not)\b/i.test(e.text) &&
        !inferred
      ) {
        candidates.push({
          id: promotionId("enforcement", e.category, e.text),
          destination: "enforcement",
          text: e.text,
          category: e.category,
          reason: `evidenceCount=${evidence}; mechanical language but trigger needs human/LLM fill-in`,
          evidenceCount: evidence,
          status: "proposed",
          createdAt: now,
        });
      }
    }

    // Skill path
    if (
      evidence >= EVIDENCE_SKILL &&
      looksProcedural(e.text) &&
      (e.category === "pattern" || e.category === "lesson" || e.category === "done")
    ) {
      const skillName = e.text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || "workflow";
      candidates.push({
        id: promotionId("skill", e.category, e.text),
        destination: "skill",
        text: e.text,
        category: e.category,
        reason: `evidenceCount=${evidence}; looks like a multi-step workflow`,
        evidenceCount: evidence,
        status: "proposed",
        skillName,
        skillCreated: false,
        createdAt: now,
      });
    }

    // Project rule path (propose only)
    if (
      evidence >= EVIDENCE_PROJECT_RULE &&
      looksProjectConvention(e.text) &&
      !hasEnforcement(e.scored) &&
      !inferred
    ) {
      candidates.push({
        id: promotionId("project_rule", e.category, e.text),
        destination: "project_rule",
        text: e.text,
        category: e.category,
        reason: `evidenceCount=${evidence}; project-wide convention — propose only, never auto-write rules/`,
        evidenceCount: evidence,
        status: "proposed",
        createdAt: now,
      });
    }
  }

  return candidates;
}

export interface ApplySafeResult {
  applied: number;
  queued: number;
  details: string[];
}

/**
 * Apply high-confidence enforcement promotions; queue the rest.
 * Never writes rules files.
 */
export function applySafePromotions(cwd: string): ApplySafeResult {
  const details: string[] = [];
  let applied = 0;

  const scanned = scanPromotionCandidates(cwd);
  const toQueue: PromotionCandidate[] = [];
  const scores = loadScores(cwd);

  for (const c of scanned) {
    if (c.destination !== "enforcement" || !c.trigger || !c.action) {
      toQueue.push(c);
      continue;
    }

    // Only auto-apply when action is block/warn (not run_after — safer)
    if (c.action !== "block" && c.action !== "warn") {
      toQueue.push(c);
      continue;
    }

    const hash = entryHash(`- [${c.category}] ${c.text}`);
    const entry = scores.entries[hash];
    if (!entry || hasEnforcement(entry)) {
      toQueue.push({ ...c, status: "proposed" });
      continue;
    }

    entry.trigger = c.trigger as EnforcementTrigger;
    entry.action = c.action as EnforcementAction;
    if (c.verifier) entry.verifier = c.verifier;
    entry.lifecycle = "active";
    markTopicEntryEnforced(cwd, c.category as MemoryCategory, c.text);

    const appliedCandidate: PromotionCandidate = { ...c, status: "applied" };
    toQueue.push(appliedCandidate);
    applied += 1;
    details.push(`enforced: [${c.category}] ${c.text}`);
  }

  saveScores(cwd, scores);

  // Merge with existing queue: upsert by id (don't reopen applied/rejected)
  const all = loadPromotions(cwd);
  const byId = new Map(all.map((x) => [x.id, x]));

  for (const c of toQueue) {
    const prev = byId.get(c.id);
    if (prev && prev.status !== "proposed" && c.status === "proposed") {
      continue;
    }
    byId.set(c.id, c);
  }
  writePromotions(cwd, [...byId.values()]);

  const queued = [...byId.values()].filter((c) => c.status === "proposed").length;
  return { applied, queued, details };
}

/**
 * Full promotion pass: scan, apply safe enforcement, refresh queue.
 * Call after reinforce threshold crossings and after dream completes.
 */
export function runPromotionPass(cwd: string): ApplySafeResult {
  try {
    return applySafePromotions(cwd);
  } catch (e: any) {
    console.debug("[memory-promotion] pass failed:", e?.message || e);
    return { applied: 0, queued: 0, details: [] };
  }
}

/**
 * After reinforce: if evidence crossed a threshold, run promotion pass.
 */
export function maybePromoteAfterReinforce(
  cwd: string,
  entryLine: string,
): ApplySafeResult | null {
  const scores = loadScores(cwd);
  const hash = entryHash(entryLine);
  const entry = scores.entries[hash];
  if (!entry) return null;

  const crossed =
    entry.evidenceCount === EVIDENCE_ENFORCEMENT ||
    entry.evidenceCount === EVIDENCE_SKILL ||
    entry.evidenceCount === EVIDENCE_PROJECT_RULE ||
    (entry.evidenceCount > EVIDENCE_ENFORCEMENT &&
      entry.evidenceCount % 3 === 0);

  if (!crossed) return null;
  return runPromotionPass(cwd);
}

export { formatPromotionsForReport, updatePromotionStatus, appendPromotions };
