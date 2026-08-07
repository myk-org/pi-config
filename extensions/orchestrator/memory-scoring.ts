/**
 * Memory Scoring Engine — stability-based memory learning.
 *
 * Scores memory entries using a stability formula with decay, evidence
 * weighting, and per-category budgets. Entries that aren't reinforced
 * fade over time. Frequently reinforced entries become stronger.
 *
 * Architecture inspired by OpenHuman (https://github.com/tinyhumansai/openhuman).
 * Clean-room TypeScript implementation under MIT — not a code translation.
 */

import { join } from "node:path";
import { createCachedStore } from "./state-jsonl.js";
import type { JsonlStateStore } from "./state-jsonl.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type MemoryCategory = "preference" | "lesson" | "pattern" | "decision" | "done" | "mistake";
export type CueType = "explicit" | "structural" | "behavioral" | "recurrence";
export type UserState = "auto" | "pinned" | "forgotten";
export type LifecycleState = "active" | "provisional" | "candidate" | "dropped";

/** Trigger types for enforcement rules */
export type EnforcementTrigger =
  | `bash_contains ${string}`   // matches if bash command contains the string
  | `bash_regex ${string}`      // matches if bash command matches the regex
  | `tool_name ${string}`       // matches if tool name equals the string
  | `file_modified ${string}`;  // matches if a write/edit targets a matching path glob

/** Action types for enforcement rules */
export type EnforcementAction =
  | "block"       // block the tool call, return error
  | "run_after"   // run a command after the tool succeeds
  | "warn";       // append warning to tool result

export interface ScoredEntry {
  /** Category of the memory */
  class: MemoryCategory;
  /** Stability score (higher = more stable) */
  score: number;
  /** Number of times this memory has been reinforced */
  evidenceCount: number;
  /** How this memory was produced */
  cue: CueType;
  /** When first observed (ISO string) */
  firstSeen: string;
  /** When last reinforced (ISO string) */
  lastReinforced: string;
  /** User override state */
  userState: UserState;
  /** Current lifecycle state */
  lifecycle: LifecycleState;

  // ── Enforcement fields (optional) ──────────────────────────────────
  /** What activates this rule (e.g., 'bash_contains git add .') */
  trigger?: EnforcementTrigger;
  /** What to do when triggered: block, run_after, warn */
  action?: EnforcementAction;
  /** Command to run (for run_after action) */
  actionCommand?: string;
  /** Semantic verifier — condition to check (e.g., 'tool_called ask_user before gh pr merge') */
  verifier?: string;

  // ── Provenance fields (optional; not injected into situation report) ──
  /** Session id or path basename this memory came from */
  sourceSession?: string;
  /** Short note or prior entry hash this was derived from */
  derivedFrom?: string;
  /** Free-text targets this memory informs (e.g. pr-review, git, skill name) */
  informs?: string[];
}

export interface ScoresFile {
  entries: Record<string, ScoredEntry>;
  lastRebuild: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Cue type weights — how strongly each evidence source contributes */
const CUE_WEIGHTS: Record<CueType, number> = {
  explicit: 1.0,
  structural: 0.9,
  behavioral: 0.7,
  recurrence: 0.6,
};

/** Half-lives in seconds per category — how fast memories decay */
const HALF_LIVES: Record<MemoryCategory, number> = {
  preference: 90 * 86400,   // 90 days
  lesson: 60 * 86400,       // 60 days
  pattern: 30 * 86400,      // 30 days
  decision: 30 * 86400,     // 30 days
  done: 14 * 86400,         // 14 days
  mistake: 14 * 86400,      // 14 days
};

/** Per-category budget caps for Active entries */
const CATEGORY_BUDGETS: Record<MemoryCategory, number> = {
  preference: 8,
  lesson: 8,
  pattern: 6,
  decision: 4,
  done: 4,
  mistake: 4,
};

/** Cross-category overflow pool for Provisional entries */
const OVERFLOW_BUDGET = 6;

/** Total max active entries */
const MAX_ACTIVE_ENTRIES = 40;

/** Lifecycle thresholds */
const TAU_PROMOTE = 1.5;
const TAU_PROVISIONAL = 0.7;
const TAU_EVICT = 0.4;

// ── Scoring Formula ────────────────────────────────────────────────────────

/**
 * Calculate stability score for a memory entry.
 *
 * Formula: cue_weight × exp(-Δt / half_life) × ln(1 + evidence_count)
 *
 * - Pinned entries → Infinity (never decay)
 * - Forgotten entries → 0 (always dropped)
 */
/** Score value representing pinned entries (JSON-safe alternative to Infinity) */
export const PINNED_SCORE = 9999;

export function calculateStability(
  cue: CueType,
  evidenceCount: number,
  lastReinforcedAt: number,
  nowMs: number,
  category: MemoryCategory,
  userState: UserState,
): number {
  if (userState === "pinned") return PINNED_SCORE;
  if (userState === "forgotten") return 0;

  const dtSeconds = Math.max(0, (nowMs - lastReinforcedAt) / 1000);
  const halfLife = HALF_LIVES[category];
  const recency = Math.exp(-dtSeconds / halfLife);
  const base = CUE_WEIGHTS[cue] * recency * Math.log(1 + evidenceCount);
  return base;
}

/**
 * Determine lifecycle state from a stability score.
 */
export function lifecycleFromScore(score: number, userState: UserState, entry?: ScoredEntry): LifecycleState {
  if (userState === "pinned") return "active";
  if (userState === "forgotten") return "dropped";
  // Enforced entries never decay below active — require trigger+action or verifier
  if (entry && ((entry.trigger && entry.action) || entry.verifier)) return "active";
  if (score >= PINNED_SCORE) return "active";
  if (score >= TAU_PROMOTE) return "active";
  if (score >= TAU_PROVISIONAL) return "provisional";
  if (score >= TAU_EVICT) return "candidate";
  return "dropped";
}

// ── Hash Utility ───────────────────────────────────────────────────────────

/** Generate a simple hash key for a memory entry text */
export function entryHash(text: string): string {
  // Simple FNV-1a hash — deterministic, no crypto dependency needed
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ── Scores File I/O ────────────────────────────────────────────────────────
// Persistence: append-only JSONL via JsonlStateStore (issue #724).
// Legacy memory-scores.json is auto-migrated on first access.

const SCORES_FILENAME_JSONL = "memory-scores.jsonl";
const LEGACY_SCORES_FILENAME = "memory-scores.json";

function getScoresStore(cwd: string): JsonlStateStore<ScoresFile> {
  return createCachedStore<ScoresFile>(
    join(cwd, ".pi", "memory"), SCORES_FILENAME_JSONL, LEGACY_SCORES_FILENAME, { compactThreshold: 50 },
  );
}

export function getScoresPath(cwd: string): string {
  return join(cwd, ".pi", "memory", SCORES_FILENAME_JSONL);
}

export function loadScores(cwd: string): ScoresFile {
  const store = getScoresStore(cwd);
  const data = store.read();
  if (data === null) {
    return { entries: {}, lastRebuild: new Date().toISOString() };
  }
  return data;
}

export function saveScores(cwd: string, scores: ScoresFile): void {
  getScoresStore(cwd).write(scores);
}

// ── Internal Types ─────────────────────────────────────────────────────────

interface ParsedEntry {
  section: "pinned" | "learned";
  category: MemoryCategory;
  text: string;
  fullLine: string;
}

// ── Rebuild Cycle ──────────────────────────────────────────────────────────

export interface RebuildResult {
  active: number;
  provisional: number;
  dropped: number;
  total: number;
}

/**
 * Run a full rebuild cycle: score all entries, apply budgets, update lifecycle states.
 * Takes entries from topic files (the sole source of truth).
 */
export function rebuild(
  cwd: string,
  entries: { category: MemoryCategory; text: string; pinned: boolean }[],
): RebuildResult {
  const parsed = entries.map((e) => ({
    section: (e.pinned ? "pinned" : "learned") as "pinned" | "learned",
    category: e.category,
    text: e.text,
    fullLine: `- [${e.category}] ${e.text}`,
  }));
  return rebuildFromParsed(cwd, parsed);
}

function rebuildFromParsed(cwd: string, parsed: ParsedEntry[]): RebuildResult {
  if (parsed.length === 0) {
    return { active: 0, provisional: 0, dropped: 0, total: 0 };
  }
  const scores = loadScores(cwd);
  const now = Date.now();

  // Step 1: Score all entries
  for (const entry of parsed) {
    const hash = entryHash(entry.fullLine);
    const existing = scores.entries[hash];

    if (existing) {
      // Recalculate stability with current time
      existing.score = calculateStability(
        existing.cue,
        existing.evidenceCount,
        new Date(existing.lastReinforced).getTime(),
        now,
        existing.class,
        existing.userState,
      );
      existing.lifecycle = lifecycleFromScore(existing.score, existing.userState, existing);
    } else {
      // New entry — initialize
      const userState: UserState = entry.section === "pinned" ? "pinned" : "auto";
      const cue: CueType = entry.section === "pinned" ? "explicit" : "behavioral";
      const score = calculateStability(cue, 1, now, now, entry.category, userState);

      scores.entries[hash] = {
        class: entry.category,
        score,
        evidenceCount: 1,
        cue,
        firstSeen: new Date(now).toISOString(),
        lastReinforced: new Date(now).toISOString(),
        userState,
        lifecycle: lifecycleFromScore(score, userState),
      };
    }
  }

  // Step 2: Remove scores for entries that no longer exist in topics
  // Preserve entries with enforcement fields — they must not be deleted even
  // if dreaming rewrites the topic file text (which changes the hash).
  const currentHashes = new Set(parsed.map((e) => entryHash(e.fullLine)));
  for (const hash of Object.keys(scores.entries)) {
    if (!currentHashes.has(hash)) {
      const entry = scores.entries[hash];
      if (entry && ((entry.trigger && entry.action) || entry.verifier)) {
        // Enforced entry (trigger+action or verifier) — keep it
        // Mark as orphaned so budgeting excludes it
        (entry as any)._orphaned = true;
        continue;
      }
      delete scores.entries[hash];
    }
  }

  // Step 3: Apply per-category budgets
  const byCategory: Record<string, { hash: string; entry: ScoredEntry }[]> = {};
  for (const [hash, entry] of Object.entries(scores.entries)) {
    // Skip orphaned enforced entries from budgeting — they don't have topic file backing
    if ((entry as any)._orphaned) continue;
    if (entry.lifecycle === "active") {
      if (!byCategory[entry.class]) byCategory[entry.class] = [];
      byCategory[entry.class]!.push({ hash, entry });
    }
  }

  const overflow: { hash: string; entry: ScoredEntry }[] = [];
  for (const [category, entries] of Object.entries(byCategory)) {
    const budget = CATEGORY_BUDGETS[category as MemoryCategory] || 4;
    // Sort by score descending
    entries.sort((a, b) => b.entry.score - a.entry.score);
    // Demote excess to provisional
    for (let i = budget; i < entries.length; i++) {
      entries[i]!.entry.lifecycle = "provisional";
      overflow.push(entries[i]!);
    }
  }

  // Step 4: Apply overflow budget for provisional entries
  overflow.sort((a, b) => b.entry.score - a.entry.score);
  for (let i = OVERFLOW_BUDGET; i < overflow.length; i++) {
    overflow[i]!.entry.lifecycle = "candidate";
  }

  // Step 5: Enforce total cap
  const allActive = Object.values(scores.entries).filter((e) => e.lifecycle === "active");
  if (allActive.length > MAX_ACTIVE_ENTRIES) {
    allActive.sort((a, b) => b.score - a.score);
    for (let i = MAX_ACTIVE_ENTRIES; i < allActive.length; i++) {
      allActive[i]!.lifecycle = "provisional";
    }
  }

  // Step 6: Clean up internal markers and save
  for (const entry of Object.values(scores.entries)) {
    delete (entry as any)._orphaned;
  }
  scores.lastRebuild = new Date(now).toISOString();
  saveScores(cwd, scores);

  // Count results
  const values = Object.values(scores.entries);
  return {
    active: values.filter((e) => e.lifecycle === "active").length,
    provisional: values.filter((e) => e.lifecycle === "provisional").length,
    dropped: values.filter((e) => e.lifecycle === "dropped").length,
    total: values.length,
  };
}

// ── Reinforcement ──────────────────────────────────────────────────────────

/**
 * Reinforce an existing memory entry (bump evidence count + last reinforced).
 * Returns true if the entry was found and reinforced.
 */
export function reinforce(cwd: string, entryLine: string): boolean {
  const scores = loadScores(cwd);
  const hash = entryHash(entryLine);
  const entry = scores.entries[hash];
  if (!entry) return false;

  entry.evidenceCount += 1;
  entry.lastReinforced = new Date().toISOString();
  entry.score = calculateStability(
    entry.cue,
    entry.evidenceCount,
    Date.now(),
    Date.now(),
    entry.class,
    entry.userState,
  );
  entry.lifecycle = lifecycleFromScore(entry.score, entry.userState, entry);
  saveScores(cwd, scores);
  return true;
}

// ── Query ──────────────────────────────────────────────────────────────────

/**
 * Get all active entries (for system prompt injection).
 * Returns entries sorted by score descending.
 */
export function getActiveEntries(cwd: string): { hash: string; entry: ScoredEntry }[] {
  const scores = loadScores(cwd);
  return Object.entries(scores.entries)
    .filter(([, e]) => e.lifecycle === "active" || e.lifecycle === "provisional")
    .sort(([, a], [, b]) => b.score - a.score)
    .map(([hash, entry]) => ({ hash, entry }));
}

// ── Preference Auto-Extraction ─────────────────────────────────────────────

/** Patterns that signal explicit user preferences in conversation */
const PREFERENCE_PATTERNS: RegExp[] = [
  /\bi prefer\b/i,
  /\bi always\b/i,
  /\balways use\b/i,
  /\bnever use\b/i,
  /\bmy timezone\b/i,
  /\bmy language\b/i,
  /\bplease always\b/i,
  /\bplease never\b/i,
  /\bfrom now on\b/i,
  /\bgoing forward\b/i,
  /\bmy name is\b/i,
  /\bi work\b/i,
  /\bmy role\b/i,
  /\bmy stack\b/i,
];

/**
 * Extract preference statements from user text.
 * Returns sentences that match preference patterns.
 */
export function extractPreferences(text: string): string[] {
  const found: string[] = [];
  const sentences = text.split(/[.!?\n]/).map((s) => s.trim()).filter((s) => s.length >= 15);

  for (const sentence of sentences) {
    if (PREFERENCE_PATTERNS.some((p) => p.test(sentence))) {
      // Normalize to a clean one-liner
      const clean = sentence.replace(/\s+/g, " ").slice(0, 100);
      found.push(clean);
    }
  }

  return found.slice(0, 3); // Cap at 3 per message
}
