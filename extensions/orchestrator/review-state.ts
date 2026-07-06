/**
 * Review state machine — tracks code review loop status.
 * State stored in .pi/data/review-state.json.
 * Used by enforcement to block git commit until all reviewers approve.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveRepoRoot } from "./utils.js";

const DATA_DIR = ".pi/data";

export interface ReviewState {
  status: "none" | "needs_review" | "in_progress" | "has_findings" | "clean";
  cycle: number;
  reviewers_pending: string[];
  reviewers_total: number;
  findings_count: number;
  last_edit_at: string | null;
  last_clean_at: string | null;
  edited_during_cycle: boolean;
}

const STATE_FILE = "review-state.json";

function statePath(cwd: string): string {
  const dataDir = join(resolveRepoRoot(cwd), DATA_DIR);
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, STATE_FILE);
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
    };
  } catch (e: any) {
    console.debug("[review-state] failed to parse state:", e?.message);
    return defaultState();
  }
}

function writeState(cwd: string, state: ReviewState): void {
  const p = statePath(cwd);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(state, null, 2) + "\n");
  } catch (e: any) {
    console.debug("[review-state] write failed:", e?.message);
  }
}

/** Mark that files were edited — review is needed. Resets any previous CLEAN state.
 *  Does NOT reset during an active review cycle (in_progress) — edits during review
 *  are tracked via last_edit_at but don't wipe the pending reviewer list. */
export function markNeedsReview(cwd: string): void {
  const state = readReviewState(cwd);
  if (state.status === "in_progress") {
    // Edits during an active review cycle — mark dirty so the cycle
    // won't be considered clean even if all reviewers return 0 findings.
    state.last_edit_at = new Date().toISOString();
    state.edited_during_cycle = true;
    writeState(cwd, state);
    return;
  }
  state.status = "needs_review";
  state.last_edit_at = new Date().toISOString();
  state.cycle = 0;
  state.findings_count = 0;
  state.reviewers_pending = [];
  state.reviewers_total = 0;
  state.edited_during_cycle = false;
  writeState(cwd, state);
}

/** Add a single reviewer to the pending list. Sets status to in_progress if not already. */
export function addReviewerPending(cwd: string, reviewerName: string): void {
  const state = readReviewState(cwd);
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
}

/** Record a reviewer's result. Idempotent — skips if reviewer already reported. Returns true if all reviewers have reported. */
export function recordReviewerResult(cwd: string, reviewerName: string, findingsCount: number): boolean {
  const state = readReviewState(cwd);
  if (!state.reviewers_pending.includes(reviewerName)) {
    // Already reported (zombie race, duplicate delivery) — skip to avoid double-counting
    return state.reviewers_pending.length === 0;
  }
  state.reviewers_pending = state.reviewers_pending.filter(n => n !== reviewerName);
  state.findings_count += findingsCount;
  if (state.reviewers_pending.length === 0) {
    // All reviewers reported — only transition to clean if status is still in_progress
    // (an edit during the cycle would have set last_edit_at but kept status as in_progress)
    if (state.status === "in_progress") {
      if (state.edited_during_cycle) {
        // Edits happened during this cycle — reviewers didn't see them
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
  return state.reviewers_pending.length === 0;
}

/** Check if the review state is clean (all reviewers approved, no edits since). */
export function isReviewClean(cwd: string): boolean {
  const state = readReviewState(cwd);
  if (state.status === "none") return true; // No tracking active — nothing to enforce
  if (state.status !== "clean") return false;
  return true;
}

/** Count findings in reviewer output by matching severity markers at line start. */
export function countFindings(output: string): number {
  const criticals = (output.match(/^\[CRITICAL\]/gm) || []).length;
  const warnings = (output.match(/^\[WARNING\]/gm) || []).length;
  const suggestions = (output.match(/^\[SUGGESTION\]/gm) || []).length;
  return criticals + warnings + suggestions;
}

/** Reset review state — for testing or manual override. */
export function resetReviewState(cwd: string): void {
  writeState(cwd, defaultState());
}
