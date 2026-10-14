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

export interface TopicEntry {
  text: string;
  category: MemoryCategory;
  pinned: boolean;
  /** Stable id from the trailing `{#id}` marker, when present (enforced entries). */
  id?: string;
}

// ── Topic Directory ────────────────────────────────────────────────────────

function getTopicsDir(cwd: string): string {
  return join(getProjectMemoryDir(cwd), "topics");
}

// ── Topic File I/O ─────────────────────────────────────────────────────────

interface TopicFile {
  entries: TopicEntry[];
}

// mtime+size read cache (issue #915): readAllTopicEntries is called several
// times per turn (situation report, contextual inject, enforcement, tools) —
// re-reading and re-parsing every topic file each time is wasted work.
const topicFileCache = new Map<string, { mtimeMs: number; size: number; entries: TopicEntry[] }>();

/** Regex for a topic entry line: category, text, optional markers, optional id. */
const TOPIC_LINE_RE =
  /^- \[(preference|lesson|pattern|decision|done|mistake)\] (.+?)(?: \*\(pinned\)\*)?(?: \*\(enforced\)\*)?(?: \{#([0-9a-f]+)\})?$/;

/** Parse one raw topic-file line into an entry, or null when not an entry. */
export function parseTopicLine(line: string): TopicEntry | null {
  const match = line.trimEnd().match(TOPIC_LINE_RE);
  if (!match) return null;
  // Markers may be duplicated in legacy data — strip remaining copies
  const rawText = match[2]!
    .replace(/\s*\*\(pinned\)\*/g, "")
    .replace(/\s*\*\(enforced\)\*/g, "")
    .replace(/\s*\{#[0-9a-f]+\}$/g, "")
    .trim();
  const entry: TopicEntry = {
    text: rawText,
    category: match[1] as MemoryCategory,
    pinned: line.includes("*(pinned)*"),
  };
  if (match[3]) entry.id = match[3];
  return entry;
}

/** Build the file line for an entry, including markers and id. */
export function formatTopicLine(entry: TopicEntry, enforced = false): string {
  const pin = entry.pinned ? " *(pinned)*" : "";
  const enf = enforced ? " *(enforced)*" : "";
  const id = entry.id ? ` {#${entry.id}}` : "";
  return `- [${entry.category}] ${entry.text}${pin}${enf}${id}`;
}

/** Match a topic line by category + exact text, ignoring marker variations.
 *  Returns the raw line, its index, and parsed markers — used by
 *  memory_remove / memory_edit so they match regardless of pinned/enforced/id
 *  marker combinations. */
export function findTopicLine(
  content: string,
  category: string,
  text: string,
): { line: string; index: number; pinned: boolean; enforced: boolean; id?: string } | null {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trimEnd();
    const m = trimmed.match(
      new RegExp(`^- \\[${category}\\] ${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: \\*\\(pinned\\)\\*)?(?: \\*\\(enforced\\)\\*)?(?: \\{#[0-9a-f]+\\})?$`),
    );
    if (m) {
      return {
        line: trimmed,
        index: i,
        pinned: trimmed.includes("*(pinned)*"),
        enforced: trimmed.includes("*(enforced)*"),
        id: trimmed.match(/\{#([0-9a-f]+)\}$/)?.[1],
      };
    }
  }
  return null;
}

function readTopicFile(path: string): TopicFile {
  if (!existsSync(path)) return { entries: [] };
  try {
    // Cache hit — unchanged file (same mtime+size) skips re-parsing
    const st = statSync(path);
    const cached = topicFileCache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return { entries: cached.entries };
    }
    const content = readFileSync(path, "utf-8");
    const entries: TopicEntry[] = [];
    for (const line of content.split("\n")) {
      const entry = parseTopicLine(line);
      if (entry) entries.push(entry);
    }
    topicFileCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, entries });
    return { entries };
  } catch {
    return { entries: [] };
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
