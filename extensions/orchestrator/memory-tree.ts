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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type MemoryCategory,
  loadScores,
  entryHash,
} from "./memory-scoring.js";

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

/** Append-only log of deliberate entry removals, so background maintenance can tell a
 *  user removal from its own damage. Score absence cannot: the scheduled rebuild prunes
 *  scores for lines missing from topic files (issue #1010). */
const REMOVALS_FILE = "removals.jsonl";
const MAX_REMOVAL_ROWS = 5000;

/** Record that an entry was removed on purpose. Fail-soft: a lost tombstone can only
 *  make the dream guard restore a line the user deleted, never delete one. */
export function recordRemoval(cwd: string, canonicalLine: string): void {
  try {
    const file = join(getProjectMemoryDir(cwd), REMOVALS_FILE);
    const row = `${JSON.stringify({ hash: entryHash(canonicalLine), at: new Date().toISOString() })}\n`;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, row, "utf-8");
    log.debug("memory_removal_recorded", { hash: entryHash(canonicalLine) });
    const rows = readFileSync(file, "utf-8").split("\n").filter(Boolean);
    if (rows.length > MAX_REMOVAL_ROWS) {
      writeFileSync(file, `${rows.slice(-MAX_REMOVAL_ROWS).join("\n")}\n`, "utf-8");
    }
  } catch (error) {
    log.warn("memory_removal_record_failed", { reason: String((error as Error)?.message ?? error).slice(0, 120) });
  }
}

/** Hashes removed at or after `sinceMs` — the only trustworthy signal that a line
 *  missing after a background dream was the user's decision, not the dream's damage. */
export function removalsSince(cwd: string, sinceMs: number): Set<string> {
  const hashes = new Set<string>();
  try {
    const file = join(getProjectMemoryDir(cwd), REMOVALS_FILE);
    if (!existsSync(file)) return hashes;
    for (const row of readFileSync(file, "utf-8").split("\n")) {
      if (!row.trim()) continue;
      try {
        const parsed = JSON.parse(row) as { hash?: unknown; at?: unknown };
        if (typeof parsed.hash !== "string" || typeof parsed.at !== "string") continue;
        if (Date.parse(parsed.at) >= sinceMs) hashes.add(parsed.hash);
      } catch {
        // Skip a malformed row rather than losing the whole log.
      }
    }
    log.debug("memory_removals_since", { sinceMs, count: hashes.size });
  } catch (error) {
    log.warn("memory_removals_read_failed", { reason: String((error as Error)?.message ?? error).slice(0, 120) });
  }
  return hashes;
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
