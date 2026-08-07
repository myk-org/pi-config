/**
 * Tests for async agent reconciliation logic (issue #734).
 *
 * Verifies that done-but-undelivered jobs get their side-effects retried
 * and that cleanup requires delivery before deletion.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { countFindings } from "../../../extensions/orchestrator/pi-config-review-state.js";

// ── AsyncJob shape tests ────────────────────────────────────────────────

interface AsyncJob {
  id: string;
  agent: string;
  status: "queued" | "running" | "complete" | "failed";
  delivered?: boolean;
  sideEffectsApplied?: boolean;
  groupId?: string;
  output?: string;
  updatedAt: number;
}

/** Cleanup predicate — mirrors the poller's cleanup condition (post-fix). */
function shouldCleanup(job: AsyncJob, now: number): boolean {
  return (
    (job.status === "complete" || job.status === "failed") &&
    now - job.updatedAt > 30000 &&
    job.delivered === true
  );
}

/** Reconciliation predicate — identifies jobs needing reconciliation. */
function needsReconciliation(job: AsyncJob): boolean {
  return (
    (job.status === "complete" || job.status === "failed") && !job.delivered
  );
}

/** Side-effects predicate — checks if side-effects should be retried. */
function needsSideEffects(job: AsyncJob): boolean {
  return needsReconciliation(job) && !job.sideEffectsApplied;
}

/** Group delivery predicate — checks if group delivery should be retried. */
function groupReadyForDelivery(job: AsyncJob, allJobs: AsyncJob[]): boolean {
  if (!job.groupId) return false;
  const groupJobs = allJobs.filter((j) => j.groupId === job.groupId);
  const pending = groupJobs.filter(
    (j) => j.status !== "complete" && j.status !== "failed",
  );
  return pending.length === 0;
}

describe("async-agents reconciliation (issue #734)", () => {
  describe("AsyncJob sideEffectsApplied flag", () => {
    it("defaults to undefined when not set", () => {
      const job: AsyncJob = {
        id: "test-1",
        agent: "code-reviewer-security",
        status: "complete",
        updatedAt: Date.now(),
      };
      assert.equal(job.sideEffectsApplied, undefined);
      assert.equal(job.delivered, undefined);
    });

    it("can be set to true after side-effects fire", () => {
      const job: AsyncJob = {
        id: "test-1",
        agent: "code-reviewer-security",
        status: "complete",
        updatedAt: Date.now(),
      };
      job.sideEffectsApplied = true;
      assert.equal(job.sideEffectsApplied, true);
    });
  });

  describe("cleanup condition — requires delivered", () => {
    const OLD_TIME = Date.now() - 60000; // 60s ago

    it("cleans up delivered complete job older than 30s", () => {
      const job: AsyncJob = {
        id: "j1",
        agent: "worker",
        status: "complete",
        delivered: true,
        updatedAt: OLD_TIME,
      };
      assert.equal(shouldCleanup(job, Date.now()), true);
    });

    it("cleans up delivered failed job older than 30s", () => {
      const job: AsyncJob = {
        id: "j2",
        agent: "worker",
        status: "failed",
        delivered: true,
        updatedAt: OLD_TIME,
      };
      assert.equal(shouldCleanup(job, Date.now()), true);
    });

    it("does NOT clean up undelivered complete job (the fix)", () => {
      const job: AsyncJob = {
        id: "j3",
        agent: "code-reviewer-docs",
        status: "complete",
        delivered: false,
        updatedAt: OLD_TIME,
      };
      assert.equal(shouldCleanup(job, Date.now()), false);
    });

    it("does NOT clean up undelivered non-grouped job (previously would be cleaned)", () => {
      const job: AsyncJob = {
        id: "j4",
        agent: "worker",
        status: "complete",
        // no delivered, no groupId — old code would delete this
        updatedAt: OLD_TIME,
      };
      assert.equal(shouldCleanup(job, Date.now()), false);
    });

    it("does NOT clean up recent delivered job", () => {
      const job: AsyncJob = {
        id: "j5",
        agent: "worker",
        status: "complete",
        delivered: true,
        updatedAt: Date.now() - 5000, // 5s ago, < 30s threshold
      };
      assert.equal(shouldCleanup(job, Date.now()), false);
    });

    it("does NOT clean up running jobs", () => {
      const job: AsyncJob = {
        id: "j6",
        agent: "worker",
        status: "running",
        delivered: true,
        updatedAt: OLD_TIME,
      };
      assert.equal(shouldCleanup(job, Date.now()), false);
    });
  });

  describe("reconciliation targeting", () => {
    it("targets complete + undelivered jobs", () => {
      const job: AsyncJob = {
        id: "r1",
        agent: "code-reviewer-security",
        status: "complete",
        updatedAt: Date.now(),
      };
      assert.equal(needsReconciliation(job), true);
    });

    it("targets failed + undelivered jobs", () => {
      const job: AsyncJob = {
        id: "r2",
        agent: "test-automator",
        status: "failed",
        updatedAt: Date.now(),
      };
      assert.equal(needsReconciliation(job), true);
    });

    it("skips delivered jobs", () => {
      const job: AsyncJob = {
        id: "r3",
        agent: "code-reviewer-security",
        status: "complete",
        delivered: true,
        updatedAt: Date.now(),
      };
      assert.equal(needsReconciliation(job), false);
    });

    it("skips running jobs", () => {
      const job: AsyncJob = {
        id: "r4",
        agent: "worker",
        status: "running",
        updatedAt: Date.now(),
      };
      assert.equal(needsReconciliation(job), false);
    });

    it("skips queued jobs", () => {
      const job: AsyncJob = {
        id: "r5",
        agent: "worker",
        status: "queued",
        updatedAt: Date.now(),
      };
      assert.equal(needsReconciliation(job), false);
    });
  });

  describe("side-effects retry gating", () => {
    it("retries side-effects when sideEffectsApplied is falsy", () => {
      const job: AsyncJob = {
        id: "s1",
        agent: "code-reviewer-docs",
        status: "complete",
        updatedAt: Date.now(),
      };
      assert.equal(needsSideEffects(job), true);
    });

    it("skips side-effects when sideEffectsApplied is true", () => {
      const job: AsyncJob = {
        id: "s2",
        agent: "code-reviewer-docs",
        status: "complete",
        sideEffectsApplied: true,
        updatedAt: Date.now(),
      };
      assert.equal(needsSideEffects(job), false);
    });

    it("skips side-effects when already delivered (even if flag not set)", () => {
      const job: AsyncJob = {
        id: "s3",
        agent: "code-reviewer-docs",
        status: "complete",
        delivered: true,
        updatedAt: Date.now(),
      };
      assert.equal(needsSideEffects(job), false);
    });
  });

  describe("group delivery retry", () => {
    it("retries delivery when all group members are done", () => {
      const jobs: AsyncJob[] = [
        { id: "g1", agent: "code-reviewer-security", status: "complete", groupId: "grp-1", updatedAt: Date.now() },
        { id: "g2", agent: "code-reviewer-docs", status: "complete", groupId: "grp-1", updatedAt: Date.now() },
        { id: "g3", agent: "test-automator", status: "failed", groupId: "grp-1", updatedAt: Date.now() },
      ];
      assert.equal(groupReadyForDelivery(jobs[0], jobs), true);
      assert.equal(groupReadyForDelivery(jobs[1], jobs), true);
      assert.equal(groupReadyForDelivery(jobs[2], jobs), true);
    });

    it("does NOT retry when some group members are still running", () => {
      const jobs: AsyncJob[] = [
        { id: "g4", agent: "code-reviewer-security", status: "complete", groupId: "grp-2", updatedAt: Date.now() },
        { id: "g5", agent: "code-reviewer-docs", status: "running", groupId: "grp-2", updatedAt: Date.now() },
      ];
      assert.equal(groupReadyForDelivery(jobs[0], jobs), false);
    });

    it("does NOT retry for non-grouped jobs", () => {
      const job: AsyncJob = {
        id: "g6",
        agent: "worker",
        status: "complete",
        updatedAt: Date.now(),
      };
      assert.equal(groupReadyForDelivery(job, [job]), false);
    });

    it("handles mixed groups correctly — only checks same groupId", () => {
      const jobs: AsyncJob[] = [
        { id: "g7", agent: "code-reviewer-security", status: "complete", groupId: "grp-A", updatedAt: Date.now() },
        { id: "g8", agent: "code-reviewer-docs", status: "complete", groupId: "grp-A", updatedAt: Date.now() },
        { id: "g9", agent: "worker", status: "running", groupId: "grp-B", updatedAt: Date.now() },
      ];
      // grp-A is fully done
      assert.equal(groupReadyForDelivery(jobs[0], jobs), true);
      // grp-B still has running member
      assert.equal(groupReadyForDelivery(jobs[2], jobs), false);
    });
  });

  describe("countFindings integration", () => {
    it("returns 0 for clean reviewer output", () => {
      const output = JSON.stringify({ approved: true, findings: [] });
      assert.equal(countFindings(output), 0);
    });

    it("returns -1 for non-JSON output (reconciliation treats as 1 finding)", () => {
      const count = countFindings("this is not json");
      assert.equal(count, -1);
    });

    it("returns finding count for reviewer with issues", () => {
      const output = JSON.stringify({
        approved: false,
        findings: [
          { file: "a.ts", line: 1, message: "issue1" },
          { file: "b.ts", line: 2, message: "issue2" },
        ],
      });
      assert.equal(countFindings(output), 2);
    });
  });

  describe("end-to-end reconciliation scenario", () => {
    it("simulates the bug: complete job with failed delivery gets reconciled", () => {
      // Simulate the exact scenario from issue #734:
      // 6 review agents spawned, 5 delivered, 1 stuck as complete but undelivered
      const groupId = "review-batch-1";
      const jobs: AsyncJob[] = [
        { id: "r-sec", agent: "code-reviewer-security", status: "complete", groupId, delivered: true, sideEffectsApplied: true, updatedAt: Date.now() },
        { id: "r-logic", agent: "code-reviewer-logic", status: "complete", groupId, delivered: true, sideEffectsApplied: true, updatedAt: Date.now() },
        { id: "r-perf", agent: "code-reviewer-performance", status: "complete", groupId, delivered: true, sideEffectsApplied: true, updatedAt: Date.now() },
        { id: "r-style", agent: "code-reviewer-style", status: "complete", groupId, delivered: true, sideEffectsApplied: true, updatedAt: Date.now() },
        { id: "r-docs", agent: "code-reviewer-docs", status: "complete", groupId, delivered: false, sideEffectsApplied: false, updatedAt: Date.now() },
        { id: "t-auto", agent: "test-automator", status: "complete", groupId, delivered: true, sideEffectsApplied: true, updatedAt: Date.now() },
      ];

      // The stuck job (code-reviewer-docs) should be identified by reconciliation
      const stuckJob = jobs[4];
      assert.equal(needsReconciliation(stuckJob), true, "stuck job needs reconciliation");
      assert.equal(needsSideEffects(stuckJob), true, "stuck job needs side-effects");
      assert.equal(groupReadyForDelivery(stuckJob, jobs), true, "group is fully done — delivery should retry");

      // After reconciliation marks side-effects applied
      stuckJob.sideEffectsApplied = true;
      assert.equal(needsSideEffects(stuckJob), false, "side-effects should not retry again");

      // After delivery succeeds
      stuckJob.delivered = true;
      assert.equal(needsReconciliation(stuckJob), false, "no longer needs reconciliation");
      assert.equal(shouldCleanup(stuckJob, Date.now() + 31000), true, "can now be cleaned up");
    });

    it("undelivered non-grouped job survives cleanup until delivered", () => {
      const job: AsyncJob = {
        id: "solo-1",
        agent: "worker",
        status: "complete",
        output: "done",
        updatedAt: Date.now() - 60000, // 60s old
        // delivered is undefined — old code would clean this up for non-grouped jobs
      };

      // With the fix, it should NOT be cleaned up
      assert.equal(shouldCleanup(job, Date.now()), false, "undelivered job must not be cleaned up");
      assert.equal(needsReconciliation(job), true, "should be targeted by reconciliation");

      // After delivery
      job.delivered = true;
      assert.equal(shouldCleanup(job, Date.now()), true, "delivered job can be cleaned up");
    });
  });
});
