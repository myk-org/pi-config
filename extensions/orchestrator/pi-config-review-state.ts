/**
 * Review state machine — tracks code review loop status.
 * State stored in <worktree-root>/.pi/data/pi-config-review-state.jsonl (per-worktree, not shared).
 * Each worktree gets its own state file via resolveWorktreeRoot (--show-toplevel).
 * Used by enforcement to block git commit until all reviewers approve.
 *
 * Persistence: append-only JSONL via JsonlStateStore (issue #724).
 * Each state mutation appends a single JSON line. The latest valid line
 * is the current state. Auto-compaction prevents unbounded growth.
 * On first access, migrates any legacy pi-config-review-state.json automatically.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getSetting } from "./project-settings.js";
import { createCachedStore } from "./state-jsonl.js";
import type { JsonlStateStore } from "./state-jsonl.js";
import { resolveWorktreeRoot } from "./utils.js";

type StateTransitionCallback = (state: ReviewState) => void;
let onTransitionCb: StateTransitionCallback | null = null;

/** Register a callback to be notified on review state transitions.
 *  Only one callback is supported — subsequent calls replace the previous one. */
export function onStateTransition(cb: StateTransitionCallback): void {
  onTransitionCb = cb;
}

/** Fire-and-forget state transition notification. Never throws. */
function notifyTransition(state: ReviewState): void {
  if (!onTransitionCb) return;
  try { onTransitionCb({ ...state, reviewers_pending: [...state.reviewers_pending] }); }
  catch { /* transition callback failed — fire-and-forget, never propagate */ }
}

/** What a review loop is looking at. Four known shapes plus an escape hatch, so a new review
 *  type is recorded instead of being blocked by the schema. */
export type ReviewSubject =
  | { kind: "pr"; repo: string; number: number; head_sha: string }
  | { kind: "issue"; repo: string; number: number }
  | { kind: "local"; head_sha: string }
  | { kind: "plan"; path: string }
  | { kind: "other"; id: string };

/** Stable identity of a subject — what the cycle counter resets against. Kept as one string so
 *  the JSONL stays greppable and two shapes can never both claim the same loop. */
export function subjectKey(subject: ReviewSubject): string {
  switch (subject.kind) {
    case "pr": return `pr:${subject.repo}#${subject.number}@${subject.head_sha}`;
    case "issue": return `issue:${subject.repo}#${subject.number}`;
    case "local": return `local:${subject.head_sha}`;
    case "plan": return `plan:${subject.path}`;
    case "other": return `other:${subject.id}`;
  }
}

/** Short human label for the status line: `PR #1054 @ 75098f6`, `commit cfb1222 (local)`. */
export function subjectLabel(subject: ReviewSubject | null): string {
  if (!subject) return "no subject";
  switch (subject.kind) {
    case "pr": return `PR #${subject.number} @ ${subject.head_sha.slice(0, 7)}`;
    case "issue": return `issue #${subject.number}`;
    case "local": return `commit ${subject.head_sha.slice(0, 7)} (local)`;
    case "plan": return `plan ${subject.path}`;
    case "other": return subject.id;
  }
}

export interface ReviewState {
  status: "none" | "needs_review" | "in_progress" | "has_findings" | "clean";
  cycle: number;
  /** What this loop reviews; `null` on state written before the field existed. */
  subject: ReviewSubject | null;
  /** When the current subject's cycle counting began. */
  subject_started_at: string | null;
  reviewers_pending: string[];
  reviewers_total: number;
  findings_count: number;
  last_edit_at: string | null;
  last_clean_at: string | null;
  edited_during_cycle: boolean;
  tests_passed: boolean;
}

const STATE_FILE_JSONL = "pi-config-review-state.jsonl";
const LEGACY_STATE_FILE = "pi-config-review-state.json";

/** Per-worktree data dir — deliberately NOT the shared getProjectDataDir:
 *  review state must stay per-worktree (one review loop per issue branch),
 *  so it joins the worktree root directly (issue #918 kept this per-cwd). */
function getWorktreeDataDir(cwd: string): string {
  const dir = join(resolveWorktreeRoot(cwd), ".pi", "data");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function getStore(cwd: string): JsonlStateStore<ReviewState> {
  return createCachedStore<ReviewState>(getWorktreeDataDir(cwd), STATE_FILE_JSONL, LEGACY_STATE_FILE);
}

export function statePath(cwd: string): string {
  return join(getWorktreeDataDir(cwd), STATE_FILE_JSONL);
}

function defaultState(): ReviewState {
  return {
    status: "none",
    cycle: 0,
    subject: null,
    subject_started_at: null,
    reviewers_pending: [],
    reviewers_total: 0,
    findings_count: 0,
    last_edit_at: null,
    last_clean_at: null,
    edited_during_cycle: false,
    tests_passed: false,
  };
}

/** Read a stored subject, rejecting anything that is not one of the known shapes (a hand-edited
 *  or older file must not crash the counter — it simply counts as "no subject"). */
function normalizeSubject(raw: any): ReviewSubject | null {
  if (!raw || typeof raw !== "object") return null;
  const str = (value: any) => (typeof value === "string" && value ? value : null);
  switch (raw.kind) {
    case "pr": {
      const repo = str(raw.repo), head = str(raw.head_sha);
      return repo && head && typeof raw.number === "number" ? { kind: "pr", repo, number: raw.number, head_sha: head } : null;
    }
    case "issue": {
      const repo = str(raw.repo);
      return repo && typeof raw.number === "number" ? { kind: "issue", repo, number: raw.number } : null;
    }
    case "local": {
      const head = str(raw.head_sha);
      return head ? { kind: "local", head_sha: head } : null;
    }
    case "plan": {
      const file = str(raw.path);
      return file ? { kind: "plan", path: file } : null;
    }
    case "other": {
      const id = str(raw.id);
      return id ? { kind: "other", id } : null;
    }
    default: return null;
  }
}

/** Normalize a raw parsed object into a valid ReviewState with defaults for missing fields. */
function normalizeRawState(raw: any): ReviewState {
  return {
    status: raw.status ?? "none",
    cycle: typeof raw.cycle === "number" ? raw.cycle : 0,
    subject: normalizeSubject(raw.subject),
    subject_started_at: typeof raw.subject_started_at === "string" ? raw.subject_started_at : null,
    reviewers_pending: Array.isArray(raw.reviewers_pending) ? raw.reviewers_pending : [],
    reviewers_total: typeof raw.reviewers_total === "number" ? raw.reviewers_total : 0,
    findings_count: typeof raw.findings_count === "number" ? raw.findings_count : 0,
    last_edit_at: typeof raw.last_edit_at === "string" ? raw.last_edit_at : null,
    last_clean_at: typeof raw.last_clean_at === "string" ? raw.last_clean_at : null,
    edited_during_cycle: raw.edited_during_cycle === true,
    tests_passed: raw.tests_passed === true,
  };
}

export function readReviewState(cwd: string): ReviewState {
  const store = getStore(cwd);
  const raw = store.read();
  if (raw === null) return defaultState();
  try {
    return normalizeRawState(raw);
  } catch {
    // failed to parse state — return defaults
    return defaultState();
  }
}

function lockPath(cwd: string): string {
  // Lock file sits next to the JSONL state file
  return statePath(cwd) + ".lock";
}

function acquireLock(cwd: string): boolean {
  const lock = lockPath(cwd);
  const maxRetries = 100;
  for (let i = 0; i < maxRetries; i++) {
    try {
      getWorktreeDataDir(cwd);
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      // Lock exists — check if holder is alive
      try {
        const pid = parseInt(readFileSync(lock, "utf-8").trim(), 10);
        // Reentrant: safe because Node.js is single-threaded — nested
        // withStateLock calls within the same process can't interleave.
        if (pid === process.pid) return true;
        if (pid) {
          try { process.kill(pid, 0); } catch {
            // Holder is dead — steal lock
            try { unlinkSync(lock); } catch { /* race */ }
            continue;
          }
        }
      } catch {
        // Corrupt lock — remove and retry
        try { unlinkSync(lock); } catch { /* race */ }
        continue;
      }
      // Holder is alive — bounded tight spin (100 iterations ≈ instant, sub-ms)
    }
  }
  return false;
}

function releaseLock(cwd: string): void {
  try { unlinkSync(lockPath(cwd)); } catch { /* ignore */ }
}

function writeState(cwd: string, state: ReviewState): void {
  try {
    const store = getStore(cwd);
    store.write(state);
  } catch {
    // write failed — non-fatal, state file may be stale
  }
}

const lockDepth = new Map<string, number>();

/** Execute a read-modify-write operation on the state file with a lock.
 *  Throws if lock cannot be acquired (never proceeds without mutual exclusion). */
function withStateLock<T>(cwd: string, fn: (state: ReviewState) => T): T {
  const key = statePath(cwd);
  const depth = lockDepth.get(key) || 0;
  if (depth === 0) {
    if (!acquireLock(cwd)) {
      throw new Error("[pi-config-review-state] failed to acquire lock — aborting to prevent state corruption");
    }
  }
  lockDepth.set(key, depth + 1);
  try {
    return fn(readReviewState(cwd));
  } finally {
    const newDepth = (lockDepth.get(key) || 1) - 1;
    if (newDepth <= 0) {
      lockDepth.delete(key);
      releaseLock(cwd);
    } else {
      lockDepth.set(key, newDepth);
    }
  }
}

/** Mark that files were edited — review is needed. Resets any previous CLEAN state.
 *  Does NOT reset during an active review cycle (in_progress) — edits during review
 *  are tracked via last_edit_at but don't wipe the pending reviewer list.
 *  The `cycle` counter is only reset on a fresh review start (status was "clean"
 *  or "none") — continuing from "has_findings"/"needs_review" preserves it so the
 *  max-cycles cap is reachable across fix-edit-review iterations. */
export function markNeedsReview(cwd: string): void {
  withStateLock(cwd, (state) => {
    const prevStatus = state.status;
    const prevTestsPassed = state.tests_passed;
    if (state.status === "in_progress") {
      state.last_edit_at = new Date().toISOString();
      state.edited_during_cycle = true;
      state.tests_passed = false;
    } else {
      // Only a fresh review start (clean or no tracking yet) resets the cycle
      // counter. Continuing from has_findings/needs_review (fix-edit-review loop)
      // must preserve cycle so the max-cycles cap can actually be reached.
      const isFreshStart = state.status === "clean" || state.status === "none";
      state.status = "needs_review";
      state.last_edit_at = new Date().toISOString();
      if (isFreshStart) {
        state.cycle = 0;
      }
      state.findings_count = 0;
      state.reviewers_pending = [];
      state.reviewers_total = 0;
      state.edited_during_cycle = false;
      state.tests_passed = false;
    }
    writeState(cwd, state);
    // Skip notification if nothing meaningful changed (e.g., repeated edits while already needs_review)
    if (state.status !== prevStatus || state.tests_passed !== prevTestsPassed) {
      notifyTransition(state);
    }
  });
}

/** Start a review round: record a pending reviewer AND the subject under review.
 *
 *  `subject` is REQUIRED — a loop that cannot name what it reviews counts rounds for nothing,
 *  which is how one worktree accumulated "cycle 46" across unrelated PRs. The first reviewer of a
 *  round increments `cycle`; a DIFFERENT subject (another PR, commit, issue or plan file) starts
 *  that subject's counting at 1. Passing null throws rather than silently miscounting. */
export function addReviewerPending(cwd: string, reviewerName: string, subject: ReviewSubject): void {
  if (!subject || typeof subject !== "object") {
    throw new Error("[pi-config-review-state] addReviewerPending requires the review subject");
  }
  withStateLock(cwd, (state) => {
    if (!state.reviewers_pending.includes(reviewerName)) {
      state.reviewers_pending.push(reviewerName);
      state.reviewers_total = Math.max(state.reviewers_total, state.reviewers_pending.length);
    }
    const key = subjectKey(subject);
    const previousKey = state.subject ? subjectKey(state.subject) : null;
    if (state.status !== "in_progress") {
      state.status = "in_progress";
      if (previousKey !== key) {
        // A new subject is a new loop: this is its first round, not a continuation.
        state.cycle = 1;
        state.subject = subject;
        state.subject_started_at = new Date().toISOString();
        state.findings_count = 0;
      } else {
        state.cycle++;
      }
      state.findings_count = 0;
      state.edited_during_cycle = false;
    }
    writeState(cwd, state);
    notifyTransition(state);
  });
}

/** Record a reviewer's result. Idempotent — skips if reviewer already reported. Returns true if all reviewers have reported. */
export function recordReviewerResult(cwd: string, reviewerName: string, findingsCount: number): boolean {
  return withStateLock(cwd, (state) => {
    if (!state.reviewers_pending.includes(reviewerName)) {
      return state.reviewers_pending.length === 0;
    }
    state.reviewers_pending = state.reviewers_pending.filter(n => n !== reviewerName);
    state.findings_count += findingsCount;
    if (state.reviewers_pending.length === 0) {
      if (state.status === "in_progress") {
        if (state.edited_during_cycle) {
          state.status = "needs_review";
        } else {
          state.status = state.findings_count > 0 ? "has_findings" : "clean";
          if (state.status === "clean") {
            state.last_clean_at = new Date().toISOString();
          }
        }
      }
    }
    writeState(cwd, state);
    notifyTransition(state);
    return state.reviewers_pending.length === 0;
  });
}

/** Check if the review state is clean (all reviewers approved, no edits since). */
export function isReviewClean(cwd: string): boolean {
  const state = readReviewState(cwd);
  if (state.status === "none") return true; // No tracking active — nothing to enforce
  if (state.status !== "clean") return false;
  if (!state.tests_passed) return false;
  return true;
}

/** HEAD of the worktree, or null when it cannot be read (not a repo, git missing). */
function currentHeadSha(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** True when the stored subject is the one this worktree is reviewing now. A subject that carries a
 *  commit must match HEAD; a plan or issue is not tied to a commit and is only replaced by a caller
 *  naming a new one. Unknown HEAD answers false, so the cap never applies on a guess. */
function subjectIsCurrent(cwd: string, subject: ReviewSubject | null): boolean {
  if (!subject) return true; // legacy state: nothing to compare, keep the historical behaviour
  if (subject.kind === "plan" || subject.kind === "issue" || subject.kind === "other") return true;
  const head = currentHeadSha(cwd);
  return head !== null && subject.head_sha === head;
}

/** Check if commit is allowed — clean review, no tracking, or max cycles exhausted FOR THIS
 *  SUBJECT. Without the subject check, an exhausted cap from an earlier loop licensed commits on
 *  new work that had never been reviewed. */
export function isCommitAllowed(cwd: string): boolean {
  if (isReviewClean(cwd)) return true;
  const state = readReviewState(cwd);
  // Allow commit when max review cycles exhausted — cap reached, no reviewers running
  if ((state.status === "has_findings" || state.status === "clean" || state.status === "needs_review") && state.reviewers_pending.length === 0) {
    const maxCycles = getSetting(cwd, "review_loop_max_cycles");
    if (state.cycle >= maxCycles && subjectIsCurrent(cwd, state.subject)) return true;
  }
  return false;
}

/** Mark that tests have passed. Only meaningful when review status is being tracked. */
export function markTestsPassed(cwd: string): void {
  withStateLock(cwd, (state) => {
    if (state.status === "none") return; // No tracking active
    state.tests_passed = true;
    writeState(cwd, state);
    notifyTransition(state);
  });
}

/** Mark that tests have failed. No-op when review status is not being tracked.
 *  Called when a detected test command exits non-zero.
 *  Resets to false on any file edit via markNeedsReview(). */
export function markTestsFailed(cwd: string): void {
  withStateLock(cwd, (state) => {
    if (state.status === "none") return; // No tracking active
    state.tests_passed = false;
    writeState(cwd, state);
    notifyTransition(state);
  });
}

/** Count findings in reviewer output by parsing JSON.
 *  Returns the number of findings, or -1 if the output is not valid JSON with a findings array. */
export function countFindings(output: string): number {
  // Try JSON parse — reviewers return {"findings": [...]}
  try {
    // Strip markdown code fences if present
    let cleaned = output.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }
    const parsed = JSON.parse(cleaned);
    if (parsed && Array.isArray(parsed.findings)) {
      return parsed.findings.length;
    }
  } catch { /* not valid JSON — return -1 */ }
  return -1;
}

/** Reset review state — for testing or manual override. */
export function resetReviewState(cwd: string): void {
  withStateLock(cwd, () => {
    writeState(cwd, defaultState());
    notifyTransition(defaultState());
  });
}
