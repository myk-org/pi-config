/**
 * Tests for autoCompleteTask() and autoMarkInProgress() task lifecycle helpers.
 * Run with: npx tsx --test tests/node/orchestrator/auto-task-lifecycle.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  autoCompleteTask,
  autoMarkInProgress,
  resolveTaskStorePath,
} from "../../../extensions/orchestrator/task-lifecycle.js";
import { registerAsyncAgents } from "../../../extensions/orchestrator/async-agents.js";
import { clearSettingsCache, setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.js";
import { getPiLogPath, setGlobalSessionId, setLogLevelPin } from "../../../extensions/shared/file-logger.js";
import { TaskStore } from "../../../extensions/pitasks/task-store.js";
import type { Task } from "../../../extensions/pitasks/types.js";
import {
  publishTaskStore,
  publishTaskTelemetryActive,
  TASK_STORE_SYMBOL,
  TASK_TELEMETRY_ACTIVE_SYMBOL,
} from "../../../extensions/shared/task-store-bridge.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

/** The lifecycle logger's own file — a warn-only pin proves these lines are not debug. */
const LOG_NAME = "task-lifecycle";
setGlobalSessionId("auto-task-lifecycle-test");

function logOffset(): number {
  const logPath = getPiLogPath(LOG_NAME);
  return logPath && existsSync(logPath) ? readFileSync(logPath, "utf-8").length : 0;
}

function logSince(offset: number): string {
  const logPath = getPiLogPath(LOG_NAME);
  return logPath && existsSync(logPath) ? readFileSync(logPath, "utf-8").slice(offset) : "";
}


/** A store file record: tests write partial payloads, and nothing here normalizes them. */
type RawTask = Partial<Task> & Pick<Task, "id" | "subject" | "status">;

function writeTaskStore(dir: string, fileName: string, tasks: RawTask[]): string {
  const tasksDir = join(dir, ".pi", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const filePath = join(tasksDir, fileName);
  writeFileSync(filePath, JSON.stringify({ tasks }));
  return filePath;
}

function readTaskStore(filePath: string): RawTask[] {
  return JSON.parse(readFileSync(filePath, "utf-8")).tasks;
}

describe("autoCompleteTask", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir("auto-complete-");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("completes a pending task with closed telemetry", async () => {
    const storePath = writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "pending", subject: "Test task" },
    ]);
    const originalNow = Date.now;
    try {
      Date.now = () => 1_000;
      const result = await autoCompleteTask("1", tmp, storePath);
      assert.equal(result, true);
      const tasks = readTaskStore(storePath);
      assert.equal(tasks[0].status, "completed");
      assert.deepEqual(tasks[0].telemetry, { startedAt: 1_000, endedAt: 1_000, inputTokens: 0, outputTokens: 0 });
    } finally {
      Date.now = originalNow;
    }
  });

  it("completes an in_progress task", async () => {
    const storePath = writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "in_progress", subject: "Test task" },
    ]);
    const result = await autoCompleteTask("1", tmp, storePath);
    assert.equal(result, true);
    const tasks = readTaskStore(storePath);
    assert.equal(tasks[0].status, "completed");
  });

  it("skips already completed task", async () => {
    const storePath = writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "completed", subject: "Test task" },
    ]);
    const result = await autoCompleteTask("1", tmp, storePath);
    assert.equal(result, false);
  });

  it("returns false for non-existent task", async () => {
    const storePath = writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "pending", subject: "Test task" },
    ]);
    const result = await autoCompleteTask("99", tmp, storePath);
    assert.equal(result, false);
  });

  it("returns false for empty taskId", async () => {
    const result = await autoCompleteTask("", tmp);
    assert.equal(result, false);
  });

  it("returns false for taskId '-1'", async () => {
    const result = await autoCompleteTask("-1", tmp);
    assert.equal(result, false);
  });
});

describe("recorded task store path", () => {
  let tmp: string;
  let originalTasks: string | undefined;
  let originalScope: string | undefined;

  beforeEach(() => {
    tmp = makeTempDir("recorded-store-");
    originalTasks = process.env.PI_TASKS;
    originalScope = process.env.PI_TASK_SCOPE;
    // No live store: these assertions are about the recorded path alone.
    delete (globalThis as Record<symbol, unknown>)[TASK_STORE_SYMBOL];
  });

  afterEach(() => {
    if (originalTasks === undefined) delete process.env.PI_TASKS;
    else process.env.PI_TASKS = originalTasks;
    if (originalScope === undefined) delete process.env.PI_TASK_SCOPE;
    else process.env.PI_TASK_SCOPE = originalScope;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("completes the recorded store after the environment moves on", async () => {
    const recorded = writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "in_progress", subject: "Job task" },
    ]);
    const other = join(tmp, "other-list.json");
    writeFileSync(other, JSON.stringify({ tasks: [{ id: "1", status: "in_progress", subject: "Other task" }] }));
    process.env.PI_TASK_SCOPE = "project";
    process.env.PI_TASKS = other;
    let result: boolean;
    try {
      result = await autoCompleteTask("1", tmp, recorded);
    } finally {
      if (originalScope === undefined) delete process.env.PI_TASK_SCOPE;
      else process.env.PI_TASK_SCOPE = originalScope;
      if (originalTasks === undefined) delete process.env.PI_TASKS;
      else process.env.PI_TASKS = originalTasks;
    }
    assert.equal(result, true);
    assert.equal(readTaskStore(recorded)[0].status, "completed");
    assert.equal(readTaskStore(other)[0].status, "in_progress");
  });

  it("warns instead of guessing when no store path was recorded", async () => {
    const guessed = writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "in_progress", subject: "Guessed task" },
    ]);
    process.env.PI_TASK_SCOPE = "project";
    let result: boolean;
    setLogLevelPin(LOG_NAME, "warn");
    const offset = logOffset();
    try {
      result = await autoCompleteTask("1", tmp);
    } finally {
      setLogLevelPin(LOG_NAME, null);
      if (originalScope === undefined) delete process.env.PI_TASK_SCOPE;
      else process.env.PI_TASK_SCOPE = originalScope;
    }
    assert.equal(result, false);
    assert.match(logSince(offset), /\[warn\] \[task-lifecycle\] task_lifecycle_store_unknown/);
    assert.equal(readTaskStore(guessed)[0].status, "in_progress");
  });
});

describe("autoMarkInProgress", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir("auto-mark-");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("marks a pending task as in_progress with fresh telemetry", async () => {
    const storePath = writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "pending", subject: "Test task" },
    ]);
    const originalNow = Date.now;
    try {
      Date.now = () => 1_000;
      const result = await autoMarkInProgress("1", tmp, storePath);
      assert.equal(result, true);
      const tasks = readTaskStore(storePath);
      assert.equal(tasks[0].status, "in_progress");
      assert.deepEqual(tasks[0].telemetry, { startedAt: 1_000, inputTokens: 0, outputTokens: 0 });
    } finally {
      Date.now = originalNow;
    }
  });

  it("does not mark already in_progress task", async () => {
    const storePath = writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "in_progress", subject: "Test task" },
    ]);
    const result = await autoMarkInProgress("1", tmp, storePath);
    assert.equal(result, false);
  });

  it("does not mark completed task", async () => {
    const storePath = writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "completed", subject: "Test task" },
    ]);
    const result = await autoMarkInProgress("1", tmp, storePath);
    assert.equal(result, false);
  });

  it("returns false for empty taskId", async () => {
    const result = await autoMarkInProgress("", tmp);
    assert.equal(result, false);
  });

  it("returns false for taskId '-1'", async () => {
    const result = await autoMarkInProgress("-1", tmp);
    assert.equal(result, false);
  });
});

describe("autoCompleteTask call-site guard (subagent-tool pattern)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir("call-site-");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function simulateSubagentCompletion(chainTaskId: string | undefined, cwd: string): Promise<boolean> {
    // Replicate the guard from subagent-tool.ts — the store is resolved once, at the call.
    if (chainTaskId && chainTaskId !== "-1") {
      return autoCompleteTask(chainTaskId, cwd, resolveTaskStorePath(cwd, "s1")).catch(() => false);
    }
    return false;
  }

  it("completes task when chainTaskId is valid", async () => {
    const storePath = writeTaskStore(tmp, "tasks-s1.json", [
      { id: "5", status: "in_progress", subject: "Linked task" },
    ]);
    const result = await simulateSubagentCompletion("5", tmp);
    assert.equal(result, true);
    const tasks = readTaskStore(storePath);
    assert.equal(tasks[0].status, "completed");
  });

  it("skips when chainTaskId is undefined", async () => {
    writeTaskStore(tmp, "tasks-s1.json", [
      { id: "5", status: "in_progress", subject: "Linked task" },
    ]);
    const result = await simulateSubagentCompletion(undefined, tmp);
    assert.equal(result, false);
  });

  it("skips when chainTaskId is '-1'", async () => {
    writeTaskStore(tmp, "tasks-s1.json", [
      { id: "5", status: "in_progress", subject: "Linked task" },
    ]);
    const result = await simulateSubagentCompletion("-1", tmp);
    assert.equal(result, false);
  });

  it("skips when chainTaskId is empty string", async () => {
    writeTaskStore(tmp, "tasks-s1.json", [
      { id: "5", status: "in_progress", subject: "Linked task" },
    ]);
    const result = await simulateSubagentCompletion("", tmp);
    assert.equal(result, false);
  });
});

describe("autoCompleteTask error handling", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir("lifecycle-err-");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns false for malformed store", async () => {
    const tasksDir = join(tmp, ".pi", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "tasks.json"), "not valid json at all");
    const result = await autoCompleteTask("1", tmp, join(tasksDir, "tasks.json"));
    assert.equal(result, false);
  });

  it("leaves another list untouched when the recorded task is completed", async () => {
    const tasksDir = join(tmp, ".pi", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    // Session store: task exists but already completed
    writeFileSync(join(tasksDir, "tasks-s1.json"), JSON.stringify({
      tasks: [{ id: "1", status: "completed", subject: "Done" }],
    }));
    // Global store: same ID, pending — should NOT be touched
    const globalPath = join(tasksDir, "tasks.json");
    writeFileSync(globalPath, JSON.stringify({
      tasks: [{ id: "1", status: "pending", subject: "Global task" }],
    }));
    const result = await autoCompleteTask("1", tmp, join(tasksDir, "tasks-s1.json"));
    assert.equal(result, false);
    // Verify global store was NOT mutated
    const globalTasks = readTaskStore(globalPath);
    assert.equal(globalTasks[0].status, "pending");
  });
});

describe("autoMarkInProgress error handling", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir("lifecycle-err-");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns false for malformed store", async () => {
    const tasksDir = join(tmp, ".pi", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "tasks.json"), "not valid json at all");
    const result = await autoMarkInProgress("1", tmp, join(tasksDir, "tasks.json"));
    assert.equal(result, false);
  });

  it("leaves another list untouched when the recorded task is in_progress", async () => {
    const tasksDir = join(tmp, ".pi", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    // Session store: task exists but already in_progress
    writeFileSync(join(tasksDir, "tasks-s2.json"), JSON.stringify({
      tasks: [{ id: "1", status: "in_progress", subject: "Running" }],
    }));
    // Global store: same ID, pending — should NOT be touched
    const globalPath = join(tasksDir, "tasks.json");
    writeFileSync(globalPath, JSON.stringify({
      tasks: [{ id: "1", status: "pending", subject: "Global task" }],
    }));
    const result = await autoMarkInProgress("1", tmp, join(tasksDir, "tasks-s2.json"));
    assert.equal(result, false);
    // Verify global store was NOT mutated
    const globalTasks = readTaskStore(globalPath);
    assert.equal(globalTasks[0].status, "pending");
  });

  it("leaves another list untouched when the recorded task is done", async () => {
    const tasksDir = join(tmp, ".pi", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    // Session store: task completed
    writeFileSync(join(tasksDir, "tasks-s3.json"), JSON.stringify({
      tasks: [{ id: "1", status: "completed", subject: "Done" }],
    }));
    // Global store: same ID, pending
    const globalPath = join(tasksDir, "tasks.json");
    writeFileSync(globalPath, JSON.stringify({
      tasks: [{ id: "1", status: "pending", subject: "Global pending" }],
    }));
    const result = await autoMarkInProgress("1", tmp, join(tasksDir, "tasks-s3.json"));
    assert.equal(result, false);
    // Global NOT mutated
    const globalTasks = readTaskStore(globalPath);
    assert.equal(globalTasks[0].status, "pending");
  });
});

describe("autoCompleteTask update-failure handling", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir("update-fail-");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns false when task completion cannot be persisted", async () => {
    const storePath = writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "pending", subject: "Task" },
    ]);
    // Inject a factory that returns a store where update() throws
    const throwingFactory = (_path: string) => ({
      get: (id: string) => ({ id, status: "pending", subject: "Task" }),
      update: () => { throw new Error("disk write failed"); },
    });
    const result = await autoCompleteTask("1", tmp, storePath, throwingFactory);
    assert.equal(result, false);
    // Verify actual file was NOT mutated
    const tasks = readTaskStore(storePath);
    assert.equal(tasks[0].status, "pending");
  });
});

describe("autoMarkInProgress update-failure handling", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir("update-fail-");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns false when in-progress status cannot be persisted", async () => {
    const storePath = writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "pending", subject: "Task" },
    ]);
    const throwingFactory = (_path: string) => ({
      get: (id: string) => ({ id, status: "pending", subject: "Task" }),
      update: () => { throw new Error("disk write failed"); },
    });
    const result = await autoMarkInProgress("1", tmp, storePath, throwingFactory);
    assert.equal(result, false);
    // Verify actual file was NOT mutated
    const tasks = readTaskStore(storePath);
    assert.equal(tasks[0].status, "pending");
  });
});

describe("concurrent status writes", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir("concurrent-write-");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses a status write another writer already overwrote", async () => {
    const state = { status: "pending" };
    const store = {
      get: () => ({ id: "1", status: state.status, assignee: "llm" }),
      // A second writer completes the task between our read and our write.
      update: () => {
        state.status = "completed";
        return { changedFields: ["status"] };
      },
    };
    assert.equal(await autoMarkInProgress("1", tmp, join(tmp, "tasks.json"), () => store), false);
    assert.equal(state.status, "completed");
  });

  it("refuses a status write the store reports as no status change", async () => {
    const store = {
      get: () => ({ id: "1", status: "pending", assignee: "llm" }),
      update: () => ({ task: undefined, changedFields: ["deleted"], warnings: [] }),
    };
    assert.equal(await autoCompleteTask("1", tmp, join(tmp, "tasks.json"), () => store), false);
  });

  it("logs a reverting concurrent update at warn level", async () => {
    setLogLevelPin(LOG_NAME, "warn");
    const offset = logOffset();
    try {
      const state = { status: "pending" };
      const store = {
        get: () => ({ id: "1", status: state.status, assignee: "llm" }),
        update: () => {
          state.status = "completed";
          return { changedFields: ["status"] };
        },
      };
      await autoMarkInProgress("1", tmp, join(tmp, "tasks.json"), () => store);
      assert.match(logSince(offset), /\[warn\] \[task-lifecycle\] task_lifecycle_concurrent_update_reverted/);
    } finally {
      setLogLevelPin(LOG_NAME, null);
    }
  });
});

describe("failed status write logging", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir("write-log-");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("logs the failed disk write at warn level with the target status", async () => {
    const storePath = writeTaskStore(tmp, "tasks.json", [{ id: "1", status: "pending", subject: "Task" }]);
    const throwingFactory = () => ({
      get: () => ({ id: "1", status: "pending", assignee: "llm" }),
      update: () => { throw new Error("disk write failed"); },
    });
    setLogLevelPin(LOG_NAME, "warn");
    const offset = logOffset();
    try {
      assert.equal(await autoCompleteTask("1", tmp, storePath, throwingFactory), false);
      const logged = logSince(offset);
      assert.match(logged, /\[warn\] \[task-lifecycle\] task_lifecycle_status_write_failed/);
      assert.match(logged, /"taskId":"1"/);
      assert.match(logged, /"targetStatus":"completed"/);
    } finally {
      setLogLevelPin(LOG_NAME, null);
    }
  });

});

describe("live task store bridge resolution", () => {
  let rootDir: string;
  let worktreeDir: string;
  let liveStore: TaskStore | null = null;

  beforeEach(() => {
    rootDir = makeTempDir("bridge-root-");
    worktreeDir = makeTempDir("bridge-wt-");
    const storePath = join(rootDir, ".pi", "tasks", "tasks-s1.json");
    liveStore = new TaskStore(storePath);
    liveStore.create("Bridge task", "desc", {
      type: "local",
      origin: "user",
      session: "s1",
      project: rootDir,
    });
    publishTaskStore(() => liveStore);
  });

  afterEach(() => {
    liveStore?.close();
    liveStore = null;
    delete (globalThis as Record<symbol, unknown>)[TASK_STORE_SYMBOL];
    delete (globalThis as Record<symbol, unknown>)[TASK_TELEMETRY_ACTIVE_SYMBOL];
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(worktreeDir, { recursive: true, force: true });
  });

  it("marks task in_progress through published store when cwd matches store root", async () => {
    const updated = await autoMarkInProgress("1", rootDir, liveStore!.filePath);
    assert.equal(updated, true);
    assert.equal(liveStore?.get("1")?.status, "in_progress");
  });

  it("activates bridged telemetry when marking task in_progress without local pitasks", async () => {
    const activations: Array<{ taskId: string; active: boolean }> = [];
    publishTaskTelemetryActive((taskId, active = true) => {
      activations.push({ taskId, active });
    });
    const updated = await autoMarkInProgress("1", rootDir, liveStore!.filePath);
    assert.equal(updated, true);
    assert.deepEqual(activations, [{ taskId: "1", active: true }]);
  });

  it("deactivates bridged telemetry when completing task without local pitasks", async () => {
    const activations: Array<{ taskId: string; active: boolean }> = [];
    publishTaskTelemetryActive((taskId, active = true) => {
      activations.push({ taskId, active });
    });
    const updated = await autoCompleteTask("1", rootDir, liveStore!.filePath);
    assert.equal(updated, true);
    assert.deepEqual(activations, [{ taskId: "1", active: false }]);
  });

  it("completes task through published store when cwd matches store root", async () => {
    const updated = await autoCompleteTask("1", rootDir, liveStore!.filePath);
    assert.equal(updated, true);
    assert.equal(liveStore?.get("1")?.status, "completed");
  });

  it("skips published store when the job recorded a store in a separate worktree", async () => {
    const worktreeStore = join(worktreeDir, ".pi", "tasks", "tasks-s1.json");
    const marked = await autoMarkInProgress("1", worktreeDir, worktreeStore);
    const completed = await autoCompleteTask("1", worktreeDir, worktreeStore);
    assert.equal(marked, false);
    assert.equal(completed, false);
    assert.equal(liveStore?.get("1")?.status, "pending");
  });

  it("refuses user-assigned tasks in published live store without activating telemetry", async () => {
    const owner = liveStore!.create("Owner step", "desc", {
      type: "local",
      origin: "user",
      session: "s1",
      project: rootDir,
    }, undefined, undefined, "user");
    const activations: Array<{ taskId: string; active: boolean }> = [];
    publishTaskTelemetryActive((taskId, active = true) => {
      activations.push({ taskId, active });
    });
    assert.equal(await autoMarkInProgress(owner.id, rootDir, liveStore!.filePath), false);
    assert.equal(await autoCompleteTask(owner.id, rootDir, liveStore!.filePath), false);
    assert.equal(liveStore?.get(owner.id)?.status, "pending");
    assert.deepEqual(activations, []);
  });

  it("refuses user-assigned tasks in disk fallback without mutating colliding global task", async () => {
    const sessPath = join(worktreeDir, ".pi", "tasks", "tasks-s1.json");
    const globalPath = join(worktreeDir, ".pi", "tasks", "tasks.json");
    const sessStore = new TaskStore(sessPath);
    sessStore.create("Owner step", "desc", {
      type: "local",
      origin: "user",
      session: "s1",
      project: worktreeDir,
    }, undefined, undefined, "user");
    sessStore.close();
    const globalStore = new TaskStore(globalPath);
    globalStore.create("Colliding agent step", "desc", {
      type: "local",
      origin: "user",
      session: "",
      project: worktreeDir,
    });
    globalStore.close();

    assert.equal(await autoMarkInProgress("1", worktreeDir, sessPath), false);
    assert.equal(await autoCompleteTask("1", worktreeDir, sessPath), false);
    assert.equal(readTaskStore(sessPath)[0].status, "pending");
    assert.equal(readTaskStore(globalPath)[0].status, "pending");
  });
});

describe("async job store recording", { concurrency: false }, () => {
  /** Spawn one async job under `env` and hand its recorded marker to `check`. */
  async function withSpawnedJob(
    env: (tmp: string) => Record<string, string>,
    check: (marker: any, tmp: string) => void,
  ): Promise<void> {
    const tmp = makeTempDir("spawn-store-");
    const previous = {
      argv: process.argv[1],
      tasks: process.env.PI_TASKS,
      scope: process.env.PI_TASK_SCOPE,
      projectTmp: process.env.PROJECT_TMP_DIR,
      interval: global.setInterval,
    };
    const script = join(tmp, "child.cjs");
    writeFileSync(script, "process.exit(0);");
    writeFileSync(join(tmp, "settings.json"), "{}");
    try {
      setGlobalSettingsPath(join(tmp, "settings.json"));
      clearSettingsCache();
      delete process.env.PI_TASKS;
      delete process.env.PI_TASK_SCOPE;
      delete process.env.PROJECT_TMP_DIR;
      for (const [key, value] of Object.entries(env(tmp))) process.env[key] = value;
      global.setInterval = (() => ({ unref() {} })) as any;
      const handlers = new Map<string, Array<(event: unknown, ctx: any) => void>>();
      const pi = {
        on: (name: string, handler: any) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
        registerCommand() {},
        sendMessage() {},
        events: new EventEmitter(),
      };
      const api = registerAsyncAgents(pi as any, () => {}, {
        spawnProcess: ((command: string, _args: string[], options: any) => spawn(command, [script], options)) as any,
      });
      handlers.get("session_start")![0]({}, { cwd: tmp, sessionManager: { getCwd: () => tmp, getSessionId: () => "spawn-test" } });
      const agent = { name: "worker", source: "project", systemPrompt: "" } as any;
      const job = api.spawnAsyncAgent("worker", "check", tmp, [agent], { taskId: "1" });
      assert.equal(job.error, undefined);
      check(JSON.parse(readFileSync(join(tmp, ".pi", "tmp", job.id, "session.json"), "utf-8")), tmp);
    } finally {
      global.setInterval = previous.interval;
      process.argv[1] = previous.argv;
      for (const [key, value] of [["PI_TASKS", previous.tasks], ["PI_TASK_SCOPE", previous.scope], ["PROJECT_TMP_DIR", previous.projectTmp]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      setGlobalSettingsPath(null);
      clearSettingsCache();
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  it("records the PI_TASKS file on the spawned job", () => withSpawnedJob(
    (tmp) => ({ PI_TASKS: join(tmp, "shared-list.json") }),
    (marker, tmp) => { assert.equal(marker.taskStorePath, join(tmp, "shared-list.json")); },
  ));

  it("records the shared-list file for a slash-containing PI_TASKS name", () => withSpawnedJob(
    () => ({ PI_TASKS: "board/custom" }),
    (marker) => { assert.equal(marker.taskStorePath, join(homedir(), ".pi", "tasks", "board", "custom.json")); },
  ));
});
