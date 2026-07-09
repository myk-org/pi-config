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
  markTestsPassed,
  markTestsFailed,
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
  it("returns false when status is clean but tests not passed", () => {
    addReviewerPending(cwd, "lint");
    recordReviewerResult(cwd, "lint", 0);
    assert.equal(isReviewClean(cwd), false);
  });

  it("returns true when status is clean with tests passed", () => {
    addReviewerPending(cwd, "lint");
    recordReviewerResult(cwd, "lint", 0);
    markTestsPassed(cwd);
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
    markTestsPassed(cwd);
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

    assert.equal(isReviewClean(cwd), false); // clean but tests not passed yet
    markTestsPassed(cwd);
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

// ── tests_passed field ──

describe("tests_passed", () => {
  it("defaults to false", () => {
    const s = readReviewState(cwd);
    assert.equal(s.tests_passed, false);
  });

  it("markTestsPassed sets tests_passed to true", () => {
    markNeedsReview(cwd); // activate tracking
    markTestsPassed(cwd);
    assert.equal(readReviewState(cwd).tests_passed, true);
  });

  it("markTestsFailed sets tests_passed to false", () => {
    markNeedsReview(cwd);
    markTestsPassed(cwd);
    assert.equal(readReviewState(cwd).tests_passed, true);
    markTestsFailed(cwd);
    assert.equal(readReviewState(cwd).tests_passed, false);
  });

  it("markNeedsReview resets tests_passed to false", () => {
    markNeedsReview(cwd);
    addReviewerPending(cwd, "lint");
    recordReviewerResult(cwd, "lint", 0);
    markTestsPassed(cwd);
    assert.equal(readReviewState(cwd).tests_passed, true);

    // Edit resets everything
    markNeedsReview(cwd);
    assert.equal(readReviewState(cwd).tests_passed, false);
  });

  it("markNeedsReview during in_progress also resets tests_passed", () => {
    addReviewerPending(cwd, "lint");
    markTestsPassed(cwd);
    assert.equal(readReviewState(cwd).tests_passed, true);

    // Edit during review resets tests_passed
    markNeedsReview(cwd);
    assert.equal(readReviewState(cwd).tests_passed, false);
    assert.equal(readReviewState(cwd).status, "in_progress"); // reviewers still pending
  });

  it("markTestsPassed is no-op when status is none", () => {
    markTestsPassed(cwd);
    assert.equal(readReviewState(cwd).tests_passed, false); // still default
    assert.equal(readReviewState(cwd).status, "none");
  });

  it("isReviewClean requires both clean status and tests_passed", () => {
    markNeedsReview(cwd);
    addReviewerPending(cwd, "lint");
    recordReviewerResult(cwd, "lint", 0);
    // status is clean but tests haven't passed
    assert.equal(readReviewState(cwd).status, "clean");
    assert.equal(isReviewClean(cwd), false);

    markTestsPassed(cwd);
    assert.equal(isReviewClean(cwd), true);
  });
});

// ── Worktree state isolation ──

import { execFileSync } from "node:child_process";

// Git identity env vars for hermetic tests (CI may not have global git config)
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.local",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.local",
};

describe("worktree state isolation", () => {
  let mainRepo: string;
  let worktreeA: string;
  let worktreeB: string;

  beforeEach(() => {
    // Create a real git repo with two worktrees to exercise the actual
    // git rev-parse --show-toplevel / --git-common-dir code paths.
    mainRepo = mkdtempSync(join(tmpdir(), "wt-main-"));
    execFileSync("git", ["init"], { cwd: mainRepo, stdio: "ignore", env: GIT_ENV });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: mainRepo, stdio: "ignore", env: GIT_ENV });

    // Worktrees in separate tmpdir paths — proves isolation works for worktrees ANYWHERE,
    // not just under .worktrees/ in the repo. Use randomUUID for collision-safe paths.
    worktreeA = join(tmpdir(), `wt-a-${crypto.randomUUID()}`);
    worktreeB = join(tmpdir(), `wt-b-${crypto.randomUUID()}`);
    execFileSync("git", ["worktree", "add", worktreeA, "-b", "branch-a"], { cwd: mainRepo, stdio: "ignore", env: GIT_ENV });
    execFileSync("git", ["worktree", "add", worktreeB, "-b", "branch-b"], { cwd: mainRepo, stdio: "ignore", env: GIT_ENV });
  });

  afterEach(() => {
    // Remove worktrees before deleting the repo — --force needed because
    // tests create .pi/data/ files inside worktrees (untracked content).
    try { execFileSync("git", ["worktree", "remove", worktreeA, "--force"], { cwd: mainRepo, stdio: "ignore", env: GIT_ENV }); } catch {}
    try { execFileSync("git", ["worktree", "remove", worktreeB, "--force"], { cwd: mainRepo, stdio: "ignore", env: GIT_ENV }); } catch {}
    rmSync(mainRepo, { recursive: true, force: true });
  });

  it("statePath returns different paths for different worktrees sharing same repo", () => {
    const pathMain = statePath(mainRepo);
    const pathA = statePath(worktreeA);
    const pathB = statePath(worktreeB);
    // All three must be different
    assert.notEqual(pathMain, pathA);
    assert.notEqual(pathMain, pathB);
    assert.notEqual(pathA, pathB);
    // Each path is under its own worktree root
    assert.ok(pathMain.startsWith(mainRepo));
    assert.ok(pathA.startsWith(worktreeA));
    assert.ok(pathB.startsWith(worktreeB));
  });

  it("markNeedsReview in worktree A does not affect worktree B or main", () => {
    markNeedsReview(worktreeA);
    assert.equal(readReviewState(worktreeA).status, "needs_review");
    assert.equal(readReviewState(worktreeB).status, "none");
    assert.equal(readReviewState(mainRepo).status, "none");
  });

  it("clean state in worktree A does not leak to worktree B", () => {
    // Make A clean
    markNeedsReview(worktreeA);
    addReviewerPending(worktreeA, "lint");
    recordReviewerResult(worktreeA, "lint", 0);
    markTestsPassed(worktreeA);
    assert.equal(isReviewClean(worktreeA), true);

    // Mark B needs review
    markNeedsReview(worktreeB);
    assert.equal(isReviewClean(worktreeB), false);

    // A's clean state should NOT affect B (tests_passed is per-worktree too)
    assert.equal(isReviewClean(worktreeA), true);
    assert.equal(isReviewClean(worktreeB), false);
    // Main repo unaffected
    assert.equal(readReviewState(mainRepo).status, "none");
  });
});
