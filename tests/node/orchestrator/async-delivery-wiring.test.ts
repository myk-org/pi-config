import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chainStoppedNote, firePendingCompletions, planSpawnExitRecovery, recoverStalledChainHooks, registerAsyncAgents } from "../../../extensions/orchestrator/async-agents.js";
import { addReviewerPending, markNeedsReview, markTestsPassed, readReviewState, recordReviewerResult, resetReviewState } from "../../../extensions/orchestrator/pi-config-review-state.js";
import { createLogger } from "../../../extensions/shared/logger.js";
import { getPiLogPath, setGlobalSessionId, setLogLevelPin } from "../../../extensions/shared/file-logger.js";
import { makeTempDir } from "../helpers/temp-dirs.js";


const log = createLogger("async-delivery-wiring-test");
setGlobalSessionId("async-delivery-wiring-test");

/** Log trail of async-agents.ts, read from an offset so each assertion sees only its own lines. */
function asyncLogOffset(): number {
  const path = getPiLogPath("async_agents");
  return path && existsSync(path) ? readFileSync(path, "utf-8").length : 0;
}

function asyncLogSince(offset: number): string {
  const path = getPiLogPath("async_agents");
  return path && existsSync(path) ? readFileSync(path, "utf-8").slice(offset) : "";
}
const reviewerOutput = JSON.stringify({ findings: Array.from({ length: 100 }, () => ({ detail: "sensitive ".repeat(80) })) });

function harness(options: { cwd?: string } = {}) {
  log.debug("create_harness");
  const cwd = options.cwd ?? makeTempDir("async-delivery-runtime-");
  const handlers = new Map<string, Array<(event: unknown, ctx: any) => void>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const events = new EventEmitter();
  const messages: any[] = [];
  let rejectedSends = 0;
  let poller: (() => void) | undefined;
  const previousSetInterval = global.setInterval;
  global.setInterval = ((fn: () => void) => {
    log.debug("register_poller");
    poller = fn;
    return { unref() {}, [Symbol.toPrimitive]: () => 0 };
  }) as typeof setInterval;
  const pi = {
    on(event: string, handler: (event: unknown, ctx: any) => void) { (handlers.get(event) ?? handlers.set(event, []).get(event)!).push(handler); },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, command); },
    sendMessage(message: any) { if (rejectedSends-- > 0) throw new Error("temporary delivery failure"); messages.push(message); },
    events,
  };
  const api = registerAsyncAgents(pi as any, () => {}, {
    spawnProcess: () => Object.assign(new EventEmitter(), { stderr: { pipe() {} } }),
    discoverAgents: () => ({ agents: [{ name: "worker" }], sources: [] }),
  });
  let overlayOpens = 0;
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      theme: { fg: (_: string, value: string) => value },
      custom: async () => { overlayOpens++; return null; },
      notify() {},
    },
    sessionManager: { getCwd: () => cwd, getSessionId: () => "test" },
  };
  handlers.get("session_start")![0]({}, ctx);
  const resultDir = () => join(cwd, ".pi", "tmp", readdirSync(join(cwd, ".pi", "tmp")).find(name => name.startsWith(`async-results-pid-${process.pid}`))!);
  const result = (id: string, output = reviewerOutput, agent = "code-reviewer-runtime", data: { status?: object; success?: boolean; exitCode?: number } = {}) => {
    const { status = {}, success = true, exitCode = success ? 0 : 1 } = data;
    log.debug("write_result", { id, agent, success, exitCode });
    writeFileSync(join(cwd, ".pi", "tmp", id, "status.json"), JSON.stringify({ runId: id, state: "running", pid: process.pid, ...status }));
    writeFileSync(join(resultDir(), `${id}.json`), JSON.stringify({ id, agent, task: "review", success, output, durationMs: 1, exitCode }));
    // Formatter tests drive the real fallback instead of depending on host inotify capacity.
    triggerPoller();
  };
  const spawn = (groupId?: string, agent = "code-reviewer-runtime") => api.spawnAsyncAgent(agent, "review", cwd, [{ name: agent } as any], { groupId });
  const triggerPoller = () => {
    assert.ok(poller, "async poller should be registered");
    poller();
  };
  return { cwd, api, commands, ctx, events, messages, overlayOpens: () => overlayOpens, result, resultDir, spawn, triggerPoller, rejectNextSend: () => { rejectedSends += 1; }, restore: () => { try { handlers.get("session_shutdown")![0]({}, ctx); } finally { global.setInterval = previousSetInterval; rmSync(cwd, { recursive: true, force: true }); } } };
}

async function eventually(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "async delivery did not settle before deadline");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function hasPersistedOutput(cwd: string, id: string): boolean {
  try { return "output" in JSON.parse(readFileSync(join(cwd, ".pi", "tmp", id, "status.json"), "utf8")); }
  catch { return false; }
}

describe("async delivery formatter runtime wiring (issue #803)", () => {
  it("delivers fixture results without waiting for filesystem notifications", () => {
    const h = harness();
    try {
      const job = h.spawn();
      h.result(job.id);
      assert.equal(h.messages.length, 1);
      assert.match(h.messages[0].content, /"truncated":true/);
    } finally { h.restore(); }
  });

  it("formats immediate reviewer delivery through registered async agents", async () => {
    const h = harness();
    try { const job = h.spawn(); h.result(job.id); await eventually(() => h.messages.length === 1); assert.match(h.messages[0].content, /"truncated":true/); } finally { h.restore(); }
  });

  it("formats persisted reviewer status through registered async agents", async () => {
    const h = harness();
    try { const job = h.spawn(); h.result(job.id); await eventually(() => hasPersistedOutput(h.cwd, job.id)); const status = JSON.parse(readFileSync(join(h.cwd, ".pi", "tmp", job.id, "status.json"), "utf8")); assert.match(status.output, /"truncated":true/); } finally { h.restore(); }
  });

  it("delivers each grouped reviewer result on its own completion", async () => {
    const h = harness();
    try { const first = h.spawn("group"); const second = h.spawn("group"); h.result(first.id); h.result(second.id); await eventually(() => h.messages.length === 2); assert.match(h.messages[0].content, /"truncated":true/); assert.match(h.messages[1].content, /"truncated":true/); } finally { h.restore(); }
  });

  it("delivers a finished grouped sibling while its sibling is still running", async () => {
    const h = harness();
    try {
      // Regression for #1110: the group gate withheld a finished agent's result until the
      // slowest sibling finished, so a hung sibling stranded it indefinitely.
      const finished = h.spawn("group", "worker-finished");
      h.spawn("group", "worker-running");
      h.result(finished.id, "done", "worker-finished");
      await eventually(() => h.messages.length === 1);
      assert.match(h.messages[0].content, /worker-finished/);
      assert.doesNotMatch(h.messages[0].content, /worker-running/);
      h.triggerPoller();
      assert.equal(h.messages.length, 1);
    } finally { h.restore(); }
  });

  it("delivers a completed grouped job from the poller sweep", () => {
    const h = harness();
    try {
      // No watcher event: the poller sees a dead pid, ingests the result file and the
      // reconciliation sweep delivers it in the same tick. `groupId` gates nothing.
      const job = h.spawn("group", "worker-swept");
      h.result(job.id, "swept output", "worker-swept", { status: { pid: 999_999_999 } });
      assert.match(String(h.messages[0]?.content), /swept output/);
    } finally { h.restore(); }
  });

  it("formats reconciliation delivery through registered async agents", async () => {
    const h = harness();
    // Ingestion and reconciliation each attempt delivery during the first tick.
    try { h.rejectNextSend(); h.rejectNextSend(); const job = h.spawn(); h.result(job.id); await eventually(() => hasPersistedOutput(h.cwd, job.id)); assert.equal(h.messages.length, 0); h.triggerPoller(); assert.match(h.messages[0].content, /"truncated":true/); } finally { h.restore(); }
  });

  it("keeps passed tests passed after failed test-runner completion", async () => {
    const h = harness();
    try {
      markNeedsReview(h.cwd);
      markTestsPassed(h.cwd);
      const job = h.spawn(undefined, "test-runner");
      log.debug("failed_test_result", { scenario: "test_runner_completion", jobId: job.id, agent: "test-runner", success: false, resultStatus: "failed", deliveryState: "immediate" });
      h.result(job.id, "Failed", "test-runner", { success: false });
      await eventually(() => h.messages.length === 1);
      assert.match(h.messages[0].content, /test-runner/);
      assert.equal(readReviewState(h.cwd).tests_passed, true);
    } finally { h.restore(); }
  });

  it("keeps passed tests passed after grouped failed test-runner completion", async () => {
    const h = harness();
    try {
      markNeedsReview(h.cwd);
      markTestsPassed(h.cwd);
      const job = h.spawn("tests", "test-runner");
      log.debug("failed_test_result", { scenario: "grouped_test_runner_completion", jobId: job.id, agent: "test-runner", success: false, resultStatus: "failed", deliveryState: "per_agent" });
      h.result(job.id, "Failed", "test-runner", { success: false });
      await eventually(() => h.messages.length === 1);
      assert.match(h.messages[0].content, /test-runner/);
      assert.equal(readReviewState(h.cwd).tests_passed, true);
    } finally { h.restore(); }
  });

  it("keeps passed tests passed after zombie failed test-automator result ingestion", () => {
    const h = harness();
    try {
      markNeedsReview(h.cwd);
      markTestsPassed(h.cwd);
      const job = h.spawn(undefined, "test-automator");
      log.debug("failed_test_result", { scenario: "zombie_test_automator_ingestion", jobId: job.id, agent: "test-automator", success: false, resultStatus: "failed", deliveryState: "poller" });
      h.result(job.id, "Failed", "test-automator", { success: false, status: { pid: 999_999_999 } });
      h.triggerPoller();
      assert.match(h.messages[0].content, /test-automator/);
      assert.equal(readReviewState(h.cwd).tests_passed, true);
    } finally { h.restore(); }
  });

  it("keeps passed tests passed after reconciliation delivery of a failed test-runner result", async () => {
    const h = harness();
    try {
      markNeedsReview(h.cwd);
      markTestsPassed(h.cwd);
      // A poll tick attempts ingestion delivery, then reconciliation delivery.
      h.rejectNextSend();
      h.rejectNextSend();
      const job = h.spawn(undefined, "test-runner");
      log.debug("failed_test_result", { scenario: "test_runner_reconciliation", jobId: job.id, agent: "test-runner", success: false, resultStatus: "failed", deliveryState: "deferred_reconciliation" });
      h.result(job.id, "Failed", "test-runner", { success: false });
      await eventually(() => hasPersistedOutput(h.cwd, job.id));
      assert.equal(h.messages.length, 0);
      h.triggerPoller();
      assert.match(h.messages[0].content, /test-runner/);
      assert.equal(readReviewState(h.cwd).tests_passed, true);
    } finally { h.restore(); }
  });

  // Watcher contract: unlike formatter cases, stale contexts cannot use the poller.
  it("persists a watched result when the captured context becomes stale", async () => {
    const h = harness();
    try {
      const job = h.spawn();
      Object.defineProperty(h.ctx, "mode", { get: () => { throw new Error("ctx inactive"); } });
      Object.defineProperty(h.ctx, "model", { get: () => { throw new Error("ctx inactive"); } });
      h.result(job.id, "preserve me");
      await eventually(() => hasPersistedOutput(h.cwd, job.id));
      h.triggerPoller();
      const status = JSON.parse(readFileSync(join(h.cwd, ".pi", "tmp", job.id, "status.json"), "utf8"));
      assert.equal(status.output, "preserve me");
      assert.equal(h.messages.length, 0);
    } finally { h.restore(); }
  });

  it("executes killed delivery through registered async agents", () => {
    const h = harness();
    try { const job = h.spawn(); const killed = h.api.killAsyncAgent(job.id); assert.deepEqual(killed.killed, ["code-reviewer-runtime"]); assert.match(h.messages[0].content, /Killed by user/); } finally { h.restore(); }
  });

  it("does not run the completion hook of a killed job", () => {
    const h = harness();
    try {
      // A kill must not advance an async chain: deliver the failure, never the hook.
      let fired = 0;
      const job = h.api.spawnAsyncAgent("worker-hooked", "review", h.cwd, [{ name: "worker-hooked" } as any], { onComplete: () => { fired++; } });
      h.api.killAsyncAgent(job.id);
      assert.equal(fired, 0);
      assert.match(String(h.messages[0]?.content), /Killed by user/);
    } finally { h.restore(); }
  });

  it("keeps the worker dir of a restored terminal job that was never delivered", async () => {
    const h = harness();
    try {
      // async-runner writes terminal status before its reviewer retries finish, so a reload can
      // land while the job is terminal but undelivered. Restore treated every terminal worker as
      // delivered: it removed the dir, dropped the job, and the result was unlinked as an orphan.
      const job = h.spawn();
      const workerDir = join(h.cwd, ".pi", "tmp", job.id);
      const resultDir = h.resultDir();
      writeFileSync(join(workerDir, "status.json"), JSON.stringify({ runId: job.id, agent: "code-reviewer-runtime", state: "complete", startedAt: Date.now(), lastUpdate: Date.now() }));
      const reloaded = harness({ cwd: h.cwd });
      try {
        assert.ok(existsSync(workerDir), "an undelivered terminal worker dir must survive restore");
        assert.equal(reloaded.messages.length, 0, "the deferral still holds until the result lands");
        writeFileSync(join(resultDir, `${job.id}.json`), JSON.stringify({ id: job.id, agent: "code-reviewer-runtime", task: "review", success: true, output: "restored findings", durationMs: 1, exitCode: 0 }));
        reloaded.triggerPoller();
        await eventually(() => reloaded.messages.length === 1);
        assert.match(reloaded.messages[0].content, /restored findings/);
      } finally { reloaded.restore(); }
    } finally { h.restore(); }
  });

  it("delivers a result file that appears after the timeout fallback", async () => {
    const h = harness();
    try {
      // A reviewer retry longer than async_phantom_timeout_ms makes the fallback deliver an empty
      // result. The findings written afterwards were unlinked because the job was "delivered".
      const job = h.spawn();
      writeFileSync(join(h.cwd, ".pi", "tmp", job.id, "status.json"), JSON.stringify({ runId: job.id, agent: "code-reviewer-runtime", state: "complete", startedAt: Date.now() - 60_000, lastUpdate: Date.now() - 60_000 }));
      h.triggerPoller();
      await eventually(() => h.messages.length === 1);
      assert.doesNotMatch(h.messages[0].content, /late result/);
      writeFileSync(join(h.resultDir(), `${job.id}.json`), JSON.stringify({ id: job.id, agent: "code-reviewer-runtime", task: "review", success: true, output: "late findings", durationMs: 1, exitCode: 0 }));
      h.triggerPoller();
      await eventually(() => h.messages.length === 2);
      assert.match(h.messages[1].content, /late result/);
      assert.match(h.messages[1].content, /late findings/);
    } finally { h.restore(); }
  });

  it("delivers a late reviewer result without touching review state, once", async () => {
    const h = harness();
    try {
      // The fallback delivered an empty result; the reviewer was already recorded as a
      // zero-finding review. Applying the late findings here let an older round's result land on
      // a newer one, and every delivery retry added them again.
      const job = h.spawn();
      writeFileSync(join(h.cwd, ".pi", "tmp", job.id, "status.json"), JSON.stringify({ runId: job.id, agent: "code-reviewer-runtime", state: "complete", startedAt: Date.now() - 60_000, lastUpdate: Date.now() - 60_000 }));
      h.triggerPoller();
      await eventually(() => h.messages.length === 1);
      resetReviewState(h.cwd);
      addReviewerPending(h.cwd, "code-reviewer-runtime", { kind: "other", id: "late-reviewer" } as any);
      recordReviewerResult(h.cwd, "code-reviewer-runtime", 0);
      const before = readReviewState(h.cwd);
      writeFileSync(join(h.resultDir(), `${job.id}.json`), JSON.stringify({ id: job.id, agent: "code-reviewer-runtime", task: "review", success: true, output: reviewerOutput, durationMs: 1, exitCode: 0 }));
      h.rejectNextSend(); // the first late attempt is lost — the poller retries it
      h.triggerPoller();
      await eventually(() => h.messages.length === 2);
      assert.deepEqual(readReviewState(h.cwd), before, "the late result must not change review state");
      assert.match(h.messages[1].content, /AFTER the delivery timeout/);
      assert.match(h.messages[1].content, /review state was NOT updated automatically/);
      assert.match(h.messages[1].content, /re-poll code-reviewer-runtime/);
      h.triggerPoller();
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(h.messages.length, 2, "a retry must not repeat the note");
    } finally { h.restore(); }
  });

  it("withholds a chain hook until the late result carries real text", async () => {
    const h = harness();
    try {
      // Firing the hook with the empty fallback spawned the next chain step with no {previous}.
      const fired: string[] = [];
      const job = h.api.spawnAsyncAgent("worker-chained", "step one", h.cwd, [{ name: "worker-chained" } as any], {
        onComplete: result => { fired.push(result.text); },
        chain: { steps: [{ agent: "worker-chained", task: "step one" }], index: 0, previous: "" },
      });
      writeFileSync(join(h.cwd, ".pi", "tmp", job.id, "status.json"), JSON.stringify({ runId: job.id, agent: "worker-chained", state: "complete", startedAt: Date.now() - 60_000, lastUpdate: Date.now() - 60_000 }));
      h.triggerPoller();
      await eventually(() => h.messages.length === 1);
      assert.deepEqual(fired, []);
      writeFileSync(join(h.resultDir(), `${job.id}.json`), JSON.stringify({ id: job.id, agent: "worker-chained", task: "step one", success: true, output: "real chain text", durationMs: 1, exitCode: 0 }));
      h.triggerPoller();
      await eventually(() => h.messages.length === 2);
      assert.deepEqual(fired, ["real chain text"]);
    } finally { h.restore(); }
  });

  it("recovers a withheld chain hook once its grace period passes", () => {
    // The result file never landed, so the withheld hook had no reader: the chain stalled with
    // nothing telling the parent why. Recovery reports the stop instead of hanging.
    const chain = { steps: [{ agent: "worker-a", task: "one" }, { agent: "worker-b", task: "two" }], index: 0, previous: "" };
    const stalled = (id: string) => ({ id, agent: "worker-a", task: "one", status: "complete", workerDir: join("/nonexistent", id), startedAt: 1, updatedAt: 1, pendingChainHook: true, pendingChainHookAt: 1_000 });
    const jobs = [stalled("job-stalled") as any];
    const recovered = recoverStalledChainHooks(jobs, { graceMs: 60_000, now: 30_000 });
    assert.equal(recovered.length, 0, "nothing is recovered inside the grace period");
    const after = recoverStalledChainHooks(jobs, { graceMs: 60_000, now: 120_000 });
    assert.equal(after.length, 1);
    assert.equal(jobs[0].pendingChainHook, false);
    assert.equal(recoverStalledChainHooks(jobs, { graceMs: 60_000, now: 300_000 }).length, 0, "recovery fires once");
    const note = chainStoppedNote(jobs[0] as any, chain);
    assert.match(note, /STOPPED at step 1 of 2/);
    assert.match(note, /job-stalled/);
    assert.match(note, /worker-b/);
  });

  it("a recovered stopped chain cannot spawn its next step when the result lands later", () => {
    // The parent was told the chain STOPPED, but the hook survived: the late result fired it and
    // spawned the next step anyway — a chain that resumes and runs its steps twice.
    const fired: string[] = [];
    const job: any = {
      id: "job-stopped", agent: "worker-a", task: "one", status: "complete",
      startedAt: 1, updatedAt: 1, workerDir: join("/nonexistent", "job-stopped"),
      pendingChainHook: true, pendingChainHookAt: 1_000,
      onComplete: (r: { text: string }) => fired.push(r.text),
    };
    recoverStalledChainHooks([job], { graceMs: 60_000, now: 120_000 });
    assert.equal(job.onComplete, undefined, "the stopped chain's hook must be gone");
    // Both post-recovery spawn paths: the reconciliation sweep and the late result delivery.
    assert.equal(firePendingCompletions([job]), 0);
    assert.deepEqual(fired, []);
  });

  it("defers delivery of a terminal job until its result file is ingested", async () => {
    const h = harness();
    try {
      // async-runner writes terminal status before its reviewer JSON retries finish, so the
      // result file lands later. Delivering on status alone sent empty output and deleted
      // the findings.
      const job = h.spawn();
      writeFileSync(join(h.cwd, ".pi", "tmp", job.id, "status.json"), JSON.stringify({ runId: job.id, state: "complete", lastUpdate: Date.now() }));
      h.triggerPoller();
      // The runner is still retrying invalid JSON. Delivery's own result-file wait is 2s, so
      // wait past it: without the deferral the job is delivered empty and the findings die.
      await new Promise(resolve => setTimeout(resolve, 2_500));
      assert.equal(h.messages.length, 0, "a terminal status without an ingested result must not be delivered");
      writeFileSync(join(h.resultDir(), `${job.id}.json`), JSON.stringify({ id: job.id, agent: "code-reviewer-runtime", task: "review", success: true, output: "late findings", durationMs: 1, exitCode: 0 }));
      await eventually(() => h.messages.length === 1);
      assert.match(h.messages[0].content, /late findings/);
    } finally { h.restore(); }
  });

  it("logs a deferred delivery that has no live session context", () => {
    const h = harness();
    setLogLevelPin("async_agents", "debug");
    try {
      // Every sweep tick skips such a job; without the line a result that never reaches the
      // parent leaves nothing behind to explain why.
      const job = h.spawn();
      Object.defineProperty(h.ctx, "mode", { get: () => { throw new Error("ctx inactive"); } });
      const offset = asyncLogOffset();
      h.api.killAsyncAgent(job.id);
      const trail = asyncLogSince(offset);
      assert.match(trail, /deliver_deferred_no_live_ctx/);
      assert.match(trail, new RegExp(job.id));
      assert.equal(h.messages.length, 0);
    } finally { setLogLevelPin("async_agents", null); h.restore(); }
  });

  it("completes a linked task when the session context is stale", async () => {
    const h = harness();
    const storePath = join(h.cwd, ".pi", "tasks", "tasks.json");
    const previousTasksEnv = process.env.PI_TASKS;
    try {
      mkdirSync(join(h.cwd, ".pi", "tasks"), { recursive: true });
      writeFileSync(storePath, JSON.stringify({ tasks: [{ id: "7", status: "in_progress", subject: "linked" }] }));
      process.env.PI_TASKS = storePath;
      const job = h.api.spawnAsyncAgent("worker-linked", "review", h.cwd, [{ name: "worker-linked" } as any], { taskId: "7" });
      Object.defineProperty(h.ctx, "mode", { get: () => { throw new Error("ctx inactive"); } });
      h.result(job.id, "done", "worker-linked");
      await eventually(() => JSON.parse(readFileSync(storePath, "utf-8")).tasks[0].status === "completed");
      assert.equal(h.messages.length, 0, "no message reaches a stale session");
    } finally {
      if (previousTasksEnv === undefined) delete process.env.PI_TASKS;
      else process.env.PI_TASKS = previousTasksEnv;
      h.restore();
    }
  });

  it("does not run the completion hook when a killed job's delivery is retried", () => {
    const h = harness();
    try {
      // The first attempt suppressed the hook; a failed send left the job undelivered, and the
      // sweep retried it with the default hook enabled.
      let fired = 0;
      const job = h.api.spawnAsyncAgent("worker-killed-retry", "review", h.cwd, [{ name: "worker-killed-retry" } as any], { onComplete: () => { fired++; } });
      h.rejectNextSend();
      h.api.killAsyncAgent(job.id);
      assert.equal(fired, 0);
      assert.equal(h.messages.length, 0, "the first send was rejected");
      h.triggerPoller();
      assert.equal(h.messages.length, 1, "the sweep retries the undelivered kill");
      assert.equal(fired, 0, "a retried kill must not advance an async chain");
    } finally { h.restore(); }
  });

  it("opens async status overlay through registered command", async () => {
    const h = harness();
    try {
      h.spawn();
      await h.commands.get("async-status")!.handler("", h.ctx);
      assert.equal(h.overlayOpens(), 1);
    } finally { h.restore(); }
  });

  it("replies to registered RPC spawn request", async () => {
    const h = harness();
    try {
      const replyPromise = new Promise<any>(resolve => h.events.once("subagents:rpc:spawn:reply:spawn-1", resolve));
      h.events.emit("subagents:rpc:spawn", { requestId: "spawn-1", type: "worker", prompt: "runtime RPC test", options: { cwd: h.cwd } });
      const reply = await replyPromise;
      assert.equal(reply.success, true);
      assert.equal(typeof reply.data.id, "string");
      assert.match(reply.data.id, /^worker-/);
    } finally { h.restore(); }
  });
});

describe("spawn-exit recovery", () => {
  it("records a failure even when the extension instance is gone", () => {
    // The timer outlives /reload: gating the status write on a live ctx made a failed agent vanish.
    assert.deepEqual(planSpawnExitRecovery({ status: "running", hasLiveCtx: false }), { record: true, deliver: false });
  });

  it("records and delivers when the instance is alive", () => {
    assert.deepEqual(planSpawnExitRecovery({ status: "running", hasLiveCtx: true }), { record: true, deliver: true });
  });

  it("does nothing for a job that already reached a terminal state", () => {
    assert.deepEqual(planSpawnExitRecovery({ status: "complete", hasLiveCtx: true }), { record: false, deliver: false });
    assert.deepEqual(planSpawnExitRecovery({ status: "failed", hasLiveCtx: true }), { record: false, deliver: false });
  });
});
