import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerAsyncAgents } from "../../../extensions/orchestrator/async-agents.js";

const reviewerOutput = JSON.stringify({ findings: Array.from({ length: 100 }, () => ({ detail: "sensitive ".repeat(80) })) });

function harness() {
  const cwd = mkdtempSync(join(tmpdir(), "async-delivery-runtime-"));
  const handlers = new Map<string, Array<(event: unknown, ctx: any) => void>>();
  const messages: any[] = [];
  let rejectedSends = 0;
  const intervals: Array<() => void> = [];
  const previousSetInterval = global.setInterval;
  global.setInterval = ((fn: () => void) => {
    intervals.push(fn);
    return { unref() {}, [Symbol.toPrimitive]: () => 0 };
  }) as typeof setInterval;
  const pi = {
    on(event: string, handler: (event: unknown, ctx: any) => void) { (handlers.get(event) ?? handlers.set(event, []).get(event)!).push(handler); },
    registerCommand() {},
    sendMessage(message: any) { if (rejectedSends-- > 0) throw new Error("temporary delivery failure"); messages.push(message); },
    events: { emit() {}, on() {} },
  };
  const api = registerAsyncAgents(pi as any, () => {}, {
    spawnProcess: () => Object.assign(new EventEmitter(), { stderr: { pipe() {} } }),
  });
  const ctx = { cwd, hasUI: true, ui: { theme: { fg: (_: string, value: string) => value } }, sessionManager: { getCwd: () => cwd, getSessionId: () => "test" } };
  handlers.get("session_start")![0]({}, ctx);
  const resultDir = () => join(cwd, ".pi", "tmp", readdirSync(join(cwd, ".pi", "tmp")).find(name => name.startsWith(`async-results-pid-${process.pid}`))!);
  const result = (id: string, output = reviewerOutput) => {
    writeFileSync(join(cwd, ".pi", "tmp", id, "status.json"), JSON.stringify({ runId: id, state: "running" }));
    writeFileSync(join(resultDir(), `${id}.json`), JSON.stringify({ id, agent: "code-reviewer-runtime", task: "review", success: true, output, durationMs: 1, exitCode: 0 }));
  };
  const spawn = (groupId?: string) => api.spawnAsyncAgent("code-reviewer-runtime", "review", cwd, [{ name: "code-reviewer-runtime" } as any], { groupId });
  return { cwd, api, intervals, messages, result, spawn, rejectNextSend: () => { rejectedSends += 1; }, restore: () => { global.setInterval = previousSetInterval; rmSync(cwd, { recursive: true, force: true }); } };
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
    try { h.rejectNextSend(); const job = h.spawn(); h.result(job.id); await settled(); assert.equal(h.messages.length, 0); h.intervals[0](); assert.match(h.messages[0].content, /"truncated":true/); } finally { h.restore(); }
  });

  it("executes killed delivery through registered async agents", () => {
    const h = harness();
    try { const job = h.spawn(); const killed = h.api.killAsyncAgent(job.id); assert.deepEqual(killed.killed, ["code-reviewer-runtime"]); assert.match(h.messages[0].content, /Killed by user/); } finally { h.restore(); }
  });
});
