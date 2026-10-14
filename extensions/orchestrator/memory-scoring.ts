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

import { createLogger } from "../shared/logger.js";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createCachedStore } from "./state-jsonl.js";
import type { JsonlStateStore } from "./state-jsonl.js";
import { getSetting } from "./project-settings.js";
import { getProjectMemoryDir } from "./utils.js";

// ── Types ──────────────────────────────────────────────────────────────────

const memLog = createLogger("memory");
memLog.debug("memory-scoring module loaded");

export type MemoryCategory = "preference" | "lesson" | "pattern" | "decision" | "done" | "mistake";
export type CueType = "explicit" | "structural" | "behavioral" | "recurrence";
export type UserState = "auto" | "pinned" | "forgotten";
export type LifecycleState = "active" | "provisional" | "candidate" | "dropped";

/** Valid memory categories — single source of truth for all memory modules. */
export const VALID_CATEGORIES: readonly MemoryCategory[] = [
  "preference", "lesson", "pattern", "decision", "done", "mistake",
];

/** Scope of a memory entry. Default (absent) is "project" — durable and global. */
export type MemoryScope = "session" | "task" | "project";

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
  /** Sessions a session-scoped entry was restated in (Qodo round 3, PR #916):
 *  rebinding must ADD the restating session, never steal the entry from the
 *  first one. sourceSession stays the original/primary. */
  sourceSessions?: string[];
  /** Short note or prior entry hash this was derived from */
  derivedFrom?: string;
  /** Free-text targets this memory informs (e.g. pr-review, git, skill name) */
  informs?: string[];

  /** Stable identity for this entry — survives text edits (issue #915).
   *  Enforced entries carry their id as a `{#id}` marker on the topic line
   *  so the score binding self-heals when the text is reworded. */
  id?: string;

  // ── Scope fields (optional; issue #915) ────────────────────────────
  /** How long this entry applies. Absent = "project" (durable, global). */
  scope?: MemoryScope;
  /** ISO timestamp after which this entry is pruned (used with non-project scopes). */
  expiresAt?: string;
}

export interface ScoresFile {
  entries: Record<string, ScoredEntry>;
  lastRebuild: string;
  /** Hash algorithm used for entry keys — "sha256-16" after issue #915
   *  migration. Absent on pre-migration stores (legacy FNV-1a 8-hex keys). */
  hashAlgo?: string;
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

/** Total max active entries (default; overridable via memory_max_active_entries, issue #915) */
const DEFAULT_MAX_ACTIVE_ENTRIES = 40;

function getMaxActiveEntries(cwd: string): number {
  const v = Number(getSetting(cwd, "memory_max_active_entries"));
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULT_MAX_ACTIVE_ENTRIES;
}

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

/** Hash algorithm marker persisted in the scores file after migration. */
const HASH_ALGO = "sha256-16";

/** Generate a stable 8-hex entry id. */
export function newEntryId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

/** Generate the key for a memory entry line (SHA-256, 16 hex chars).
 *  Issue #915: replaced 32-bit FNV-1a, which risked collisions binding
 *  enforcement to the wrong entry. Consistent with the embedding store. */
export function entryHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Legacy 32-bit FNV-1a — kept only to migrate pre-#915 score keys. */
export function legacyFnvHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** True when a score key is a pre-#915 legacy FNV-1a key (8 hex chars). */
function isLegacyKey(key: string): boolean {
  return /^[0-9a-f]{8}$/.test(key);
}

/** True when an entry carries enforcement (trigger+action or verifier). */
function hasEnforcementFields(entry: ScoredEntry): boolean {
  return !!((entry.trigger && entry.action) || entry.verifier);
}

// ── Scores File I/O ────────────────────────────────────────────────────────
// Persistence: append-only JSONL via JsonlStateStore (issue #724).
// Legacy memory-scores.json is auto-migrated on first access.

const SCORES_FILENAME_JSONL = "memory-scores.jsonl";
const LEGACY_SCORES_FILENAME = "memory-scores.json";

function getScoresStore(cwd: string): JsonlStateStore<ScoresFile> {
  return createCachedStore<ScoresFile>(
    getProjectMemoryDir(cwd), SCORES_FILENAME_JSONL, LEGACY_SCORES_FILENAME, { compactThreshold: 50 },
  );
}

export function getScoresPath(cwd: string): string {
  return join(getProjectMemoryDir(cwd), SCORES_FILENAME_JSONL);
}

/**
 * Session-aware eligibility for a scored entry (Qodo #8/#19, PR #916).
 * Session-scoped entries (including code-enforced ones — enforcement is a
 * WRITE path, grants are not) are only active in their own session: a rule
 * learned in session A must not block or inject in session B. When the
 * current session id is unknown, session-scoped entries fail closed (they
 * are transient by design). Expired entries (any scope) are never active.
 * Entries without a score record stay visible — nothing is known about them.
 */
export function isEntryActiveForSession(entry: ScoredEntry | undefined, currentSessionId?: string): boolean {
  if (!entry) return true;
  if (entry.expiresAt) {
    const t = Date.parse(entry.expiresAt);
    if (!Number.isNaN(t) && t <= Date.now()) {
      memLog.debug("memory_eligibility: entry expired", { scope: entry.scope, expiresAt: entry.expiresAt });
      return false;
    }
  }
  if (entry.scope === "session") {
    const known = entry.sourceSession
      ? [entry.sourceSession, ...(entry.sourceSessions ?? [])]
      : [...(entry.sourceSessions ?? [])];
    const active = !!currentSessionId && known.includes(currentSessionId);
    if (!active) {
      memLog.debug("memory_eligibility: session-scoped entry not active for this session", {
        sourceSession: entry.sourceSession,
        sourceSessions: entry.sourceSessions?.length ?? 0,
        currentSessionId,
      });
    }
    return active;
  }
  return true;
}

export function loadScores(cwd: string): ScoresFile {
  const store = getScoresStore(cwd);
  const data = store.read();
  if (data === null) {
    return { entries: {}, lastRebuild: new Date().toISOString() };
  }
  // One-time key migration (issue #915): re-key legacy FNV-1a 8-hex score
  // keys to SHA-256 so topic lines and score entries stay bound.
  // Locked migration (Qodo #2, PR #916): transform the LATEST state inside
  // the cross-process lock — migrating the snapshot loaded above could
  // append a stale state and erase a concurrent writer's update.
  if (data.hashAlgo !== HASH_ALGO) {
    getScoresStore(cwd).mutate<ScoresFile>(
      (latest) => {
        if (latest.hashAlgo === HASH_ALGO) return; // a concurrent process already migrated
        migrateScoreKeysInPlace(cwd, latest);
      },
      { entries: {}, lastRebuild: new Date().toISOString(), hashAlgo: HASH_ALGO },
    );
    const fresh = store.read();
    return fresh ?? { entries: {}, lastRebuild: new Date().toISOString(), hashAlgo: HASH_ALGO };
  }
  return data;
}

/**
 * Minimal topic-line parser used only for key migration. Intentionally
 * local — importing memory-tree here would create a cycle (memory-tree
 * imports loadScores/entryHash from this module).
 */
function parseTopicLinesForMigration(cwd: string): { category: string; text: string }[] {
  const topicsDir = join(getProjectMemoryDir(cwd), "topics");
  const out: { category: string; text: string }[] = [];
  if (!existsSync(topicsDir)) return out;
  try {
    for (const file of readdirSync(topicsDir).filter((f) => f.endsWith(".md"))) {
      const content = readFileSync(join(topicsDir, file), "utf-8");
      for (const line of content.split("\n")) {
        const m = line.match(/^- \[(preference|lesson|pattern|decision|done|mistake)\] (.+)$/);
        if (!m) continue;
        const rawText = m[2]!
          .replace(/\s*\*\(pinned\)\*/g, "")
          .replace(/\s*\*\(enforced\)\*/g, "")
          .replace(/\s*\{#[0-9a-f]+\}$/g, "")
          .trim();
        out.push({ category: m[1]!, text: rawText });
      }
    }
  } catch {
    // unreadable topics — migration maps what it can
  }
  return out;
}

/** Re-key legacy FNV score keys to SHA-256 keys via topic lines.
 *  In-place transform — the caller persists (locked migrate in loadScores,
 *  Qodo #2 PR #916). */
function migrateScoreKeysInPlace(cwd: string, scores: ScoresFile): ScoresFile {
  const keys = Object.keys(scores.entries);
  if (keys.length === 0) {
    scores.hashAlgo = HASH_ALGO;
    return scores;
  }
  const lines = parseTopicLinesForMigration(cwd);
  const oldToNew = new Map<string, string>();
  for (const { category, text } of lines) {
    const canonical = `- [${category}] ${text}`;
    oldToNew.set(legacyFnvHash(canonical), entryHash(canonical));
  }
  const migrated: Record<string, ScoredEntry> = {};
  for (const key of keys) {
    const entry = scores.entries[key]!;
    if (!entry.id) entry.id = newEntryId();
    // Keys that are already new-format (not 8-hex legacy) pass through —
    // only legacy FNV keys need remapping.
    if (!isLegacyKey(key)) {
      migrated[key] = entry;
      continue;
    }
    const newKey = oldToNew.get(key);
    if (newKey && !migrated[newKey] && !scores.entries[newKey]) {
      migrated[newKey] = entry;
    } else if (newKey && migrated[newKey]) {
      // Two legacy entries collapsed onto one topic line — keep the richer one
      const existing = migrated[newKey]!;
      if ((entry.evidenceCount ?? 0) > (existing.evidenceCount ?? 0)) migrated[newKey] = entry;
    } else if (hasEnforcementFields(entry)) {
      // Enforced orphan — no topic line, so no text to hash into a new key.
      // Enforcement itself reads the score entry directly and keeps working;
      // re-key to a synthetic id-based key so NO legacy keys remain. If the
      // topic line reappears with its {#id} marker, rebuild step 0 re-binds it.
      migrated[`id:${entry.id}`] = entry;
    } else {
      // Non-enforced orphan — dead weight the next rebuild would delete
      // anyway. Drop it now so the migrated file contains no legacy keys.
    }
  }
  scores.entries = migrated;
  scores.hashAlgo = HASH_ALGO;
  return scores;
}

export function saveScores(cwd: string, scores: ScoresFile): void {
  getScoresStore(cwd).write(scores);
}

/**
 * Locked read-modify-write over the scores store (issue #915): re-reads the
 * latest state under the cross-process lock, applies the mutator, writes.
 * Prevents concurrent sessions from clobbering each other between a
 * loadScores and a saveScores.
 */
export function mutateScores(
  cwd: string,
  fn: (scores: ScoresFile) => void,
): ScoresFile | null {
  // Ensure key migration has run before mutating (idempotent, cached read)
  loadScores(cwd);
  return getScoresStore(cwd).mutate<ScoresFile>(fn, {
    entries: {},
    lastRebuild: new Date().toISOString(),
    hashAlgo: HASH_ALGO,
  });
}

// ── Internal Types ─────────────────────────────────────────────────────────

interface ParsedEntry {
  section: "pinned" | "learned";
  category: MemoryCategory;
  text: string;
  fullLine: string;
  id?: string;
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
  entries: { category: MemoryCategory; text: string; pinned: boolean; id?: string }[],
): RebuildResult {
  const parsed = entries.map((e) => ({
    section: (e.pinned ? "pinned" : "learned") as "pinned" | "learned",
    category: e.category,
    text: e.text,
    id: e.id,
    fullLine: `- [${e.category}] ${e.text}`,
  }));
  return rebuildFromParsed(cwd, parsed);
}

function rebuildFromParsed(cwd: string, parsed: ParsedEntry[]): RebuildResult {
  if (parsed.length === 0) {
    return { active: 0, provisional: 0, dropped: 0, total: 0 };
  }
  const now = Date.now();

  // The whole rebuild is a locked read-modify-write (issue #915): concurrent
  // sessions cannot interleave a load/save between our steps.
  const scores = mutateScores(cwd, (s) => {
    // Step 0: Re-bind orphaned enforced entries by stable id (issue #915).
    // When an enforced entry's text is reworded (memory_edit, dream), the
    // hash changes — the {#id} marker on the topic line lets us move the
    // score entry to the new key so enforcement survives the edit.
    const idToKey = new Map<string, string>();
    for (const [hash, entry] of Object.entries(s.entries)) {
      if (entry.id) idToKey.set(entry.id, hash);
    }
    for (const entry of parsed) {
      if (!entry.id) continue;
      const newHash = entryHash(entry.fullLine);
      if (s.entries[newHash]) continue;
      const orphanKey = idToKey.get(entry.id);
      if (orphanKey && orphanKey !== newHash && s.entries[orphanKey]) {
        s.entries[newHash] = s.entries[orphanKey]!;
        delete s.entries[orphanKey];
        idToKey.set(entry.id, newHash);
      }
    }

    // Step 1: Score all entries
    for (const entry of parsed) {
      const hash = entryHash(entry.fullLine);
      const existing = s.entries[hash];

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
        // New entry — initialize with a stable id
        const userState: UserState = entry.section === "pinned" ? "pinned" : "auto";
        const cue: CueType = entry.section === "pinned" ? "explicit" : "behavioral";
        const score = calculateStability(cue, 1, now, now, entry.category, userState);

        s.entries[hash] = {
          class: entry.category,
          score,
          evidenceCount: 1,
          cue,
          firstSeen: new Date(now).toISOString(),
          lastReinforced: new Date(now).toISOString(),
          userState,
          lifecycle: lifecycleFromScore(score, userState),
          id: entry.id ?? newEntryId(),
        };
      }
    }

    // Step 2: Remove scores for entries that no longer exist in topics
    // Preserve entries with enforcement fields — they must not be deleted even
    // if dreaming rewrites the topic file text (which changes the hash).
    const currentHashes = new Set(parsed.map((e) => entryHash(e.fullLine)));
    for (const hash of Object.keys(s.entries)) {
      if (!currentHashes.has(hash)) {
        const entry = s.entries[hash];
        if (entry && ((entry.trigger && entry.action) || entry.verifier)) {
          // Enforced entry (trigger+action or verifier) — keep it
          // Mark as orphaned so budgeting excludes it
          (entry as any)._orphaned = true;
          continue;
        }
        delete s.entries[hash];
      }
    }

    // Step 3: Apply per-category budgets
    const byCategory: Record<string, { hash: string; entry: ScoredEntry }[]> = {};
    for (const [hash, entry] of Object.entries(s.entries)) {
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

    // Step 5: Enforce total cap (configurable via memory_max_active_entries)
    const maxActive = getMaxActiveEntries(cwd);
    const allActive = Object.values(s.entries).filter((e) => e.lifecycle === "active");
    if (allActive.length > maxActive) {
      allActive.sort((a, b) => b.score - a.score);
      for (let i = maxActive; i < allActive.length; i++) {
        allActive[i]!.lifecycle = "provisional";
      }
    }

    // Step 6: Clean up internal markers
    for (const entry of Object.values(s.entries)) {
      delete (entry as any)._orphaned;
    }
    s.lastRebuild = new Date(now).toISOString();
  });

  if (!scores) return { active: 0, provisional: 0, dropped: 0, total: 0 };

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
 * Locked read-modify-write — safe against concurrent sessions (issue #915).
 * Returns true if the entry was found and reinforced.
 */
export function reinforce(cwd: string, entryLine: string): boolean {
  let found = false;
  mutateScores(cwd, (scores) => {
    const hash = entryHash(entryLine);
    const entry = scores.entries[hash];
    if (!entry) return;
    found = true;

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
  });
  return found;
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

/** Sentence starts that mark a question, not a statement. */
/** One-off permission grant phrasing — session instruction, not a durable preference. */
const GRANT_PHRASE_RE: RegExp[] = [
  /\byou (can|may)\b/i,
  /\bgo ahead\b/i,
  /\bfeel free\b/i,
  /\bjust this once\b/i,
  /\bthis time only\b/i,
  /\bone[- ]off\b/i,
  /\bfor (this|that|the) (specific )?(pr|issue|task|ticket|branch|release)\b/i,
  /\b(this|that|specific) (pr|issue|task|ticket|branch)\b/i,
];

/** Detect one-off grant phrasing (shared by extractor and memory_add guardrail). */
export function isGrantText(text: string): boolean {
  return GRANT_PHRASE_RE.some((re) => re.test(text));
}

/**
 * Extract preference statements from user text.
 * Questions and one-off permission grants are excluded — they are not
 * durable preferences (issue #915).
 */
export function extractPreferences(text: string): string[] {
  const found: string[] = [];
  // Split on sentence terminators but KEEP them (Qodo #21, PR #916): a
  // sentence is a question only when it ends with "?". The old split
  // dropped the terminator and then guessed by leading verb — which dropped
  // imperatives like "Do not use pip" because they start with "do".
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 15);

  for (const sentence of sentences) {
    if (sentence.endsWith("?")) continue; // question, not a statement
    if (isGrantText(sentence)) continue; // one-off grant, not a preference
    if (PREFERENCE_PATTERNS.some((p) => p.test(sentence))) {
      // Normalize to a clean one-liner
      const clean = sentence.replace(/\s+/g, " ").slice(0, 100);
      found.push(clean);
    }
  }

  memLog.debug("preference_extraction", { inputChars: text.length, sentences: sentences.length, found: found.length });
  return found.slice(0, 3); // Cap at 3 per message
}
