/**
 * Tests for review state machine (review loop enforcement).
 * Run with: npx tsx --test tests/node/orchestrator/pi-config-review-state.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readReviewState,
  markNeedsReview,
  addReviewerPending,
  recordReviewerResult,
  isReviewClean,
  isCommitAllowed,
  resetReviewState,
  countFindings,
  statePath,
  markTestsPassed,
  markTestsFailed,
  onStateTransition,
  subjectKey,
  subjectLabel,
  type ReviewSubject,
} from "../../../extensions/orchestrator/pi-config-review-state.js";
import { parseOpenPr, resolveReviewSubject } from "../../../extensions/orchestrator/review-subject.js";

/** Every round must name what it reviews; these suites review one local commit. */
const SUBJECT: ReviewSubject = { kind: "local", head_sha: "0123456789abcdef0123456789abcdef01234567" }; // pragma: allowlist secret

let cwd: string;

beforeEach(() => {
  cwd = makeTempDir("pi-config-review-state-test-");
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
    addReviewerPending(cwd, "reviewer-a", SUBJECT);
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
    addReviewerPending(cwd, "lint", SUBJECT);
    const s = readReviewState(cwd);
    assert.equal(s.status, "in_progress");
    assert.equal(s.cycle, 1);
    assert.deepEqual(s.reviewers_pending, ["lint"]);
    assert.equal(s.reviewers_total, 1);
  });

  it("increments cycle only on first transition to in_progress", () => {
    addReviewerPending(cwd, "lint", SUBJECT);
    addReviewerPending(cwd, "test", SUBJECT);
    const s = readReviewState(cwd);
    assert.equal(s.cycle, 1);
    assert.deepEqual(s.reviewers_pending, ["lint", "test"]);
    assert.equal(s.reviewers_total, 2);
  });
});

// ── 5. addReviewerPending duplicate ──

describe("addReviewerPending duplicate", () => {
  it("doesn't add same reviewer twice", () => {
    addReviewerPending(cwd, "lint", SUBJECT);
    addReviewerPending(cwd, "lint", SUBJECT);
    const s = readReviewState(cwd);
    assert.deepEqual(s.reviewers_pending, ["lint"]);
    assert.equal(s.reviewers_total, 1);
  });
});

// ── 6. recordReviewerResult ──

describe("recordReviewerResult", () => {
  it("removes reviewer from pending and accumulates findings", () => {
    addReviewerPending(cwd, "lint", SUBJECT);
    addReviewerPending(cwd, "test", SUBJECT);
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
    addReviewerPending(cwd, "lint", SUBJECT);
    addReviewerPending(cwd, "test", SUBJECT);
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
    addReviewerPending(cwd, "lint", SUBJECT);
    addReviewerPending(cwd, "test", SUBJECT);
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
    addReviewerPending(cwd, "lint", SUBJECT);
    recordReviewerResult(cwd, "lint", 0);
    assert.equal(isReviewClean(cwd), false);
  });

  it("returns true when status is clean with tests passed", () => {
    addReviewerPending(cwd, "lint", SUBJECT);
    recordReviewerResult(cwd, "lint", 0);
    markTestsPassed(cwd);
    assert.equal(isReviewClean(cwd), true);
  });

  it("returns false when status is not clean", () => {
    assert.equal(isReviewClean(cwd), true); // none — no tracking active
    markNeedsReview(cwd);
    assert.equal(isReviewClean(cwd), false); // needs_review
    addReviewerPending(cwd, "lint", SUBJECT);
    assert.equal(isReviewClean(cwd), false); // in_progress
  });
});

// ── 10. isReviewClean after edit ──

describe("isReviewClean after edit", () => {
  it("returns false when edit happened after clean", () => {
    addReviewerPending(cwd, "lint", SUBJECT);
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
    addReviewerPending(cwd, "lint", SUBJECT);
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

    addReviewerPending(cwd, "lint", SUBJECT);
    addReviewerPending(cwd, "typecheck", SUBJECT);
    addReviewerPending(cwd, "security", SUBJECT);

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

    addReviewerPending(cwd, "lint", SUBJECT);
    addReviewerPending(cwd, "typecheck", SUBJECT);
    addReviewerPending(cwd, "security", SUBJECT);

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
  it("returns -1 for empty string", () => {
    assert.equal(countFindings(""), -1);
  });

  it("returns -1 for non-JSON text", () => {
    assert.equal(countFindings("No quality issues found. Code approved."), -1);
  });

  it("returns 0 for empty findings array", () => {
    assert.equal(countFindings('{"findings": []}'), 0);
  });

  it("counts single finding", () => {
    const output = '{"findings": [{"severity": "CRITICAL", "file": "a.ts", "line": 10, "description": "bug"}]}';
    assert.equal(countFindings(output), 1);
  });

  it("counts multiple findings", () => {
    const output = '{"findings": [{"severity": "CRITICAL", "file": "a.ts", "line": 1, "description": "bug"}, {"severity": "WARNING", "file": "b.ts", "line": 2, "description": "style"}, {"severity": "SUGGESTION", "file": "c.ts", "line": 3, "description": "improve"}]}';
    assert.equal(countFindings(output), 3);
  });

  it("strips markdown code fences", () => {
    const output = '```json\n{"findings": [{"severity": "WARNING", "file": "a.ts", "line": 1, "description": "x"}]}\n```';
    assert.equal(countFindings(output), 1);
  });

  it("returns -1 for invalid JSON", () => {
    assert.equal(countFindings('{"findings": [}'), -1);
  });

  it("returns -1 for JSON without findings array", () => {
    assert.equal(countFindings('{"result": "ok"}'), -1);
  });
});

describe("markNeedsReview during in_progress (race condition regression)", () => {
  it("preserves reviewers_pending when called during in_progress", () => {
    addReviewerPending(cwd, "code-reviewer-quality", SUBJECT);
    addReviewerPending(cwd, "code-reviewer-security", SUBJECT);
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
    addReviewerPending(cwd, "code-reviewer-quality", SUBJECT);
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
    addReviewerPending(cwd, "lint", SUBJECT);
    markNeedsReview(cwd); // edit during review
    recordReviewerResult(cwd, "lint", 2);
    const afterCycle1 = readReviewState(cwd);
    assert.equal(afterCycle1.status, "needs_review");
    assert.equal(afterCycle1.edited_during_cycle, true);

    // Start cycle 2
    addReviewerPending(cwd, "lint", SUBJECT);
    const afterCycle2Start = readReviewState(cwd);
    assert.equal(afterCycle2Start.status, "in_progress");
    assert.equal(afterCycle2Start.edited_during_cycle, false);
  });
});

describe("recordReviewerResult idempotent", () => {
  it("second call for same reviewer doesn't double-count findings", () => {
    addReviewerPending(cwd, "lint", SUBJECT);
    addReviewerPending(cwd, "test", SUBJECT);
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
    addReviewerPending(cwd, "lint", SUBJECT);
    recordReviewerResult(cwd, "lint", 0);
    markTestsPassed(cwd);
    assert.equal(readReviewState(cwd).tests_passed, true);

    // Edit resets everything
    markNeedsReview(cwd);
    assert.equal(readReviewState(cwd).tests_passed, false);
  });

  it("markNeedsReview during in_progress also resets tests_passed", () => {
    addReviewerPending(cwd, "lint", SUBJECT);
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
    addReviewerPending(cwd, "lint", SUBJECT);
    recordReviewerResult(cwd, "lint", 0);
    // status is clean but tests haven't passed
    assert.equal(readReviewState(cwd).status, "clean");
    assert.equal(isReviewClean(cwd), false);

    markTestsPassed(cwd);
    assert.equal(isReviewClean(cwd), true);
  });

  it("isCommitAllowed true when has_findings and max cycles exhausted", () => {
    // The cap now also requires the subject to BE the current one, so this worktree must be a repo
    // whose HEAD matches the reviewed subject.
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "T"], { cwd });
    writeFileSync(join(cwd, "f.txt"), "x\n");
    execFileSync("git", ["add", "f.txt"], { cwd });
    execFileSync("git", ["commit", "-qm", "init"], { cwd });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8" }).trim();
    const subject: ReviewSubject = { kind: "local", head_sha: head };

    // Cycle 1: findings
    markNeedsReview(cwd);
    addReviewerPending(cwd, "lint", subject);
    recordReviewerResult(cwd, "lint", 2);
    markTestsPassed(cwd);
    assert.equal(readReviewState(cwd).status, "has_findings");
    assert.equal(readReviewState(cwd).cycle, 1);
    assert.equal(isReviewClean(cwd), false); // not clean — still has findings
    assert.equal(isCommitAllowed(cwd), false); // below default max 3

    // Cycle 2
    markNeedsReview(cwd);
    addReviewerPending(cwd, "lint", subject);
    recordReviewerResult(cwd, "lint", 1);
    markTestsPassed(cwd);
    assert.equal(readReviewState(cwd).cycle, 2);
    assert.equal(isReviewClean(cwd), false);
    assert.equal(isCommitAllowed(cwd), false);

    // Cycle 3 — at default max
    markNeedsReview(cwd);
    addReviewerPending(cwd, "lint", subject);
    recordReviewerResult(cwd, "lint", 1);
    assert.equal(readReviewState(cwd).status, "has_findings");
    assert.equal(readReviewState(cwd).cycle, 3);
    assert.equal(isReviewClean(cwd), false); // still not clean
    assert.equal(isCommitAllowed(cwd), true); // max cycles exhausted (tests_passed not required)
    markTestsPassed(cwd);
    assert.equal(isReviewClean(cwd), false); // max cycles ≠ clean
    assert.equal(isCommitAllowed(cwd), true); // still allowed
  });

  it("isCommitAllowed false when has_findings below max cycles", () => {
    markNeedsReview(cwd);
    addReviewerPending(cwd, "lint", SUBJECT);
    recordReviewerResult(cwd, "lint", 3);
    markTestsPassed(cwd);
    assert.equal(readReviewState(cwd).status, "has_findings");
    assert.equal(readReviewState(cwd).cycle, 1);
    assert.equal(isReviewClean(cwd), false);
    assert.equal(isCommitAllowed(cwd), false);
  });

  it("isCommitAllowed true for needs_review when cycle >= max", () => {
    // The cap requires the subject to be the CURRENT one — this worktree must be a repo.
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "T"], { cwd });
    writeFileSync(join(cwd, "f.txt"), "x\n");
    execFileSync("git", ["add", "f.txt"], { cwd });
    execFileSync("git", ["commit", "-qm", "init"], { cwd });
    const subject: ReviewSubject = {
      kind: "local",
      head_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8" }).trim(),
    };
    // Reach max cycles with findings, then edit again → needs_review with empty pending
    markNeedsReview(cwd);
    addReviewerPending(cwd, "lint", subject);
    recordReviewerResult(cwd, "lint", 1);
    markNeedsReview(cwd);
    addReviewerPending(cwd, "lint", subject);
    recordReviewerResult(cwd, "lint", 1);
    markNeedsReview(cwd);
    addReviewerPending(cwd, "lint", subject);
    recordReviewerResult(cwd, "lint", 1);
    assert.equal(readReviewState(cwd).cycle, 3);
    assert.equal(isCommitAllowed(cwd), true); // has_findings at max

    markNeedsReview(cwd); // edits again — reviewers not spawned yet
    assert.equal(readReviewState(cwd).status, "needs_review");
    assert.equal(readReviewState(cwd).reviewers_pending.length, 0);
    assert.equal(readReviewState(cwd).cycle, 3);
    assert.equal(isCommitAllowed(cwd), true); // needs_review at max cycle — commit allowed
  });
});

// ── Worktree state isolation ──

import { makeTempDir } from "../helpers/temp-dirs.js";



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
    mainRepo = makeTempDir("wt-main-");
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
    addReviewerPending(worktreeA, "lint", SUBJECT);
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

// ── cycle counter preservation across fix-edit-review loop (max-cycles regression) ──

describe("cycle counter preservation across fix-edit-review loop", () => {
  it("preserves cycle when continuing from has_findings, only resets on fresh start", () => {
    // Cycle 1: start review, findings come back
    addReviewerPending(cwd, "reviewer-a", SUBJECT);
    assert.equal(readReviewState(cwd).cycle, 1);

    recordReviewerResult(cwd, "reviewer-a", 2);
    assert.equal(readReviewState(cwd).status, "has_findings");
    assert.equal(readReviewState(cwd).cycle, 1);

    // Simulate fix edits in response to findings — must NOT reset cycle
    markNeedsReview(cwd);
    assert.equal(readReviewState(cwd).status, "needs_review");
    assert.equal(readReviewState(cwd).cycle, 1);

    // Cycle 2: re-dispatch reviewers
    addReviewerPending(cwd, "reviewer-a", SUBJECT);
    assert.equal(readReviewState(cwd).cycle, 2);

    recordReviewerResult(cwd, "reviewer-a", 1);
    assert.equal(readReviewState(cwd).status, "has_findings");
    assert.equal(readReviewState(cwd).cycle, 2);

    markNeedsReview(cwd); // fix edits again
    assert.equal(readReviewState(cwd).cycle, 2);

    // Cycle 3: re-dispatch reviewers again — reaches the max cap of 3
    addReviewerPending(cwd, "reviewer-a", SUBJECT);
    assert.equal(readReviewState(cwd).cycle, 3);
  });

  it("resets cycle to 0 on a fresh start after a clean pass", () => {
    addReviewerPending(cwd, "reviewer-a", SUBJECT);
    recordReviewerResult(cwd, "reviewer-a", 0);
    assert.equal(readReviewState(cwd).status, "clean");
    assert.equal(readReviewState(cwd).cycle, 1);

    // A brand-new edit after clean starts a fresh review — cycle resets
    markNeedsReview(cwd);
    assert.equal(readReviewState(cwd).status, "needs_review");
    assert.equal(readReviewState(cwd).cycle, 0);

    addReviewerPending(cwd, "reviewer-a", SUBJECT);
    assert.equal(readReviewState(cwd).cycle, 1);
  });

  it("resets cycle to 0 on fresh start from none", () => {
    assert.equal(readReviewState(cwd).status, "none");
    markNeedsReview(cwd);
    assert.equal(readReviewState(cwd).cycle, 0);
  });
});

// ── onStateTransition callback ──

describe("onStateTransition", () => {
  afterEach(() => {
    // Clear callback to avoid leaking into other tests
    onStateTransition(() => {});
  });

  it("fires callback on markNeedsReview", () => {
    const states: Array<{ status: string }> = [];
    onStateTransition((s) => states.push({ status: s.status }));
    markNeedsReview(cwd);
    assert.equal(states.length, 1);
    assert.equal(states[0].status, "needs_review");
  });

  it("fires callback on addReviewerPending", () => {
    const states: Array<{ status: string; reviewers_pending: string[] }> = [];
    onStateTransition((s) => states.push({ status: s.status, reviewers_pending: [...s.reviewers_pending] }));
    markNeedsReview(cwd);
    addReviewerPending(cwd, "reviewer-a", SUBJECT);
    assert.equal(states.length, 2);
    assert.equal(states[1].status, "in_progress");
    assert.deepEqual(states[1].reviewers_pending, ["reviewer-a"]);
  });

  it("fires callback on recordReviewerResult", () => {
    const states: Array<{ status: string }> = [];
    markNeedsReview(cwd);
    addReviewerPending(cwd, "reviewer-a", SUBJECT);
    onStateTransition((s) => states.push({ status: s.status }));
    recordReviewerResult(cwd, "reviewer-a", 0);
    assert.equal(states.length, 1);
    assert.equal(states[0].status, "clean");
  });

  it("fires callback on markTestsPassed", () => {
    const states: Array<{ tests_passed: boolean }> = [];
    markNeedsReview(cwd); // activate tracking
    onStateTransition((s) => states.push({ tests_passed: s.tests_passed }));
    markTestsPassed(cwd);
    assert.equal(states.length, 1);
    assert.equal(states[0].tests_passed, true);
  });

  it("fires callback on markTestsFailed", () => {
    const states: Array<{ tests_passed: boolean }> = [];
    markNeedsReview(cwd); // activate tracking
    onStateTransition((s) => states.push({ tests_passed: s.tests_passed }));
    markTestsFailed(cwd);
    assert.equal(states.length, 1);
    assert.equal(states[0].tests_passed, false);
  });

  it("fires callback on resetReviewState", () => {
    const states: Array<{ status: string }> = [];
    markNeedsReview(cwd);
    onStateTransition((s) => states.push({ status: s.status }));
    resetReviewState(cwd);
    assert.equal(states.length, 1);
    assert.equal(states[0].status, "none");
  });

  it("deep-copies reviewers_pending (no shared reference)", () => {
    let captured: string[] = [];
    onStateTransition((s) => { captured = s.reviewers_pending; });
    addReviewerPending(cwd, "r1", SUBJECT);
    addReviewerPending(cwd, "r2", SUBJECT);
    // captured should be the snapshot from the last call, not mutated
    assert.deepEqual(captured, ["r1", "r2"]);
    // Mutating captured should not affect internal state
    captured.push("r3");
    const state = readReviewState(cwd);
    assert.ok(!state.reviewers_pending.includes("r3"));
  });

  it("is fire-and-forget — callback errors do not propagate", () => {
    onStateTransition(() => { throw new Error("boom"); });
    // Should not throw
    assert.doesNotThrow(() => markNeedsReview(cwd));
  });

  it("does not fire duplicate notifications for repeated edits while needs_review", () => {
    const states: Array<{ status: string }> = [];
    onStateTransition((s) => states.push({ status: s.status }));
    markNeedsReview(cwd);
    markNeedsReview(cwd); // second edit — already needs_review
    markNeedsReview(cwd); // third edit
    assert.equal(states.length, 1); // Only the first transition fires
  });

  it("subsequent calls replace the previous callback", () => {
    const calls1: string[] = [];
    const calls2: string[] = [];
    onStateTransition(() => calls1.push("a"));
    markNeedsReview(cwd);
    onStateTransition(() => calls2.push("b"));
    resetReviewState(cwd);
    assert.equal(calls1.length, 1); // Only fired before replacement
    assert.equal(calls2.length, 1); // Fires after replacement
  });
});

// ── Review subject: rounds are counted per loop, and every round names its loop ──

describe("review subject", () => {
  const planA: ReviewSubject = { kind: "plan", path: "docs/plan-a.md" };
  const planB: ReviewSubject = { kind: "plan", path: "docs/plan-b.md" };

  // A round that finds something keeps the loop alive (has_findings) — that is the fix-edit-review
  // pattern the counter exists for. `findings` 0 ends the loop clean.
  const round = (subject: ReviewSubject, reviewer: string, findings = 1) => {
    addReviewerPending(cwd, reviewer, subject);
    recordReviewerResult(cwd, reviewer, findings);
    markNeedsReview(cwd);
  };

  it("counts consecutive finding rounds of the SAME subject 1, 2, 3", () => {
    markNeedsReview(cwd);
    round(planA, "a");
    assert.equal(readReviewState(cwd).cycle, 1);
    round(planA, "b");
    assert.equal(readReviewState(cwd).cycle, 2);
    round(planA, "c");
    const s = readReviewState(cwd);
    assert.equal(s.cycle, 3, "the third round of one plan is cycle 3");
    assert.deepEqual(s.subject, planA);
    assert.notEqual(s.subject_started_at, null);
  });

  it("starts a DIFFERENT subject at cycle 1", () => {
    markNeedsReview(cwd);
    round(planA, "a");
    round(planA, "b");
    assert.equal(readReviewState(cwd).cycle, 2);
    round(planB, "c");
    const s = readReviewState(cwd);
    assert.equal(s.cycle, 1, "a different plan is a different loop, not round 3");
    assert.deepEqual(s.subject, planB);
  });

  it("treats a new commit of the same PR as a new loop", () => {
    const sha = (c: string) => c.repeat(40);
    markNeedsReview(cwd);
    round({ kind: "pr", repo: "o/r", number: 1, head_sha: sha("a") }, "a");
    round({ kind: "pr", repo: "o/r", number: 1, head_sha: sha("a") }, "b");
    assert.equal(readReviewState(cwd).cycle, 2);
    round({ kind: "pr", repo: "o/r", number: 1, head_sha: sha("b") }, "c");
    assert.equal(readReviewState(cwd).cycle, 1, "a new head is a new review loop");
  });

  it("keeps today's reset after a CLEAN round, so the max-cycles cap cannot latch", () => {
    markNeedsReview(cwd);
    round(planA, "a", 1);
    round(planA, "b", 1);
    assert.equal(readReviewState(cwd).cycle, 2);
    // Finish the loop clean without the helper's trailing edit.
    addReviewerPending(cwd, "c", planA);
    recordReviewerResult(cwd, "c", 0);
    assert.equal(readReviewState(cwd).status, "clean");
    assert.equal(isCommitAllowed(cwd), true, "a clean loop allows the commit");
    markNeedsReview(cwd);
    assert.equal(readReviewState(cwd).cycle, 0, "a finished loop restarts counting");
    addReviewerPending(cwd, "d", planA);
    assert.equal(readReviewState(cwd).cycle, 1, "and the cap is not already tripped");
  });

  it("refuses a round that does not name its subject", () => {
    assert.throws(
      () => addReviewerPending(cwd, "a", null as unknown as ReviewSubject),
      /requires the review subject/,
      "silently counting for nothing is the bug this prevents",
    );
    assert.equal(readReviewState(cwd).cycle, 0, "the state was not advanced");
  });

  it("renders a label for each kind", () => {
    assert.equal(subjectLabel({ kind: "pr", repo: "o/r", number: 1054, head_sha: "75098f6cabc" }), "PR #1054 @ 75098f6"); // pragma: allowlist secret
    assert.equal(subjectLabel({ kind: "issue", repo: "o/r", number: 42 }), "issue #42");
    assert.equal(subjectLabel({ kind: "local", head_sha: "cfb12228abc" }), "commit cfb1222 (local)");
    assert.equal(subjectLabel({ kind: "plan", path: "docs/x.md" }), "plan docs/x.md");
    assert.equal(subjectLabel({ kind: "other", id: "design-review" }), "design-review");
    assert.equal(subjectLabel(null), "no subject");
  });

  it("keys are stable and repo-qualified", () => {
    assert.equal(subjectKey({ kind: "pr", repo: "o/r", number: 7, head_sha: "abc" }), "pr:o/r#7@abc");
    assert.equal(subjectKey({ kind: "issue", repo: "o/r", number: 7 }), "issue:o/r#7");
    assert.equal(subjectKey({ kind: "local", head_sha: "abc" }), "local:abc");
    assert.equal(subjectKey({ kind: "plan", path: "docs/x.md" }), "plan:docs/x.md");
    assert.equal(subjectKey({ kind: "other", id: "x" }), "other:x");
  });

  it("survives a state file written before subjects existed", () => {
    // A legacy line: no subject fields at all. It must read, not throw, and report no subject.
    const legacy = { status: "has_findings", cycle: 46, reviewers_pending: [], reviewers_total: 5, findings_count: 8 };
    writeFileSync(statePath(cwd), `${JSON.stringify(legacy)}\n`);
    const s = readReviewState(cwd);
    assert.equal(s.cycle, 46, "an old counter is shown as-is, never silently reset");
    assert.equal(s.subject, null);
    assert.equal(subjectLabel(s.subject), "no subject");
  });
});

// ── Subject resolution from the worktree (no PR → the commit being reviewed) ──

describe("resolveReviewSubject", () => {
  const silent = { debug() {}, info() {}, warn() {}, error() {}, isDebugEnabled: () => false } as any;
  let repo: string;

  beforeEach(() => {
    repo = join(tmpdir(), `review-subject-${process.pid}-${Date.now()}`);
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "T"], { cwd: repo });
    writeFileSync(join(repo, "f.txt"), "x\n");
    execFileSync("git", ["add", "f.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("falls back to the commit when there is no PR to name", () => {
    const subject = resolveReviewSubject(repo, silent);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
    assert.deepEqual(subject, { kind: "local", head_sha: head });
  });

  it("returns null outside a git worktree, so no round can be counted", () => {
    const plain = join(tmpdir(), `review-subject-plain-${process.pid}-${Date.now()}`);
    mkdirSync(plain, { recursive: true });
    try {
      assert.equal(resolveReviewSubject(plain, silent), null);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("max-cycles cap is scoped to the reviewed subject", () => {
  const atCap = (head_sha: string): ReviewSubject => ({ kind: "local", head_sha });
  const currentHead = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8" }).trim();

  // The cap compares a commit-bearing subject with HEAD, so this worktree must be a repo.
  beforeEach(() => {
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "T"], { cwd });
    writeFileSync(join(cwd, "f.txt"), "x\n");
    execFileSync("git", ["add", "f.txt"], { cwd });
    execFileSync("git", ["commit", "-qm", "init"], { cwd });
  });

  it("allows the commit when the cap was reached on THIS head", () => {
    markNeedsReview(cwd);
    for (let i = 0; i < 3; i++) {
      addReviewerPending(cwd, `r${i}`, atCap(currentHead()));
      recordReviewerResult(cwd, `r${i}`, 1);
      markNeedsReview(cwd);
    }
    const s = readReviewState(cwd);
    assert.ok(s.cycle >= 3, `expected the cap to be reached, got ${s.cycle}`);
    assert.equal(isCommitAllowed(cwd), true);
  });

  it("does NOT let that exhausted cap license a commit for a different head", () => {
    markNeedsReview(cwd);
    for (let i = 0; i < 3; i++) {
      addReviewerPending(cwd, `r${i}`, atCap(currentHead()));
      recordReviewerResult(cwd, `r${i}`, 1);
      markNeedsReview(cwd);
    }
    assert.equal(isCommitAllowed(cwd), true);
    // A round recorded for an older commit must not keep the cap open for the current one.
    addReviewerPending(cwd, "stale", atCap("f".repeat(40)));
    recordReviewerResult(cwd, "stale", 1);
    markNeedsReview(cwd);
    assert.equal(isCommitAllowed(cwd), false, "new head, new loop: the cap does not carry over");
  });
});

describe("parseOpenPr", () => {
  // Shaped like `gh pr view --json number,headRefOid,state` output.
  const open = JSON.stringify({ number: 1056, headRefOid: "d1c6e7f072295b68ad0078736bf643779464e69e", state: "OPEN" }); // pragma: allowlist secret

  it("keeps the PR number and head exactly as gh reports them", () => {
    assert.deepEqual(parseOpenPr(open), { number: 1056, head_sha: "d1c6e7f072295b68ad0078736bf643779464e69e" }); // pragma: allowlist secret
  });

  it("ignores a PR that is not open", () => {
    assert.equal(parseOpenPr(JSON.stringify({ number: 1, headRefOid: "a".repeat(40), state: "MERGED" })), null);
  });

  it("rejects an unusable payload instead of inventing an identity", () => {
    assert.equal(parseOpenPr(""), null);
    assert.equal(parseOpenPr("not json"), null);
    assert.equal(parseOpenPr(JSON.stringify({ state: "OPEN" })), null);
    assert.equal(parseOpenPr(JSON.stringify({ number: "1056", headRefOid: "x", state: "OPEN" })), null);
    // The shape the jq filter produced before it was removed: a PR with no real number.
    assert.equal(parseOpenPr(JSON.stringify({ number: null, headRefOid: "(.headRefOid)", state: "OPEN" })), null);
  });
});
