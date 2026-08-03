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
} from "../../../extensions/orchestrator/pi-config-review-state.js";

describe("poller state transitions", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "poller-test-"));
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
    addReviewerPending(tmp, "test-reviewer");
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
    addReviewerPending(tmp, "test-reviewer");
    recordReviewerResult(tmp, "test-reviewer", 3);
    const hf = readReviewState(tmp);
    assert.equal(hf.status, "has_findings");
    markNeedsReview(tmp);
    const after = readReviewState(tmp);
    assert.equal(after.status, "needs_review");
  });

  it("dirty during in_progress → sets edited_during_cycle", () => {
    markNeedsReview(tmp);
    addReviewerPending(tmp, "test-reviewer");
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
    addReviewerPending(tmp, "r");
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
      if (state.status === "clean" || state.status === "needs_review") {
        return "resetReviewState";
      }
      return "skip";
    }
  }

  it("same snapshot → skip", () => {
    assert.equal(pollerDecision("M file.ts", "M file.ts", { status: "none" }), "skip");
  });

  it("dirty from clean snapshot → markNeedsReview", () => {
    assert.equal(pollerDecision("M file.ts", "", { status: "none" }), "markNeedsReview");
  });

  it("dirty change (different files) → markNeedsReview", () => {
    assert.equal(pollerDecision("M a.ts\nM b.ts", "M a.ts", { status: "needs_review" }), "markNeedsReview");
  });

  it("dirty during in_progress → markNeedsReview (sets edited_during_cycle)", () => {
    assert.equal(pollerDecision("M file.ts", "", { status: "in_progress" }), "markNeedsReview");
  });

  it("clean from clean status → resetReviewState", () => {
    assert.equal(pollerDecision("", "M file.ts", { status: "clean" }), "resetReviewState");
  });

  it("clean from needs_review → resetReviewState", () => {
    assert.equal(pollerDecision("", "M file.ts", { status: "needs_review" }), "resetReviewState");
  });

  it("clean from in_progress → skip (reviewers running)", () => {
    assert.equal(pollerDecision("", "M file.ts", { status: "in_progress" }), "skip");
  });

  it("clean from has_findings → skip (review results pending)", () => {
    assert.equal(pollerDecision("", "M file.ts", { status: "has_findings" }), "skip");
  });

  it("clean from none → skip (already none)", () => {
    assert.equal(pollerDecision("", "M file.ts", { status: "none" }), "skip");
  });
});
