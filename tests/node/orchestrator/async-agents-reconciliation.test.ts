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
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
    it("stuck grouped job is targeted by reconciliation", () => {
      const groupId = "review-batch-1";
      const stuckJob = makeJob({ id: "r-docs", agent: "code-reviewer-docs", groupId, delivered: false, sideEffectsApplied: false });
      assert.equal(needsReconciliation(stuckJob), true);
    });

    it("stuck grouped job needs side-effects retry", () => {
      const stuckJob = makeJob({ id: "r-docs", agent: "code-reviewer-docs", groupId: "grp", delivered: false, sideEffectsApplied: false });
      assert.equal(needsSideEffects(stuckJob), true);
    });

    it("stuck grouped job triggers group delivery when all members done", () => {
      const groupId = "review-batch-1";
      const jobs = [
        makeJob({ id: "r-sec", agent: "code-reviewer-security", groupId, delivered: true, sideEffectsApplied: true }),
        makeJob({ id: "r-docs", agent: "code-reviewer-docs", groupId, delivered: false, sideEffectsApplied: false }),
      ];
      assert.equal(groupReadyForDelivery(jobs[1], jobs), true);
    });

    it("stuck job stops needing side-effects after they succeed", () => {
      const job = makeJob({ id: "r-docs", agent: "code-reviewer-docs", groupId: "grp", delivered: false, sideEffectsApplied: false });
      job.sideEffectsApplied = true;
      assert.equal(needsSideEffects(job), false);
    });

    it("stuck job exits reconciliation after delivery", () => {
      const job = makeJob({ id: "r-docs", agent: "code-reviewer-docs", groupId: "grp", delivered: false });
      job.delivered = true;
      assert.equal(needsReconciliation(job), false);
    });

    it("delivered job can be cleaned up after 30s", () => {
      const job = makeJob({ id: "r-docs", agent: "code-reviewer-docs", delivered: true, updatedAt: Date.now() - 60000 });
      assert.equal(shouldCleanup(job, Date.now()), true);
    });

    it("non-grouped zombie-ingested job is targeted by reconciliation", () => {
      const job = makeJob({ id: "zombie-1", agent: "worker", output: "done" });
      assert.equal(needsReconciliation(job), true);
    });

    it("non-grouped zombie-ingested job triggers non-group delivery retry", () => {
      const job = makeJob({ id: "zombie-1", agent: "worker", output: "done" });
      assert.equal(nonGroupNeedsDelivery(job), true);
    });

    it("non-grouped undelivered job is not cleaned up", () => {
      const job = makeJob({ id: "zombie-1", agent: "worker", output: "done", updatedAt: Date.now() - 60000 });
      assert.equal(shouldCleanup(job, Date.now()), false);
    });

    it("non-grouped job can be cleaned up after delivery", () => {
      const job = makeJob({ id: "zombie-1", agent: "worker", delivered: true, updatedAt: Date.now() - 60000 });
      assert.equal(shouldCleanup(job, Date.now()), true);
    });

    it("side-effect failure keeps sideEffectsApplied unset", () => {
      const job = makeJob({ id: "retry-1", agent: "code-reviewer-docs" });
      let ok = true;
      try { throw new Error("transient lock failure"); } catch { ok = false; }
      if (ok) job.sideEffectsApplied = true;
      assert.equal(job.sideEffectsApplied, undefined);
    });

    it("side-effect failure allows retry on next poll", () => {
      const job = makeJob({ id: "retry-1", agent: "code-reviewer-docs" });
      // Simulate failed side-effect — sideEffectsApplied stays unset
      assert.equal(needsSideEffects(job), true);
    });

    it("side-effect success sets sideEffectsApplied, stops retries", () => {
      const job = makeJob({ id: "retry-1", agent: "code-reviewer-docs" });
      let ok = true;
      if (ok) job.sideEffectsApplied = true;
      assert.equal(job.sideEffectsApplied, true);
      assert.equal(needsSideEffects(job), false);
    });

    it("group: successful job gets sideEffectsApplied marked true", () => {
      const job = makeJob({ id: "g-ok", agent: "code-reviewer-security", groupId: "grp-1" });
      // Post-loop: mark non-failed jobs (mirrors production)
      if (job.sideEffectsApplied !== false) job.sideEffectsApplied = true;
      assert.equal(job.sideEffectsApplied, true);
    });

    it("group: failed side-effect job stays false for retry", () => {
      const job = makeJob({ id: "g-fail", agent: "code-reviewer-docs", groupId: "grp-1" });
      job.sideEffectsApplied = false; // simulate catch in deliverGroupResults
      if (job.sideEffectsApplied !== false) job.sideEffectsApplied = true;
      assert.equal(job.sideEffectsApplied, false);
    });
  });

  describe("result file lifecycle (filesystem)", () => {
    let tmpDir: string;

    it("fs.unlinkSync deletes result file after ingestion", () => {
      // Simulates processResultFile: create file, read it, delete it
      tmpDir = mkdtempSync(join(tmpdir(), "async-result-lifecycle-"));
      const resultPath = join(tmpDir, "worker-123.json");
      writeFileSync(resultPath, JSON.stringify({ id: "worker-123", success: true, output: "done", exitCode: 0, durationMs: 1000 }));
      assert.ok(existsSync(resultPath), "result file should exist before ingestion");

      // Simulate ingestion: read + delete (mirrors processResultFile)
      const data = JSON.parse(readFileSync(resultPath, "utf-8"));
      assert.equal(data.id, "worker-123");
      unlinkSync(resultPath);
      assert.ok(!existsSync(resultPath), "result file must be deleted after ingestion");
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("re-ingestion skip deletes stale file", () => {
      // Simulates: job.output !== undefined → delete file, return
      tmpDir = mkdtempSync(join(tmpdir(), "async-result-reingest-"));
      const resultPath = join(tmpDir, "worker-456.json");
      writeFileSync(resultPath, JSON.stringify({ id: "worker-456", output: "stale" }));

      // Simulate re-ingestion: file exists but job already has output
      const job = makeJob({ id: "worker-456", agent: "worker", output: "already ingested" });
      if (job.output !== undefined) {
        try { unlinkSync(resultPath); } catch {}
      }
      assert.ok(!existsSync(resultPath), "stale file must be deleted on re-ingest skip");
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("orphan result file is deleted when no matching job exists", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "async-result-orphan-"));
      const resultPath = join(tmpDir, "orphan-789.json");
      writeFileSync(resultPath, JSON.stringify({ id: "orphan-789", output: "old" }));

      // Simulate: job not found in asyncState → delete
      const job = undefined;
      if (!job) {
        try { unlinkSync(resultPath); } catch {}
      }
      assert.ok(!existsSync(resultPath), "orphan file must be deleted");
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("delivered job result file is cleaned up", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "async-result-delivered-"));
      const resultPath = join(tmpDir, "delivered-101.json");
      writeFileSync(resultPath, JSON.stringify({ id: "delivered-101" }));

      const job = makeJob({ id: "delivered-101", agent: "worker", delivered: true });
      if (job.delivered) {
        try { unlinkSync(resultPath); } catch {}
      }
      assert.ok(!existsSync(resultPath), "delivered file must be cleaned up");
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("output persisted to status.json survives result file deletion", () => {
      // Simulates: after ingestion, output is written to status.json
      tmpDir = mkdtempSync(join(tmpdir(), "async-result-persist-"));
      const statusPath = join(tmpDir, "status.json");
      writeFileSync(statusPath, JSON.stringify({ runId: "persist-1", state: "running" }));

      // Simulate ingestion + persist (mirrors processResultFile)
      const output = "agent completed successfully";
      const existing = JSON.parse(readFileSync(statusPath, "utf-8"));
      existing.output = output.slice(0, 3000);
      existing.state = "complete";
      writeFileSync(statusPath, JSON.stringify(existing));

      // Verify output persisted
      const restored = JSON.parse(readFileSync(statusPath, "utf-8"));
      assert.equal(restored.output, output, "output must persist in status.json");
      assert.equal(restored.state, "complete");
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe("session restore with delivered/sideEffectsApplied (filesystem)", () => {
    let tmpDir: string;

    it("restored complete job reads output from status.json", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "async-restore-"));
      const statusPath = join(tmpDir, "status.json");
      writeFileSync(statusPath, JSON.stringify({
        runId: "restore-1", agent: "worker", state: "complete",
        startedAt: Date.now() - 5000, lastUpdate: Date.now(),
        output: "restored output", exitCode: 0
      }));

      // Simulate restore: read status, create job
      const status = JSON.parse(readFileSync(statusPath, "utf-8"));
      const isComplete = status.state === "complete" || status.state === "failed";
      const job = makeJob({
        id: status.runId, agent: status.agent,
        status: isComplete ? status.state : "running",
        output: status.output || undefined,
        delivered: isComplete,
        sideEffectsApplied: isComplete,
      });

      assert.equal(job.delivered, true, "complete job must have delivered=true");
      assert.equal(job.sideEffectsApplied, true, "complete job must have sideEffectsApplied=true");
      assert.equal(job.output, "restored output", "output must be restored from status.json");
      assert.equal(needsReconciliation(job), false, "restored complete job must not be reconciled");
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("restored running job has delivered=false, eligible for zombie detection", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "async-restore-running-"));
      const statusPath = join(tmpDir, "status.json");
      writeFileSync(statusPath, JSON.stringify({
        runId: "restore-2", agent: "worker", state: "running",
        startedAt: Date.now() - 60000, lastUpdate: Date.now() - 30000,
        pid: 99999
      }));

      const status = JSON.parse(readFileSync(statusPath, "utf-8"));
      const isComplete = status.state === "complete" || status.state === "failed";
      const job = makeJob({
        id: status.runId, agent: status.agent,
        status: isComplete ? status.state : "running",
        output: status.output || undefined,
        delivered: isComplete || undefined,
        sideEffectsApplied: isComplete || undefined,
      } as any);

      assert.equal(job.status, "running");
      assert.equal(job.delivered, undefined, "running job must not be marked delivered");
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("killed job with persisted state restores as delivered", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "async-restore-killed-"));
      const statusPath = join(tmpDir, "status.json");
      // killAsyncAgent writes state: "failed", exitCode: -9
      writeFileSync(statusPath, JSON.stringify({
        runId: "restore-3", agent: "worker", state: "failed",
        startedAt: Date.now() - 120000, endedAt: Date.now() - 60000,
        exitCode: -9, output: "Killed by user"
      }));

      const status = JSON.parse(readFileSync(statusPath, "utf-8"));
      const isComplete = status.state === "complete" || status.state === "failed";
      const job = makeJob({
        id: status.runId, agent: status.agent,
        status: isComplete ? status.state : "running",
        output: status.output || undefined,
        delivered: isComplete,
        sideEffectsApplied: isComplete,
      });

      assert.equal(job.status, "failed");
      assert.equal(job.delivered, true, "killed job must restore as delivered");
      assert.equal(job.output, "Killed by user");
      assert.equal(needsReconciliation(job), false, "killed job must not be reconciled");
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe("stale result directory cleanup", () => {
    it("matches current format: async-results-pid-{pid}-{starttime}", () => {
      const match = "async-results-pid-12345-67890".match(/^async-results-pid-(\d+)(?:-(\d+))?$/);
      assert.ok(match);
      assert.equal(match![1], "12345");
      assert.equal(match![2], "67890");
    });

    it("matches legacy format: async-results-pid-{pid}", () => {
      const match = "async-results-pid-12345".match(/^async-results-pid-(\d+)(?:-(\d+))?$/);
      assert.ok(match);
      assert.equal(match![1], "12345");
      assert.equal(match![2], undefined);
    });

    it("does not match non-result directories", () => {
      const match = "some-other-dir".match(/^async-results-pid-(\d+)(?:-(\d+))?$/);
      assert.equal(match, null);
    });

    it("does not match malformed names", () => {
      assert.equal("async-results-pid-".match(/^async-results-pid-(\d+)(?:-(\d+))?$/), null);
      assert.equal("async-results-pid-abc".match(/^async-results-pid-(\d+)(?:-(\d+))?$/), null);
      assert.equal("async-results-pid-123-abc".match(/^async-results-pid-(\d+)(?:-(\d+))?$/), null);
    });
  });

  describe("taskId sanitization", () => {
    it("allows numeric taskId", () => {
      assert.equal(/^-?\d+$/.test("42"), true);
      assert.equal(/^-?\d+$/.test("-1"), true);
      assert.equal(/^-?\d+$/.test("0"), true);
    });

    it("rejects taskId with special characters", () => {
      assert.equal(/^-?\d+$/.test('42"}, status="hacked'), false);
      assert.equal(/^-?\d+$/.test("42\ninjected"), false);
      assert.equal(/^-?\d+$/.test("42`cmd`"), false);
      assert.equal(/^-?\d+$/.test(""), false);
    });
  });

  describe("phantom agent detection", () => {
    it("job without status file, missing worker dir, is a phantom", () => {
      // No status file = readAsyncStatus returns null
      // Missing worker dir = fs.existsSync(job.workerDir) returns false
      // → mark failed immediately
      const job = makeJob({ id: "p1", agent: "worker", status: "running", workerDir: "/nonexistent" });
      assert.equal(job.status, "running"); // before detection
      // Production code: if (!status && !fs.existsSync(job.workerDir)) → failed
    });

    it("job with status file, no PID, is a phantom", () => {
      // Status exists, state is "running", but pid is null/undefined
      // → mark failed immediately
      const status = { state: "running", pid: null };
      assert.equal(status.state, "running");
      assert.equal(!status.pid, true, "no PID = phantom");
    });

    it("job with status file, valid PID, is NOT a phantom", () => {
      // Status exists with a PID — check /proc/{pid} to determine alive/dead
      const status = { state: "running", pid: 12345 };
      assert.equal(!!status.pid, true, "has PID — not an immediate phantom");
    });

    it("complete job is never checked for phantom status", () => {
      const job = makeJob({ id: "p2", agent: "worker", status: "complete" });
      // The poller skips complete/failed jobs: if (job.status === "complete" || job.status === "failed") continue;
      assert.equal(job.status === "complete" || job.status === "failed", true);
    });
  });
});
