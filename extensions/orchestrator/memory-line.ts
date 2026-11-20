/**
 * Pure topic-line parser and formatter — single source of truth for
 * `- [category] text *(pinned)* *(enforced)* {#id}` lines.
 *
 * Leaf module (type-only import from memory-scoring.ts) so both
 * memory-tree.ts and memory-scoring.ts can import it without cycles.
 */

import type { MemoryCategory } from "./memory-scoring.js";

export interface TopicEntry {
  text: string;
  category: MemoryCategory;
  pinned: boolean;
  /** Stable id from the trailing `{#id}` marker, when present (enforced entries). */
  id?: string;
}

/** Regex for a topic entry line: category, text, optional markers, optional id. */
export const TOPIC_LINE_RE =
  /^- \[(preference|lesson|pattern|decision|done|mistake)\] (.+?)(?: \*\(pinned\)\*)?(?: \*\(enforced\)\*)?(?: \{#([0-9a-f]+)\})?$/;

/** Strip pinned/enforced markers and trailing `{#id}` from topic-line text. */
export function stripTopicMarkers(raw: string): string {
  return raw
    .replace(/\s*\*\(pinned\)\*/g, "")
    .replace(/\s*\*\(enforced\)\*/g, "")
    .replace(/\s*\{#[0-9a-f]+\}$/g, "")
    .trim();
}

/** Parse one raw topic-file line into an entry, or null when not an entry. */
export function parseTopicLine(line: string): TopicEntry | null {
  const trimmed = line.trimEnd();
  const match = trimmed.match(TOPIC_LINE_RE);
  if (!match) return null;
  const rawText = stripTopicMarkers(match[2]!);
  const entry: TopicEntry = {
    text: rawText,
    category: match[1] as MemoryCategory,
    pinned: trimmed.includes("*(pinned)*"),
  };
  if (match[3]) entry.id = match[3];
  return entry;
}

/** Canonical `- [category] text` key (no markers or id) used for hashing/scoring. */
export function canonicalTopicLine(entry: Pick<TopicEntry, "category" | "text">): string {
  return `- [${entry.category}] ${entry.text}`;
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
 *  memory_remove / memory_edit / promotion so they match regardless of
 *  pinned/enforced/id marker combinations. */
export function findTopicLine(
  content: string,
  category: string,
  text: string,
): { line: string; index: number; pinned: boolean; enforced: boolean; id?: string } | null {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trimEnd();
    const parsed = parseTopicLine(trimmed);
    if (parsed && parsed.category === category && parsed.text === text) {
      return {
        line: trimmed,
        index: i,
        pinned: parsed.pinned,
        enforced: trimmed.includes("*(enforced)*"),
        id: parsed.id,
      };
    }
  }
  return null;
}
