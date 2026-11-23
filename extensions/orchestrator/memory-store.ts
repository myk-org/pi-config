/**
 * memory-store.ts — single deep memory-store module (issue #1354).
 *
 * Owns every topic markdown write, topic-file cache invalidation, score/tombstone
 * mutation, and embedding upkeep/pruning behind a narrow mutation interface:
 *
 *   - addMemoryEntry: validation, guardrails, contradiction gate, dedup, cap, write
 *   - editMemoryEntry: in-place update with the same marker-shape, grant, task-scope,
 *     duplicate, contradiction, and topic-cap guards
 *   - removeMemoryEntry: line removal, cache invalidation, score/id cleanup,
 *     embedding removal, optional tombstone
 *   - markEntryEnforced / applyEnforcementPromotions: atomic score+topic enforcement
 *   - applyEntryProvenance: locked provenance metadata merge
 *   - snapshotTopicLines / isProtectedTopicLine / restoreProtectedTopicLines:
 *     dream-guard snapshot and restore via the canonical topic list
 *   - pruneExpiredEntries / rebuildMemoryStore: expiry pruning, score rebuild,
 *     and stale embedding pruning
 *   - recordRemoval / removalsSince: deliberate-removal tombstone log
 *
 * Contradiction NLP heuristics are isolated in memory-contradiction.ts.
 */

import { createLogger } from "../shared/logger.js";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getProjectMemoryDir } from "./utils.js";
import {
  type EnforcementAction,
  type EnforcementTrigger,
  type MemoryCategory,
  type MemoryScope,
  type ScoredEntry,
  VALID_CATEGORIES,
  PINNED_SCORE,
  entryHash,
  hasEnforcementFields,
  loadScores,
  mutateScores,
  newEntryId,
  applyReinforceToEntry,
  isGrantText,
  isTaskScopedText,
  hasDurabilityMarker,
  rebuild,
} from "./memory-scoring.js";
import {
  ALL_TOPIC_NAMES,
  CATEGORY_TO_TOPIC,
  topicCharCap,
  readAllTopicEntries,
  parseTopicLine,
  formatTopicLine,
  findTopicLine,
  canonicalTopicLine,
  canonicalizeTopicLine,
  extractTopicLineText,
  invalidateTopicFileCache,
} from "./memory-tree.js";
import {
  embedEntry,
  embedMissing,
  pruneEmbeddings,
  removeEmbedding,
  removeEmbeddings,
} from "./memory-embeddings.js";
import {
  type ConflictCandidate,
  findContradiction,
  findContradictionWithVector,
} from "./memory-contradiction.js";
import { SKIP_MUTATE } from "./state-jsonl.js";
import { getSetting } from "./project-settings.js";

export { type ConflictCandidate, findContradiction };

const log = createLogger("memory");

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_NEAR_DUPLICATE_THRESHOLD = 0.90;
/** Safety-net expiry for session/task-scoped entries (issue #915). */
const SESSION_SCOPE_TTL_MS = 24 * 60 * 60 * 1000;
const VALID_SCOPES: readonly MemoryScope[] = ["session", "task", "project"];

/** Append-only log of deliberate entry removals, so background maintenance can tell a
 *  user removal from its own damage. Score absence cannot: the scheduled rebuild prunes
 *  scores for lines missing from topic files (issue #1010). */
const REMOVALS_FILE = "removals.jsonl";
const MAX_REMOVAL_ROWS = 5000;

/** Near-duplicate threshold from settings (issue #915). */
function getNearDuplicateThreshold(cwd: string): number {
  const v = Number(getSetting(cwd, "memory_near_duplicate_threshold"));
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_NEAR_DUPLICATE_THRESHOLD;
}

// ── Internal topic-file write seam ─────────────────────────────────────────

/** Single topic markdown write chokepoint: always invalidates the read cache. */
function writeTopicFile(topicPath: string, content: string): void {
  mkdirSync(dirname(topicPath), { recursive: true });
  writeFileSync(topicPath, content, "utf-8");
  invalidateTopicFileCache(topicPath);
}

// ── Tombstones (removals.jsonl) ────────────────────────────────────────────

/** Record that an entry was removed on purpose. Fail-soft: a lost tombstone can only
 *  make the dream guard restore a line the user deleted, never delete one. */
export function recordRemoval(cwd: string, canonicalLine: string): void {
  try {
    const file = join(getProjectMemoryDir(cwd), REMOVALS_FILE);
    const hash = entryHash(canonicalLine);
    const row = `${JSON.stringify({ hash, at: new Date().toISOString() })}\n`;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, row, "utf-8");
    log.debug("memory_removal_recorded", { hash });
    // Each valid JSONL row is at least 60 bytes — skip reading the entire log
    // until file size can plausibly exceed MAX_REMOVAL_ROWS.
    if (statSync(file).size > MAX_REMOVAL_ROWS * 60) {
      const rows = readFileSync(file, "utf-8").split("\n").filter(Boolean);
      if (rows.length > MAX_REMOVAL_ROWS) {
        writeFileSync(file, `${rows.slice(-MAX_REMOVAL_ROWS).join("\n")}\n`, "utf-8");
      }
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

// ── Types ──────────────────────────────────────────────────────────────────

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

export interface EditMemoryInput {
  category: string;
  text: string;
  newText: string;
  sourceSession?: string;
  derivedFrom?: string;
  informs?: string[];
}

export type EditMemoryStatus =
  | "updated"
  | "invalid_category"
  | "topic_missing"
  | "not_found"
  | "rejected";

export interface EditMemoryResult {
  status: EditMemoryStatus;
  message: string;
}

export type RemoveMemoryResult =
  | { status: "removed"; id?: string }
  | { status: "invalid_category" }
  | { status: "topic_missing" }
  | { status: "not_found" };

export interface EnforcementPromotionInput {
  category: MemoryCategory;
  text: string;
  trigger: EnforcementTrigger;
  action: EnforcementAction;
  verifier?: string;
}

export interface EntryProvenancePatch {
  category: MemoryCategory | string;
  text: string;
  sourceSession?: string;
  derivedFrom?: string;
  informs?: string[];
}

export type TopicRestoreReport = {
  restored: number;
  failed: number;
  /** Topics still over their cap after reconcile. Never trimmed here. */
  overCapTopics: string[];
};

// ── Validation & shared text guardrails ────────────────────────────────────

function validateTrigger(trigger: string): string | null {
  const validPrefixes = ["bash_contains ", "bash_regex ", "tool_name ", "file_modified "];
  if (!validPrefixes.some((p) => trigger.startsWith(p))) {
    log.warn("memory-store: invalid trigger rejected", trigger.slice(0, 80));
    return (
      `Invalid trigger format "${trigger}". Must start with: ` +
      validPrefixes.map((p) => p.trim()).join(", ")
    );
  }
  return null;
}

/** A `tool_name bash` rule fires on EVERY command, so a block (or a warn) there can brick
 *  the session instead of enforcing anything specific. Such a rule is never what the writer
 *  means — a bash rule has to name the command it is about. */
export function unscopedBashRuleError(trigger: string, action: string | undefined): string | null {
  if (trigger.trim().toLowerCase() !== "tool_name bash") return null;
  const verb = (action ?? "").trim().split(/\s+/)[0];
  if (verb !== "block" && verb !== "warn") return null;
  log.warn("memory-store: unscoped bash trigger rejected", { trigger, action });
  return (
    `Refusing "${trigger}" with action "${verb}": it would apply to EVERY bash call. ` +
    "Scope it to the command, e.g. 'bash_contains rm -rf /' or 'bash_regex ^git push'."
  );
}

function validateAction(action: string): string | null {
  const validActions = ["block", "warn"];
  const isRunAfter = action.startsWith("run_after ");
  if (!validActions.includes(action) && !isRunAfter) {
    log.warn("memory-store: invalid action rejected", action.slice(0, 80));
    return `Invalid action "${action}". Valid: block, warn, run_after <command>`;
  }
  if (isRunAfter && !action.slice("run_after ".length).trim()) {
    log.warn("memory-store: run_after action without a command rejected");
    return `Invalid action "${action}". run_after requires a command (e.g., 'run_after npm test')`;
  }
  return null;
}

/** Shell commands that are NOT pi tools — a `tool_name` trigger naming one
 *  can never fire because these run INSIDE bash (#936). */
const SHELL_COMMAND_TOOL_NAMES = new Set([
  "curl", "wget", "jq", "gh", "docker", "podman", "kubectl", "oc",
  "ssh", "scp", "rsync", "git", "npm", "npx", "pip", "pip3", "uv",
  "tox", "pytest", "python", "python3", "node", "deno", "bun", "make",
  "cargo", "go", "java", "mvn", "gradle",
]);

/** Write-time warning for over-broad or ineffective `tool_name` triggers (#936). */
function toolNameTriggerWarning(trigger: string | undefined, action: string | undefined): string | null {
  if (!trigger?.startsWith("tool_name ")) return null;
  const tool = trigger.slice("tool_name ".length).trim();
  const advise = (warning: string): string => {
    log.warn("memory-store: tool_name trigger advisory", trigger, warning);
    return warning;
  };
  const toolLower = tool.toLowerCase();
  if (!action) {
    return advise(`warning: trigger "tool_name ${tool}" has no action — it will never fire; add an action (block, warn, or run_after <command>) for enforcement to load it`);
  }
  if (SHELL_COMMAND_TOOL_NAMES.has(toolLower)) {
    return advise(`warning: trigger "tool_name ${tool}" names a shell command, not a pi tool — ${toolLower} runs inside bash, so this trigger never fires; use a bash_contains pattern for the specific command instead`);
  }
  if (toolLower === "bash") {
    return advise(`warning: trigger "tool_name ${tool}" with action ${action ?? "(none)"} applies to EVERY bash call — usually over-broad; prefer a bash_contains pattern targeting the specific command`);
  }
  return null;
}

/** Shared text guardrails for both addMemoryEntry and editMemoryEntry:
 *  marker-shape, grant-phrase, and task-scope checks. */
function checkTextGuardrails(
  text: string,
  category: string,
  options: { isSessionScoped: boolean },
): string | null {
  // Marker-shape guard (Qodo #16, PR #916): topic-line markers are reserved
  // for storage. User text carrying `{#id}`, `*(pinned)*`, or `*(enforced)*`
  // breaks the parse/hash binding.
  if (/\s*\{#[0-9a-f]+\}$/.test(text) || text.includes("*(pinned)*") || text.includes("*(enforced)*")) {
    return (
      `Rejected: text contains topic-line markers (\`{#id}\`, \`*(pinned)*\`, \`*(enforced)*\`) — ` +
      `these are reserved for storage and break hash binding. Store the plain rule text; ` +
      `pinned/enforced state is set via the \`pinned\`/\`trigger\`+\`action\` parameters.`
    );
  }

  // Grant-phrase guardrail — one-off permissions are session instructions,
  // not durable memories (issue #915 incident).
  if (isGrantText(text) && !options.isSessionScoped) {
    return (
      `Rejected: "${text}" reads like a one-off permission grant (e.g. "you can merge this PR"). ` +
      `One-off grants are session instructions, NOT memories — do not store them. ` +
      `If the user confirmed a standing rule, rephrase it as the durable rule itself ` +
      `(e.g. "Agent may merge release-flow bump PRs") without grant phrasing.`
    );
  }

  // Task-scope guardrail (issue #961): task-scoped instructions are task
  // attributes or session instructions, not durable memories.
  if (isTaskScopedText(text, category) && !options.isSessionScoped) {
    log.info("memory_task_scoped_rejected", { category, text: text.slice(0, 120) });
    return (
      `Rejected: "${text}" reads like a task-scoped instruction (e.g. "when done, I want an ` +
      `html report" or "when bumping to 1.4.0, drop the vendor dir"). ` +
      `Task-scoped asks belong to the CURRENT task (its description, a task attribute, or a ` +
      `session instruction) — NOT memory. If the user confirmed a standing rule, rephrase it ` +
      `as the durable rule itself (e.g. "Always produce an HTML report when a task completes") ` +
      `without the task-scoped phrasing.`
    );
  }

  return null;
}

// ── Entry Removal & Supersession ───────────────────────────────────────────

/**
 * Shared entry-removal pipeline used by `memory_remove`, `memory_edit`
 * (`invalidate`), and conflict supersession: removes the topic line,
 * invalidates the topic cache, removes the embedding, cleans up the
 * score entry (including id-bound keys), and optionally writes a removal
 * tombstone so the dream guard does not restore it.
 */
export function removeMemoryEntry(
  cwd: string,
  category: string,
  text: string,
  options: { recordTombstone: boolean },
): RemoveMemoryResult {
  if (!VALID_CATEGORIES.includes(category as MemoryCategory)) {
    return { status: "invalid_category" };
  }
  const topicName = CATEGORY_TO_TOPIC[category as MemoryCategory];
  const topicPath = join(getProjectMemoryDir(cwd), "topics", `${topicName}.md`);
  if (!existsSync(topicPath)) {
    return { status: "topic_missing" };
  }
  const content = readFileSync(topicPath, "utf-8");
  const match = findTopicLine(content, category, text);
  if (!match) {
    return { status: "not_found" };
  }

  const lines = content.split("\n");
  lines.splice(match.index, 1);
  const cleaned = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  writeTopicFile(topicPath, cleaned);

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

  if (options.recordTombstone) {
    recordRemoval(cwd, canonicalLine);
  }
  log.info("memory_remove_entry", { category, text: text.slice(0, 60), tombstone: options.recordTombstone });
  return { status: "removed", id: removedId };
}

/**
 * Invalidate an entry that a confirmed rule change supersedes: remove the
 * topic line, score entry, and embedding.
 */
function supersedeEntry(cwd: string, category: string, text: string): void {
  try {
    const res = removeMemoryEntry(cwd, category, text, { recordTombstone: true });
    if (res.status === "removed") {
      log.info("memory_supersede", category, text.slice(0, 60));
    }
  } catch (err) {
    log.warn("memory-store: supersede failed:", err);
  }
}

// ── Dedup + enforcement merge ──────────────────────────────────────────────

/** Topic-size cap rejection for a prospective new line, or null when it fits. */
function topicCapRejection(cwd: string, category: string, entryLine: string): AddMemoryResult | null {
  const topicName = CATEGORY_TO_TOPIC[category as MemoryCategory];
  if (!topicName) return null;
  const topicPath = join(getProjectMemoryDir(cwd), "topics", `${topicName}.md`);
  let content = "";
  if (existsSync(topicPath)) {
    content = readFileSync(topicPath, "utf-8");
  } else {
    const title = topicName.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
    content = `# ${title}\n`;
  }
  const newContent = content.trimEnd() + "\n" + entryLine + "\n";
  const cap = topicCharCap(topicName);
  if (newContent.length > cap) {
    log.warn("memory_topic_cap_rejected", { topic: topicName, chars: newContent.length, cap });
    return {
      status: "rejected",
      message:
        `Topic "${topicName}" would exceed size limit (${newContent.length}/${cap} chars). ` +
        `Consolidate or remove entries first using memory_remove.`,
    };
  }
  return null;
}

/**
 * Single locked read-modify-write for dedup reinforcement: bumps evidence/score,
 * reconciles scope, and merges any new enforcement fields in one lock cycle.
 */
function reinforceOnDedup(
  cwd: string,
  existingLine: string,
  input: AddMemoryInput,
): { found: boolean; merged: boolean } {
  const hash = entryHash(existingLine);
  let found = false;
  let merged = false;
  mutateScores(cwd, (scores) => {
    const existing = scores.entries[hash];
    if (!existing) return SKIP_MUTATE;
    found = true;

    applyReinforceToEntry(existing);

    // Scope reconciliation: restatement without scope (or as project) clears
    // prior session/task scope; session restatement in another session adds
    // that session without stealing it from earlier ones.
    if (!input.scope || input.scope === "project") {
      if (existing.scope && existing.scope !== "project") {
        delete existing.scope;
        delete existing.expiresAt;
        log.info("memory_scope_reconciled", existingLine.slice(0, 60));
      }
    } else if (
      input.scope === "session" &&
      existing.scope === "session" &&
      input.sourceSession
    ) {
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

    // Merge enforcement fields when supplied
    if (input.trigger || input.action || input.verifier) {
      if (input.trigger) existing.trigger = input.trigger as EnforcementTrigger;
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
    }
  });
  return { found, merged };
}

/** Warn from the EFFECTIVE merged action on the reinforced path. */
function reinforcedTriggerWarning(
  cwd: string,
  existingLine: string,
  input: AddMemoryInput,
  base: string | null,
): string | null {
  try {
    const existing = loadScores(cwd).entries[entryHash(existingLine)];
    if (!existing) return base;
    if (!input.trigger && !input.action) return base;
    const effectiveTrigger = input.trigger ?? existing.trigger;
    const existingAction =
      existing.action === "run_after" && existing.actionCommand
        ? `run_after ${existing.actionCommand}`
        : existing.action;
    const effectiveAction = input.action ?? existingAction;
    return toolNameTriggerWarning(effectiveTrigger, effectiveAction) ?? base;
  } catch {
    return base;
  }
}

// ── Add Entry ──────────────────────────────────────────────────────────────

/**
 * Add a memory entry through the unified store write path.
 * Enforces: validation → marker/grant/task-scope guardrails → contradiction gate →
 * durability gate → near/exact dedup → topic cap → write + cache invalidation +
 * score mutation + embedding upkeep.
 */
export async function addMemoryEntry(cwd: string, input: AddMemoryInput): Promise<AddMemoryResult> {
  // Canonicalize tool_name triggers (Qodo dfbdbf1c, 53d6b3d0, 17b68cf5):
  // exact case-sensitive matching; only repair lowercase "bash" misspellings.
  if (input.trigger?.startsWith("tool_name ")) {
    const tool = input.trigger
      .slice("tool_name ".length)
      .replace(/\s+/g, " ")
      .trim();
    if (!tool) {
      return {
        status: "rejected",
        message:
          `Rejected: trigger "${input.trigger.trim()}" names no tool — ` +
          `provide the tool name (e.g. "tool_name bash") or use a bash_contains pattern.`,
      };
    }
    input = {
      ...input,
      trigger: `tool_name ${tool.toLowerCase() === "bash" ? "bash" : tool}`,
    };
  }
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
    const unscoped = unscopedBashRuleError(input.trigger, input.action);
    if (unscoped) return { status: "rejected", message: unscoped };
  }
  if (input.action) {
    const err = validateAction(input.action);
    if (err) return { status: "rejected", message: err };
  }
  const triggerWarning = toolNameTriggerWarning(input.trigger, input.action);
  if (input.scope && !VALID_SCOPES.includes(input.scope as MemoryScope)) {
    return {
      status: "rejected",
      message: `Invalid scope "${input.scope}". Valid: ${VALID_SCOPES.join(", ")}`,
    };
  }

  // 1b–2b. Shared text guardrails: marker-shape, grant-phrase, task-scope
  const guardrailErr = checkTextGuardrails(text, category, {
    isSessionScoped: input.scope === "session",
  });
  if (guardrailErr) {
    return { status: "rejected", message: guardrailErr };
  }

  // Embed missing topic entries ONCE before contradiction detection so both
  // findContradictionWithVector() and Step 4a share a single vectorSearch() pass.
  let topicEntries = readAllTopicEntries(cwd);
  if (topicEntries.length > 0) {
    try {
      await embedMissing(cwd, topicEntries);
    } catch (err) {
      log.debug("memory-store: pre-embed skipped:", err);
    }
  }

  // 3. Contradiction gate — before dedup, so a permission-flipping near-duplicate
  // is refused rather than silently reinforcing the wrong entry.
  const {
    conflicts,
    vectorMatches: poolVectorMatches,
  } = await findContradictionWithVector(cwd, text, category, topicEntries);
  const supersededKeys = new Set<string>();
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
    // Confirmed override — verify writable BEFORE invalidating anything (Qodo #20).
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
    for (const c of conflicts) {
      supersedeEntry(cwd, c.category, c.text);
      supersededKeys.add(`${c.category}:${c.text}`);
    }
    topicEntries = readAllTopicEntries(cwd);
    if (!input.derivedFrom) {
      input.derivedFrom =
        `supersedes: [${conflict.category}] ${conflict.text}` +
        (conflicts.length > 1 ? ` (+${conflicts.length - 1} more)` : "");
    }
    log.info("memory_conflict_override", conflict.text.slice(0, 60), `count=${conflicts.length}`);
  }

  // 3b. Durability gate (issue #961)
  if (
    category === "preference" &&
    !input.pinned &&
    !input.overrideConflicts &&
    input.scope !== "session" &&
    !hasDurabilityMarker(text)
  ) {
    log.info("memory_unmarked_preference_rejected", { text: text.slice(0, 120) });
    return {
      status: "rejected",
      message:
        `Rejected: "${text}" carries no durability marker (always, never, prefer, from now on, ` +
        `by default…). A preference said once, unmarked, is a session instruction — it must not ` +
        `apply to all future work. Either confirm with the user that it is a standing rule ` +
        `(then rephrase as the rule itself, e.g. "Always commit and push before reporting done"), ` +
        `store it with scope=session, or pin it with "remember this".`,
    };
  }

  const canonicalLine = `- [${category}] ${text}`;

  // 4a. Near-duplicate check via vector similarity (reusing Step 3 vectorSearch).
  try {
    const nearDupThreshold = getNearDuplicateThreshold(cwd);
    const sameCategoryMatches = poolVectorMatches
      .filter((vm) => vm.category === category && !supersededKeys.has(`${vm.category}:${vm.text}`))
      .slice(0, 20);
    for (const vm of sameCategoryMatches) {
      if (vm.similarity < nearDupThreshold) continue;
      const existingLine = `- [${vm.category}] ${vm.text}`;
      const { found, merged } = reinforceOnDedup(cwd, existingLine, input);
      if (found) {
        const enforcementNote = merged ? " (enforcement fields merged)" : "";
        const reinforcedWarning = reinforcedTriggerWarning(cwd, existingLine, input, triggerWarning);
        if (reinforcedWarning) log.warn(`memory-store: ${reinforcedWarning}`);
        return {
          status: "reinforced",
          message:
            `Near-duplicate found (similarity: ${vm.similarity.toFixed(3)}) — reinforced instead: ` +
            `[${vm.category}] ${vm.text}${enforcementNote}${reinforcedWarning ? ` — ${reinforcedWarning}` : ""}`,
        };
      }
    }
  } catch (err) {
    log.debug("memory-store: vector dedup skipped:", err);
  }

  // 4b. Exact match check
  for (const te of topicEntries) {
    if (te.text !== text || te.category !== category) continue;
    const { merged } = reinforceOnDedup(cwd, canonicalLine, input);
    const enforcementNote = merged ? " (enforcement fields merged)" : "";
    const reinforcedWarning = reinforcedTriggerWarning(cwd, canonicalLine, input, triggerWarning);
    if (reinforcedWarning) log.warn(`memory-store: ${reinforcedWarning}`);
    return {
      status: "reinforced",
      message: `Already exists — reinforced instead: [${category}] ${text}${enforcementNote}${reinforcedWarning ? ` — ${reinforcedWarning}` : ""}`,
    };
  }

  // 5. Topic cap + write
  const topicName = CATEGORY_TO_TOPIC[category as MemoryCategory];
  const topicsDir = join(getProjectMemoryDir(cwd), "topics");
  const topicPath = join(topicsDir, `${topicName}.md`);

  const isEnforced = !!((input.trigger && input.action) || input.verifier);
  const entryId = newEntryId();
  const entryLine = formatTopicLine(
    { text, category: category as MemoryCategory, pinned: isPinned, id: entryId },
    isEnforced,
  );

  const capRejection = topicCapRejection(cwd, category, entryLine);
  if (capRejection) return capRejection;
  const content = existsSync(topicPath) ? readFileSync(topicPath, "utf-8") : "";
  const newContent =
    (content || `# ${topicName.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())}\n`).trimEnd() +
    "\n" +
    entryLine +
    "\n";
  writeTopicFile(topicPath, newContent);

  // Score entry — always hash the canonical line (no markers). Locked RMW.
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
      entry.trigger = input.trigger as EnforcementTrigger;
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
  if (triggerWarning) log.warn(`memory-store: ${triggerWarning}`);
  const pin = isPinned ? " (pinned)" : "";
  const scope = input.scope && input.scope !== "project" ? ` (scope: ${input.scope})` : "";
  return {
    status: "added",
    message: `Added: [${category}] ${text}${pin}${scope}${triggerWarning ? ` — ${triggerWarning}` : ""}`,
  };
}

// ── Edit Entry (in-place update with full write guards) ────────────────────

/**
 * Update a memory entry in-place through the store, preserving markers, stable id,
 * enforcement binding, and scoring history.
 *
 * Enforces the same write guards as `addMemoryEntry` (marker-shape, grant-phrase,
 * task-scope, contradiction against other entries, duplicate target, and topic cap)
 * so `memory_edit` can never bypass memory write safety (issue #1354).
 */
export async function editMemoryEntry(cwd: string, input: EditMemoryInput): Promise<EditMemoryResult> {
  const { category, text, newText } = input;

  if (!VALID_CATEGORIES.includes(category as MemoryCategory)) {
    return {
      status: "invalid_category",
      message: `Invalid category "${category}". Valid: ${VALID_CATEGORIES.join(", ")}`,
    };
  }
  if (!newText || !newText.trim()) {
    return {
      status: "rejected",
      message: "newText is required for update operation.",
    };
  }
  if (newText.includes("\n")) {
    return {
      status: "rejected",
      message: "newText must be a single line (no newlines).",
    };
  }

  const topicName = CATEGORY_TO_TOPIC[category as MemoryCategory];
  const topicPath = join(getProjectMemoryDir(cwd), "topics", `${topicName}.md`);
  if (!existsSync(topicPath)) {
    return {
      status: "topic_missing",
      message: `Topic file not found for category "${category}".`,
    };
  }

  const content = readFileSync(topicPath, "utf-8");
  const match = findTopicLine(content, category, text);
  if (!match) {
    return {
      status: "not_found",
      message: `Memory not found: [${category}] ${text}\nUse memory_search to find the exact text.`,
    };
  }
  const { index: matchIndex, pinned: wasPinned, enforced: wasEnforced, id: wasId } = match;

  // Determine whether the existing entry is session-scoped so session edits obey
  // the same scope exemption as addMemoryEntry.
  const oldHash = entryHash(`- [${category}] ${text}`);
  const existingScored = loadScores(cwd).entries[oldHash];
  const isSessionScoped = existingScored?.scope === "session";

  // Shared write guardrails: marker-shape, grant-phrase, task-scope
  const guardrailErr = checkTextGuardrails(newText, category, { isSessionScoped });
  if (guardrailErr) {
    log.warn("memory_edit_guardrail_rejected", { category, text: text.slice(0, 60), newText: newText.slice(0, 60) });
    return { status: "rejected", message: guardrailErr };
  }

  if (newText !== text) {
    // Reject duplicate target line in the same topic to prevent score hash collisions
    if (findTopicLine(content, category, newText)) {
      log.warn("memory_edit_duplicate_rejected", { category, newText: newText.slice(0, 60) });
      return {
        status: "rejected",
        message: `Rejected: memory already exists: [${category}] ${newText}. Use memory_remove to drop duplicates.`,
      };
    }

    // Contradiction gate against all OTHER entries (excluding the target being edited)
    const topicEntries = readAllTopicEntries(cwd);
    if (topicEntries.length > 0) {
      try {
        await embedMissing(cwd, topicEntries);
      } catch (err) {
        log.debug("memory-store: edit pre-embed skipped:", err);
      }
    }
    const { conflicts } = await findContradictionWithVector(cwd, newText, category, topicEntries, {
      exclude: { category, text },
    });
    if (conflicts.length > 0) {
      const pinned = conflicts.filter((c) => c.pinned);
      const primary = pinned[0] ?? conflicts[0]!;
      const more =
        conflicts.length > 1
          ? ` (and ${conflicts.length - 1} other conflicting ${conflicts.length - 1 === 1 ? "entry" : "entries"})`
          : "";
      log.warn("memory_edit_conflict_rejected", {
        category,
        text: text.slice(0, 60),
        newText: newText.slice(0, 60),
        conflicts: conflicts.length,
        pinned: primary.pinned,
      });
      if (primary.pinned) {
        return {
          status: "rejected",
          message:
            `Rejected: edit contradicts pinned memory "[${primary.category}] ${primary.text}"${more}. ` +
            `Pinned entries are user-explicit — ask the user (ask_user). If they confirm the rule ` +
            `changed, remove or edit the pinned entry (memory_remove / memory_edit) first.`,
        };
      }
      return {
        status: "rejected",
        message:
          `Rejected: edit contradicts existing memory "[${primary.category}] ${primary.text}"` +
          `${primary.enforced ? " (code-enforced)" : ""}${more}. ` +
          `Ask the user (ask_user) which is correct, then remove or invalidate the conflicting ` +
          `${conflicts.length > 1 ? "entries" : "entry"} before editing.`,
      };
    }
  }

  // Format replacement line preserving markers and stable id (issue #915)
  const replacement = formatTopicLine(
    {
      category: category as MemoryCategory,
      text: newText,
      pinned: wasPinned,
      ...(wasId ? { id: wasId } : {}),
    },
    wasEnforced,
  );
  const lines = content.split("\n");
  lines[matchIndex] = replacement;
  const newContent = lines.join("\n");
  const cap = topicCharCap(topicName);
  if (newContent.length > cap) {
    log.warn("memory_edit_topic_cap_rejected", { topic: topicName, chars: newContent.length, cap });
    return {
      status: "rejected",
      message: `Update would exceed topic size limit (${newContent.length}/${cap} chars).`,
    };
  }

  writeTopicFile(topicPath, newContent);

  // Transfer old entry's score to the new key, preserving stable id, enforcement
  // fields, and optional provenance patches — locked RMW.
  const newHash = entryHash(`- [${category}] ${newText}`);
  mutateScores(cwd, (scores) => {
    if (oldHash !== newHash) {
      let existing = scores.entries[oldHash];
      if (existing) {
        scores.entries[newHash] = { ...existing };
        delete scores.entries[oldHash];
      } else if (wasId) {
        for (const [hash, entry] of Object.entries(scores.entries)) {
          if (entry.id === wasId) {
            existing = entry;
            scores.entries[newHash] = { ...entry };
            delete scores.entries[hash];
            break;
          }
        }
      }
    }
    const target = scores.entries[newHash];
    if (target) {
      if (!target.id && wasId) target.id = wasId;
      if (input.sourceSession !== undefined) target.sourceSession = input.sourceSession;
      if (input.derivedFrom !== undefined) target.derivedFrom = input.derivedFrom;
      if (input.informs !== undefined) target.informs = input.informs;
    }
  });

  if (newText !== text) {
    removeEmbedding(cwd, text, category);
    await embedEntry(cwd, newText, category);
  }

  log.info("memory_edit_entry", { category, text: text.slice(0, 60), newText: newText.slice(0, 60) });
  return {
    status: "updated",
    message: `Updated: [${category}] ${text}\n     → [${category}] ${newText}`,
  };
}

// ── Enforcement Promotion Mutations ────────────────────────────────────────

/** Mark `*(enforced)*` (and stable `{#id}` when present in scores) on a topic line. */
export function markEntryEnforced(
  cwd: string,
  category: MemoryCategory,
  text: string,
): boolean {
  const topicName = CATEGORY_TO_TOPIC[category];
  if (!topicName) return false;
  const topicPath = join(getProjectMemoryDir(cwd), "topics", `${topicName}.md`);
  if (!existsSync(topicPath)) return false;

  const content = readFileSync(topicPath, "utf-8");
  const match = findTopicLine(content, category, text);
  if (!match) return false;
  if (match.enforced) return true;

  const scores = loadScores(cwd);
  const entryId = scores.entries[entryHash(canonicalTopicLine({ category, text }))]?.id;
  const id = match.id ?? entryId;
  const lines = content.split("\n");
  lines[match.index] = formatTopicLine(
    { category, text, pinned: match.pinned, ...(id ? { id } : {}) },
    true,
  );
  writeTopicFile(topicPath, lines.join("\n"));
  log.debug("memory_entry_marked_enforced", { category, text: text.slice(0, 80) });
  return true;
}

/**
 * Atomically attach enforcement fields to existing unenforced score entries and
 * mark their topic lines `*(enforced)*`. Returns the subset actually applied.
 */
export function applyEnforcementPromotions(
  cwd: string,
  items: readonly EnforcementPromotionInput[],
): EnforcementPromotionInput[] {
  if (items.length === 0) return [];
  const applied: EnforcementPromotionInput[] = [];

  mutateScores(cwd, (latestScores) => {
    for (const item of items) {
      const hash = entryHash(canonicalTopicLine({ category: item.category, text: item.text }));
      const entry = latestScores.entries[hash];
      if (!entry || hasEnforcementFields(entry)) continue;

      entry.trigger = item.trigger;
      entry.action = item.action;
      if (item.verifier) entry.verifier = item.verifier;
      entry.lifecycle = "active";
      applied.push(item);
    }
    if (applied.length === 0) return SKIP_MUTATE;
  });

  for (const item of applied) {
    markEntryEnforced(cwd, item.category, item.text);
  }
  if (applied.length > 0) {
    log.info("memory_enforcement_promotions_applied", { count: applied.length });
  }
  return applied;
}

// ── Provenance Merge Mutation ──────────────────────────────────────────────

/** Merge provenance metadata onto existing score entries in one locked RMW. */
export function applyEntryProvenance(
  cwd: string,
  items: readonly EntryProvenancePatch[],
): number {
  if (items.length === 0) return 0;
  let updated = 0;

  mutateScores(cwd, (scores) => {
    for (const item of items) {
      if (!item?.category || !item?.text) continue;
      const hash = entryHash(`- [${item.category}] ${item.text}`);
      const entry = scores.entries[hash];
      if (!entry) continue;

      if (item.sourceSession) entry.sourceSession = item.sourceSession;
      if (item.derivedFrom) entry.derivedFrom = item.derivedFrom;
      if (item.informs?.length) entry.informs = item.informs;
      updated += 1;
    }
    if (updated === 0) return SKIP_MUTATE;
  });

  log.debug("memory_provenance_applied", { updated });
  return updated;
}

// ── Dream Snapshot & Protected-Line Restore ────────────────────────────────

/**
 * Entries memory maintenance must never delete, whatever the prompt says:
 * pinned/enforced entries and lessons distilled from reviews (issue #1010).
 */
export function isProtectedTopicLine(line: string, reviewLessons: readonly string[]): boolean {
  if (!line.startsWith("- [")) return false;
  if (line.includes("*(pinned)*") || line.includes("*(enforced)*")) return true;
  const text = extractTopicLineText(line);
  return reviewLessons.some((lesson) => {
    const candidate = lesson.trim();
    return candidate.length > 0 && text === candidate;
  });
}

/** Snapshot every canonical memory topic file's lines so dream deletions can be audited. */
export function snapshotTopicLines(topicsDir: string): Record<string, string[]> {
  const before: Record<string, string[]> = {};
  for (const name of ALL_TOPIC_NAMES) {
    try {
      before[`${name}.md`] = readFileSync(join(topicsDir, `${name}.md`), "utf-8").split("\n");
    } catch {
      // Topic absent — nothing to protect.
    }
  }
  return before;
}

/**
 * Restore protected entries a dream removed at their original index and recreate
 * any topic file the dream deleted outright. Never trims over-cap topics; reports
 * them so callers can log/handle them. Never throws.
 */
export function restoreProtectedTopicLines(
  topicsDir: string,
  before: Record<string, string[]>,
  reviewLessons: readonly string[],
  removedByUser: (line: string) => boolean = () => false,
): TopicRestoreReport {
  const report: TopicRestoreReport = { restored: 0, failed: 0, overCapTopics: [] };
  for (const [file, beforeLines] of Object.entries(before)) {
    const filePath = join(topicsDir, file);
    let current: string[] | null = null;
    try {
      current = readFileSync(filePath, "utf-8").split("\n");
    } catch {
      current = null; // Deleted outright — rebuilt below from the snapshot.
    }
    const base = current ?? beforeLines.filter((line) => !line.startsWith("- ["));
    const surviving = new Set((current ?? []).map(canonicalizeTopicLine));
    const missing = beforeLines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => {
        if (!line.startsWith("- [") || !isProtectedTopicLine(line, reviewLessons)) return false;
        if (surviving.has(canonicalizeTopicLine(line))) return false;
        return !removedByUser(line);
      });
    if (missing.length === 0 && current !== null) continue;

    const merged = [...base];
    for (const { line, index } of missing) {
      merged.splice(Math.min(index, merged.length), 0, line);
      report.restored += 1;
    }

    const cap = topicCharCap(file.replace(/\.md$/, ""));
    if (merged.join("\n").length > cap) report.overCapTopics.push(file);

    try {
      writeTopicFile(filePath, merged.join("\n"));
    } catch {
      report.failed += 1;
      report.restored -= missing.length;
    }
  }
  return report;
}

// ── Expiry Pruning & Store Rebuild ─────────────────────────────────────────

/**
 * Remove entries whose expiresAt has passed: delete the topic line, score entry,
 * and embedding. Called from rebuildMemoryStore so session/task-scoped entries
 * cannot outlive their scope (issue #915).
 */
export function pruneExpiredEntries(cwd: string): number {
  const topicsDir = join(getProjectMemoryDir(cwd), "topics");
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

  const expiredEntries: { text: string; category: string }[] = [];
  for (const file of readdirSync(topicsDir).filter((f) => f.endsWith(".md"))) {
    const topicPath = join(topicsDir, file);
    const lines = readFileSync(topicPath, "utf-8").split("\n");
    const kept = lines.filter((l) => {
      const parsed = parseTopicLine(l);
      if (!parsed) return true;
      const hash = entryHash(canonicalTopicLine(parsed));
      if (!expiredHashes.has(hash)) return true;
      pruned++;
      expiredEntries.push({ text: parsed.text, category: parsed.category });
      return false;
    });
    if (kept.length !== lines.length) {
      const cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n");
      writeTopicFile(topicPath, cleaned);
    }
  }

  mutateScores(cwd, (s) => {
    for (const hash of expiredHashes) {
      delete s.entries[hash];
    }
  });
  removeEmbeddings(cwd, expiredEntries);
  if (pruned > 0) log.info("memory_prune_expired", pruned);
  return pruned;
}

/**
 * Full store maintenance cycle: prune expired scoped entries, rebuild scores from
 * topic files (source of truth), and prune stale embeddings.
 */
export function rebuildMemoryStore(cwd: string): void {
  const topicsDir = join(getProjectMemoryDir(cwd), "topics");
  if (!existsSync(topicsDir)) return;

  try {
    pruneExpiredEntries(cwd);
  } catch (err) {
    log.warn("memory_rebuild_prune_expired_failed", { reason: String((err as Error)?.message ?? err).slice(0, 120) });
  }

  const topicEntries = readAllTopicEntries(cwd);
  if (topicEntries.length > 0) {
    rebuild(cwd, topicEntries);
    try {
      pruneEmbeddings(cwd, topicEntries, () => readAllTopicEntries(cwd));
    } catch (err) {
      log.debug("memory_rebuild_prune_embeddings_failed", { reason: String((err as Error)?.message ?? err).slice(0, 120) });
    }
  }
}
