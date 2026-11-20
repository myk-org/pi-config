import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  markNeedsReview,
  resetReviewState,
  readReviewState,
  addReviewerPending,
  recordReviewerResult,
  type ReviewSubject,
} from "../../../extensions/orchestrator/pi-config-review-state.js";
import { normalizePorcelain } from "../../../extensions/orchestrator/review-porcelain.js";
import { registerReviewUI, reviewStatusLine, type AsyncGitStatusRunner } from "../../../extensions/orchestrator/review-ui.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

/** Every round must name what it reviews; these suites review one local commit. */
const SUBJECT: ReviewSubject = { kind: "local", head_sha: "0123456789abcdef0123456789abcdef01234567" }; // pragma: allowlist secret



describe("poller state transitions", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir("poller-test-");
    fs.mkdirSync(path.join(tmp, ".pi", "data"), { recursive: true });
    // Create minimal settings file for getSetting
    fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".pi", "pi-config-settings.json"),
      JSON.stringify({ review_loop_enforcement: true, review_loop_max_cycles: 3 }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("dirty from none → needs_review", () => {
    const before = readReviewState(tmp);
    assert.equal(before.status, "none");
    markNeedsReview(tmp);
    const after = readReviewState(tmp);
    assert.equal(after.status, "needs_review");
  });

  it("dirty from clean → needs_review", () => {
    // Set up clean state
    markNeedsReview(tmp);
    addReviewerPending(tmp, "test-reviewer", SUBJECT);
    recordReviewerResult(tmp, "test-reviewer", 0);
    const clean = readReviewState(tmp);
    assert.equal(clean.status, "clean");
    // Dirty again
    markNeedsReview(tmp);
    const after = readReviewState(tmp);
    assert.equal(after.status, "needs_review");
  });

  it("dirty from has_findings → needs_review", () => {
    markNeedsReview(tmp);
    addReviewerPending(tmp, "test-reviewer", SUBJECT);
    recordReviewerResult(tmp, "test-reviewer", 3);
    const hf = readReviewState(tmp);
    assert.equal(hf.status, "has_findings");
    markNeedsReview(tmp);
    const after = readReviewState(tmp);
    assert.equal(after.status, "needs_review");
  });

  it("dirty during in_progress → sets edited_during_cycle", () => {
    markNeedsReview(tmp);
    addReviewerPending(tmp, "test-reviewer", SUBJECT);
    const ip = readReviewState(tmp);
    assert.equal(ip.status, "in_progress");
    assert.equal(ip.edited_during_cycle, false);
    markNeedsReview(tmp);
    const after = readReviewState(tmp);
    assert.equal(after.status, "in_progress"); // stays in_progress
    assert.equal(after.edited_during_cycle, true);
    assert.equal(after.tests_passed, false);
  });

  it("dirty from needs_review → no-op (already needs_review)", () => {
    markNeedsReview(tmp);
    const before = readReviewState(tmp);
    assert.equal(before.status, "needs_review");
    markNeedsReview(tmp);
    const after = readReviewState(tmp);
    assert.equal(after.status, "needs_review");
  });

  it("clean from clean → resets to none", () => {
    markNeedsReview(tmp);
    addReviewerPending(tmp, "r", SUBJECT);
    recordReviewerResult(tmp, "r", 0);
    assert.equal(readReviewState(tmp).status, "clean");
    resetReviewState(tmp);
    assert.equal(readReviewState(tmp).status, "none");
  });

  it("clean from needs_review → resets to none", () => {
    markNeedsReview(tmp);
    assert.equal(readReviewState(tmp).status, "needs_review");
    resetReviewState(tmp);
    assert.equal(readReviewState(tmp).status, "none");
  });

  it("clean from none → stays none (no resetReviewState call needed)", () => {
    assert.equal(readReviewState(tmp).status, "none");
    // Poller skips reset when already none
  });
});

describe("poller decision logic (replica)", () => {
  // Replica of the poller's decision branches from review-ui.ts gitDirtyPoller
  function pollerDecision(
    snapshot: string,
    lastSnapshot: string,
    state: { status: string },
  ): "skip" | "markNeedsReview" | "resetReviewState" {
    if (snapshot === lastSnapshot) return "skip";
    if (snapshot) {
      return "markNeedsReview";
    } else {
      if (state.status === "clean" || state.status === "needs_review" || state.status === "has_findings") {
        return "resetReviewState";
      }
      return "skip";
    }
  }

  it("same snapshot → skip", () => {
    assert.equal(pollerDecision("file.ts", "file.ts", { status: "none" }), "skip");
  });

  it("staging-only change (same paths) → skip", () => {
    const unstaged = normalizePorcelain(" M file.ts");
    const staged = normalizePorcelain("M  file.ts");
    assert.equal(unstaged, staged);
    assert.equal(pollerDecision(staged, unstaged, { status: "needs_review" }), "skip");
  });

  it("dirty from clean snapshot → markNeedsReview", () => {
    assert.equal(pollerDecision("file.ts", "", { status: "none" }), "markNeedsReview");
  });

  it("dirty change (different files) → markNeedsReview", () => {
    assert.equal(pollerDecision("a.ts\nb.ts", "a.ts", { status: "needs_review" }), "markNeedsReview");
  });

  it("dirty during in_progress → markNeedsReview (sets edited_during_cycle)", () => {
    assert.equal(pollerDecision("file.ts", "", { status: "in_progress" }), "markNeedsReview");
  });

  it("clean from clean status → resetReviewState", () => {
    assert.equal(pollerDecision("", "file.ts", { status: "clean" }), "resetReviewState");
  });

  it("clean from needs_review → resetReviewState", () => {
    assert.equal(pollerDecision("", "file.ts", { status: "needs_review" }), "resetReviewState");
  });

  it("clean from in_progress → skip (reviewers running)", () => {
    assert.equal(pollerDecision("", "file.ts", { status: "in_progress" }), "skip");
  });

  it("clean from has_findings → resetReviewState (committed+pushed)", () => {
    assert.equal(pollerDecision("", "file.ts", { status: "has_findings" }), "resetReviewState");
  });

  it("clean from none → skip (already none)", () => {
    assert.equal(pollerDecision("", "file.ts", { status: "none" }), "skip");
  });
});

// ── Status line: the reviewed subject must appear, in every state that shows a cycle ──

describe("reviewStatusLine", () => {
  const base = {
    status: "in_progress" as const,
    cycle: 3,
    findings_count: 2,
    tests_passed: false,
    reviewers_pending: ["code-reviewer-security"],
    reviewers_total: 5,
    timestamp: 0,
  };
  const pr = { kind: "pr" as const, repo: "o/r", number: 1056, head_sha: "d1c6e7f0abc" }; // pragma: allowlist secret

  it("names the subject and the cycle while reviewers run", () => {
    const line = reviewStatusLine({ ...base, subject: pr });
    assert.match(line, /Review cycle 3/);
    assert.match(line, /PR #1056 @ d1c6e7f/, "the reviewed PR must be visible");
    assert.match(line, /2 findings/);
    assert.match(line, /waiting: code-reviewer-security/);
  });

  it("names the subject when the review is clean", () => {
    const line = reviewStatusLine({ ...base, status: "clean", tests_passed: true, subject: pr });
    assert.match(line, /Review clean — cycle 3/);
    assert.match(line, /PR #1056 @ d1c6e7f/);
    assert.match(line, /tests passed/);
  });

  it("names the subject when findings need fixing", () => {
    const line = reviewStatusLine({ ...base, status: "has_findings", subject: { kind: "local", head_sha: "abc1234def" } });
    assert.match(line, /cycle 3/);
    assert.match(line, /commit abc1234 \(local\)/);
    assert.match(line, /2 findings — needs fixes/);
  });

  it("says so when a legacy entry has no subject", () => {
    assert.match(reviewStatusLine({ ...base, subject: undefined }), /no subject/);
  });
});

describe("gitDirtyPoller async behavior (#1264)", () => {
  function setupPollerHarness() {
    const tmp = makeTempDir("poller-async-");
    fs.mkdirSync(path.join(tmp, ".pi", "data"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".pi", "pi-config-settings.json"),
      JSON.stringify({ review_loop_enforcement: true, review_loop_max_cycles: 3 }),
    );
    const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
    const pi = {
      registerEntryRenderer() {},
      on(event: string, fn: (event: any, ctx: any) => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      },
      appendEntry() {},
    };
    let activeCalls = 0;
    let maxConcurrent = 0;
    let totalCalls = 0;
    const pending: Array<(res: { stdout: string; code: number }) => void> = [];
    const gitStatusAsync: AsyncGitStatusRunner = (_cwd, cb) => {
      activeCalls += 1;
      totalCalls += 1;
      maxConcurrent = Math.max(maxConcurrent, activeCalls);
      pending.push((res) => {
        activeCalls -= 1;
        cb(res);
      });
    };
    registerReviewUI(pi as any, { gitStatusAsync, gitPollIntervalMs: 15 });
    const ctx = {
      cwd: tmp,
      hasUI: false,
      mode: "interactive",
      ui: { theme: { fg: (_c: string, s: string) => s } },
    };
    for (const h of handlers.get("session_start") ?? []) h({}, ctx);
    const shutdown = () => {
      for (const h of handlers.get("session_shutdown") ?? []) h({}, ctx);
    };
    const cleanup = () => {
      shutdown();
      fs.rmSync(tmp, { recursive: true, force: true });
    };
    return {
      tmp,
      pending,
      shutdown,
      cleanup,
      getTotalCalls: () => totalCalls,
      getMaxConcurrent: () => maxConcurrent,
    };
  }

  it("prevents overlapping git status polls while one is in flight", async () => {
    const h = setupPollerHarness();
    try {
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(h.getTotalCalls(), 1);
      assert.equal(h.getMaxConcurrent(), 1);
    } finally {
      h.cleanup();
    }
  });

  it("transitions dirty tree to needs_review via async poll", async () => {
    const h = setupPollerHarness();
    try {
      await new Promise((r) => setTimeout(r, 35));
      assert.ok(h.pending.length >= 1);
      h.pending.shift()!({ stdout: " M foo.ts", code: 0 });
      assert.equal(readReviewState(h.tmp).status, "needs_review");
    } finally {
      h.cleanup();
    }
  });

  it("resets review state to none after revalidating a clean tree", async () => {
    const h = setupPollerHarness();
    try {
      await new Promise((r) => setTimeout(r, 35));
      h.pending.shift()!({ stdout: " M foo.ts", code: 0 });
      assert.equal(readReviewState(h.tmp).status, "needs_review");

      // Wait briefly so the next poll starts strictly after last_edit_at
      await new Promise((r) => setTimeout(r, 40));
      assert.ok(h.pending.length >= 1);
      // First clean poll triggers a revalidation check before resetting
      h.pending.shift()!({ stdout: "", code: 0 });
      assert.equal(readReviewState(h.tmp).status, "needs_review");
      assert.equal(h.pending.length, 1, "revalidation poll must run before resetting state");
      h.pending.shift()!({ stdout: "", code: 0 });
      assert.equal(readReviewState(h.tmp).status, "none");
    } finally {
      h.cleanup();
    }
  });

  it("does not clear needs_review when an edit lands while a clean poll is in flight", async () => {
    const h = setupPollerHarness();
    try {
      await new Promise((r) => setTimeout(r, 35));
      h.pending.shift()!({ stdout: " M foo.ts", code: 0 });
      assert.equal(readReviewState(h.tmp).status, "needs_review");

      // Next poll starts while tree was transiently clean
      await new Promise((r) => setTimeout(r, 40));
      assert.ok(h.pending.length >= 1);
      const staleCleanCallback = h.pending.shift()!;

      // Intervening edit occurs before the clean callback completes
      markNeedsReview(h.tmp);
      staleCleanCallback({ stdout: "", code: 0 });
      assert.equal(readReviewState(h.tmp).status, "needs_review");
    } finally {
      h.cleanup();
    }
  });

  it("stops scheduling polls after session_shutdown", async () => {
    const h = setupPollerHarness();
    try {
      await new Promise((r) => setTimeout(r, 35));
      h.shutdown();
      const callsAtShutdown = h.getTotalCalls();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(h.getTotalCalls(), callsAtShutdown);
    } finally {
      h.cleanup();
    }
  });

  it("ignores late-resolving poll callbacks after session_shutdown", async () => {
    const h = setupPollerHarness();
    try {
      await new Promise((r) => setTimeout(r, 35));
      const inFlight = h.pending.splice(0);
      assert.ok(inFlight.length >= 1);
      h.shutdown();
      for (const cb of inFlight) cb({ stdout: " M late.ts", code: 0 });
      assert.equal(readReviewState(h.tmp).status, "none");
    } finally {
      h.cleanup();
    }
  });
});
