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
import { CATEGORY_TO_TOPIC, MAX_TOPIC_CHARS, readAllTopicEntries, formatTopicLine, findTopicLine, invalidateTopicFileCache } from "./memory-tree.js";
import { embedEntry, removeEmbedding, vectorSearch } from "./memory-embeddings.js";
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
  /** Confirm a conflict override — only set after the user explicitly
   *  confirmed the rule changed. Supersedes the conflicting (non-pinned) entry. */
  overrideConflicts?: boolean;
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
    log.warn("memory-write: invalid trigger rejected", trigger.slice(0, 80));
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
    log.warn("memory-write: invalid action rejected", action.slice(0, 80));
    return `Invalid action "${action}". Valid: block, warn, run_after <command>`;
  }
  if (isRunAfter && !action.slice("run_after ".length).trim()) {
    log.warn("memory-write: run_after action without a command rejected");
    return `Invalid action "${action}". run_after requires a command (e.g., 'run_after npm test')`;
  }
  return null;
}

// ── Contradiction gate ─────────────────────────────────────────────────────

/** Prohibition markers — text forbids an action. */
const NEGATION_RE =
  /\b(never|not|no|don'?t|do not|doesn'?t|didn'?t|cannot|can'?t|won'?t|mustn'?t|must not|forbidden|avoid|stop)\b/i;
/** Permission markers — text allows an action. "always" is a permit by
 *  force: "always use X" vs "never use X" is the canonical flip, and
 *  without it the near-duplicate path silently REINFORCES the opposite
 *  rule (live battery, round 7, PR #916). A bare "only" is deliberately
 *  NOT here (Qodo round 8): sentence-initial or trailing "only" is a
 *  restrictive qualifier ("only stage files after tests pass") and
 *  treating it as permission falsely rejected unrelated restrictions. */
const PERMIT_RE =
  /\b(can|may|allowed|permit(ted|s)?|okay|ok|go ahead|feel free|fine to|(is|are|'s) fine|acceptable|safe to|always)\b/i;
/** Affirmative-exclusive instruction — `only` IMMEDIATELY AFTER an action
 *  verb ("use only uv", "install only via pip"): the sentence exclusively
 *  permits that action's tool, so it opposes a prohibition of the same
 *  action (Qodo round 9, PR #916). Unlike a bare `only`, this shape cannot
 *  be a temporal restriction — "only stage files after tests pass" has
 *  `only` BEFORE the verb and never matches. */
const ONLY_PERMIT_RE =
  /\b(?:use|uses|using|install|installs|installing|run|runs|running|execute|executes|executing|deploy|deploys|deploying|commit|commits|push|pushes|merge|merges|write|writes|call|calls|invoke|invokes)\s+only\b/i;

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

/** True when one text permits what the other forbids (permission flip).
 *  The non-negated side must carry the OPPOSING permission: a candidate that
 *  mixes negation and permission in its own text ("Enforce via code, not
 *  rules — code can't be ignored, rules can") must not clash with a neutral
 *  new entry that merely shares a topic word. */
function polarityClash(a: string, b: string): boolean {
  const aNeg = NEGATION_RE.test(a);
  const bNeg = NEGATION_RE.test(b);
  if (aNeg === bNeg) return false;
  // Permits come from PERMIT_RE or the verb-qualified ONLY_PERMIT_RE
  // ("use only X" — Qodo round 9, PR #916).
  const aPerm = PERMIT_RE.test(a) || ONLY_PERMIT_RE.test(a);
  const bPerm = PERMIT_RE.test(b) || ONLY_PERMIT_RE.test(b);
  return aNeg ? bPerm : aPerm;
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
 * Find every existing entry that the new text contradicts (Qodo #6,
 * PR #916). Returning ALL conflicts — not just the best one — matters for
 * correctness: if a non-pinned entry outranked a pinned one, the pinned
 * entry escaped the gate entirely and a confirmed override superseded only
 * the best match, leaving the other contradiction in place.
 *
 * Candidates: same-category entries, pinned entries, and enforced entries
 * (the protected classes), narrowed by vector similarity when the embedding
 * model is available and by content-word overlap otherwise. A candidate is a
 * conflict when permission polarity flips (one forbids, the other permits).
 * Results are sorted best-first.
 */
export async function findContradiction(
  cwd: string,
  text: string,
  category: string,
): Promise<ConflictCandidate[]> {
  const topicEntries = readAllTopicEntries(cwd);
  if (topicEntries.length === 0) return [];
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
  if (pool.length === 0) return [];

  // Vector-narrowed candidates (paraphrase-tolerant). Model may be
  // unavailable — the overlap fallback below still applies. Entries with NO
  // embedding are never dropped by narrowing (Qodo #7, PR #916): a pinned
  // or recently added entry that has not been embedded yet must still reach
  // the overlap check, or it becomes invisible to the conflict gate.
  // topK covers the WHOLE pool (Qodo round 2, PR #916): with a small topK,
  // embedded-but-dissimilar entries are absent from the results and were
  // indistinguishable from unembedded ones.
  let candidates = pool;
  const similarKeys = new Set<string>();
  let similarityByText = new Map<string, number>();
  try {
    const vectorMatches = await vectorSearch(
      cwd,
      text,
      pool.map((p) => ({ text: p.text, category: p.category, pinned: p.pinned })),
      pool.length,
    );
    similarityByText = new Map(
      vectorMatches.map((vm) => [`${vm.category}:${vm.text}`, vm.similarity]),
    );
    const matchedKeys = new Set(vectorMatches.map((vm) => `${vm.category}:${vm.text}`));
    for (const vm of vectorMatches) {
      if (vm.similarity >= getConflictSimilarityThreshold(cwd)) {
        similarKeys.add(`${vm.category}:${vm.text}`);
      }
    }
    if (similarKeys.size > 0 || matchedKeys.size > 0) {
      // Keep vector-similar entries AND entries the vector search never saw
      // (no embedding) — the latter fall through to the overlap check.
      candidates = pool.filter(
        (p) => similarKeys.has(`${p.category}:${p.text}`) || !matchedKeys.has(`${p.category}:${p.text}`),
      );
    }
  } catch (err) {
    log.debug("memory-write: conflict vector search unavailable, using overlap fallback", err);
  }

  // Collect EVERY conflicting candidate, best score first — first match in
  // file order could be a weaker conflict than the real one.
  const conflicts: Array<{ candidate: ConflictCandidate; score: number }> = [];
  for (const candidate of candidates) {
    if (!polarityClash(text, candidate.text)) continue;
    // Vector-CONFIRMED candidates (similarity ≥ threshold) are already
    // topically related, so one shared content word corroborates; every
    // other candidate (unembedded, or vector search unavailable) needs the
    // strict ≥ 2 corroboration (Qodo round 2, PR #916: a global loose gate
    // let a single shared word like "main" reject unrelated rules).
    const shared = sharedContentWords(text, candidate.text);
    const vectorConfirmed = similarKeys.has(`${candidate.category}:${candidate.text}`);
    if (!(shared >= 2 || (vectorConfirmed && shared >= 1))) continue;
    const similarity = similarityByText.get(`${candidate.category}:${candidate.text}`) ?? 0;
    conflicts.push({ candidate, score: similarity * 10 + shared });
  }
  conflicts.sort((a, b) => b.score - a.score);
  return conflicts.map((c) => c.candidate);
}

// ── Supersession ─────────────────────────────────────────────────────

/**
 * Invalidate an entry that a confirmed rule change supersedes: remove the
 * topic line, score entry, and embedding. Called from the conflict-override
 * path so no contradiction remains in memory (issue #915).
 */
function supersedeEntry(cwd: string, category: string, text: string): void {
  try {
    const topicName = CATEGORY_TO_TOPIC[category as MemoryCategory];
    if (!topicName) return;
    const topicPath = join(cwd, ".pi", "memory", "topics", `${topicName}.md`);
    if (!existsSync(topicPath)) return;
    const content = readFileSync(topicPath, "utf-8");
    const match = findTopicLine(content, category, text);
    if (!match) return;
    const lines = content.split("\n");
    lines.splice(match.index, 1);
    writeFileSync(topicPath, lines.join("\n").replace(/\n{3,}/g, "\n\n"), "utf-8");
    invalidateTopicFileCache(topicPath);

    removeEmbedding(cwd, text, category);

    const canonicalLine = `- [${category}] ${text}`;
    const removedId = match.id;
    mutateScores(cwd, (scores) => {
      delete scores.entries[entryHash(canonicalLine)];
      if (removedId) {
        for (const [hash, entry] of Object.entries(scores.entries)) {
          if (entry.id === removedId) delete scores.entries[hash];
        }
      }
    });
    log.info("memory_supersede", category, text.slice(0, 60));
  } catch (err) {
    log.warn("memory-write: supersede failed:", err);
  }
}

// ── Dedup + enforcement merge ──────────────────────────────────────────

/** Topic-size cap rejection for a prospective new line, or null when it
 *  fits. Shared by the conflict-override path (precheck BEFORE superseding,
 *  Qodo #20 PR #916) and the final write. */
function topicCapRejection(cwd: string, category: string, entryLine: string): AddMemoryResult | null {
  const topicName = CATEGORY_TO_TOPIC[category as MemoryCategory];
  if (!topicName) return null;
  const topicPath = join(cwd, ".pi", "memory", "topics", `${topicName}.md`);
  let content = "";
  if (existsSync(topicPath)) {
    content = readFileSync(topicPath, "utf-8");
  } else {
    const title = topicName.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
    content = `# ${title}\n`;
  }
  const newContent = content.trimEnd() + "\n" + entryLine + "\n";
  if (newContent.length > MAX_TOPIC_CHARS) {
    return {
      status: "rejected",
      message:
        `Topic "${topicName}" would exceed size limit (${newContent.length}/${MAX_TOPIC_CHARS} chars). ` +
        `Consolidate or remove entries first using memory_remove.`,
    };
  }
  return null;
}

/** Scope reconciliation on dedup reinforcement (Qodo #10, PR #916): when an
 *  entry is restated WITHOUT a scope (or as project), a previous session/task
 *  scope and its TTL are cleared — the user confirmed the rule is durable.
 *  A narrower restatement never narrows an existing durable entry.
 *  Qodo round 2 (PR #916): when a session-scoped entry is restated in a
 *  DIFFERENT session, the entry rebinds to that session (sourceSession +
 *  fresh TTL) — otherwise the rule the user just restated stays inactive in
 *  the very session that asked for it. */
function reconcileScopeOnReinforce(cwd: string, existingLine: string, input: AddMemoryInput): void {
  mutateScores(cwd, (scores) => {
    const existing = scores.entries[entryHash(existingLine)];
    if (!existing) return;
    if (!input.scope || input.scope === "project") {
      if (!existing.scope || existing.scope === "project") return;
      delete existing.scope;
      delete existing.expiresAt;
      log.info("memory_scope_reconciled", existingLine.slice(0, 60));
      return;
    }
    if (
      input.scope === "session" &&
      existing.scope === "session" &&
      input.sourceSession
    ) {
      // Rebinding ADDS the restating session — it must never steal the entry
      // from a still-active earlier session (Qodo round 3, PR #916).
      const known = new Set(
        [existing.sourceSession, ...(existing.sourceSessions ?? [])].filter((s): s is string => !!s),
      );
      if (!known.has(input.sourceSession)) {
        known.add(input.sourceSession);
        existing.sourceSessions = [...known];
      }
      existing.expiresAt = new Date(Date.now() + SESSION_SCOPE_TTL_MS).toISOString();
      log.info("memory_scope_rebound", existingLine.slice(0, 60), input.sourceSession);
    }
  });
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
  // 1b. Marker-shape guard (Qodo #16, PR #916): topic-line markers are
  // reserved for storage. User text carrying `{#id}`, `*(pinned)*`, or
  // `*(enforced)*` breaks the parse/hash binding — parsers strip markers,
  // so the stored line would hash differently from the requested text.
  if (/\s*\{#[0-9a-f]+\}$/.test(text) || text.includes("*(pinned)*") || text.includes("*(enforced)*")) {
    return {
      status: "rejected",
      message:
        `Rejected: text contains topic-line markers (\`{#id}\`, \`*(pinned)*\`, \`*(enforced)*\`) — ` +
        `these are reserved for storage and break hash binding. Store the plain rule text; ` +
        `pinned/enforced state is set via the \`pinned\`/\`trigger\`+\`action\` parameters.`,
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
  // is refused rather than silently reinforcing the wrong entry. A conflict is
  // a decision point, not a dead end (issue #915): the model asks the user, and
  // a confirmed rule change retries with overrideConflicts, which supersedes
  // ALL the old entries. Pinned entries are never auto-superseded — they are
  // user-explicit and require the user's own memory_remove / memory_edit.
  const conflicts = await findContradiction(cwd, text, category);
  if (conflicts.length > 0) {
    const pinned = conflicts.filter((c) => c.pinned);
    if (pinned.length > 0) {
      const c = pinned[0]!;
      const more =
        conflicts.length > 1
          ? ` (and ${conflicts.length - 1} other conflicting ${conflicts.length - 1 === 1 ? "entry" : "entries"})`
          : "";
      return {
        status: "rejected",
        message:
          `Rejected: contradicts pinned memory "[${c.category}] ${c.text}"${more}. ` +
          `Pinned entries are user-explicit — ask the user (ask_user). If they confirm the rule ` +
          `changed, they must remove or edit the pinned entry (memory_remove / memory_edit) ` +
          `per their instruction first; overrideConflicts does not apply to pinned entries.`,
      };
    }
    const conflict = conflicts[0]!;
    if (!input.overrideConflicts) {
      const more =
        conflicts.length > 1
          ? ` (and ${conflicts.length - 1} other conflicting ${conflicts.length - 1 === 1 ? "entry" : "entries"})`
          : "";
      return {
        status: "rejected",
        message:
          `Rejected: contradicts existing memory "[${conflict.category}] ${conflict.text}"` +
          `${conflict.enforced ? " (code-enforced)" : ""}${more}. ` +
          `Ask the user (ask_user) which is correct. If they confirm the rule changed, retry ` +
          `memory_add with overrideConflicts: true — the old ${conflicts.length > 1 ? "entries will be" : "entry will be"} superseded ` +
          `(invalidated, with provenance) automatically.`,
      };
    }
    // Confirmed override — but verify the new entry is actually writable
    // BEFORE invalidating anything (Qodo #20, PR #916): superseding first
    // and then failing the topic-size cap would lose both the old and the
    // new rule.
    const entryLine = formatTopicLine(
      {
        text,
        category: category as MemoryCategory,
        pinned: isPinned,
        id: newEntryId(),
      },
      !!((input.trigger && input.action) || input.verifier),
    );
    const capRejection = topicCapRejection(cwd, category, entryLine);
    if (capRejection) return capRejection;
    // Supersede every conflicting entry so no contradiction remains
    for (const c of conflicts) {
      supersedeEntry(cwd, c.category, c.text);
    }
    if (!input.derivedFrom) {
      input.derivedFrom =
        `supersedes: [${conflict.category}] ${conflict.text}` +
        (conflicts.length > 1 ? ` (+${conflicts.length - 1} more)` : "");
    }
    log.info("memory_conflict_override", conflict.text.slice(0, 60), `count=${conflicts.length}`);
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
        reconcileScopeOnReinforce(cwd, existingLine, input);
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
    reconcileScopeOnReinforce(cwd, canonicalLine, input);
    const merged = mergeEnforcementFields(cwd, canonicalLine, input);
    const enforcementNote = merged ? " (enforcement fields merged)" : "";
    return {
      status: "reinforced",
      message: `Already exists — reinforced instead: [${category}] ${text}${enforcementNote}`,
    };
  }

  // 5. Topic cap + write (cap precheck already ran in the override path;
  // this re-check is a race safety net — another writer may have appended)
  const topicName = CATEGORY_TO_TOPIC[category as MemoryCategory];
  const topicsDir = join(cwd, ".pi", "memory", "topics");
  const topicPath = join(topicsDir, `${topicName}.md`);

  if (!existsSync(topicsDir)) {
    mkdirSync(topicsDir, { recursive: true });
  }

  const isEnforced = !!((input.trigger && input.action) || input.verifier);
  const entryId = newEntryId();
  const entryLine = formatTopicLine(
    { text, category: category as MemoryCategory, pinned: isPinned, id: entryId },
    isEnforced,
  );

  const capRejection = topicCapRejection(cwd, category, entryLine);
  if (capRejection) return capRejection;
  const content = existsSync(topicPath) ? readFileSync(topicPath, "utf-8") : "";
  const newContent = (content || `# ${topicName.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())}\n`).trimEnd() + "\n" + entryLine + "\n";
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
      if (input.scope === "session" || input.scope === "task") {
        // Safety net: even if dream never runs, scoped entries expire. Task
        // scope has no task-end signal, so it gets the same TTL (Qodo #9,
        // PR #916) — without it, task-scoped entries behaved as durable
        // project memories.
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
