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

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  type MemoryCategory,
  loadScores,
  entryHash,
} from "./memory-scoring.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** Max chars per topic file (~3000 tokens × 4 chars/token) */
const MAX_TOPIC_CHARS = 12000;

/** Topic mapping: which categories go into which topic files */
const CATEGORY_TO_TOPIC: Record<MemoryCategory, string> = {
  preference: "preferences",
  lesson: "lessons",
  pattern: "patterns",
  decision: "decisions",
  done: "completions",
  mistake: "mistakes",
};

/** How old a topic's newest entry must be (relative to half-life) before archival */
const ARCHIVAL_MULTIPLIER = 2;

/** Half-lives in ms for archival check */
const HALF_LIVES_MS: Record<string, number> = {
  preferences: 90 * 86400 * 1000,
  lessons: 60 * 86400 * 1000,
  patterns: 30 * 86400 * 1000,
  decisions: 30 * 86400 * 1000,
  completions: 14 * 86400 * 1000,
  mistakes: 14 * 86400 * 1000,
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

function ensureTopicsDir(cwd: string): string {
  const dir = getTopicsDir(cwd);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
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
        // Strip *(pinned)* tags from text (may have duplicates from legacy data)
        const rawText = match[2]!.replace(/\s*\*\(pinned\)\*/g, "").trim();
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

function writeTopicFile(
  path: string,
  topicName: string,
  entries: TopicFile["entries"],
): void {
  const header = `# ${topicName.charAt(0).toUpperCase() + topicName.slice(1)}\n\n`;
  const lines = entries.map((e) => {
    const pinTag = e.pinned ? " *(pinned)*" : "";
    return `- [${e.category}] ${e.text}${pinTag}`;
  });
  const content = header + lines.join("\n") + "\n";

  // Enforce token limit — truncate if too long
  if (content.length > MAX_TOPIC_CHARS) {
    const truncated = content.slice(0, MAX_TOPIC_CHARS);
    const lastNewline = truncated.lastIndexOf("\n");
    writeFileSync(path, truncated.slice(0, lastNewline + 1), "utf-8");
  } else {
    writeFileSync(path, content, "utf-8");
  }
}

// ── Archival ───────────────────────────────────────────────────────────────

function archiveColdTopics(topicsDir: string, topics: TopicInfo[], now: number): void {
  for (const topic of topics) {
    const halfLifeMs = HALF_LIVES_MS[topic.name] || 30 * 86400 * 1000;
    const threshold = halfLifeMs * ARCHIVAL_MULTIPLIER;
    const newestMs = new Date(topic.newestEntry).getTime();
    const age = now - newestMs;

    if (age > threshold && topic.entryCount > 0) {
      // Check if all entries are non-pinned before archiving
      const topicFile = readTopicFile(topic.path);
      const hasPinned = topicFile.entries.some((e) => e.pinned);
      if (!hasPinned) {
        try {
          unlinkSync(topic.path);
        } catch {}
      }
    }
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
  } catch {}
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
  } catch {}

  return infos.sort((a, b) => b.hotness - a.hotness);
}
