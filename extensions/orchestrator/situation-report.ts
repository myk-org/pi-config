/**
 * Situation Report — token-budgeted memory context for system prompts.
 *
 * Replaces raw memory.md dump with a structured, prioritized report
 * that fits within a token budget. Higher-priority sections are always
 * included; lower-priority sections are truncated or dropped.
 *
 * Architecture inspired by OpenHuman (https://github.com/tinyhumansai/openhuman).
 * Clean-room TypeScript implementation under MIT — not a code translation.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ScoredEntry,
  type MemoryCategory,
  loadScores,
  parseMemoryFile,
  entryHash,
  rebuild,
  rebuildFromEntries,
} from "./memory-scoring.js";
import { organizeIntoTopics, listTopics, regenerateMemoryMd, readAllTopicEntries, type TopicInfo } from "./memory-tree.js";

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
 *
 * If topics don't exist yet but memory.md does (migration), populates topics first.
 */
export function rebuildAndOrganize(cwd: string): void {
  const memoryPath = join(cwd, ".pi", "memory", "memory.md");
  const topicsDir = join(cwd, ".pi", "memory", "topics");

  // Need at least one source to work with
  if (!existsSync(memoryPath) && !existsSync(topicsDir)) return;

  // Migration: if topics don't exist yet, populate from memory.md
  if (!existsSync(topicsDir) && existsSync(memoryPath)) {
    rebuild(cwd);
    organizeIntoTopics(cwd);
    return;
  }

  // Normal path: rebuild scores from topic files (source of truth)
  const topicEntries = readAllTopicEntries(cwd);
  if (topicEntries.length > 0) {
    rebuildFromEntries(cwd, topicEntries);
  }
}

/**
 * Build a situation report from scored memory entries.
 *
 * Returns a formatted markdown string that fits within the token budget,
 * ready for injection into the system prompt.
 */
export function buildSituationReport(
  cwd: string,
  tokenBudget: number = DEFAULT_TOKEN_BUDGET,
): string {
  const topicsDir = join(cwd, ".pi", "memory", "topics");
  const memoryPath = join(cwd, ".pi", "memory", "memory.md");
  if (!existsSync(topicsDir) && !existsSync(memoryPath)) return "";

  // Read scores (rebuilt on session start + dreaming, not every turn)
  const scores = loadScores(cwd);

  // Read from topic files (source of truth) with hotness ordering
  const topics = listTopics(cwd);
  const topicEntries = readAllTopicEntries(cwd);

  // Build topic hotness map for section ordering
  const topicHotness = new Map<string, number>();
  for (const t of topics) {
    topicHotness.set(t.name, t.hotness);
  }

  // Build entries from topic files (source of truth)
  const entries: MemoryEntryWithText[] = [];
  for (const te of topicEntries) {
    const entryLine = `- [${te.category}] ${te.text}`;
    const hash = entryHash(entryLine);
    const scored = scores.entries[hash];
    if (!scored) continue;
    // Only include active and provisional entries
    if (scored.lifecycle !== "active" && scored.lifecycle !== "provisional") continue;
    entries.push({
      text: te.text,
      category: te.category,
      scored,
      isPinned: te.pinned || scored.userState === "pinned",
    });
  }

  // Fallback: if no topic entries, try memory.md directly (migration path)
  if (entries.length === 0 && existsSync(memoryPath)) {
    const content = readFileSync(memoryPath, "utf-8");
    const parsed = parseMemoryFile(content);
    for (const p of parsed) {
      const hash = entryHash(p.fullLine);
      const scored = scores.entries[hash];
      if (!scored) continue;
      if (scored.lifecycle !== "active" && scored.lifecycle !== "provisional") continue;
      entries.push({
        text: p.text,
        category: p.category,
        scored,
        isPinned: p.section === "pinned" || scored.userState === "pinned",
      });
    }
  }

  if (entries.length === 0) return "";

  // Sort entries by score descending within each category
  entries.sort((a, b) => b.scored.score - a.scored.score);

  // Build sections
  let charBudget = tokenBudget * CHARS_PER_TOKEN;
  const reportSections: string[] = [];

  // Header
  const header = "# Project Memory\n";
  charBudget -= header.length;
  reportSections.push(header);

  // Pinned entries always come first (no budget limit)
  const pinned = entries.filter((e) => e.isPinned);
  if (pinned.length > 0) {
    const pinnedSection = formatSection("Pinned", pinned);
    reportSections.push(pinnedSection);
    charBudget -= pinnedSection.length;
  }

  // Build each scored section in priority order, boosted by topic hotness
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
    const aHot = topicHotness.get(topicMap[a.name] || "") || 0;
    const bHot = topicHotness.get(topicMap[b.name] || "") || 0;
    // Primary: priority (lower = higher). Secondary: hotness (higher = first)
    if (a.priority !== b.priority) return a.priority - b.priority;
    return bHot - aHot;
  });

  for (const sectionDef of sortedSections) {
    if (charBudget <= 0) break;

    const sectionEntries = nonPinned.filter((e) =>
      sectionDef.filter(e.category, e.scored)
    );

    if (sectionEntries.length === 0) continue;

    const sectionCharBudget = Math.min(
      sectionDef.tokenBudget * CHARS_PER_TOKEN,
      charBudget,
    );

    const section = formatSectionWithBudget(
      sectionDef.name,
      sectionEntries,
      sectionCharBudget,
    );

    if (section) {
      reportSections.push(section);
      charBudget -= section.length;
    }
  }

  return reportSections.join("\n");
}

// ── Formatting ─────────────────────────────────────────────────────────────

function formatSection(name: string, entries: MemoryEntryWithText[]): string {
  const header = `## ${name}\n`;
  const lines = entries.map((e) => `- [${e.category}] ${e.text}`);
  return header + lines.join("\n") + "\n";
}

function formatSectionWithBudget(
  name: string,
  entries: MemoryEntryWithText[],
  charBudget: number,
): string | null {
  const header = `## ${name}\n`;
  if (charBudget < header.length + 20) return null;

  let remaining = charBudget - header.length;
  const lines: string[] = [];

  for (const entry of entries) {
    const line = `- [${entry.category}] ${entry.text}`;
    if (remaining < line.length + 1) break; // +1 for newline
    lines.push(line);
    remaining -= line.length + 1;
  }

  if (lines.length === 0) return null;

  const omitted = entries.length - lines.length;
  if (omitted > 0) {
    lines.push(`- ... ${omitted} more (lower priority, omitted for context budget)`);
  }

  return header + lines.join("\n") + "\n";
}
