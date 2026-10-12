/**
 * memory-write.ts — unified memory write path (issue #915).
 *
 * Single entry point for adding memory entries from every producer
 * (memory_add tool, preference extractor). Enforces, in order:
 *
 *   1. category / trigger / action / scope validation
 *   2. grant-phrase guardrail — one-off permissions are session
 *      instructions, not memories
 *   3. contradiction gate — refuses adds that contradict existing
 *      entries (always refuses contradictions of pinned entries)
 *   4. near-duplicate / exact dedup — reinforces instead of adding
 *   5. topic size cap, score entry, embedding upkeep
 *
 * Having one write path means every producer gets the same safeguards;
 * previously preference-extractor bypassed cap, dedup, and conflict checks.
 */

import { createLogger } from "../shared/logger.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type MemoryCategory,
  type MemoryScope,
  type ScoredEntry,
  VALID_CATEGORIES,
  PINNED_SCORE,
  entryHash,
  loadScores,
  mutateScores,
  newEntryId,
  reinforce,
  isGrantText,
} from "./memory-scoring.js";
import { CATEGORY_TO_TOPIC, MAX_TOPIC_CHARS, readAllTopicEntries, formatTopicLine, invalidateTopicFileCache } from "./memory-tree.js";
import { embedEntry, vectorSearch } from "./memory-embeddings.js";
import { getSetting } from "./project-settings.js";

const log = createLogger("memory");

const DEFAULT_NEAR_DUPLICATE_THRESHOLD = 0.90;
/** Vector similarity floor for contradiction candidates (issue #915). */
const DEFAULT_CONFLICT_SIMILARITY_THRESHOLD = 0.55;

/** Near-duplicate threshold from settings (issue #915). */
function getNearDuplicateThreshold(cwd: string): number {
  const v = Number(getSetting(cwd, "memory_near_duplicate_threshold"));
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_NEAR_DUPLICATE_THRESHOLD;
}

/** Conflict-candidate similarity floor from settings (issue #915). */
function getConflictSimilarityThreshold(cwd: string): number {
  const v = Number(getSetting(cwd, "memory_conflict_similarity"));
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_CONFLICT_SIMILARITY_THRESHOLD;
}
/** Safety-net expiry for session-scoped entries (issue #915). */
const SESSION_SCOPE_TTL_MS = 24 * 60 * 60 * 1000;
const VALID_SCOPES: readonly MemoryScope[] = ["session", "task", "project"];

export interface AddMemoryInput {
  text: string;
  category: string;
  pinned?: boolean;
  trigger?: string;
  action?: string;
  verifier?: string;
  /** "session" | "task" | "project" — validated in addMemoryEntry. */
  scope?: string;
  sourceSession?: string;
  derivedFrom?: string;
  informs?: string[];
}

export type AddMemoryStatus =
  | "added"
  | "reinforced" // exact or near-duplicate match — existing entry reinforced
  | "rejected"; // validation, guardrail, conflict, or capacity rejection

export interface AddMemoryResult {
  status: AddMemoryStatus;
  message: string;
}

// ── Validation ─────────────────────────────────────────────────────────────

function validateTrigger(trigger: string): string | null {
  const validPrefixes = ["bash_contains ", "bash_regex ", "tool_name ", "file_modified "];
  if (!validPrefixes.some((p) => trigger.startsWith(p))) {
    return (
      `Invalid trigger format "${trigger}". Must start with: ` +
      validPrefixes.map((p) => p.trim()).join(", ")
    );
  }
  return null;
}

function validateAction(action: string): string | null {
  const validActions = ["block", "warn"];
  const isRunAfter = action.startsWith("run_after ");
  if (!validActions.includes(action) && !isRunAfter) {
    return `Invalid action "${action}". Valid: block, warn, run_after <command>`;
  }
  if (isRunAfter && !action.slice("run_after ".length).trim()) {
    return `Invalid action "${action}". run_after requires a command (e.g., 'run_after npm test')`;
  }
  return null;
}

// ── Contradiction gate ─────────────────────────────────────────────────────

/** Prohibition markers — text forbids an action. */
const NEGATION_RE =
  /\b(never|not|no|don'?t|do not|doesn'?t|didn'?t|cannot|can'?t|won'?t|mustn'?t|must not|forbidden|avoid|stop)\b/i;
/** Permission markers — text allows an action. */
const PERMIT_RE =
  /\b(can|may|allowed|permit(ted|s)?|okay|ok|go ahead|feel free|fine to|(is|are|'s) fine|acceptable|safe to)\b/i;

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with",
  "you", "your", "we", "our", "user", "agent", "llm", "this", "that", "these",
  "those", "is", "are", "am", "was", "were", "be", "been", "it", "its", "as",
  "at", "by", "from", "not", "no", "yes", "do", "does", "did", "will", "would",
  "should", "could", "can", "may", "must", "shall", "when", "what", "which",
]);

/** Lowercase content words with naive plural stripping, for overlap scoring. */
function contentWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z][a-z0-9#-]*/g) ?? [];
  const out = new Set<string>();
  for (const w of words) {
    const norm = w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w;
    if (norm.length >= 2 && !STOP_WORDS.has(norm)) out.add(norm);
  }
  return out;
}

/** True when one text permits what the other forbids (permission flip). */
function polarityClash(a: string, b: string): boolean {
  const aNeg = NEGATION_RE.test(a);
  const bNeg = NEGATION_RE.test(b);
  if (aNeg === bNeg) return false;
  const aPerm = PERMIT_RE.test(a);
  const bPerm = PERMIT_RE.test(b);
  return aPerm || bPerm;
}

function sharedContentWords(a: string, b: string): number {
  const wa = contentWords(a);
  let shared = 0;
  for (const w of contentWords(b)) {
    if (wa.has(w)) shared++;
  }
  return shared;
}

function isEnforcedEntry(entry: ScoredEntry | undefined): boolean {
  return !!entry && (!!((entry.trigger && entry.action) || entry.verifier));
}

export interface ConflictCandidate {
  text: string;
  category: MemoryCategory;
  pinned: boolean;
  enforced: boolean;
}

/**
 * Find an existing entry that the new text contradicts.
 *
 * Candidates: same-category entries, pinned entries, and enforced entries
 * (the protected classes), narrowed by vector similarity when the embedding
 * model is available and by content-word overlap otherwise. A candidate is a
 * conflict when permission polarity flips (one forbids, the other permits).
 */
export async function findContradiction(
  cwd: string,
  text: string,
  category: string,
): Promise<ConflictCandidate | null> {
  const topicEntries = readAllTopicEntries(cwd);
  if (topicEntries.length === 0) return null;
  const scores = loadScores(cwd);

  // Protected pool: same category + pinned + enforced. These are the entries
  // a one-off grant is most likely to contradict (issue #915 incident).
  const pool: ConflictCandidate[] = [];
  const seen = new Set<string>();
  for (const te of topicEntries) {
    const key = `${te.category}:${te.text}`;
    if (seen.has(key)) continue;
    const scored = scores.entries[entryHash(`- [${te.category}] ${te.text}`)];
    const enforced = isEnforcedEntry(scored);
    if (te.category === category || te.pinned || enforced) {
      seen.add(key);
      pool.push({ text: te.text, category: te.category, pinned: te.pinned, enforced });
    }
  }
  if (pool.length === 0) return null;

  // Vector-narrowed candidates (paraphrase-tolerant). Model may be
  // unavailable — the overlap fallback below still applies.
  let candidates = pool;
  try {
    const vectorMatches = await vectorSearch(
      cwd,
      text,
      pool.map((p) => ({ text: p.text, category: p.category, pinned: p.pinned })),
      20,
    );
    const similar = new Set(
      vectorMatches
        .filter((vm) => vm.similarity >= getConflictSimilarityThreshold(cwd))
        .map((vm) => `${vm.category}:${vm.text}`),
    );
    if (similar.size > 0) {
      candidates = pool.filter((p) => similar.has(`${p.category}:${p.text}`));
    }
  } catch (err) {
    log.debug("memory-write: conflict vector search unavailable, using overlap fallback", err);
  }

  for (const candidate of candidates) {
    if (!polarityClash(text, candidate.text)) continue;
    // Vector-similar candidates are already topic-related; overlap candidates
    // need corroboration (≥ 2 shared content words).
    const shared = sharedContentWords(text, candidate.text);
    const inVectorSet = candidates !== pool;
    if (shared >= 2 || (inVectorSet && shared >= 1)) {
      return candidate;
    }
  }
  return null;
}

// ── Dedup + enforcement merge ──────────────────────────────────────────────

/** Merge enforcement fields from new input into an existing scored entry.
 *  Locked read-modify-write (issue #915). */
function mergeEnforcementFields(
  cwd: string,
  existingLine: string,
  input: AddMemoryInput,
): boolean {
  if (!input.trigger && !input.action && !input.verifier) return false;
  let merged = false;
  mutateScores(cwd, (scores) => {
    const existing = scores.entries[entryHash(existingLine)];
    if (!existing) return;
    if (input.trigger) existing.trigger = input.trigger as any;
    if (input.action) {
      if (input.action.startsWith("run_after ")) {
        existing.action = "run_after";
        existing.actionCommand = input.action.slice("run_after ".length);
      } else if (input.action === "block" || input.action === "warn") {
        existing.action = input.action;
      }
    }
    if (input.verifier) existing.verifier = input.verifier;
    merged = true;
  });
  return merged;
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Add a memory entry through the unified write path.
 * See module header for the safeguard order.
 */
export async function addMemoryEntry(cwd: string, input: AddMemoryInput): Promise<AddMemoryResult> {
  const category = input.category;
  const text = input.text;
  const isPinned = input.pinned ?? false;

  // 1. Validation
  if (!VALID_CATEGORIES.includes(category as MemoryCategory)) {
    return {
      status: "rejected",
      message: `Invalid category "${category}". Valid: ${VALID_CATEGORIES.join(", ")}`,
    };
  }
  if (input.trigger) {
    const err = validateTrigger(input.trigger);
    if (err) return { status: "rejected", message: err };
  }
  if (input.action) {
    const err = validateAction(input.action);
    if (err) return { status: "rejected", message: err };
  }
  if (input.scope && !VALID_SCOPES.includes(input.scope as MemoryScope)) {
    return {
      status: "rejected",
      message: `Invalid scope "${input.scope}". Valid: ${VALID_SCOPES.join(", ")}`,
    };
  }

  // 2. Grant-phrase guardrail — one-off permissions are session instructions,
  // not durable memories (issue #915 incident).
  if (isGrantText(text) && input.scope !== "session") {
    return {
      status: "rejected",
      message:
        `Rejected: "${text}" reads like a one-off permission grant (e.g. "you can merge this PR"). ` +
        `One-off grants are session instructions, NOT memories — do not store them. ` +
        `If the user confirmed a standing rule, rephrase it as the durable rule itself ` +
        `(e.g. "Agent may merge release-flow bump PRs") without grant phrasing.`,
    };
  }

  // 3. Contradiction gate — before dedup, so a permission-flipping near-duplicate
  // is refused rather than silently reinforcing the wrong entry.
  const conflict = await findContradiction(cwd, text, category);
  if (conflict) {
    if (conflict.pinned) {
      return {
        status: "rejected",
        message:
          `Rejected: contradicts pinned memory "[${conflict.category}] ${conflict.text}". ` +
          `Pinned entries are user-explicit. If the rule truly changed, ask the user — ` +
          `they must remove or edit the pinned entry (memory_remove / memory_edit) first.`,
      };
    }
    return {
      status: "rejected",
      message:
        `Rejected: contradicts existing memory "[${conflict.category}] ${conflict.text}"` +
        `${conflict.enforced ? " (code-enforced)" : ""}. ` +
        `If the rule changed, use memory_edit (invalidate the old entry) instead of adding ` +
        `a contradicting one; otherwise ask the user which is correct.`,
    };
  }

  const canonicalLine = `- [${category}] ${text}`;
  const topicEntries = readAllTopicEntries(cwd);

  // 4a. Near-duplicate check via vector similarity (catches same lesson,
  // different wording) — reinforce instead of duplicating.
  try {
    const seen = new Set<string>();
    const sameCategoryEntries = topicEntries.filter((te) => {
      if (te.category !== category || seen.has(te.text)) return false;
      seen.add(te.text);
      return true;
    });
    await (await import("./memory-embeddings.js")).embedMissing(cwd, sameCategoryEntries);
    // Do NOT embed the new entry before searching — if the entry already exists
    // in sameCategoryEntries, it would match itself with similarity 1.000.
    const vectorMatches = await vectorSearch(cwd, text, sameCategoryEntries, 20);
    for (const vm of vectorMatches) {
      if (vm.similarity < getNearDuplicateThreshold(cwd)) continue;
      const existingLine = `- [${vm.category}] ${vm.text}`;
      if (reinforce(cwd, existingLine)) {
        const merged = mergeEnforcementFields(cwd, existingLine, input);
        const enforcementNote = merged ? " (enforcement fields merged)" : "";
        return {
          status: "reinforced",
          message:
            `Near-duplicate found (similarity: ${vm.similarity.toFixed(3)}) — reinforced instead: ` +
            `[${vm.category}] ${vm.text}${enforcementNote}`,
        };
      }
      // reinforce() failed (score entry missing) — try next candidate
    }
  } catch (err) {
    log.debug("memory-write: vector dedup skipped:", err);
  }

  // 4b. Exact match check (fast O(n) string comparison)
  for (const te of topicEntries) {
    if (te.text !== text || te.category !== category) continue;
    reinforce(cwd, canonicalLine);
    const merged = mergeEnforcementFields(cwd, canonicalLine, input);
    const enforcementNote = merged ? " (enforcement fields merged)" : "";
    return {
      status: "reinforced",
      message: `Already exists — reinforced instead: [${category}] ${text}${enforcementNote}`,
    };
  }

  // 5. Topic cap + write
  const topicName = CATEGORY_TO_TOPIC[category as MemoryCategory];
  const topicsDir = join(cwd, ".pi", "memory", "topics");
  const topicPath = join(topicsDir, `${topicName}.md`);

  if (!existsSync(topicsDir)) {
    mkdirSync(topicsDir, { recursive: true });
  }

  let content = "";
  if (existsSync(topicPath)) {
    content = readFileSync(topicPath, "utf-8");
  } else {
    const title = topicName.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
    content = `# ${title}\n`;
  }

  const isEnforced = !!((input.trigger && input.action) || input.verifier);
  const entryId = newEntryId();
  const entryLine = formatTopicLine(
    { text, category: category as MemoryCategory, pinned: isPinned, id: entryId },
    isEnforced,
  );

  const newContent = content.trimEnd() + "\n" + entryLine + "\n";
  if (newContent.length > MAX_TOPIC_CHARS) {
    return {
      status: "rejected",
      message:
        `Topic "${topicName}" would exceed size limit (${newContent.length}/${MAX_TOPIC_CHARS} chars). ` +
        `Consolidate or remove entries first using memory_remove.`,
    };
  }
  writeFileSync(topicPath, newContent, "utf-8");
  invalidateTopicFileCache(topicPath);

  // Score entry — always hash the canonical line (no markers). Locked RMW
  // so concurrent sessions cannot clobber each other (issue #915).
  mutateScores(cwd, (scores) => {
    const hash = entryHash(canonicalLine);
    const entry: ScoredEntry = {
      class: category as MemoryCategory,
      score: isPinned ? PINNED_SCORE : 1.0,
      evidenceCount: 1,
      cue: "explicit",
      firstSeen: new Date().toISOString(),
      lastReinforced: new Date().toISOString(),
      userState: isPinned ? "pinned" : "auto",
      lifecycle: "active",
      id: entryId,
    };

    if (input.trigger) {
      entry.trigger = input.trigger as any;
      if (input.action) {
        if (input.action.startsWith("run_after ")) {
          entry.action = "run_after";
          entry.actionCommand = input.action.slice("run_after ".length);
        } else if (input.action === "block" || input.action === "warn") {
          entry.action = input.action;
        }
      }
    }
    if (input.verifier) entry.verifier = input.verifier;
    if (input.scope) {
      entry.scope = input.scope as MemoryScope;
      if (input.scope === "session") {
        // Safety net: even if dream never runs, session-scoped entries expire.
        entry.expiresAt = new Date(Date.now() + SESSION_SCOPE_TTL_MS).toISOString();
      }
    }
    if (input.sourceSession) entry.sourceSession = input.sourceSession;
    if (input.derivedFrom) entry.derivedFrom = input.derivedFrom;
    if (input.informs && input.informs.length > 0) entry.informs = input.informs;

    scores.entries[hash] = entry;
  });

  // Embed the new entry for future similarity searches
  await embedEntry(cwd, text, category);

  log.info("memory_add_entry", category, text.slice(0, 60), input.scope ?? "project");
  const pin = isPinned ? " (pinned)" : "";
  const scope = input.scope && input.scope !== "project" ? ` (scope: ${input.scope})` : "";
  return { status: "added", message: `Added: [${category}] ${text}${pin}${scope}` };
}

// ── Expiry pruning ─────────────────────────────────────────────────────────

/**
 * Remove entries whose expiresAt has passed: delete the topic line and the
 * score entry. Called from the periodic rebuild so session/task-scoped
 * entries cannot outlive their scope (issue #915).
 */
export function pruneExpiredEntries(cwd: string): number {
  const topicsDir = join(cwd, ".pi", "memory", "topics");
  if (!existsSync(topicsDir)) return 0;
  const scores = loadScores(cwd);
  const now = Date.now();
  let pruned = 0;

  const expiredHashes = new Set<string>();
  for (const [hash, entry] of Object.entries(scores.entries)) {
    if (entry.expiresAt && new Date(entry.expiresAt).getTime() < now) {
      expiredHashes.add(hash);
    }
  }
  if (expiredHashes.size === 0) return 0;

  // Remove expired lines from topic files (any category — we do not know
  // which topic file holds which text without scanning).
  for (const file of readdirSync(topicsDir).filter((f) => f.endsWith(".md"))) {
    const topicPath = join(topicsDir, file);
    const lines = readFileSync(topicPath, "utf-8").split("\n");
    const kept = lines.filter((l) => {
      const m = l.match(/^- \[(preference|lesson|pattern|decision|done|mistake)\] (.+)$/);
      if (!m) return true;
      const rawText = m[2]!.replace(/\s*\*\(pinned\)\*/g, "").replace(/\s*\*\(enforced\)\*/g, "").replace(/\s*\{#[0-9a-f]+\}$/g, "").trim();
      const hash = entryHash(`- [${m[1]}] ${rawText}`);
      if (!expiredHashes.has(hash)) return true;
      pruned++;
      return false;
    });
    const cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n");
    writeFileSync(topicPath, cleaned, "utf-8");
    invalidateTopicFileCache(topicPath);
  }

  // Locked removal of the expired score entries
  mutateScores(cwd, (s) => {
    for (const hash of expiredHashes) {
      delete s.entries[hash];
    }
  });
  if (pruned > 0) log.info("memory_prune_expired", pruned);
  return pruned;
}
