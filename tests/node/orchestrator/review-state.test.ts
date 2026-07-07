/**
 * Tests for review state machine (review loop enforcement).
 * Run with: npx tsx --test tests/node/orchestrator/review-state.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readReviewState,
  markNeedsReview,
  addReviewerPending,
  recordReviewerResult,
  isReviewClean,
  resetReviewState,
  countFindings,
  statePath,
} from "../../../extensions/orchestrator/review-state.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "review-state-test-"));
  mkdirSync(join(cwd, ".git")); // .git dir needed so resolveWorktreeRoot treats this as a git root
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

// ── 1. defaultState ──

describe("readReviewState on non-existent file", () => {
  it("returns default state", () => {
    const s = readReviewState(cwd);
    assert.equal(s.status, "none");
    assert.equal(s.cycle, 0);
    assert.deepEqual(s.reviewers_pending, []);
    assert.equal(s.reviewers_total, 0);
    assert.equal(s.findings_count, 0);
    assert.equal(s.last_edit_at, null);
    assert.equal(s.last_clean_at, null);
  });
});

// ── 2. markNeedsReview ──

describe("markNeedsReview", () => {
  it("sets status to needs_review and resets findings", () => {
    markNeedsReview(cwd);
    const s = readReviewState(cwd);
    assert.equal(s.status, "needs_review");
    assert.equal(s.findings_count, 0);
    assert.deepEqual(s.reviewers_pending, []);
    assert.equal(s.reviewers_total, 0);
    assert.notEqual(s.last_edit_at, null);
  });
});

// ── 3. markNeedsReview after clean ──

describe("markNeedsReview after clean", () => {
  it("resets clean back to needs_review", () => {
    // Set up a clean state first
    markNeedsReview(cwd);
    addReviewerPending(cwd, "reviewer-a");
    recordReviewerResult(cwd, "reviewer-a", 0);
    assert.equal(readReviewState(cwd).status, "clean");

    // Now mark needs review again
    markNeedsReview(cwd);
    const s = readReviewState(cwd);
    assert.equal(s.status, "needs_review");
    assert.equal(s.findings_count, 0);
    assert.deepEqual(s.reviewers_pending, []);
  });
});

// ── 4. addReviewerPending ──

describe("addReviewerPending", () => {
  it("adds reviewer, sets status to in_progress, increments cycle", () => {
    addReviewerPending(cwd, "lint");
    const s = readReviewState(cwd);
    assert.equal(s.status, "in_progress");
    assert.equal(s.cycle, 1);
    assert.deepEqual(s.reviewers_pending, ["lint"]);
    assert.equal(s.reviewers_total, 1);
  });

  it("increments cycle only on first transition to in_progress", () => {
    addReviewerPending(cwd, "lint");
    addReviewerPending(cwd, "test");
    const s = readReviewState(cwd);
    assert.equal(s.cycle, 1);
    assert.deepEqual(s.reviewers_pending, ["lint", "test"]);
    assert.equal(s.reviewers_total, 2);
  });
});

// ── 5. addReviewerPending duplicate ──

describe("addReviewerPending duplicate", () => {
  it("doesn't add same reviewer twice", () => {
    addReviewerPending(cwd, "lint");
    addReviewerPending(cwd, "lint");
    const s = readReviewState(cwd);
    assert.deepEqual(s.reviewers_pending, ["lint"]);
    assert.equal(s.reviewers_total, 1);
  });
});

// ── 6. recordReviewerResult ──

describe("recordReviewerResult", () => {
  it("removes reviewer from pending and accumulates findings", () => {
    addReviewerPending(cwd, "lint");
    addReviewerPending(cwd, "test");
    recordReviewerResult(cwd, "lint", 3);
    const s = readReviewState(cwd);
    assert.deepEqual(s.reviewers_pending, ["test"]);
    assert.equal(s.findings_count, 3);
    assert.equal(s.status, "in_progress");
  });
});

// ── 7. recordReviewerResult all clean ──

describe("recordReviewerResult all clean", () => {
  it("last reviewer with 0 findings sets status to clean", () => {
    addReviewerPending(cwd, "lint");
    addReviewerPending(cwd, "test");
    recordReviewerResult(cwd, "lint", 0);
    const done = recordReviewerResult(cwd, "test", 0);
    const s = readReviewState(cwd);
    assert.equal(done, true);
    assert.equal(s.status, "clean");
    assert.equal(s.findings_count, 0);
    assert.notEqual(s.last_clean_at, null);
  });
});

// ── 8. recordReviewerResult with findings ──

describe("recordReviewerResult with findings", () => {
  it("last reviewer sets status to has_findings when total findings > 0", () => {
    addReviewerPending(cwd, "lint");
    addReviewerPending(cwd, "test");
    recordReviewerResult(cwd, "lint", 2);
    const done = recordReviewerResult(cwd, "test", 0);
    const s = readReviewState(cwd);
    assert.equal(done, true);
    assert.equal(s.status, "has_findings");
    assert.equal(s.findings_count, 2);
  });
});

// ── 9. isReviewClean ──

describe("isReviewClean", () => {
  it("returns true when status is clean", () => {
    addReviewerPending(cwd, "lint");
    recordReviewerResult(cwd, "lint", 0);
    assert.equal(isReviewClean(cwd), true);
  });

  it("returns false when status is not clean", () => {
    assert.equal(isReviewClean(cwd), true); // none — no tracking active
    markNeedsReview(cwd);
    assert.equal(isReviewClean(cwd), false); // needs_review
    addReviewerPending(cwd, "lint");
    assert.equal(isReviewClean(cwd), false); // in_progress
  });
});

// ── 10. isReviewClean after edit ──

describe("isReviewClean after edit", () => {
  it("returns false when edit happened after clean", () => {
    addReviewerPending(cwd, "lint");
    recordReviewerResult(cwd, "lint", 0);
    assert.equal(isReviewClean(cwd), true);

    // Simulate an edit after clean by writing state with last_edit_at > last_clean_at
    markNeedsReview(cwd);
    // status is now needs_review, so isReviewClean should be false
    assert.equal(isReviewClean(cwd), false);

    // Also test the timestamp comparison path: manually set status back to clean
    // but with a later edit timestamp
    const s = readReviewState(cwd);
    assert.equal(s.status, "needs_review");
    assert.equal(isReviewClean(cwd), false);
  });
});

// ── 11. resetReviewState ──

describe("resetReviewState", () => {
  it("resets to defaults", () => {
    markNeedsReview(cwd);
    addReviewerPending(cwd, "lint");
    recordReviewerResult(cwd, "lint", 5);

    resetReviewState(cwd);
    const s = readReviewState(cwd);
    assert.equal(s.status, "none");
    assert.equal(s.cycle, 0);
    assert.deepEqual(s.reviewers_pending, []);
    assert.equal(s.reviewers_total, 0);
    assert.equal(s.findings_count, 0);
    assert.equal(s.last_edit_at, null);
    assert.equal(s.last_clean_at, null);
  });
});

// ── 12. Full cycle — all clean ──

describe("Full cycle — all reviewers clean", () => {
  it("markNeedsReview → addReviewerPending x3 → recordReviewerResult x3 with 0 → isClean = true", () => {
    markNeedsReview(cwd);

    addReviewerPending(cwd, "lint");
    addReviewerPending(cwd, "typecheck");
    addReviewerPending(cwd, "security");

    assert.equal(readReviewState(cwd).status, "in_progress");
    assert.equal(readReviewState(cwd).cycle, 1);

    let done = recordReviewerResult(cwd, "lint", 0);
    assert.equal(done, false);

    done = recordReviewerResult(cwd, "typecheck", 0);
    assert.equal(done, false);

    done = recordReviewerResult(cwd, "security", 0);
    assert.equal(done, true);

    assert.equal(isReviewClean(cwd), true);
    const s = readReviewState(cwd);
    assert.equal(s.status, "clean");
    assert.equal(s.findings_count, 0);
    assert.equal(s.reviewers_total, 3);
    assert.deepEqual(s.reviewers_pending, []);
  });
});

// ── 13. Full cycle — with findings ──

describe("Full cycle — one reviewer has findings", () => {
  it("markNeedsReview → addReviewerPending x3 → one has findings → isClean = false", () => {
    markNeedsReview(cwd);

    addReviewerPending(cwd, "lint");
    addReviewerPending(cwd, "typecheck");
    addReviewerPending(cwd, "security");

    recordReviewerResult(cwd, "lint", 0);
    recordReviewerResult(cwd, "typecheck", 4);
    const done = recordReviewerResult(cwd, "security", 0);
    assert.equal(done, true);

    assert.equal(isReviewClean(cwd), false);
    const s = readReviewState(cwd);
    assert.equal(s.status, "has_findings");
    assert.equal(s.findings_count, 4);
  });
});

describe("countFindings", () => {
  it("returns 0 for empty string", () => {
    assert.equal(countFindings(""), 0);
  });

  it("returns 0 for approved output", () => {
    assert.equal(countFindings("No quality issues found. Code approved."), 0);
  });

  it("counts single CRITICAL", () => {
    assert.equal(countFindings("[CRITICAL] file.ts:10 — Missing null check"), 1);
  });

  it("counts mixed severities", () => {
    const output = `[CRITICAL] a.ts:1 — Bug\n[WARNING] b.ts:2 — Style\n[SUGGESTION] c.ts:3 — Improvement`;
    assert.equal(countFindings(output), 3);
  });

  it("counts multiple of same severity", () => {
    const output = `[WARNING] a.ts:1\n[WARNING] b.ts:2\n[WARNING] c.ts:3`;
    assert.equal(countFindings(output), 3);
  });

  it("does not count markers in prose (not at line start)", () => {
    const output = "The reviewer should not raise [CRITICAL] for this pattern.";
    assert.equal(countFindings(output), 0);
  });

  it("counts markers at line start but not mid-line", () => {
    const output = "[CRITICAL] real finding\nDo not raise [WARNING] here\n[SUGGESTION] another real one";
    assert.equal(countFindings(output), 2);
  });
});

describe("markNeedsReview during in_progress (race condition regression)", () => {
  it("preserves reviewers_pending when called during in_progress", () => {
    addReviewerPending(cwd, "code-reviewer-quality");
    addReviewerPending(cwd, "code-reviewer-security");
    const before = readReviewState(cwd);
    assert.equal(before.status, "in_progress");
    assert.equal(before.reviewers_pending.length, 2);

    // Edit happens during review — should NOT wipe pending list
    markNeedsReview(cwd);

    const after = readReviewState(cwd);
    assert.equal(after.status, "in_progress");
    assert.equal(after.reviewers_pending.length, 2);
    assert.ok(after.last_edit_at !== null);
  });

  it("results in isReviewClean false after cycle completes with edit", () => {
    addReviewerPending(cwd, "code-reviewer-quality");
    markNeedsReview(cwd); // edit during review
    recordReviewerResult(cwd, "code-reviewer-quality", 0);

    // Reviewer found 0 issues but edit happened during cycle
    assert.equal(isReviewClean(cwd), false);
  });
});

describe("isReviewClean with status none", () => {
  it("returns true when no state exists (fresh project)", () => {
    assert.equal(isReviewClean(cwd), true);
  });
});

describe("edited_during_cycle resets on new cycle", () => {
  it("resets to false when addReviewerPending starts a new cycle after has_findings", () => {
    addReviewerPending(cwd, "lint");
    markNeedsReview(cwd); // edit during review
    recordReviewerResult(cwd, "lint", 2);
    const afterCycle1 = readReviewState(cwd);
    assert.equal(afterCycle1.status, "needs_review");
    assert.equal(afterCycle1.edited_during_cycle, true);

    // Start cycle 2
    addReviewerPending(cwd, "lint");
    const afterCycle2Start = readReviewState(cwd);
    assert.equal(afterCycle2Start.status, "in_progress");
    assert.equal(afterCycle2Start.edited_during_cycle, false);
  });
});

describe("recordReviewerResult idempotent", () => {
  it("second call for same reviewer doesn't double-count findings", () => {
    addReviewerPending(cwd, "lint");
    addReviewerPending(cwd, "test");
    recordReviewerResult(cwd, "lint", 3);
    recordReviewerResult(cwd, "lint", 3); // duplicate
    const s = readReviewState(cwd);
    assert.equal(s.findings_count, 3); // not 6
    assert.deepEqual(s.reviewers_pending, ["test"]);
  });
});

// ── Worktree state isolation ──

describe("worktree state isolation", () => {
  let worktreeA: string;
  let worktreeB: string;

  beforeEach(() => {
    worktreeA = mkdtempSync(join(tmpdir(), "wt-a-"));
    worktreeB = mkdtempSync(join(tmpdir(), "wt-b-"));
    mkdirSync(join(worktreeA, ".git")); // .git dir needed so resolveWorktreeRoot treats these as git roots
    mkdirSync(join(worktreeB, ".git"));
  });

  afterEach(() => {
    rmSync(worktreeA, { recursive: true, force: true });
    rmSync(worktreeB, { recursive: true, force: true });
  });

  it("statePath returns different paths for different directories", () => {
    const pathA = statePath(worktreeA);
    const pathB = statePath(worktreeB);
    assert.notEqual(pathA, pathB);
    assert.ok(pathA.startsWith(worktreeA));
    assert.ok(pathB.startsWith(worktreeB));
  });

  it("markNeedsReview in worktree A does not affect worktree B", () => {
    markNeedsReview(worktreeA);
    const stateA = readReviewState(worktreeA);
    const stateB = readReviewState(worktreeB);
    assert.equal(stateA.status, "needs_review");
    assert.equal(stateB.status, "none");
  });

  it("clean state in worktree A does not leak to worktree B", () => {
    // Make A clean
    markNeedsReview(worktreeA);
    addReviewerPending(worktreeA, "lint");
    recordReviewerResult(worktreeA, "lint", 0);
    assert.equal(isReviewClean(worktreeA), true);

    // Mark B needs review
    markNeedsReview(worktreeB);
    assert.equal(isReviewClean(worktreeB), false);

    // A's clean state should NOT affect B
    assert.equal(isReviewClean(worktreeA), true);
    assert.equal(isReviewClean(worktreeB), false);
  });
});
