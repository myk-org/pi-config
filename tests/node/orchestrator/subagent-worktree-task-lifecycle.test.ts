import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { registerAsyncAgents } from "../../../extensions/orchestrator/async-agents.js";
import { clearSettingsCache, setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.js";
import { registerSubagentTool } from "../../../extensions/orchestrator/subagent-tool.js";
import { TaskStore } from "../../../extensions/pitasks/task-store.js";
import { publishTaskStore, TASK_STORE_SYMBOL } from "../../../extensions/shared/task-store-bridge.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

function writeWorkerAgent(dir: string): void {
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "worker.md"),
    "---\nname: worker\ndescription: test worker\n---\nWork.\n",
  );
}

interface ChildTrace {
  id: string;
  cwd: string;
  statuses: Record<string, string>;
  argv: string[];
}

function writeSyncChildScript(dir: string): { scriptPath: string; traceDir: string; gateDir: string } {
  const scriptPath = join(dir, "sync-child.cjs");
  const traceDir = join(dir, "traces");
  const gateDir = join(dir, "gates");
  mkdirSync(traceDir, { recursive: true });
  mkdirSync(gateDir, { recursive: true });
  writeFileSync(
    scriptPath,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const id = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;",
      "const storeRaw = JSON.parse(fs.readFileSync(process.env.TEST_ORCH_STORE_PATH, 'utf8'));",
      "const statuses = Object.fromEntries(storeRaw.tasks.map((t) => [t.id, t.status]));",
      "const record = { id, cwd: fs.realpathSync(process.cwd()), statuses, argv: process.argv.slice(2) };",
      "const traceTmp = path.join(process.env.TEST_TRACE_DIR, `${id}.tmp`);",
      "const traceFile = path.join(process.env.TEST_TRACE_DIR, `${id}.json`);",
      "fs.writeFileSync(traceTmp, JSON.stringify(record));",
      "fs.renameSync(traceTmp, traceFile);",
      "const gateDir = process.env.TEST_GATE_DIR;",
      "const readReleaseToken = () => {",
      "  for (const name of [`${id}.release`, 'release-all']) {",
      "    try {",
      "      return fs.readFileSync(path.join(gateDir, name), 'utf8').trim();",
      "    } catch (err) {",
      "      if (!err || err.code !== 'ENOENT') throw err;",
      "    }",
      "  }",
      "  return null;",
      "};",
      "let settled = false;",
      "let watcher;",
      "let pollTimer;",
      "let deadlineTimer;",
      "const finish = (token, code = 0) => {",
      "  if (settled) return;",
      "  settled = true;",
      "  if (watcher) watcher.close();",
      "  if (pollTimer) clearInterval(pollTimer);",
      "  if (deadlineTimer) clearTimeout(deadlineTimer);",
      "  if (code === 0) {",
      "    process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `worker-ok:${token}` }] } }) + '\\n');",
      "  } else {",
      "    process.exitCode = code;",
      "  }",
      "};",
      "const tryRelease = () => {",
      "  if (!fs.existsSync(gateDir)) { finish('aborted', 1); return true; }",
      "  const token = readReleaseToken();",
      "  if (token !== null) { finish(token, 0); return true; }",
      "  return false;",
      "};",
      "if (!tryRelease()) {",
      "  try {",
      "    watcher = fs.watch(gateDir, tryRelease);",
      "    watcher.on('error', tryRelease);",
      "  } catch {}",
      "  pollTimer = setInterval(tryRelease, 10);",
      "  deadlineTimer = setTimeout(() => { process.stderr.write(`gate timed out for ${id}\\n`); finish('timeout', 1); }, 15000);",
      "  tryRelease();",
      "}",
    ].join("\n"),
  );
  return { scriptPath, traceDir, gateDir };
}

function readTraces(traceDir: string): ChildTrace[] {
  return readdirSync(traceDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(traceDir, file), "utf8")));
}

async function eventually(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "condition did not settle before deadline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface WorktreeHarnessOptions {
  publishLiveStore?: boolean;
  includeSessionGetCwd?: boolean;
  omitCtxCwd?: boolean;
}

function createWorktreeHarness(opts: WorktreeHarnessOptions = {}) {
  const publishLiveStore = opts.publishLiveStore ?? true;
  const includeSessionGetCwd = opts.includeSessionGetCwd ?? true;
  const omitCtxCwd = opts.omitCtxCwd ?? false;

  const orchestratorCwd = makeTempDir("orch-root-");
  const worktreeA = makeTempDir("orch-wt-a-");
  const worktreeB = makeTempDir("orch-wt-b-");
  writeWorkerAgent(orchestratorCwd);
  writeWorkerAgent(worktreeA);
  writeWorkerAgent(worktreeB);

  const globalSettingsPath = join(orchestratorCwd, "global-settings.json");
  writeFileSync(globalSettingsPath, "{}");
  setGlobalSettingsPath(globalSettingsPath);
  clearSettingsCache();

  const sessionId = "sess-worktree-1102";
  const storePath = join(orchestratorCwd, ".pi", "tasks", `tasks-${sessionId}.json`);
  const seedStore = new TaskStore(storePath);
  seedStore.create("First worktree task", "desc 1", {
    type: "local",
    origin: "user",
    session: sessionId,
    project: orchestratorCwd,
  });
  seedStore.create("Second worktree task", "desc 2", {
    type: "local",
    origin: "user",
    session: sessionId,
    project: orchestratorCwd,
  });

  let liveStore: TaskStore | null = null;
  if (publishLiveStore) {
    liveStore = seedStore;
    publishTaskStore(() => liveStore);
  } else {
    seedStore.close();
    delete (globalThis as Record<symbol, unknown>)[TASK_STORE_SYMBOL];
  }

  const { scriptPath, traceDir, gateDir } = writeSyncChildScript(orchestratorCwd);
  const previousArgv1 = process.argv[1];
  const previousOrchStoreEnv = process.env.TEST_ORCH_STORE_PATH;
  const previousTraceDirEnv = process.env.TEST_TRACE_DIR;
  const previousGateDirEnv = process.env.TEST_GATE_DIR;
  const previousProjectTmp = process.env.PROJECT_TMP_DIR;
  const previousSetInterval = global.setInterval;

  process.argv[1] = scriptPath;
  process.env.TEST_ORCH_STORE_PATH = storePath;
  process.env.TEST_TRACE_DIR = traceDir;
  process.env.TEST_GATE_DIR = gateDir;

  let poller: (() => void) | undefined;
  global.setInterval = ((fn: () => void) => {
    poller = fn;
    return { unref() {}, [Symbol.toPrimitive]: () => 0 };
  }) as typeof setInterval;

  const handlers = new Map<string, Array<(event: unknown, ctx: any) => void>>();
  const messages: any[] = [];
  let tool: any;
  const pi = {
    registerTool(definition: any) {
      tool = definition;
    },
    registerCommand() {},
    on(event: string, handler: (event: unknown, ctx: any) => void) {
      (handlers.get(event) ?? handlers.set(event, []).get(event)!).push(handler);
    },
    sendMessage(message: any) {
      messages.push(message);
    },
    events: new EventEmitter(),
  };

  let asyncApi: ReturnType<typeof registerAsyncAgents>;
  withSubagentChildEnv(undefined, () => {
    asyncApi = registerAsyncAgents(pi as any, () => {}, {
      spawnProcess: () => Object.assign(new EventEmitter(), { stderr: { pipe() {} } }) as any,
    });
    registerSubagentTool(pi as any, asyncApi.spawnAsyncAgent, asyncApi.killAsyncAgent);
  });
  assert.ok(tool, "subagent tool must register");

  const sessionManager: Record<string, () => string> = {
    getSessionId: () => sessionId,
  };
  if (includeSessionGetCwd) {
    sessionManager.getCwd = () => orchestratorCwd;
  }

  const ctx = {
    cwd: omitCtxCwd ? undefined : orchestratorCwd,
    hasUI: true,
    model: { id: "claude-sonnet-4-5", provider: "anthropic" },
    ui: {
      theme: { fg: (_: string, value: string) => value, bold: (value: string) => value },
      notify() {},
      setWorkingMessage() {},
      setStatus() {},
      confirm: async () => true,
    },
    sessionManager,
  };

  for (const handler of handlers.get("session_start") ?? []) {
    handler({}, { ...ctx, cwd: orchestratorCwd });
  }

  const readDiskStatuses = (): Record<string, string> => {
    const raw = JSON.parse(readFileSync(storePath, "utf8"));
    return Object.fromEntries(raw.tasks.map((t: any) => [t.id, t.status]));
  };

  const resultsDir = (): string => {
    const tmpRoot = join(orchestratorCwd, ".pi", "tmp");
    const entry = readdirSync(tmpRoot).find((name) => name.startsWith(`async-results-pid-${process.pid}`));
    assert.ok(entry, "async results directory must exist");
    return join(tmpRoot, entry);
  };

  const completeAsyncJob = (jobId: string, output: string, agent = "worker") => {
    const jobDir = join(orchestratorCwd, ".pi", "tmp", jobId);
    writeFileSync(
      join(jobDir, "status.json"),
      JSON.stringify({ runId: jobId, agent, state: "running", pid: process.pid, startedAt: Date.now() }),
    );
    writeFileSync(
      join(resultsDir(), `${jobId}.json`),
      JSON.stringify({ id: jobId, agent, task: "step", success: true, output, durationMs: 5, exitCode: 0 }),
    );
    assert.ok(poller, "async poller must be registered");
    poller();
  };

  const pendingRuns: Array<Promise<unknown>> = [];

  const waitForTraces = async (count: number): Promise<ChildTrace[]> => {
    await eventually(() => readTraces(traceDir).length >= count);
    return readTraces(traceDir);
  };

  const writeGateFile = (name: string): void => {
    if (!existsSync(gateDir)) return;
    const tmp = join(gateDir, `${name}.tmp`);
    writeFileSync(tmp, "released");
    renameSync(tmp, join(gateDir, name));
  };

  const releaseChild = (traceId: string): void => writeGateFile(`${traceId}.release`);
  const releaseAllChildren = (): void => writeGateFile("release-all");

  return {
    orchestratorCwd,
    worktreeA,
    worktreeB,
    traceDir,
    messages,
    asyncApi: asyncApi!,
    readDiskStatuses,
    completeAsyncJob,
    waitForTraces,
    releaseChild,
    releaseAllChildren,
    run: (params: Record<string, unknown>) => {
      const promise = tool.execute(
        "call-wt",
        { confirmProjectAgents: false, ...params },
        new AbortController().signal,
        undefined,
        ctx,
      );
      pendingRuns.push(promise);
      return promise;
    },
    restore: async () => {
      try {
        releaseAllChildren();
        await Promise.allSettled(pendingRuns);
        for (const handler of handlers.get("session_shutdown") ?? []) {
          handler({}, ctx);
        }
      } finally {
        liveStore?.close();
        delete (globalThis as Record<symbol, unknown>)[TASK_STORE_SYMBOL];
        global.setInterval = previousSetInterval;
        process.argv[1] = previousArgv1;
        if (previousOrchStoreEnv === undefined) delete process.env.TEST_ORCH_STORE_PATH;
        else process.env.TEST_ORCH_STORE_PATH = previousOrchStoreEnv;
        if (previousTraceDirEnv === undefined) delete process.env.TEST_TRACE_DIR;
        else process.env.TEST_TRACE_DIR = previousTraceDirEnv;
        if (previousGateDirEnv === undefined) delete process.env.TEST_GATE_DIR;
        else process.env.TEST_GATE_DIR = previousGateDirEnv;
        if (previousProjectTmp === undefined) delete process.env.PROJECT_TMP_DIR;
        else process.env.PROJECT_TMP_DIR = previousProjectTmp;
        setGlobalSettingsPath(null);
        clearSettingsCache();
        rmSync(orchestratorCwd, { recursive: true, force: true });
        rmSync(worktreeA, { recursive: true, force: true });
        rmSync(worktreeB, { recursive: true, force: true });
      }
    },
  };
}

describe("subagent worktree task lifecycle", { concurrency: false }, () => {
  it("updates orchestrator task store during sync single execution in a worktree", async () => {
    const h = createWorktreeHarness();
    try {
      const runPromise = h.run({
        agent: "worker",
        task: "single worktree work",
        cwd: h.worktreeA,
        estimatedSeconds: 5,
        taskId: "1",
      });
      const traces = await h.waitForTraces(1);
      assert.equal(h.readDiskStatuses()["1"], "in_progress");
      assert.equal(traces.length, 1);
      assert.equal(traces[0].cwd, realpathSync(h.worktreeA));
      assert.equal(traces[0].statuses["1"], "in_progress");

      h.releaseAllChildren();
      const result = await runPromise;
      assert.ok(!result.isError);
      assert.match(result.content[0].text, /worker-ok:released/);
      assert.equal(h.readDiskStatuses()["1"], "completed");
      assert.equal(existsSync(join(h.worktreeA, ".pi", "tasks")), false);
    } finally {
      await h.restore();
    }
  });

  it("updates orchestrator task store during sync parallel execution in worktrees", async () => {
    const h = createWorktreeHarness();
    try {
      const runPromise = h.run({
        tasks: [
          { agent: "worker", task: "parallel A", cwd: h.worktreeA, estimatedSeconds: 5, taskId: "1" },
          { agent: "worker", task: "parallel B", cwd: h.worktreeB, estimatedSeconds: 5, taskId: "2" },
        ],
      });
      const traces = await h.waitForTraces(2);
      assert.deepEqual(h.readDiskStatuses(), { "1": "in_progress", "2": "in_progress" });
      assert.equal(traces.length, 2);
      assert.deepEqual(
        new Set(traces.map((t) => t.cwd)),
        new Set([realpathSync(h.worktreeA), realpathSync(h.worktreeB)]),
      );
      for (const trace of traces) {
        assert.equal(trace.statuses["1"], "in_progress");
        assert.equal(trace.statuses["2"], "in_progress");
      }

      h.releaseAllChildren();
      const result = await runPromise;
      assert.ok(!result.isError);
      assert.equal(result.content[0].text.match(/worker-ok:released/g)?.length, 2);
      const finalStatuses = h.readDiskStatuses();
      assert.equal(finalStatuses["1"], "completed");
      assert.equal(finalStatuses["2"], "completed");
      assert.equal(existsSync(join(h.worktreeA, ".pi", "tasks")), false);
      assert.equal(existsSync(join(h.worktreeB, ".pi", "tasks")), false);
    } finally {
      await h.restore();
    }
  });

  it("updates orchestrator task store during sync chain execution in a worktree", async () => {
    const h = createWorktreeHarness();
    try {
      const runPromise = h.run({
        chain: [
          { agent: "worker", task: "chain step 1", cwd: h.worktreeA, estimatedSeconds: 5, taskId: "1" },
          { agent: "worker", task: "chain step 2 {previous}", cwd: h.worktreeB, estimatedSeconds: 5, taskId: "2" },
        ],
      });
      const [step1Trace] = await h.waitForTraces(1);
      assert.deepEqual(h.readDiskStatuses(), { "1": "in_progress", "2": "pending" });
      assert.equal(step1Trace.cwd, realpathSync(h.worktreeA));
      assert.equal(step1Trace.statuses["1"], "in_progress");
      assert.equal(step1Trace.statuses["2"], "pending");

      h.releaseChild(step1Trace.id);
      const tracesAfterStep2 = await h.waitForTraces(2);
      const step2Trace = tracesAfterStep2.find((t) => t.id !== step1Trace.id);
      assert.ok(step2Trace);
      assert.deepEqual(h.readDiskStatuses(), { "1": "completed", "2": "in_progress" });
      assert.equal(step2Trace.cwd, realpathSync(h.worktreeB));
      assert.equal(step2Trace.statuses["1"], "completed");
      assert.equal(step2Trace.statuses["2"], "in_progress");
      assert.ok(step2Trace.argv.some((arg) => arg.includes("worker-ok:released")));

      h.releaseChild(step2Trace.id);
      const result = await runPromise;
      assert.ok(!result.isError);
      assert.match(result.content[0].text, /worker-ok:released/);
      const finalStatuses = h.readDiskStatuses();
      assert.equal(finalStatuses["1"], "completed");
      assert.equal(finalStatuses["2"], "completed");
    } finally {
      await h.restore();
    }
  });

  it("updates orchestrator task store during async chain execution in a worktree", async () => {
    const h = createWorktreeHarness({ includeSessionGetCwd: false });
    try {
      const result = await h.run({
        async: true,
        chain: [
          { agent: "worker", task: "async step 1", cwd: h.worktreeA, estimatedSeconds: 5, taskId: "1" },
          { agent: "worker", task: "async step 2 {previous}", cwd: h.worktreeB, estimatedSeconds: 5, taskId: "2" },
        ],
      });
      assert.ok(!result.isError);
      await eventually(() => h.readDiskStatuses()["1"] === "in_progress");
      assert.equal(h.readDiskStatuses()["2"], "pending");

      const step1Job = h.asyncApi.getAsyncJobs()[0];
      assert.ok(step1Job);
      h.completeAsyncJob(step1Job.id, "STEP-1-DONE");

      await eventually(() => h.readDiskStatuses()["1"] === "completed");
      await eventually(() => h.readDiskStatuses()["2"] === "in_progress");

      const step2Job = h.asyncApi.getAsyncJobs().find((j) => j.id !== step1Job.id);
      assert.ok(step2Job);
      h.completeAsyncJob(step2Job.id, "STEP-2-DONE");

      await eventually(() => h.readDiskStatuses()["2"] === "completed");
      assert.equal(existsSync(join(h.worktreeA, ".pi", "tasks")), false);
      assert.equal(existsSync(join(h.worktreeB, ".pi", "tasks")), false);
    } finally {
      await h.restore();
    }
  });

  it("updates disk-backed orchestrator task store when no live store is published", async () => {
    const h = createWorktreeHarness({ publishLiveStore: false });
    try {
      const runPromise = h.run({
        agent: "worker",
        task: "disk fallback work",
        cwd: h.worktreeA,
        estimatedSeconds: 5,
        taskId: "1",
      });
      const traces = await h.waitForTraces(1);
      assert.equal(h.readDiskStatuses()["1"], "in_progress");
      assert.equal(traces.length, 1);
      assert.equal(traces[0].statuses["1"], "in_progress");

      h.releaseAllChildren();
      const result = await runPromise;
      assert.ok(!result.isError);
      assert.match(result.content[0].text, /worker-ok:released/);
      assert.equal(h.readDiskStatuses()["1"], "completed");
    } finally {
      await h.restore();
    }
  });

  it("falls back to target cwd when orchestrator ctx.cwd is absent", async () => {
    const h = createWorktreeHarness({ publishLiveStore: false, includeSessionGetCwd: false, omitCtxCwd: true });
    try {
      const wtStorePath = join(h.worktreeA, ".pi", "tasks", "tasks-sess-worktree-1102.json");
      const wtStore = new TaskStore(wtStorePath);
      wtStore.create("Fallback target task", "desc", {
        type: "local",
        origin: "user",
        session: "sess-worktree-1102",
        project: h.worktreeA,
      });
      wtStore.close();

      const runPromise = h.run({
        agent: "worker",
        task: "fallback work",
        cwd: h.worktreeA,
        estimatedSeconds: 5,
        taskId: "1",
      });
      await h.waitForTraces(1);
      const inProgressWtTasks = JSON.parse(readFileSync(wtStorePath, "utf8")).tasks;
      assert.equal(inProgressWtTasks[0].status, "in_progress");
      assert.equal(h.readDiskStatuses()["1"], "pending");

      h.releaseAllChildren();
      const result = await runPromise;
      assert.ok(!result.isError);
      assert.match(result.content[0].text, /worker-ok:released/);
      const wtTasks = JSON.parse(readFileSync(wtStorePath, "utf8")).tasks;
      assert.equal(wtTasks[0].status, "completed");
      assert.equal(h.readDiskStatuses()["1"], "pending");
    } finally {
      await h.restore();
    }
  });
});
