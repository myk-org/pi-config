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
import { getProjectMemoryDir } from "./utils.js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type MemoryCategory,
  loadScores,
  entryHash,
} from "./memory-scoring.js";
import {
  type TopicEntry,
  parseTopicLine,
  formatTopicLine,
  findTopicLine,
  canonicalTopicLine,
  canonicalizeTopicLine,
  extractTopicLineText,
  stripTopicMarkers,
} from "./memory-line.js";

export {
  type TopicEntry,
  parseTopicLine,
  formatTopicLine,
  findTopicLine,
  canonicalTopicLine,
  canonicalizeTopicLine,
  extractTopicLineText,
  stripTopicMarkers,
};

const log = createLogger("memory");

// ── Constants ──────────────────────────────────────────────────────────────

/** Max chars per topic file (~3000 tokens × 4 chars/token) */
export const MAX_TOPIC_CHARS = 12000;

/** Per-topic override of MAX_TOPIC_CHARS. `completions` accretes by default, so it gets
 *  a tighter budget: completed-work entries crowd out the knowledge worth keeping. */
export const TOPIC_CHAR_CAP: Record<string, number> = { completions: 6000 };

/** Char cap for a topic file name (without `.md`), falling back to MAX_TOPIC_CHARS. */
export function topicCharCap(topic: string): number {
  const cap = TOPIC_CHAR_CAP[topic] ?? MAX_TOPIC_CHARS;
  log.debug("topic_char_cap_resolved", { topic, cap, overridden: topic in TOPIC_CHAR_CAP });
  return cap;
}

/** Topic mapping: which categories go into which topic files */
export const CATEGORY_TO_TOPIC: Record<MemoryCategory, string> = {
  preference: "preferences",
  lesson: "lessons",
  pattern: "patterns",
  decision: "decisions",
  done: "completions",
  mistake: "mistakes",
};

/** Single source of truth for all managed topic file base names (without `.md`). */
export const ALL_TOPIC_NAMES: readonly string[] = Object.values(CATEGORY_TO_TOPIC);

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
  return join(getProjectMemoryDir(cwd), "topics");
}

// ── Topic File I/O ─────────────────────────────────────────────────────────

interface TopicFile {
  entries: TopicEntry[];
  chars: number;
}

// mtime+size read cache (issue #915): readAllTopicEntries is called several
// times per turn (situation report, contextual inject, enforcement, tools) —
// re-reading and re-parsing every topic file each time is wasted work.
const topicFileCache = new Map<string, { mtimeMs: number; size: number; chars: number; entries: TopicEntry[] }>();

function readTopicFile(path: string): TopicFile {
  if (!existsSync(path)) return { entries: [], chars: 0 };
  try {
    // Cache hit — unchanged file (same mtime+size) skips re-parsing
    const st = statSync(path);
    const cached = topicFileCache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return { entries: cached.entries, chars: cached.chars };
    }
    const content = readFileSync(path, "utf-8");
    const entries: TopicEntry[] = [];
    for (const line of content.split("\n")) {
      const entry = parseTopicLine(line);
      if (entry) entries.push(entry);
    }
    const chars = content.length;
    topicFileCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, chars, entries });
    return { entries, chars };
  } catch {
    return { entries: [], chars: 0 };
  }
}

/** Invalidate the topic-file read cache for a path (call after writing it). */
export function invalidateTopicFileCache(path: string): void {
  topicFileCache.delete(path);
}

// ── Read All Topic Entries ──────────────────────────────────────────────────

/**
 * Read all entries from all topic files.
 * This is the primary read path — topics are the source of truth.
 */
export function readAllTopicEntries(cwd: string): TopicEntry[] {
  const topicsDir = getTopicsDir(cwd);
  if (!existsSync(topicsDir)) return [];

  const all: TopicEntry[] = [];
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
        const line = canonicalTopicLine(entry);
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
        chars: topicFile.chars,
      });
    }
  } catch (e: any) { log.debug("list topics failed:", e?.message || e); }

  return infos.sort((a, b) => b.hotness - a.hotness);
}
