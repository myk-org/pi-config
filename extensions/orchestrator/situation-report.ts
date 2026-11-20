/**
 * Situation Report — token-budgeted memory context for system prompts.
 *
 * Replaces raw memory dump with a structured, prioritized report
 * that fits within a token budget. Higher-priority sections are always
 * included; lower-priority sections are truncated or dropped.
 *
 * Architecture inspired by OpenHuman (https://github.com/tinyhumansai/openhuman).
 * Clean-room TypeScript implementation under MIT — not a code translation.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getSetting } from "./project-settings.js";
import { getProjectMemoryDir } from "./utils.js";
import {
  type ScoredEntry,
  type ScoresFile,
  type MemoryCategory,
  loadScores,
  entryHash,
  rebuild,
} from "./memory-scoring.js";
import {
  CATEGORY_TO_TOPIC,
  type TopicEntry,
  canonicalTopicLine,
  readAllTopicEntries,
} from "./memory-tree.js";
import { pruneEmbeddings } from "./memory-embeddings.js";
import { formatPromotionsForReport } from "./promotion-queue.js";
import { pruneExpiredEntries } from "./memory-write.js";
import {
  type QueryClass,
  getQueryClassBias,
  sectionPriorityBoost,
} from "./memory-query-class.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** Rough chars-per-token estimate for budget enforcement */
const CHARS_PER_TOKEN = 4;

/** Default total token budget for the situation report */
const DEFAULT_TOKEN_BUDGET = 1700;

/** Section definitions with priority and token budgets */
interface SectionDef {
  name: string;
  priority: number;
  tokenBudget: number;
  filter: (category: MemoryCategory, entry: ScoredEntry) => boolean;
}

const SECTIONS: SectionDef[] = [
  {
    name: "Active Preferences",
    priority: 1,
    tokenBudget: 400,
    filter: (cat) => cat === "preference",
  },
  {
    name: "Active Lessons",
    priority: 2,
    tokenBudget: 400,
    filter: (cat) => cat === "lesson",
  },
  {
    name: "Vetoes & Mistakes",
    priority: 3,
    tokenBudget: 200,
    filter: (cat) => cat === "mistake",
  },
  {
    name: "Patterns",
    priority: 4,
    tokenBudget: 200,
    filter: (cat) => cat === "pattern",
  },
  {
    name: "Recent Decisions",
    priority: 5,
    tokenBudget: 200,
    filter: (cat, entry) => {
      if (cat !== "decision") return false;
      // Only include decisions from last 7 days
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const lastReinforced = new Date(entry.lastReinforced).getTime();
      return Date.now() - lastReinforced < sevenDaysMs;
    },
  },
  {
    name: "Recent Completions",
    priority: 6,
    tokenBudget: 200,
    filter: (cat, entry) => {
      if (cat !== "done") return false;
      // Only include completions from last 3 days
      const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
      const lastReinforced = new Date(entry.lastReinforced).getTime();
      return Date.now() - lastReinforced < threeDaysMs;
    },
  },
];

// ── Report Building ────────────────────────────────────────────────────────

interface MemoryEntryWithText {
  text: string;
  category: MemoryCategory;
  scored: ScoredEntry;
  isPinned: boolean;
}

/**
 * Run a full rebuild cycle: rescore all entries from topics (source of truth).
 * Called on session_start, every 30 min, and after dreaming.
 */
export function rebuildAndOrganize(cwd: string): void {
  const topicsDir = join(getProjectMemoryDir(cwd), "topics");
  if (!existsSync(topicsDir)) return;

  // Prune expired scoped entries first (issue #915): session/task-scoped
  // entries must not outlive their scope. Pruning removes topic lines, so it
  // must happen before the rebuild re-initializes scores for topic entries.
  try {
    pruneExpiredEntries(cwd);
  } catch {
    // non-fatal — rebuild continues with whatever entries remain
  }

  const topicEntries = readAllTopicEntries(cwd);
  if (topicEntries.length > 0) {
    rebuild(cwd, topicEntries);
  }
  try {
    pruneEmbeddings(cwd, topicEntries);
  } catch {
    // non-fatal — stale embeddings do not affect correctness
  }
}

export interface SituationReportOptions {
  /** Query class for section budget / priority bias */
  queryClass?: QueryClass;
  /** Preloaded scores and topic entries from the caller to avoid duplicate per-turn reads */
  preloaded?: { scores: ScoresFile; topicEntries: TopicEntry[] };
  /** Populated with canonical `- [category] text` keys actually emitted in the report */
  emittedKeys?: Set<string>;
}

/**
 * Build a situation report from scored memory entries.
 *
 * Returns a formatted markdown string that fits within the token budget,
 * ready for injection into the system prompt.
 */
export function buildSituationReport(
  cwd: string,
  tokenBudget: number = -1,
  options: SituationReportOptions = {},
): string {
  // Budget not passed explicitly (negative) — resolve from settings (issue #915).
  // An explicit 0 still means "no budget — skip injection".
  if (tokenBudget < 0) tokenBudget = getMemoryTokenBudget(cwd);
  // Exhausted memory budget — do not inject (avoids divide-by-zero / NaN usage %)
  if (tokenBudget <= 0) return "";

  const topicsDir = join(getProjectMemoryDir(cwd), "topics");
  const queryClass: QueryClass = options.queryClass ?? "general";
  const bias = getQueryClassBias(queryClass);

  const hasTopics = options.preloaded ? true : existsSync(topicsDir);

  // Read scores (rebuilt on session start + dreaming, not every turn)
  const scores = options.preloaded?.scores ?? (hasTopics ? loadScores(cwd) : { entries: {}, lastRebuild: "" });
  const topicEntries = options.preloaded?.topicEntries ?? (hasTopics ? readAllTopicEntries(cwd) : []);

  // Build topic hotness map + eligible entries in one pass (avoids duplicate listTopics I/O + SHA-256 hashing)
  const topicHotness = new Map<string, number>();
  const entries: MemoryEntryWithText[] = [];
  for (const te of topicEntries) {
    const entryLine = canonicalTopicLine(te);
    const hash = entryHash(entryLine);
    const scored = scores.entries[hash];
    if (!scored) continue;
    const topicName = CATEGORY_TO_TOPIC[te.category];
    if (topicName) {
      topicHotness.set(topicName, (topicHotness.get(topicName) ?? 0) + scored.score);
    }
    // Only include active and provisional entries
    if (scored.lifecycle !== "active" && scored.lifecycle !== "provisional") continue;
    // Session-scoped entries are transient (issue #915) — never injected
    // into the situation report; they expire via pruneExpiredEntries.
    if (scored.scope === "session") continue;
    entries.push({
      text: te.text,
      category: te.category,
      scored,
      isPinned: te.pinned || scored.userState === "pinned",
    });
  }

  // Build body sections first, then compute actual capacity from emitted content
  let charBudget = Math.max(0, tokenBudget * CHARS_PER_TOKEN);
  const bodySections: string[] = [];

  const headerTemplate = `# Project Memory [XX% — XXXX/${tokenBudget} tokens]\n`;
  const warningText = "> ⚠️ Memory ≥80% full; remove stale entries via memory_remove before adding.\n";
  const groundTruthLine =
    "> **Ground Truth:** Memories here and below are authoritative; use directly without re-verifying.\n";

  // Reserve budget for header + ground truth instruction
  const headerReserve = headerTemplate.length + groundTruthLine.length;
  charBudget = Math.max(0, charBudget - headerReserve);

  // Promotion candidates (low budget) — show even when topics empty
  const promoSection = formatPromotionsForReport(cwd, 5);
  if (promoSection) {
    const promoBudget = Math.min(150 * CHARS_PER_TOKEN, charBudget);
    const truncated = truncateLinesToBudget(promoSection, promoBudget);
    if (truncated) {
      bodySections.push(truncated);
      charBudget -= truncated.length;
    }
  }

  if (bias.hint && queryClass !== "general") {
    const hintLine = `> Query class: \`${queryClass}\` — ${bias.hint}\n`;
    bodySections.push(hintLine);
    charBudget -= hintLine.length;
  }

  if (entries.length === 0 && bodySections.length === 0) return "";

  // Sort entries by score descending within each category
  entries.sort((a, b) => b.scored.score - a.scored.score);

  // Pinned entries always come first (no budget limit)
  const pinned = entries.filter((e) => e.isPinned);
  if (pinned.length > 0) {
    const pinnedSection = formatSection("Pinned", pinned, options.emittedKeys);
    bodySections.push(pinnedSection);
    charBudget -= pinnedSection.length;
  }

  // Build each scored section in priority order, boosted by topic hotness + query class
  const nonPinned = entries.filter((e) => !e.isPinned);

  // Sort sections: use base priority but boost sections whose topic is hotter
  const sortedSections = [...SECTIONS].sort((a, b) => {
    // Map section names to topic names
    const topicMap: Record<string, string> = {
      "Active Preferences": "preferences",
      "Active Lessons": "lessons",
      "Vetoes & Mistakes": "mistakes",
      "Patterns": "patterns",
      "Recent Decisions": "decisions",
      "Recent Completions": "completions",
    };
    const aPriority = sectionPriorityBoost(a.name, a.priority, queryClass);
    const bPriority = sectionPriorityBoost(b.name, b.priority, queryClass);
    const aHot = topicHotness.get(topicMap[a.name] || "") || 0;
    const bHot = topicHotness.get(topicMap[b.name] || "") || 0;
    // Primary: priority (lower = higher). Secondary: hotness (higher = first)
    if (aPriority !== bPriority) return aPriority - bPriority;
    return bHot - aHot;
  });

  for (const sectionDef of sortedSections) {
    if (charBudget <= 0) break;

    const sectionEntries = nonPinned.filter((e) =>
      sectionDef.filter(e.category, e.scored)
    );

    if (sectionEntries.length === 0) continue;

    // Boost token budget for query-class-relevant sections
    const sectionCatMap: Record<string, MemoryCategory> = {
      "Active Preferences": "preference",
      "Active Lessons": "lesson",
      "Vetoes & Mistakes": "mistake",
      Patterns: "pattern",
      "Recent Decisions": "decision",
      "Recent Completions": "done",
    };
    const sectionCat = sectionCatMap[sectionDef.name];
    const boosted = !!(sectionCat && bias.boostCategories.includes(sectionCat));
    const sectionTokenBudget = boosted
      ? Math.floor(sectionDef.tokenBudget * 1.25)
      : sectionDef.tokenBudget;

    const sectionCharBudget = Math.min(
      sectionTokenBudget * CHARS_PER_TOKEN,
      charBudget,
    );

    const section = formatSectionWithBudget(
      sectionDef.name,
      sectionEntries,
      sectionCharBudget,
      options.emittedKeys,
    );

    if (section) {
      bodySections.push(section);
      charBudget -= section.length;
    }
  }

  // Build header and optional warning, then include their sizes in the capacity calculation
  const bodyContent = bodySections.join("\n");

  // Estimate: include header; include warning only when removable (non-pinned) entries exist
  const bodyChars = bodyContent.length;
  const roughUsage = (bodyChars + headerTemplate.length + groundTruthLine.length) / CHARS_PER_TOKEN / tokenBudget;
  const includeWarning = roughUsage >= 0.8 && nonPinned.length > 0;

  // Include header + warning + ground truth in the actual usage
  const headerChars = headerTemplate.length + groundTruthLine.length + (includeWarning ? warningText.length : 0);
  const actualCharsUsed = bodyChars + headerChars;
  const totalTokensUsed = Math.floor(actualCharsUsed / CHARS_PER_TOKEN);
  const usagePercent = Math.floor((totalTokensUsed / tokenBudget) * 100);

  // Build final report: header first, then body
  const reportSections: string[] = [];
  const header = `# Project Memory [${usagePercent}% — ${totalTokensUsed}/${tokenBudget} tokens]\n`;
  reportSections.push(header);

  // Consolidation warning when above 80% and non-pinned entries can be removed
  if (usagePercent >= 80 && nonPinned.length > 0) {
    reportSections.push(warningText);
  }

  // Ground Truth instruction (text defined above for budget accounting)
  reportSections.push(groundTruthLine);

  reportSections.push(...bodySections);

  return reportSections.join("\n");
}

/** Default total token budget for the system prompt (rules + context + memory). */
const SYSTEM_PROMPT_TOKEN_BUDGET = 8000;

/** Resolve the memory report token budget from settings (issue #915).
 *  0 is a valid, honored value — it DISABLES the memory report (Qodo #15,
 *  PR #916); only missing/non-numeric/negative values fall back to default. */
export function getMemoryTokenBudget(cwd: string): number {
  const v = Number(getSetting(cwd, "memory_token_budget"));
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_TOKEN_BUDGET;
}

/**
 * Estimate available token budget for memory based on system prompt size.
 * Shrinks memory budget when the system prompt is already large.
 */
export function estimateMemoryBudget(
  systemPromptLength: number,
  totalBudget: number = SYSTEM_PROMPT_TOKEN_BUDGET,
  cwd?: string,
): number {
  // Memory competes with rules, context files, skills, etc.
  const systemPromptTokens = Math.ceil(systemPromptLength / CHARS_PER_TOKEN);
  const remaining = totalBudget - systemPromptTokens;
  // No budget left — skip memory injection entirely
  if (remaining <= 0) return 0;
  // Clamp to the configured memory budget maximum
  const max = cwd ? getMemoryTokenBudget(cwd) : DEFAULT_TOKEN_BUDGET;
  return Math.min(max, remaining);
}

// ── Formatting ─────────────────────────────────────────────────────────────

function truncateLinesToBudget(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const add = line.length + 1;
    if (used + add > budget) break;
    kept.push(line);
    used += add;
  }
  return kept.some((l) => l.startsWith("- ")) ? kept.join("\n") + "\n" : "";
}

function formatSection(
  name: string,
  entries: MemoryEntryWithText[],
  emittedKeys?: Set<string>,
): string {
  const header = `## ${name}\n`;
  const lines = entries.map((e) => {
    const line = canonicalTopicLine(e);
    emittedKeys?.add(line);
    return line;
  });
  return header + lines.join("\n") + "\n";
}

function formatSectionWithBudget(
  name: string,
  entries: MemoryEntryWithText[],
  charBudget: number,
  emittedKeys?: Set<string>,
): string | null {
  const header = `## ${name}\n`;
  if (charBudget < header.length + 20) return null;

  let remaining = charBudget - header.length;
  const lines: string[] = [];
  const addedKeys: string[] = [];

  for (const entry of entries) {
    const line = canonicalTopicLine(entry);
    if (remaining < line.length + 1) break; // +1 for newline
    lines.push(line);
    addedKeys.push(line);
    remaining -= line.length + 1;
  }

  if (lines.length === 0) return null;
  if (emittedKeys) {
    for (const k of addedKeys) emittedKeys.add(k);
  }

  const omitted = entries.length - lines.length;
  if (omitted > 0) {
    lines.push(`- ... ${omitted} more (lower priority, omitted for context budget)`);
  }

  return header + lines.join("\n") + "\n";
}
