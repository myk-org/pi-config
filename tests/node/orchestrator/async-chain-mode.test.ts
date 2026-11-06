import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerSubagentTool } from "../../../extensions/orchestrator/subagent-tool.js";
import { createLogger } from "../../../extensions/shared/logger.js";

const log = createLogger("subagent-async-chain-test");

interface SpawnCall {
  agent: string;
  task: string;
  options: any;
  onComplete?: (result: { text: string; isError: boolean }) => void;
}

/**
 * Harness around registerSubagentTool with a stubbed spawnAsyncAgent. The stub
 * records every spawn and keeps its onComplete hook so the test can drive step
 * completion manually — no child processes, no result files, no polling.
 */
function harness() {
  const cwd = mkdtempSync(join(tmpdir(), "subagent-async-chain-"));
  const spawns: SpawnCall[] = [];
  let tool: any;
  let failNextSpawn = false;
  const pi = {
    registerTool(definition: any) { tool = definition; },
    on() {},
    sendMessage() {},
    events: { on() {}, emit() {} },
  } as any;

  registerSubagentTool(
    pi,
    (agent: string, task: string, _cwd: string, _agents: any[], options?: any) => {
      if (failNextSpawn) return { id: "", error: "spawn refused" };
      const id = `job-${spawns.length + 1}`;
      spawns.push({ agent, task, options, onComplete: options?.onComplete });
      return { id, model: undefined };
    },
    () => ({ killed: [], errors: [] }),
  );

  const ctx = {
    cwd,
    hasUI: false,
    ui: { theme: { fg: (_: string, value: string) => value }, notify() {}, setWorkingMessage() {} },
    sessionManager: { getCwd: () => cwd, getSessionId: () => "test" },
  };

  return {
    spawns,
    ctx,
    setFailNextSpawn: (value: boolean) => { failNextSpawn = value; },
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
