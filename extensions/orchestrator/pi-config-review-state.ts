/**
 * Review state machine — tracks code review loop status.
 * State stored in <worktree-root>/.pi/data/pi-config-review-state.json (per-worktree, not shared).
 * Each worktree gets its own state file via resolveWorktreeRoot (--show-toplevel).
 * Used by enforcement to block git commit until all reviewers approve.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getSetting } from "./project-settings.js";
import { resolveWorktreeRoot, getProjectDataDir } from "./utils.js";

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
  catch (e: any) { console.debug("[pi-config-review-state] transition callback failed:", e?.message); }
}

export interface ReviewState {
  status: "none" | "needs_review" | "in_progress" | "has_findings" | "clean";
  cycle: number;
  reviewers_pending: string[];
  reviewers_total: number;
  findings_count: number;
  last_edit_at: string | null;
  last_clean_at: string | null;
  edited_during_cycle: boolean;
  tests_passed: boolean;
}

const STATE_FILE = "pi-config-review-state.json";

export function statePath(cwd: string): string {
  return join(getProjectDataDir(resolveWorktreeRoot(cwd)), STATE_FILE);
}

function ensureDataDir(cwd: string): void {
  getProjectDataDir(resolveWorktreeRoot(cwd));
}

function defaultState(): ReviewState {
  return {
    status: "none",
    cycle: 0,
    reviewers_pending: [],
    reviewers_total: 0,
    findings_count: 0,
    last_edit_at: null,
    last_clean_at: null,
    edited_during_cycle: false,
    tests_passed: false,
  };
}

export function readReviewState(cwd: string): ReviewState {
  const p = statePath(cwd);
  if (!existsSync(p)) return defaultState();
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    return {
      status: raw.status ?? "none",
      cycle: typeof raw.cycle === "number" ? raw.cycle : 0,
      reviewers_pending: Array.isArray(raw.reviewers_pending) ? raw.reviewers_pending : [],
      reviewers_total: typeof raw.reviewers_total === "number" ? raw.reviewers_total : 0,
      findings_count: typeof raw.findings_count === "number" ? raw.findings_count : 0,
      last_edit_at: typeof raw.last_edit_at === "string" ? raw.last_edit_at : null,
      last_clean_at: typeof raw.last_clean_at === "string" ? raw.last_clean_at : null,
      edited_during_cycle: raw.edited_during_cycle === true,
      tests_passed: raw.tests_passed === true,
    };
  } catch (e: any) {
    console.debug("[pi-config-review-state] failed to parse state:", e?.message);
    return defaultState();
  }
}

function lockPath(cwd: string): string {
  return statePath(cwd) + ".lock";
}

function acquireLock(cwd: string): boolean {
  const lock = lockPath(cwd);
  const maxRetries = 100;
  for (let i = 0; i < maxRetries; i++) {
    try {
      ensureDataDir(cwd);
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
  const p = statePath(cwd);
  try {
    ensureDataDir(cwd);
    // Atomic write: temp file + rename
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
    renameSync(tmp, p);
  } catch (e: any) {
    console.debug("[pi-config-review-state] write failed:", e?.message);
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

/** Add a single reviewer to the pending list. Sets status to in_progress if not already. */
export function addReviewerPending(cwd: string, reviewerName: string): void {
  withStateLock(cwd, (state) => {
    if (!state.reviewers_pending.includes(reviewerName)) {
      state.reviewers_pending.push(reviewerName);
      state.reviewers_total = Math.max(state.reviewers_total, state.reviewers_pending.length);
    }
    if (state.status !== "in_progress") {
      state.status = "in_progress";
      state.cycle++;
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

/** Check if commit is allowed — clean review, no tracking, or max cycles exhausted. */
export function isCommitAllowed(cwd: string): boolean {
  if (isReviewClean(cwd)) return true;
  const state = readReviewState(cwd);
  // Allow commit when max review cycles exhausted — cap reached, no reviewers running
  if ((state.status === "has_findings" || state.status === "clean" || state.status === "needs_review") && state.reviewers_pending.length === 0) {
    const maxCycles = getSetting(cwd, "review_loop_max_cycles");
    if (state.cycle >= maxCycles) return true;
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
 *  Called when a detected test command exits non-zero, or test-automator/test-runner agent fails.
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
