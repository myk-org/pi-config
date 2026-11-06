import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerSubagentTool } from "../../../extensions/orchestrator/subagent-tool.js";
import { fireOnComplete, firePendingCompletions, registerAsyncAgents } from "../../../extensions/orchestrator/async-agents.js";
import { clearLogLevelCache, getPiLogPath, setGlobalSessionId } from "../../../extensions/shared/file-logger.js";
import { createLogger } from "../../../extensions/shared/logger.js";
import { makeTempDir } from "../helpers/temp-dirs.js";


const log = createLogger("subagent-async-chain-test");

/** Log writes are captured from the real file logger under a test session id. */
const LOG_SESSION = "async-chain-mode-test";
setGlobalSessionId(LOG_SESSION);
process.env.PI_LOG_SUBAGENT = "info";
process.env.PI_LOG_ASYNC_AGENTS = "info";
clearLogLevelCache();

function logOffset(name: string): number {
  const path = getPiLogPath(name);
  return path && existsSync(path) ? readFileSync(path, "utf-8").length : 0;
}

function logSince(name: string, offset: number): string {
  const path = getPiLogPath(name);
  return path && existsSync(path) ? readFileSync(path, "utf-8").slice(offset) : "";
}

interface SpawnCall {
  agent: string;
  task: string;
  cwd: string;
  agents: Array<{ name: string }>;
  options: any;
  onComplete?: (result: { text: string; isError: boolean }) => void;
}

/**
 * Harness around registerSubagentTool with a stubbed spawnAsyncAgent. The stub
 * records every spawn and keeps its onComplete hook so the test can drive step
 * completion manually — no child processes, no result files, no polling.
 */
function harness(opts: { hasUI?: boolean; confirm?: (title: string, message?: string) => Promise<boolean> } = {}) {
  const cwd = makeTempDir("subagent-async-chain-");
  const confirmCalls: Array<{ title: string; message?: string }> = [];
  const spawns: SpawnCall[] = [];
  const messages: any[] = [];
  let tool: any;
  let failNextSpawn = false;
  let throwNextSpawn = false;
  const pi = {
    registerTool(definition: any) { tool = definition; },
    on() {},
    sendMessage(message: any) { messages.push(message); },
    events: { on() {}, emit() {} },
  } as any;

  registerSubagentTool(
    pi,
    (agent: string, task: string, spawnCwd: string, agents: any[], options?: any) => {
      if (throwNextSpawn) throw new Error("spawn exploded");
      if (failNextSpawn) return { id: "", error: "spawn refused" };
      const id = `job-${spawns.length + 1}`;
      spawns.push({ agent, task, cwd: spawnCwd, agents, options, onComplete: options?.onComplete });
      return { id, model: undefined };
    },
    () => ({ killed: [], errors: [] }),
  );

  const ctx = {
    cwd,
    hasUI: opts.hasUI ?? false,
    ui: {
      theme: { fg: (_: string, value: string) => value },
      notify() {},
      setWorkingMessage() {},
      confirm: async (title: string, message?: string) => {
        confirmCalls.push({ title, message });
        return opts.confirm ? opts.confirm(title, message) : true;
      },
    },
    sessionManager: { getCwd: () => cwd, getSessionId: () => "test" },
  };

  return {
    spawns,
    messages,
    confirmCalls,
    ctx,
    setFailNextSpawn: (value: boolean) => { failNextSpawn = value; },
    setThrowNextSpawn: (value: boolean) => { throwNextSpawn = value; },
    run: (params: Record<string, unknown>) =>
      tool.execute("call-1", params, new AbortController().signal, () => {}, ctx),
    text: (result: any) => result.content.map((c: any) => c.text).join("\n"),
    restore: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

const chain = (cwd: string) => [
  { agent: "worker", task: "step one", cwd, estimatedSeconds: 5, taskId: "-1" },
  { agent: "worker", task: "step two after {previous}", cwd, estimatedSeconds: 5, taskId: "-1" },
];

describe("subagent async chain mode", () => {
  it("spawns only the first step", async () => {
    const h = harness();
    try {
      const result = await h.run({ chain: chain(h.ctx.cwd), async: true });
      log.debug("chain_start_result", { text: h.text(result), spawns: h.spawns.length });
      assert.ok(!result.isError);
      assert.equal(h.spawns.length, 1, "step 2 must wait for step 1 to complete");
      assert.equal(h.spawns[0].task, "step one");
      assert.match(h.spawns[0].options.name, /chain 1\/2/);
      assert.match(h.text(result), /Async chain started/);
    } finally { h.restore(); }
  });

  it("spawns step 2 after step 1 completes, with {previous} substituted", async () => {
    const h = harness();
    try {
      await h.run({ chain: chain(h.ctx.cwd), async: true });
      const step1 = h.spawns[0];
      assert.ok(step1.onComplete, "step 1 must register a completion hook");
      step1.onComplete!({ text: "OUTPUT-FROM-STEP-1", isError: false });

      assert.equal(h.spawns.length, 2, "step 1 completion must chain into step 2");
      assert.equal(h.spawns[1].task, "step two after OUTPUT-FROM-STEP-1");
      assert.match(h.spawns[1].options.name, /chain 2\/2/);
      assert.notEqual(h.spawns[1].options.name, step1.options.name, "each step needs a distinct display name");

      // Last step completing must not spawn anything further.
      h.spawns[1].onComplete!({ text: "OUTPUT-FROM-STEP-2", isError: false });
      assert.equal(h.spawns.length, 2);
    } finally { h.restore(); }
  });

  it("stops the chain when a step fails", async () => {
    const h = harness();
    try {
      await h.run({ chain: chain(h.ctx.cwd), async: true });
      h.spawns[0].onComplete!({ text: "step 1 exploded", isError: true });
      assert.equal(h.spawns.length, 1, "a failed step must not spawn the next step");
    } finally { h.restore(); }
  });

  it("rejects a step without a taskId", async () => {
    const h = harness();
    try {
      const steps = chain(h.ctx.cwd);
      delete (steps[1] as any).taskId;
      const result = await h.run({ chain: steps, async: true });
      assert.equal(result.isError, true);
      assert.equal(h.spawns.length, 0);
      assert.match(h.text(result), /taskId/);
    } finally { h.restore(); }
  });

  it("rejects a step without a cwd", async () => {
    const h = harness();
    try {
      const steps: any[] = chain(h.ctx.cwd);
      delete steps[1].cwd;
      const result = await h.run({ chain: steps, async: true });
      assert.equal(result.isError, true);
      assert.equal(h.spawns.length, 0);
      assert.match(h.text(result), /cwd/);
    } finally { h.restore(); }
  });

  it("reports a first-step spawn failure", async () => {
    const h = harness();
    try {
      h.setFailNextSpawn(true);
      const result = await h.run({ chain: chain(h.ctx.cwd), async: true });
      assert.equal(result.isError, true);
      assert.match(h.text(result), /failed to spawn/);
    } finally { h.restore(); }
  });
});

describe("async-only agents in chain mode", () => {
  it("accepts an async chain (reviewers can run as async steps)", async () => {
    const h = harness();
    try {
      const steps = [{ agent: "code-reviewer-quality", task: "review", cwd: h.ctx.cwd, estimatedSeconds: 5, taskId: "-1" }];
      const result = await h.run({ chain: steps, async: true });
      assert.ok(!result.isError, h.text(result));
      assert.equal(h.spawns.length, 1);
    } finally { h.restore(); }
  });

  it("explains why a sync chain cannot run them", async () => {
    const h = harness();
    try {
      const steps = [{ agent: "code-reviewer-quality", task: "review", cwd: h.ctx.cwd, estimatedSeconds: 5 }];
      const result = await h.run({ chain: steps });
      assert.equal(result.isError, true);
      assert.equal(h.spawns.length, 0);
      assert.match(h.text(result), /only run async/);
      assert.doesNotMatch(h.text(result), /tasks array/);
    } finally { h.restore(); }
  });
});

describe("async chain step handoff", () => {
  it("substitutes {previous} literally — $ sequences are not expanded", async () => {
    const h = harness();
    try {
      await h.run({ chain: chain(h.ctx.cwd), async: true });
      const previous = "cost $& and $$ and $` and $'";
      h.spawns[0].onComplete!({ text: previous, isError: false });
      assert.equal(h.spawns[1].task, `step two after ${previous}`);
    } finally { h.restore(); }
  });

  it("caps a huge previous result so the next task stays one bounded argument", async () => {
    const h = harness();
    try {
      await h.run({ chain: chain(h.ctx.cwd), async: true });
      h.spawns[0].onComplete!({ text: "x".repeat(40_000), isError: false });
      const task = h.spawns[1].task;
      assert.ok(task.length < 33_000, `task must be capped, got ${task.length} chars`);
      assert.match(task, /truncated: 8000 of 40000 chars dropped/);
    } finally { h.restore(); }
  });

  it("reports a synchronous throw from the next-step spawn instead of letting it escape", async () => {
    const h = harness();
    try {
      await h.run({ chain: chain(h.ctx.cwd), async: true });
      h.setThrowNextSpawn(true);
      h.spawns[0].onComplete!({ text: "OUTPUT", isError: false });
      assert.equal(h.messages.length, 1, "the failure must surface as a system note");
      assert.match(h.messages[0].content, /Async chain stopped: step 2 \(worker\) could not be spawned/);
      assert.match(h.messages[0].content, /spawn exploded/);
    } finally { h.restore(); }
  });

  it("discovers project agents for each step's cwd", async () => {
    const h = harness();
    const stepCwd = makeTempDir("subagent-async-chain-step-");
    try {
      mkdirSync(join(stepCwd, ".pi", "agents"), { recursive: true });
      writeFileSync(join(stepCwd, ".pi", "agents", "step-only.md"), "---\nname: step-only\ndescription: only in this directory\n---\nbody\n");
      const steps = chain(h.ctx.cwd);
      steps[1].cwd = stepCwd;
      await h.run({ chain: steps, async: true });
      assert.ok(!h.spawns[0].agents.some(a => a.name === "step-only"), "step 1 cwd has no project agents");
      h.spawns[0].onComplete!({ text: "OUTPUT", isError: false });
      assert.ok(h.spawns[1].agents.some(a => a.name === "step-only"), "step 2 must see agents from its own cwd");
    } finally {
      h.restore();
      rmSync(stepCwd, { recursive: true, force: true });
    }
  });

  it("logs every chain transition under its documented event name", async () => {
    const h = harness();
    const offset = logOffset("subagent");
    try {
      await h.run({ chain: chain(h.ctx.cwd), async: true });
      h.spawns[0].onComplete!({ text: "OUTPUT-1", isError: false });
      h.spawns[1].onComplete!({ text: "OUTPUT-2", isError: false });
      const logged = logSince("subagent", offset);
      for (const event of [
        "async_chain_step_spawn",
        "async_chain_step_complete",
        "async_chain_next_step",
        "async_chain_next_step_spawned",
        "async_chain_done",
      ]) {
        assert.match(logged, new RegExp(event), `${event} must be logged`);
      }
    } finally { h.restore(); }
  });

  it("logs a failed step and an unspawnable next step under their event names", async () => {
    const h = harness();
    const offset = logOffset("subagent");
    try {
      await h.run({ chain: chain(h.ctx.cwd), async: true });
      h.spawns[0].onComplete!({ text: "step 1 exploded", isError: true });
      const failed = logSince("subagent", offset);
      assert.match(failed, /async_chain_step_failed/);
      assert.match(failed, /\[error\].*async_chain_step_failed/, "a dead chain must log at error level");

      const second = harness();
      const secondOffset = logOffset("subagent");
      try {
        await second.run({ chain: chain(second.ctx.cwd), async: true });
        second.setFailNextSpawn(true);
        second.spawns[0].onComplete!({ text: "OUTPUT", isError: false });
        assert.match(logSince("subagent", secondOffset), /async_chain_next_step_spawn_failed/);
      } finally { second.restore(); }
    } finally { h.restore(); }
  });
});

describe("fireOnComplete one-shot semantics", () => {
  it("passes the ingested output/status, clears the hook first, and never re-fires", () => {
    const job: any = { id: "j1", agent: "worker", task: "t", workerDir: "/tmp", startedAt: 1, updatedAt: 1, status: "failed", output: "OUTPUT-TEXT" };
    const calls: Array<{ text: string; isError: boolean }> = [];
    job.onComplete = (result: { text: string; isError: boolean }) => {
      assert.equal(job.onComplete, undefined, "hook must be cleared before it is invoked");
      calls.push(result);
    };
    fireOnComplete(job);
    fireOnComplete(job); // second reconciliation pass
    assert.deepEqual(calls, [{ text: "OUTPUT-TEXT", isError: true }]);
  });

  it("reports an empty text and isError: false for a completed job with no output", () => {
    const job: any = { id: "j2", agent: "worker", task: "t", workerDir: "/tmp", startedAt: 1, updatedAt: 1, status: "complete" };
    const calls: Array<{ text: string; isError: boolean }> = [];
    job.onComplete = (result: { text: string; isError: boolean }) => calls.push(result);
    fireOnComplete(job);
    assert.deepEqual(calls, [{ text: "", isError: false }]);
  });
});

/** Harness around registerAsyncAgents — real spawn path, stubbed child process. */
function asyncHarness(opts: { hasUI?: boolean; confirm?: (title: string, message?: string) => Promise<boolean> } = {}) {
  const cwd = makeTempDir("async-chain-durable-");
  const handlers = new Map<string, Array<(event: unknown, ctx: any) => void>>();
  const messages: any[] = [];
  const previousSetInterval = global.setInterval;
  global.setInterval = (() => ({ unref() {}, [Symbol.toPrimitive]: () => 0 })) as any;
  const pi = {
    on(event: string, handler: (event: unknown, ctx: any) => void) {
      (handlers.get(event) ?? handlers.set(event, []).get(event)!).push(handler);
    },
    registerCommand() {},
    sendMessage(message: any) { messages.push(message); },
    events: new EventEmitter(),
  };
  const api = registerAsyncAgents(pi as any, () => {}, {
    spawnProcess: () => Object.assign(new EventEmitter(), { stderr: { pipe() {} } }),
    discoverAgents: () => ({ agents: [{ name: "worker" } as any] }),
  });
  const ctx = {
    cwd,
    hasUI: opts.hasUI ?? false,
    ui: {
      theme: { fg: (_: string, value: string) => value },
      notify() {},
      setWorkingMessage() {},
      confirm: async (title: string, message?: string) => {
        confirmCalls.push({ title, message });
        return opts.confirm ? opts.confirm(title, message) : true;
      },
    },
    sessionManager: { getCwd: () => cwd, getSessionId: () => "test" },
  };
  const sessionStart = () => handlers.get("session_start")![0]({}, ctx);
  sessionStart();
  const projectTmp = join(cwd, ".pi", "tmp");
  const resultsDir = () => readdirSync(projectTmp).find(name => name.startsWith(`async-results-pid-${process.pid}`))!;
  return {
    cwd,
    api,
    messages,
    projectTmp,
    resultsDir,
    sessionStart,
    restore: () => { global.setInterval = previousSetInterval; rmSync(cwd, { recursive: true, force: true }); },
  };
}

describe("async chain durability across a reload", () => {
  it("writes the chain position next to the spawned job", () => {
    const h = asyncHarness();
    try {
      const steps = [{ agent: "worker", task: "one" }, { agent: "worker", task: "two after {previous}" }];
      const job = h.api.spawnAsyncAgent("worker", "one", h.cwd, [{ name: "worker" } as any], {
        chain: { steps, index: 0, previous: "" },
      });
      assert.ok(job.id, job.error);
      const chainState = JSON.parse(readFileSync(join(h.projectTmp, job.id, "chain.json"), "utf-8"));
      assert.deepEqual(chainState.steps, steps);
      assert.equal(chainState.index, 0);
      assert.equal(chainState.previous, "");
    } finally { h.restore(); }
  });

  it("reports an interrupted chain on restore instead of dropping it silently", () => {
    const h = asyncHarness();
    const logStart = logOffset("async_agents");
    try {
      // A step-2 job of a 3-step chain, still running when the extension reloaded.
      const jobDir = join(h.projectTmp, "worker-restored");
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(join(jobDir, "status.json"), JSON.stringify({ runId: "worker-restored", agent: "worker", state: "running", pid: process.pid, startedAt: Date.now() }));
      writeFileSync(join(jobDir, "session.json"), JSON.stringify({ resultsDir: join(h.projectTmp, h.resultsDir()) }));
      writeFileSync(join(jobDir, "chain.json"), JSON.stringify({
        steps: [{ agent: "scout", task: "s" }, { agent: "worker", task: "w" }, { agent: "planner", task: "p" }],
        index: 1,
        previous: "SCOUT-OUTPUT",
      }));

      h.sessionStart();

      assert.equal(h.messages.length, 1, "the interrupted chain must surface as a system note");
      assert.match(h.messages[0].content, /chain interrupted at step 2 of 3/i);
      assert.match(h.messages[0].content, /Remaining agents: planner/);
      assert.match(logSince("async_agents", logStart), /\[error\][^\n]*async_chain_interrupted: chain interrupted at step 2 of 3/);
    } finally { h.restore(); }
  });

  it("does not report a chain whose last step is the one restored", () => {
    const h = asyncHarness();
    try {
      const jobDir = join(h.projectTmp, "worker-last");
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(join(jobDir, "status.json"), JSON.stringify({ runId: "worker-last", agent: "worker", state: "running", pid: process.pid, startedAt: Date.now() }));
      writeFileSync(join(jobDir, "session.json"), JSON.stringify({ resultsDir: join(h.projectTmp, h.resultsDir()) }));
      writeFileSync(join(jobDir, "chain.json"), JSON.stringify({ steps: [{ agent: "scout", task: "s" }], index: 0, previous: "" }));

      h.sessionStart();
      assert.equal(h.messages.length, 0);
    } finally { h.restore(); }
  });
});


describe("firePendingCompletions reconciliation pass", () => {
  const job = (id: string, status: "complete" | "failed", output: string) => ({
    id, agent: "worker", task: "t", workerDir: "/tmp", startedAt: 1, updatedAt: 1, status, output,
  }) as any;

  it("fires each hook once across repeated passes, skipping jobs without one", () => {
    const calls: string[] = [];
    const a = job("a", "complete", "A");
    a.onComplete = () => calls.push("a");
    const b = job("b", "failed", "B");
    b.onComplete = (result: { text: string; isError: boolean }) => calls.push(`b:${result.text}:${result.isError}`);
    const noHook = job("c", "complete", "C");

    assert.equal(firePendingCompletions([a, b, noHook]), 2, "first pass fires both hooks");
    assert.equal(firePendingCompletions([a, b, noHook]), 0, "second reconciliation pass must not re-fire");
    assert.deepEqual(calls, ["a", "b:B:true"]);
  });

  it("leaves a log trail with the fired count", () => {
    const job = (id: string) => ({ id, agent: "worker", task: "t", workerDir: "/tmp", startedAt: 1, updatedAt: 1, status: "complete", output: "x" }) as any;
    const a = job("a");
    a.onComplete = () => {};
    // async-agents.ts logs under "async_agents" — read that trail.
    const logPath = getPiLogPath("async_agents");
    const before = logPath && existsSync(logPath) ? readFileSync(logPath, "utf-8").length : 0;
    assert.equal(firePendingCompletions([a]), 1);
    const after = logPath && existsSync(logPath) ? readFileSync(logPath, "utf-8").slice(before) : "";
    assert.match(after, /fire_pending_completions/, "the pass must log how many hooks fired");
  });

  it("keeps firing the remaining hooks when one throws", () => {
    const calls: string[] = [];
    const boom = job("boom", "complete", "X");
    boom.onComplete = () => { throw new Error("hook exploded"); };
    const after = job("after", "complete", "Y");
    after.onComplete = () => calls.push("after");

    assert.equal(firePendingCompletions([boom, after]), 2, "a throwing hook must not stop the pass");
    assert.deepEqual(calls, ["after"]);
    assert.equal(boom.onComplete, undefined, "the throwing hook is still one-shot");
  });
});


describe("project-agent approval covers every chain step cwd", () => {
  const writeProjectAgent = (dir: string, name: string) => {
    mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "agents", `${name}.md`),
      `---\nname: ${name}\ndescription: step-local project agent\ntools: read\n---\n\nDo the thing.\n`,
    );
  };

  it("asks for approval when a step's own cwd contributes a project agent", async () => {
    const h = harness({ hasUI: true, confirm: async () => true });
    try {
      const stepDir = makeTempDir("chain-step-cwd-");
      writeProjectAgent(stepDir, "step-only");
      const steps = [
        { agent: "worker", task: "one", cwd: h.ctx.cwd, estimatedSeconds: 5, taskId: "-1" },
        { agent: "step-only", task: "two", cwd: stepDir, estimatedSeconds: 5, taskId: "-1" },
      ];
      const result = await h.run({ chain: steps, name: "gate test", async: true, taskId: "-1" });
      assert.ok(h.confirmCalls.length > 0, "the step-local project agent must be presented for approval");
      const body = h.confirmCalls.map(c => c.message ?? "").join("\n");
      assert.match(body, /step-only/, "the prompt names the agent");
      assert.match(body, new RegExp(stepDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the prompt shows that agent's source dir");
      assert.equal(h.spawns.length, 1, `approval allows the chain to start — got: ${h.text(result)} | confirmCalls=${h.confirmCalls.length}`);
      rmSync(stepDir, { recursive: true, force: true });
    } finally {
      h.restore();
    }
  });

  it("cancels the chain when the step-local project agent is declined", async () => {
    const h = harness({ hasUI: true, confirm: async () => false });
    try {
      const stepDir = makeTempDir("chain-step-cwd-");
      writeProjectAgent(stepDir, "step-only");
      const steps = [
        { agent: "worker", task: "one", cwd: h.ctx.cwd, estimatedSeconds: 5, taskId: "-1" },
        { agent: "step-only", task: "two", cwd: stepDir, estimatedSeconds: 5, taskId: "-1" },
      ];
      const result = await h.run({ chain: steps, name: "gate test", async: true, taskId: "-1" });
      assert.equal(h.spawns.length, 0, "declined approval must not spawn anything");
      assert.match(h.text(result), /Canceled: project-local agents not approved/);
      rmSync(stepDir, { recursive: true, force: true });
    } finally {
      h.restore();
    }
  });

  it("lists BOTH sources when two step dirs hold an agent of the same name", async () => {
    const h = harness({ hasUI: true, confirm: async () => true });
    try {
      const dirA = makeTempDir("chain-dup-a-");
      const dirB = makeTempDir("chain-dup-b-");
      writeProjectAgent(dirA, "dup-name");
      writeProjectAgent(dirB, "dup-name");
      const steps = [
        { agent: "dup-name", task: "one", cwd: dirA, estimatedSeconds: 5, taskId: "-1" },
        { agent: "dup-name", task: "two", cwd: dirB, estimatedSeconds: 5, taskId: "-1" },
      ];
      await h.run({ chain: steps, name: "dup gate", async: true, taskId: "-1" });
      const body = h.confirmCalls.map(c => c.message ?? "").join("\n");
      assert.match(body, new RegExp(dirA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "source A listed");
      assert.match(body, new RegExp(dirB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "source B listed — same name, different agent");
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    } finally {
      h.restore();
    }
  });

  it("does not prompt when every step resolves to the parent's own agents", async () => {
    const h = harness({ hasUI: true });
    try {
      const result = await h.run({ chain: chain(h.ctx.cwd), name: "no gate", async: true, taskId: "-1" });
      assert.equal(h.confirmCalls.length, 0, "no project agent involved → no prompt");
      assert.equal(h.spawns.length, 1);
    } finally {
      h.restore();
    }
  });
});
