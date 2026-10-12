/**
 * Memory Tree — hierarchical topic-based memory organization.
 *
 * Organizes memory entries into topic files under .pi/memory/topics/.
 * Each topic file is a Markdown chunk limited to ~3000 tokens.
 * Topics have hotness scores based on reinforcement frequency.
 * The situation report pulls from hot topics first.
 *
 * Architecture inspired by OpenHuman (https://github.com/tinyhumansai/openhuman).
 * Clean-room TypeScript implementation under MIT — not a code translation.
 */

import { createLogger } from "../shared/logger.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type MemoryCategory,
  loadScores,
  entryHash,
} from "./memory-scoring.js";

const log = createLogger("memory");

// ── Constants ──────────────────────────────────────────────────────────────

/** Max chars per topic file (~3000 tokens × 4 chars/token) */
export const MAX_TOPIC_CHARS = 12000;

/** Topic mapping: which categories go into which topic files */
export const CATEGORY_TO_TOPIC: Record<MemoryCategory, string> = {
  preference: "preferences",
  lesson: "lessons",
  pattern: "patterns",
  decision: "decisions",
  done: "completions",
  mistake: "mistakes",
};

// ── Types ──────────────────────────────────────────────────────────────────

export interface TopicInfo {
  name: string;
  path: string;
  entryCount: number;
  hotness: number;
  newestEntry: string; // ISO date
  chars: number;
}

// ── Topic Directory ────────────────────────────────────────────────────────

function getTopicsDir(cwd: string): string {
  return join(cwd, ".pi", "memory", "topics");
}

// ── Topic File I/O ─────────────────────────────────────────────────────────

interface TopicFile {
  entries: { text: string; category: MemoryCategory; pinned: boolean }[];
}

function readTopicFile(path: string): TopicFile {
  if (!existsSync(path)) return { entries: [] };
  try {
    const content = readFileSync(path, "utf-8");
    const entries: TopicFile["entries"] = [];
    for (const line of content.split("\n")) {
      const match = line.match(/^- \[(preference|lesson|pattern|decision|done|mistake)\] (.+)$/);
      if (match) {
        // Strip *(pinned)* and *(enforced)* tags from text (may have duplicates from legacy data)
        const rawText = match[2]!.replace(/\s*\*\(pinned\)\*/g, "").replace(/\s*\*\(enforced\)\*/g, "").trim();
        entries.push({
          text: rawText,
          category: match[1] as MemoryCategory,
          pinned: line.includes("*(pinned)*"),
        });
      }
    }
    return { entries };
  } catch {
    return { entries: [] };
  }
}

// ── Read All Topic Entries ──────────────────────────────────────────────────

/**
 * Read all entries from all topic files.
 * This is the primary read path — topics are the source of truth.
 */
export function readAllTopicEntries(cwd: string): { text: string; category: MemoryCategory; pinned: boolean }[] {
  const topicsDir = getTopicsDir(cwd);
  if (!existsSync(topicsDir)) return [];

  const all: { text: string; category: MemoryCategory; pinned: boolean }[] = [];
  try {
    const files = readdirSync(topicsDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const topicFile = readTopicFile(join(topicsDir, file));
      all.push(...topicFile.entries);
    }
  } catch (e: any) { log.debug("read topic entries failed:", e?.message || e); }
  return all;
}

// ── List Topics ────────────────────────────────────────────────────────────

/**
 * List all topic files with their info.
 */
export function listTopics(cwd: string): TopicInfo[] {
  const topicsDir = getTopicsDir(cwd);
  if (!existsSync(topicsDir)) return [];

  const scores = loadScores(cwd);
  const infos: TopicInfo[] = [];

  try {
    const files = readdirSync(topicsDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const path = join(topicsDir, file);
      const topicFile = readTopicFile(path);
      const topicName = file.replace(/\.md$/, "");

      let hotness = 0;
      let newestDate = 0;
      for (const entry of topicFile.entries) {
        const line = `- [${entry.category}] ${entry.text}`;
        const hash = entryHash(line);
        const scored = scores.entries[hash];
        if (scored) {
          hotness += scored.score;
          const reinforced = new Date(scored.lastReinforced).getTime();
          if (reinforced > newestDate) newestDate = reinforced;
        }
      }

      infos.push({
        name: topicName,
        path,
        entryCount: topicFile.entries.length,
        hotness,
        newestEntry: newestDate ? new Date(newestDate).toISOString() : "",
        chars: readFileSync(path, "utf-8").length,
      });
    }
  } catch (e: any) { log.debug("list topics failed:", e?.message || e); }

  return infos.sort((a, b) => b.hotness - a.hotness);
}
