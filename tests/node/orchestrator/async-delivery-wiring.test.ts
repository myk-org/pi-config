import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerAsyncAgents } from "../../../extensions/orchestrator/async-agents.js";
import { markNeedsReview, markTestsPassed, readReviewState } from "../../../extensions/orchestrator/pi-config-review-state.js";
import { createLogger } from "../../../extensions/shared/logger.js";

const log = createLogger("async-delivery-wiring-test");
const reviewerOutput = JSON.stringify({ findings: Array.from({ length: 100 }, () => ({ detail: "sensitive ".repeat(80) })) });

function harness() {
  log.debug("create_harness");
  const cwd = mkdtempSync(join(tmpdir(), "async-delivery-runtime-"));
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
    writeFileSync(join(cwd, ".pi", "tmp", id, "status.json"), JSON.stringify({ runId: id, state: "running", ...status }));
    writeFileSync(join(resultDir(), `${id}.json`), JSON.stringify({ id, agent, task: "review", success, output, durationMs: 1, exitCode }));
  };
  const spawn = (groupId?: string, agent = "code-reviewer-runtime") => api.spawnAsyncAgent(agent, "review", cwd, [{ name: agent } as any], { groupId });
  const triggerPoller = () => {
    log.debug("trigger_poller", { registered: Boolean(poller) });
    assert.ok(poller, "async poller should be registered");
    poller();
  };
  return { cwd, api, commands, ctx, events, messages, overlayOpens: () => overlayOpens, result, spawn, triggerPoller, rejectNextSend: () => { rejectedSends += 1; }, restore: () => { global.setInterval = previousSetInterval; rmSync(cwd, { recursive: true, force: true }); } };
}

async function settled() { await new Promise(resolve => setTimeout(resolve, 180)); }

describe("async delivery formatter runtime wiring (issue #803)", () => {
  it("formats immediate reviewer delivery through registered async agents", async () => {
    const h = harness();
    try { const job = h.spawn(); h.result(job.id); await settled(); assert.match(h.messages[0].content, /"truncated":true/); } finally { h.restore(); }
  });

  it("formats persisted reviewer status through registered async agents", async () => {
    const h = harness();
    try { const job = h.spawn(); h.result(job.id); await settled(); const workerDir = join(h.cwd, ".pi", "tmp", readdirSync(join(h.cwd, ".pi", "tmp")).find(name => name === job.id)!); const status = JSON.parse(readFileSync(join(workerDir, "status.json"), "utf8")); assert.match(status.output, /"truncated":true/); } finally { h.restore(); }
  });

  it("formats grouped reviewer delivery through registered async agents", async () => {
    const h = harness();
    try { const first = h.spawn("group"); const second = h.spawn("group"); h.result(first.id); h.result(second.id); await settled(); assert.match(h.messages[0].content, /"truncated":true/); } finally { h.restore(); }
  });

  it("formats reconciliation delivery through registered async agents", async () => {
    const h = harness();
    try { h.rejectNextSend(); const job = h.spawn(); h.result(job.id); await settled(); assert.equal(h.messages.length, 0); h.triggerPoller(); assert.match(h.messages[0].content, /"truncated":true/); } finally { h.restore(); }
  });

  it("keeps passed tests passed after failed test-runner completion", async () => {
    const h = harness();
    try {
      markNeedsReview(h.cwd);
      markTestsPassed(h.cwd);
      const job = h.spawn(undefined, "test-runner");
      log.debug("failed_test_result", { scenario: "test_runner_completion", jobId: job.id, agent: "test-runner", success: false, resultStatus: "failed", deliveryState: "immediate" });
      h.result(job.id, "Failed", "test-runner", { success: false });
      await settled();
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
      log.debug("failed_test_result", { scenario: "grouped_test_runner_completion", jobId: job.id, agent: "test-runner", success: false, resultStatus: "failed", deliveryState: "grouped" });
      h.result(job.id, "Failed", "test-runner", { success: false });
      await settled();
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
      h.rejectNextSend();
      const job = h.spawn(undefined, "test-runner");
      log.debug("failed_test_result", { scenario: "test_runner_reconciliation", jobId: job.id, agent: "test-runner", success: false, resultStatus: "failed", deliveryState: "deferred_reconciliation" });
      h.result(job.id, "Failed", "test-runner", { success: false });
      await settled();
      assert.equal(h.messages.length, 0);
      h.triggerPoller();
      assert.match(h.messages[0].content, /test-runner/);
      assert.equal(readReviewState(h.cwd).tests_passed, true);
    } finally { h.restore(); }
  });

  it("persists a result and defers delivery when the captured context becomes stale", async () => {
    const h = harness();
    try {
      const job = h.spawn();
      Object.defineProperty(h.ctx, "mode", { get: () => { throw new Error("ctx inactive"); } });
      Object.defineProperty(h.ctx, "model", { get: () => { throw new Error("ctx inactive"); } });
      h.result(job.id, "preserve me");
      await settled();
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
