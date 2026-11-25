/**
 * Review state machine — tracks code review loop status.
 * State stored in `<worktree-root>/.pi/data/state.db` (`kv_state` key
 * `"pi-config-review-state"`, per-worktree, not shared).
 * Each worktree gets its own state DB via `getWorktreeStateDbPath` (`--show-toplevel`).
 * Used by enforcement to block git commit until all reviewers approve.
 *
 * Persistence: WAL-mode SQLite via `state-db.ts` (issue #1399) with atomic
 * `BEGIN IMMEDIATE` transactions. Legacy `pi-config-review-state.jsonl` / `.json`
 * files are auto-migrated once on first access.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getSetting } from "./project-settings.js";
import { createLogger } from "../shared/logger.js";
import {
  createSqliteStateStore,
  getWorktreeStateDbPath,
  SKIP_MUTATE,
  withTransaction,
  type SqliteStateStore,
} from "./state-db.js";
import { getHeadSha } from "./git-helpers.js";
import { getProjectRunDir, resolveWorktreeRoot } from "./utils.js";

const log = createLogger("pi-config-review-state");

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
  try { onTransitionCb({ ...state, reviewers_pending: [...state.reviewers_pending], reviewers_pending_at: { ...state.reviewers_pending_at } }); }
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
  /** When each pending reviewer was added (epoch ms). A result whose job started BEFORE
   *  this belongs to an older round and must not clear the entry. Absent for legacy state. */
  reviewers_pending_at: Record<string, number>;
  reviewers_total: number;
  findings_count: number;
  last_edit_at: string | null;
  /** Monotonic revision incremented on every markNeedsReview write (including repeated
   *  edits in the same millisecond that skip transition notification). */
  edit_seq?: number;
  last_clean_at: string | null;
  edited_during_cycle: boolean;
  tests_passed: boolean;
}

const REVIEW_STATE_STORE_KEY = "pi-config-review-state";
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

function getStore(cwd: string): SqliteStateStore<ReviewState> {
  const dir = getWorktreeDataDir(cwd);
  return createSqliteStateStore<ReviewState>(
    getWorktreeStateDbPath(cwd),
    REVIEW_STATE_STORE_KEY,
    {
      legacyFiles: [
        join(dir, STATE_FILE_JSONL),
        join(dir, LEGACY_STATE_FILE),
      ],
    },
  );
}

export function statePath(cwd: string): string {
  return getWorktreeStateDbPath(cwd);
}

function defaultState(): ReviewState {
  return {
    status: "none",
    cycle: 0,
    subject: null,
    subject_started_at: null,
    reviewers_pending: [],
    reviewers_pending_at: {},
    reviewers_total: 0,
    findings_count: 0,
    last_edit_at: null,
    edit_seq: 0,
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
    reviewers_pending_at: raw.reviewers_pending_at && typeof raw.reviewers_pending_at === "object" && !Array.isArray(raw.reviewers_pending_at)
      ? Object.fromEntries(Object.entries(raw.reviewers_pending_at).filter(([, v]) => typeof v === "number")) as Record<string, number>
      : {},
    reviewers_total: typeof raw.reviewers_total === "number" ? raw.reviewers_total : 0,
    findings_count: typeof raw.findings_count === "number" ? raw.findings_count : 0,
    last_edit_at: typeof raw.last_edit_at === "string" ? raw.last_edit_at : null,
    edit_seq: typeof raw.edit_seq === "number" && Number.isFinite(raw.edit_seq) ? raw.edit_seq : 0,
    last_clean_at: typeof raw.last_clean_at === "string" ? raw.last_clean_at : null,
    edited_during_cycle: raw.edited_during_cycle === true,
    tests_passed: raw.tests_passed === true,
  };
}

/** Worktree DB paths known to have active review tracking in this process.
 *  Paired with a durable marker under `<worktree-root>/.pi/run/review-tracked`
 *  (written/removed inside SQLite's `BEGIN IMMEDIATE` write lock so concurrent
 *  resets and transitions cannot race) so wiping `state.db` — even across process
 *  restarts — cannot silently reset review tracking to `status: "none"`. */
const trackedReviewWorktrees = new Set<string>();
/** Worktrees where writing the durable wipe-detection marker failed; fail closed
 *  even if a caller catches the transition error. */
const markerWriteFailedWorktrees = new Set<string>();

function reviewTrackedMarkerPath(cwd: string): string {
  return join(resolveWorktreeRoot(cwd), ".pi", "run", "review-tracked");
}

function hasDurableReviewMarker(cwd: string): boolean {
  try {
    return existsSync(reviewTrackedMarkerPath(cwd));
  } catch {
    return false;
  }
}

/** Write durable marker strictly — throws on failure so active review state is
 *  never committed without wipe evidence. Must be called inside SQLite's write lock. */
function writeDurableReviewMarkerStrict(cwd: string): void {
  const worktreeRoot = resolveWorktreeRoot(cwd);
  const runDir = getProjectRunDir(worktreeRoot);
  writeFileSync(join(runDir, "review-tracked"), "1\n", { encoding: "utf-8", mode: 0o600 });
}

/** Remove durable marker while holding SQLite's write lock (called only on explicit reset). */
function removeDurableReviewMarker(cwd: string): void {
  const markerPath = reviewTrackedMarkerPath(cwd);
  if (existsSync(markerPath)) unlinkSync(markerPath);
}

/** Strict read that distinguishes a missing row from corrupt JSON or DB errors.
 *  Throws on malformed payload, SQLite errors, or missing/unwritable durable marker
 *  for an active review state so commit gates fail closed. */
function readReviewStateStrict(cwd: string): { state: ReviewState; rowPresent: boolean } {
  const raw = getStore(cwd).readStrict();
  if (raw === null) return { state: defaultState(), rowPresent: false };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Corrupt review state payload: expected JSON object");
  }
  const state = normalizeRawState(raw);
  const dbKey = resolve(statePath(cwd));
  if (state.status !== "none") {
    trackedReviewWorktrees.add(dbKey);
    if (!hasDurableReviewMarker(cwd)) {
      // Backfill marker for pre-marker active rows inside the SQLite write lock so
      // a concurrent reset cannot race it, and throw if the marker cannot be persisted.
      withTransaction(statePath(cwd), () => {
        const latest = getStore(cwd).readStrict();
        if (latest && normalizeRawState(latest).status !== "none") {
          writeDurableReviewMarkerStrict(cwd);
        }
      });
    }
  }
  return { state, rowPresent: true };
}

/** Fail-soft read for UI/status hooks — logs and returns defaults if state.db is locked or corrupt. */
export function readReviewState(cwd: string): ReviewState {
  try {
    return readReviewStateStrict(cwd).state;
  } catch (err) {
    log.warn("review_state_read_failed", { cwd }, err);
    return defaultState();
  }
}

/** Execute an atomic read-modify-write inside SQLite `BEGIN IMMEDIATE`.
 *  Durable marker writes/removals execute INSIDE the same SQLite write lock so:
 *  - marker write failures roll back and fail closed (never commit unguarded active state),
 *  - concurrent resets and renewed tracking cannot interleave marker deletion after activation.
 *  Transition notifications fire after `COMMIT` succeeds. */
function mutateReviewState<T>(
  cwd: string,
  fn: (state: ReviewState) => { result: T; persist: boolean; notify: boolean },
): T {
  let outcome!: { result: T; persist: boolean; notify: boolean };
  let committedState: ReviewState | null = null;
  const dbKey = resolve(statePath(cwd));

  getStore(cwd).mutate((raw) => {
    const state = normalizeRawState(raw);
    outcome = fn(state);
    if (!outcome.persist) return SKIP_MUTATE;

    if (state.status !== "none") {
      try {
        writeDurableReviewMarkerStrict(cwd);
        markerWriteFailedWorktrees.delete(dbKey);
      } catch (err) {
        markerWriteFailedWorktrees.add(dbKey);
        log.error("review_tracked_marker_write_failed", { cwd }, err);
        throw err;
      }
    } else {
      try {
        removeDurableReviewMarker(cwd);
        markerWriteFailedWorktrees.delete(dbKey);
      } catch (err) {
        log.warn("review_tracked_marker_remove_failed", { cwd }, err);
      }
    }

    committedState = state;
    return state;
  }, defaultState());

  if (committedState !== null) {
    if ((committedState as ReviewState).status !== "none") {
      trackedReviewWorktrees.add(dbKey);
    } else {
      trackedReviewWorktrees.delete(dbKey);
    }
  }
  if (outcome.notify && committedState !== null) {
    notifyTransition(committedState);
  }
  return outcome.result;
}

/** Mark that files were edited — review is needed. Resets any previous CLEAN state.
 *  Does NOT reset during an active review cycle (in_progress) — edits during review
 *  are tracked via last_edit_at but don't wipe the pending reviewer list.
 *  The `cycle` counter is only reset on a fresh review start (status was "clean"
 *  or "none") — continuing from "has_findings"/"needs_review" preserves it so the
 *  max-cycles cap is reachable across fix-edit-review iterations. */
export function markNeedsReview(cwd: string): void {
  mutateReviewState(cwd, (state) => {
    const prevStatus = state.status;
    const prevTestsPassed = state.tests_passed;
    state.edit_seq = (state.edit_seq ?? 0) + 1;
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
      state.reviewers_pending_at = {};
      state.reviewers_total = 0;
      state.edited_during_cycle = false;
      state.tests_passed = false;
    }
    // Skip notification if nothing meaningful changed (e.g., repeated edits while already needs_review)
    const notify = state.status !== prevStatus || state.tests_passed !== prevTestsPassed;
    return { result: undefined, persist: true, notify };
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
  mutateReviewState(cwd, (state) => {
    if (!state.reviewers_pending.includes(reviewerName)) {
      state.reviewers_pending.push(reviewerName);
      state.reviewers_pending_at[reviewerName] = Date.now();
      state.reviewers_total = Math.max(state.reviewers_total, state.reviewers_pending.length);
    }
    const key = subjectKey(subject);
    const previousKey = state.subject ? subjectKey(state.subject) : null;
    const subjectChanged = previousKey !== key;
    const startsRound = subjectChanged || state.status !== "in_progress";
    if (subjectChanged) {
      // A new subject is a new loop — even while a reviewer for the previous subject is still
      // pending: keeping the old subject would attribute this round to the wrong loop.
      state.subject = subject;
      state.cycle = 1;
      state.subject_started_at = new Date().toISOString();
    } else if (state.status !== "in_progress") {
      state.cycle++;
    }
    if (startsRound) {
      // A round begins: findings and edit flags belong to it, not to the round before.
      state.findings_count = 0;
      state.edited_during_cycle = false;
    }
    state.status = "in_progress";
    log.debug("review_round_start", { reviewer: reviewerName, subject: key, cycle: state.cycle, subjectChanged, previousSubject: previousKey });
    return { result: undefined, persist: true, notify: true };
  });
}

/** Record a reviewer's result. Idempotent — skips if reviewer already reported. Returns true if all reviewers have reported.
 *  `since` (the job's startedAt) rejects a result older than the pending entry it would clear:
 *  a late result from a previous round must not approve the round running now. */
export function recordReviewerResult(cwd: string, reviewerName: string, findingsCount: number, opts?: { since?: number }): boolean {
  return mutateReviewState(cwd, (state) => {
    const pendingSince = state.reviewers_pending_at[reviewerName];
    if (opts?.since !== undefined && pendingSince !== undefined && pendingSince > opts.since) {
      // This round registered the reviewer AFTER the job that produced the result started.
      log.warn("reviewer_result_stale", { agent: reviewerName, pending_added_at: pendingSince, job_started_at: opts.since });
      return { result: state.reviewers_pending.length === 0, persist: false, notify: false };
    }
    if (!state.reviewers_pending.includes(reviewerName)) {
      return { result: state.reviewers_pending.length === 0, persist: false, notify: false };
    }
    state.reviewers_pending = state.reviewers_pending.filter(n => n !== reviewerName);
    delete state.reviewers_pending_at[reviewerName];
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
    return { result: state.reviewers_pending.length === 0, persist: true, notify: true };
  });
}

/** Check if the review state is clean (all reviewers approved, no edits since).
 *  Fails closed (returns false) if reading state.db throws, payload is malformed,
 *  or a previously tracked worktree's DB row was wiped mid-session. */
export function isReviewClean(cwd: string): boolean {
  let state: ReviewState;
  let rowPresent: boolean;
  try {
    ({ state, rowPresent } = readReviewStateStrict(cwd));
  } catch (err) {
    log.error("review_clean_check_read_failed", { cwd }, err);
    return false;
  }
  const dbKey = resolve(statePath(cwd));
  if (markerWriteFailedWorktrees.has(dbKey)) {
    log.error("review_clean_check_marker_unavailable", { cwd });
    return false;
  }
  if (!rowPresent && (trackedReviewWorktrees.has(dbKey) || hasDurableReviewMarker(cwd))) {
    log.error("review_clean_check_state_wiped", { cwd });
    return false;
  }
  if (state.status === "none") return true; // No tracking active — nothing to enforce
  if (state.status !== "clean") return false;
  if (!state.tests_passed) return false;
  return true;
}

/** True when the stored subject is the one this worktree is reviewing now. A subject that carries a
 *  commit must match HEAD; a plan or issue is not tied to a commit and is only replaced by a caller
 *  naming a new one. Unknown HEAD answers false, so the cap never applies on a guess. */
function subjectIsCurrent(cwd: string, subject: ReviewSubject | null): boolean {
  if (!subject) return true; // legacy state: nothing to compare, keep the historical behaviour
  // ONLY a review of a commit can exhaust the commit cap. A plan, an issue, or an `other` subject
  // (including the `unresolved:` fallback written when HEAD cannot be read) never licensed a
  // commit — treating them as current let such a round's count authorize unreviewed code.
  if (subject.kind !== "pr" && subject.kind !== "local") return false;
  const head = getHeadSha(cwd);
  return head !== null && subject.head_sha === head;
}

/** Check if commit is allowed — clean review, no tracking, or max cycles exhausted FOR THIS
 *  SUBJECT. Fails closed (returns false) when reading state.db fails, payload is corrupt,
 *  or a previously tracked worktree's DB row was wiped mid-session. */
export function isCommitAllowed(cwd: string): boolean {
  let state: ReviewState;
  let rowPresent: boolean;
  try {
    ({ state, rowPresent } = readReviewStateStrict(cwd));
  } catch (err) {
    log.error("commit_gate_review_state_read_failed", { cwd }, err);
    return false;
  }
  const dbKey = resolve(statePath(cwd));
  if (markerWriteFailedWorktrees.has(dbKey)) {
    log.error("commit_gate_marker_unavailable", { cwd });
    return false;
  }
  if (!rowPresent && (trackedReviewWorktrees.has(dbKey) || hasDurableReviewMarker(cwd))) {
    log.error("commit_gate_review_state_wiped", { cwd });
    return false;
  }
  if (state.status === "none") return true;
  if (state.status === "clean" && state.tests_passed) return true;
  // Allow commit when max review cycles exhausted — cap reached, no reviewers running
  if ((state.status === "has_findings" || state.status === "clean" || state.status === "needs_review") && state.reviewers_pending.length === 0) {
    const maxCycles = getSetting(cwd, "review_loop_max_cycles");
    if (state.cycle >= maxCycles && subjectIsCurrent(cwd, state.subject)) return true;
  }
  return false;
}

/** Mark that tests have passed. Only meaningful when review status is being tracked. */
export function markTestsPassed(cwd: string): void {
  mutateReviewState(cwd, (state) => {
    if (state.status === "none") return { result: undefined, persist: false, notify: false };
    state.tests_passed = true;
    return { result: undefined, persist: true, notify: true };
  });
}

/** Mark that tests have failed. No-op when review status is not being tracked.
 *  Called when a detected test command exits non-zero.
 *  Resets to false on any file edit via markNeedsReview(). */
export function markTestsFailed(cwd: string): void {
  mutateReviewState(cwd, (state) => {
    if (state.status === "none") return { result: undefined, persist: false, notify: false };
    state.tests_passed = false;
    return { result: undefined, persist: true, notify: true };
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

/** Reset review state — for testing or manual override.
 *  Preserves monotonic `edit_seq` so concurrent pollers never see an ABA revision collision. */
export function resetReviewState(cwd: string): void {
  mutateReviewState(cwd, (prev) => {
    const next: ReviewState = { ...defaultState(), edit_seq: prev.edit_seq ?? 0 };
    Object.assign(prev, next);
    return { result: undefined, persist: true, notify: true };
  });
}
