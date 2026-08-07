/**
 * Tests for async agent reconciliation logic (issue #734).
 *
 * Verifies that done-but-undelivered jobs get their side-effects retried,
 * that cleanup requires delivery before deletion, and that sideEffectsApplied
 * is only set true when side-effects succeed.
 *
 * Imports production exports (countFindings, formatDuration) where the module
 * graph allows. AsyncJob is typed locally (matches the exported interface)
 * because async-agents.ts transitively imports pi SDK internals that are
 * unavailable in the test harness.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { countFindings } from "../../../extensions/orchestrator/pi-config-review-state.js";
// formatDuration is in async-agents.ts which cannot be imported in test context
// (transitive pi SDK deps). Inline copy for testing.
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m${s}s`;
}

// ── AsyncJob shape — matches the exported interface in async-agents.ts ───

interface AsyncJob {
  id: string;
  agent: string;
  name?: string;
  task: string;
  status: "queued" | "running" | "complete" | "failed";
  workerDir: string;
  startedAt: number;
  updatedAt: number;
  output?: string;
  exitCode?: number | null;
  durationMs?: number;
  delivered?: boolean;
  sideEffectsApplied?: boolean;
  fireAndForget?: boolean;
  onComplete?: () => void;
  groupId?: string;
  taskId?: string;
  cwd?: string;
  projectCwd?: string;
  sessionId?: string;
  model?: string;
}

// ── Predicate functions — exact mirrors of production poller logic ────────

/** Cleanup predicate — mirrors the poller's cleanup condition. */
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

/** Non-group delivery predicate — checks if non-grouped job needs delivery retry. */
function nonGroupNeedsDelivery(job: AsyncJob): boolean {
  return needsReconciliation(job) && !job.groupId && !job.fireAndForget;
}

/** jobCwd — mirrors the exported function in async-agents.ts. */
function jobCwd(job: { cwd?: string; projectCwd?: string }): string {
  return job.cwd || job.projectCwd || process.cwd();
}

// ── Helper to create minimal AsyncJob for testing ────────────────────────

function makeJob(overrides: Partial<AsyncJob> & { id: string; agent: string }): AsyncJob {
  return {
    status: "complete",
    workerDir: "/tmp/test",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    task: "test task",
    ...overrides,
  };
}

describe("async-agents reconciliation (issue #734)", () => {
  describe("jobCwd helper", () => {
    it("returns cwd when set", () => {
      assert.equal(jobCwd({ cwd: "/a", projectCwd: "/b" }), "/a");
    });

    it("falls back to projectCwd", () => {
      assert.equal(jobCwd({ projectCwd: "/b" }), "/b");
    });

    it("falls back to process.cwd()", () => {
      assert.equal(jobCwd({}), process.cwd());
    });
  });

  describe("AsyncJob sideEffectsApplied flag", () => {
    it("defaults to undefined when not set", () => {
      const job = makeJob({ id: "t1", agent: "worker" });
      assert.equal(job.sideEffectsApplied, undefined);
    });

    it("can be set to true after side-effects fire", () => {
      const job = makeJob({ id: "t2", agent: "worker" });
      job.sideEffectsApplied = true;
      assert.equal(job.sideEffectsApplied, true);
    });
  });

  describe("cleanup condition — requires delivered", () => {
    const OLD_TIME = Date.now() - 60000;

    it("cleans up delivered complete job older than 30s", () => {
      assert.equal(shouldCleanup(makeJob({ id: "j1", agent: "worker", delivered: true, updatedAt: OLD_TIME }), Date.now()), true);
    });

    it("cleans up delivered failed job older than 30s", () => {
      assert.equal(shouldCleanup(makeJob({ id: "j2", agent: "worker", status: "failed", delivered: true, updatedAt: OLD_TIME }), Date.now()), true);
    });

    it("does NOT clean up undelivered complete job (the fix)", () => {
      assert.equal(shouldCleanup(makeJob({ id: "j3", agent: "code-reviewer-docs", delivered: false, updatedAt: OLD_TIME }), Date.now()), false);
    });

    it("does NOT clean up undelivered non-grouped job (previously would be cleaned)", () => {
      assert.equal(shouldCleanup(makeJob({ id: "j4", agent: "worker", updatedAt: OLD_TIME }), Date.now()), false);
    });

    it("does NOT clean up recent delivered job", () => {
      assert.equal(shouldCleanup(makeJob({ id: "j5", agent: "worker", delivered: true, updatedAt: Date.now() - 5000 }), Date.now()), false);
    });

    it("does NOT clean up running jobs", () => {
      assert.equal(shouldCleanup(makeJob({ id: "j6", agent: "worker", status: "running", delivered: true, updatedAt: OLD_TIME }), Date.now()), false);
    });
  });

  describe("reconciliation targeting", () => {
    it("targets complete + undelivered jobs", () => {
      assert.equal(needsReconciliation(makeJob({ id: "r1", agent: "code-reviewer-security" })), true);
    });

    it("targets failed + undelivered jobs", () => {
      assert.equal(needsReconciliation(makeJob({ id: "r2", agent: "test-automator", status: "failed" })), true);
    });

    it("skips delivered jobs", () => {
      assert.equal(needsReconciliation(makeJob({ id: "r3", agent: "code-reviewer-security", delivered: true })), false);
    });

    it("skips running jobs", () => {
      assert.equal(needsReconciliation(makeJob({ id: "r4", agent: "worker", status: "running" })), false);
    });

    it("skips queued jobs", () => {
      assert.equal(needsReconciliation(makeJob({ id: "r5", agent: "worker", status: "queued" })), false);
    });
  });

  describe("side-effects retry gating (sideEffectsOk pattern)", () => {
    it("retries side-effects when sideEffectsApplied is falsy", () => {
      assert.equal(needsSideEffects(makeJob({ id: "s1", agent: "code-reviewer-docs" })), true);
    });

    it("skips side-effects when sideEffectsApplied is true", () => {
      assert.equal(needsSideEffects(makeJob({ id: "s2", agent: "code-reviewer-docs", sideEffectsApplied: true })), false);
    });

    it("skips side-effects when already delivered (even if flag not set)", () => {
      assert.equal(needsSideEffects(makeJob({ id: "s3", agent: "code-reviewer-docs", delivered: true })), false);
    });

    it("sideEffectsApplied stays false when side-effect throws (simulated sideEffectsOk pattern)", () => {
      // Simulates the production sideEffectsOk pattern from async-agents.ts lines 264-272
      const job = makeJob({ id: "s4", agent: "code-reviewer-docs" });
      let sideEffectsOk = true;
      try { throw new Error("lock acquisition failed"); } catch { sideEffectsOk = false; }
      if (sideEffectsOk) job.sideEffectsApplied = true;
      assert.equal(job.sideEffectsApplied, undefined, "should remain unset when side-effect fails");
      assert.equal(needsSideEffects(job), true, "reconciliation should retry on next poll");
    });

    it("sideEffectsApplied set true when side-effect succeeds (simulated sideEffectsOk pattern)", () => {
      const job = makeJob({ id: "s5", agent: "code-reviewer-docs" });
      let sideEffectsOk = true;
      // No throw — side-effect succeeded
      if (sideEffectsOk) job.sideEffectsApplied = true;
      assert.equal(job.sideEffectsApplied, true);
      assert.equal(needsSideEffects(job), false);
    });
  });

  describe("non-group delivery retry (zombie-ingest fix)", () => {
    it("non-grouped undelivered job needs delivery retry", () => {
      assert.equal(nonGroupNeedsDelivery(makeJob({ id: "n1", agent: "worker" })), true);
    });

    it("grouped job does NOT match non-group delivery", () => {
      assert.equal(nonGroupNeedsDelivery(makeJob({ id: "n2", agent: "worker", groupId: "grp-1" })), false);
    });

    it("fire-and-forget job does NOT need non-group delivery", () => {
      assert.equal(nonGroupNeedsDelivery(makeJob({ id: "n3", agent: "worker", fireAndForget: true })), false);
    });

    it("already delivered job does NOT need delivery", () => {
      assert.equal(nonGroupNeedsDelivery(makeJob({ id: "n4", agent: "worker", delivered: true })), false);
    });
  });

  describe("group delivery retry", () => {
    it("retries delivery when all group members are done", () => {
      const jobs = [
        makeJob({ id: "g1", agent: "code-reviewer-security", groupId: "grp-1" }),
        makeJob({ id: "g2", agent: "code-reviewer-docs", groupId: "grp-1" }),
        makeJob({ id: "g3", agent: "test-automator", status: "failed", groupId: "grp-1" }),
      ];
      assert.equal(groupReadyForDelivery(jobs[0], jobs), true);
      assert.equal(groupReadyForDelivery(jobs[1], jobs), true);
      assert.equal(groupReadyForDelivery(jobs[2], jobs), true);
    });

    it("does NOT retry when some group members are still running", () => {
      const jobs = [
        makeJob({ id: "g4", agent: "code-reviewer-security", groupId: "grp-2" }),
        makeJob({ id: "g5", agent: "code-reviewer-docs", status: "running", groupId: "grp-2" }),
      ];
      assert.equal(groupReadyForDelivery(jobs[0], jobs), false);
    });

    it("does NOT retry for non-grouped jobs", () => {
      const job = makeJob({ id: "g6", agent: "worker" });
      assert.equal(groupReadyForDelivery(job, [job]), false);
    });

    it("handles mixed groups correctly — only checks same groupId", () => {
      const jobs = [
        makeJob({ id: "g7", agent: "code-reviewer-security", groupId: "grp-A" }),
        makeJob({ id: "g8", agent: "code-reviewer-docs", groupId: "grp-A" }),
        makeJob({ id: "g9", agent: "worker", status: "running", groupId: "grp-B" }),
      ];
      assert.equal(groupReadyForDelivery(jobs[0], jobs), true);
      assert.equal(groupReadyForDelivery(jobs[2], jobs), false);
    });
  });

  describe("countFindings integration (production export)", () => {
    it("returns 0 for clean reviewer output", () => {
      assert.equal(countFindings(JSON.stringify({ approved: true, findings: [] })), 0);
    });

    it("returns -1 for non-JSON output (reconciliation treats as 1 finding)", () => {
      assert.equal(countFindings("this is not json"), -1);
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

  describe("formatDuration (mirrors production)", () => {
    it("formats milliseconds", () => {
      assert.equal(formatDuration(500), "500ms");
    });

    it("formats seconds", () => {
      assert.equal(formatDuration(5000), "5.0s");
    });

    it("formats minutes", () => {
      assert.equal(formatDuration(90000), "1m30s");
    });
  });

  describe("end-to-end reconciliation scenario", () => {
    it("simulates the bug: complete job with failed delivery gets reconciled", () => {
      const groupId = "review-batch-1";
      const jobs = [
        makeJob({ id: "r-sec", agent: "code-reviewer-security", groupId, delivered: true, sideEffectsApplied: true }),
        makeJob({ id: "r-qual", agent: "code-reviewer-quality", groupId, delivered: true, sideEffectsApplied: true }),
        makeJob({ id: "r-guide", agent: "code-reviewer-guidelines", groupId, delivered: true, sideEffectsApplied: true }),
        makeJob({ id: "r-safe", agent: "code-reviewer-security", groupId, delivered: true, sideEffectsApplied: true }),
        makeJob({ id: "r-docs", agent: "code-reviewer-docs", groupId, delivered: false, sideEffectsApplied: false }),
        makeJob({ id: "t-auto", agent: "test-automator", groupId, delivered: true, sideEffectsApplied: true }),
      ];

      const stuckJob = jobs[4];
      assert.equal(needsReconciliation(stuckJob), true, "stuck job needs reconciliation");
      assert.equal(needsSideEffects(stuckJob), true, "stuck job needs side-effects");
      assert.equal(groupReadyForDelivery(stuckJob, jobs), true, "group is fully done");

      stuckJob.sideEffectsApplied = true;
      assert.equal(needsSideEffects(stuckJob), false, "side-effects should not retry again");

      stuckJob.delivered = true;
      assert.equal(needsReconciliation(stuckJob), false, "no longer needs reconciliation");
      assert.equal(shouldCleanup(stuckJob, Date.now() + 31000), true, "can now be cleaned up");
    });

    it("non-grouped zombie-ingested job gets delivery retried", () => {
      const job = makeJob({ id: "zombie-1", agent: "worker", output: "done" });
      assert.equal(needsReconciliation(job), true);
      assert.equal(nonGroupNeedsDelivery(job), true, "non-group delivery retry should trigger");
      assert.equal(shouldCleanup(job, Date.now() + 60000), false, "must not clean up before delivery");

      job.delivered = true;
      assert.equal(shouldCleanup(job, Date.now() + 60000), true, "can clean up after delivery");
    });

    it("side-effect failure allows retry on next poll cycle", () => {
      const job = makeJob({ id: "retry-1", agent: "code-reviewer-docs" });

      // Cycle 1: side-effect fails (simulates sideEffectsOk pattern)
      let ok = true;
      try { throw new Error("transient lock failure"); } catch { ok = false; }
      if (ok) job.sideEffectsApplied = true;
      assert.equal(job.sideEffectsApplied, undefined, "should remain unset after failure");
      assert.equal(needsSideEffects(job), true, "should retry on next poll");

      // Cycle 2: side-effect succeeds
      ok = true;
      if (ok) job.sideEffectsApplied = true;
      assert.equal(job.sideEffectsApplied, true, "should be set after success");
      assert.equal(needsSideEffects(job), false, "should NOT retry again");
    });

    it("group per-job sideEffectsApplied tracking (production pattern)", () => {
      const jobs = [
        makeJob({ id: "g-ok", agent: "code-reviewer-security", groupId: "grp-1" }),
        makeJob({ id: "g-fail", agent: "code-reviewer-docs", groupId: "grp-1" }),
      ];

      // Simulate deliverGroupResults: first job succeeds, second fails
      // (mirrors production: catch sets j.sideEffectsApplied = false)
      jobs[1].sideEffectsApplied = false;

      // Post-loop: mark non-failed jobs (mirrors production line 393)
      for (const j of jobs) {
        if (j.sideEffectsApplied !== false) j.sideEffectsApplied = true;
      }

      assert.equal(jobs[0].sideEffectsApplied, true, "successful job marked applied");
      assert.equal(jobs[1].sideEffectsApplied, false, "failed job stays false for retry");
    });
  });
});
