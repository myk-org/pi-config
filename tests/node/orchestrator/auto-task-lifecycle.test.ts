/**
 * Tests for autoCompleteTask() and autoMarkInProgress() task lifecycle helpers.
 * Run with: npx tsx --test tests/node/orchestrator/auto-task-lifecycle.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  autoCompleteTask,
  autoMarkInProgress,
} from "../../../extensions/orchestrator/task-lifecycle.js";
import { TaskStore } from "../../../extensions/pitasks/task-store.js";
import {
  publishTaskStore,
  publishTaskTelemetryActive,
  TASK_STORE_SYMBOL,
  TASK_TELEMETRY_ACTIVE_SYMBOL,
} from "../../../extensions/shared/task-store-bridge.js";
import { makeTempDir } from "../helpers/temp-dirs.js";


function writeTaskStore(dir: string, fileName: string, tasks: Array<{ id: string; status: string; subject: string }>): string {
  const tasksDir = join(dir, ".pi", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const filePath = join(tasksDir, fileName);
  writeFileSync(filePath, JSON.stringify({ tasks }));
  return filePath;
}

function readTaskStore(filePath: string): Array<{ id: string; status: string; subject: string }> {
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
      const result = await autoCompleteTask("1", tmp, undefined, (p) => new TaskStore(p));
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
    const result = await autoCompleteTask("1", tmp, undefined, (p) => new TaskStore(p));
    assert.equal(result, true);
    const tasks = readTaskStore(storePath);
    assert.equal(tasks[0].status, "completed");
  });

  it("skips already completed task", async () => {
    writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "completed", subject: "Test task" },
    ]);
    const result = await autoCompleteTask("1", tmp, undefined, (p) => new TaskStore(p));
    assert.equal(result, false);
  });

  it("returns false for non-existent task", async () => {
    writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "pending", subject: "Test task" },
    ]);
    const result = await autoCompleteTask("99", tmp, undefined, (p) => new TaskStore(p));
    assert.equal(result, false);
  });

  it("returns false for empty taskId", async () => {
    const result = await autoCompleteTask("", tmp, undefined, (p) => new TaskStore(p));
    assert.equal(result, false);
  });

  it("returns false for taskId '-1'", async () => {
    const result = await autoCompleteTask("-1", tmp, undefined, (p) => new TaskStore(p));
    assert.equal(result, false);
  });

  it("finds task in session-scoped store when sessionId provided", async () => {
    const storePath = writeTaskStore(tmp, "tasks-sess1.json", [
      { id: "1", status: "pending", subject: "Session task" },
    ]);
    const result = await autoCompleteTask("1", tmp, "sess1", (p) => new TaskStore(p));
    assert.equal(result, true);
    const tasks = readTaskStore(storePath);
    assert.equal(tasks[0].status, "completed");
  });

  it("falls back to tasks.json when session store does not have the task", async () => {
    writeTaskStore(tmp, "tasks-sess1.json", [
      { id: "2", status: "pending", subject: "Other task" },
    ]);
    const storePath = writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "pending", subject: "Fallback task" },
    ]);
    const result = await autoCompleteTask("1", tmp, "sess1", (p) => new TaskStore(p));
    assert.equal(result, true);
    const tasks = readTaskStore(storePath);
    assert.equal(tasks[0].status, "completed");
  });

  it("returns false when no store files exist", async () => {
    const result = await autoCompleteTask("1", tmp, undefined, (p) => new TaskStore(p));
    assert.equal(result, false);
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
      const result = await autoMarkInProgress("1", tmp, undefined, (p) => new TaskStore(p));
      assert.equal(result, true);
      const tasks = readTaskStore(storePath);
      assert.equal(tasks[0].status, "in_progress");
      assert.deepEqual(tasks[0].telemetry, { startedAt: 1_000, inputTokens: 0, outputTokens: 0 });
    } finally {
      Date.now = originalNow;
    }
  });

  it("does not mark already in_progress task", async () => {
    writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "in_progress", subject: "Test task" },
    ]);
    const result = await autoMarkInProgress("1", tmp, undefined, (p) => new TaskStore(p));
    assert.equal(result, false);
  });

  it("does not mark completed task", async () => {
    writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "completed", subject: "Test task" },
    ]);
    const result = await autoMarkInProgress("1", tmp, undefined, (p) => new TaskStore(p));
    assert.equal(result, false);
  });

  it("returns false for empty taskId", async () => {
    const result = await autoMarkInProgress("", tmp, undefined, (p) => new TaskStore(p));
    assert.equal(result, false);
  });

  it("returns false for taskId '-1'", async () => {
    const result = await autoMarkInProgress("-1", tmp, undefined, (p) => new TaskStore(p));
    assert.equal(result, false);
  });

  it("finds task in session-scoped store", async () => {
    const storePath = writeTaskStore(tmp, "tasks-sess2.json", [
      { id: "1", status: "pending", subject: "Session task" },
    ]);
    const result = await autoMarkInProgress("1", tmp, "sess2", (p) => new TaskStore(p));
    assert.equal(result, true);
    const tasks = readTaskStore(storePath);
    assert.equal(tasks[0].status, "in_progress");
  });

  it("returns false when no store files exist", async () => {
    const result = await autoMarkInProgress("1", tmp, undefined, (p) => new TaskStore(p));
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
    // Replicate the guard from subagent-tool.ts[870-873]
    if (chainTaskId && chainTaskId !== "-1") {
      return autoCompleteTask(chainTaskId, cwd, undefined, (p) => new TaskStore(p)).catch(() => false);
    }
    return false;
  }

  it("completes task when chainTaskId is valid", async () => {
    const storePath = writeTaskStore(tmp, "tasks.json", [
      { id: "5", status: "in_progress", subject: "Linked task" },
    ]);
    const result = await simulateSubagentCompletion("5", tmp);
    assert.equal(result, true);
    const tasks = readTaskStore(storePath);
    assert.equal(tasks[0].status, "completed");
  });

  it("skips when chainTaskId is undefined", async () => {
    writeTaskStore(tmp, "tasks.json", [
      { id: "5", status: "in_progress", subject: "Linked task" },
    ]);
    const result = await simulateSubagentCompletion(undefined, tmp);
    assert.equal(result, false);
  });

  it("skips when chainTaskId is '-1'", async () => {
    writeTaskStore(tmp, "tasks.json", [
      { id: "5", status: "in_progress", subject: "Linked task" },
    ]);
    const result = await simulateSubagentCompletion("-1", tmp);
    assert.equal(result, false);
  });

  it("skips when chainTaskId is empty string", async () => {
    writeTaskStore(tmp, "tasks.json", [
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
    const result = await autoCompleteTask("1", tmp, undefined, (p) => new TaskStore(p));
    assert.equal(result, false);
  });

  it("does not fall through to global when session store has the task (already completed)", async () => {
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
    const result = await autoCompleteTask("1", tmp, "s1", (p) => new TaskStore(p));
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
    const result = await autoMarkInProgress("1", tmp, undefined, (p) => new TaskStore(p));
    assert.equal(result, false);
  });

  it("does not fall through to global when session store has the task (already in_progress)", async () => {
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
    const result = await autoMarkInProgress("1", tmp, "s2", (p) => new TaskStore(p));
    assert.equal(result, false);
    // Verify global store was NOT mutated
    const globalTasks = readTaskStore(globalPath);
    assert.equal(globalTasks[0].status, "pending");
  });

  it("does not fall through to global when session store has completed task", async () => {
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
    const result = await autoMarkInProgress("1", tmp, "s3", (p) => new TaskStore(p));
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
    const result = await autoCompleteTask("1", tmp, undefined, throwingFactory);
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
    const result = await autoMarkInProgress("1", tmp, undefined, throwingFactory);
    assert.equal(result, false);
    // Verify actual file was NOT mutated
    const tasks = readTaskStore(storePath);
    assert.equal(tasks[0].status, "pending");
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
    const updated = await autoMarkInProgress("1", rootDir, "s1");
    assert.equal(updated, true);
    assert.equal(liveStore?.get("1")?.status, "in_progress");
  });

  it("activates bridged telemetry when marking task in_progress without local pitasks", async () => {
    const activations: Array<{ taskId: string; active: boolean }> = [];
    publishTaskTelemetryActive((taskId, active = true) => {
      activations.push({ taskId, active });
    });
    const updated = await autoMarkInProgress("1", rootDir, "s1");
    assert.equal(updated, true);
    assert.deepEqual(activations, [{ taskId: "1", active: true }]);
  });

  it("deactivates bridged telemetry when completing task without local pitasks", async () => {
    const activations: Array<{ taskId: string; active: boolean }> = [];
    publishTaskTelemetryActive((taskId, active = true) => {
      activations.push({ taskId, active });
    });
    const updated = await autoCompleteTask("1", rootDir, "s1");
    assert.equal(updated, true);
    assert.deepEqual(activations, [{ taskId: "1", active: false }]);
  });

  it("completes task through published store when cwd matches store root", async () => {
    const updated = await autoCompleteTask("1", rootDir, "s1");
    assert.equal(updated, true);
    assert.equal(liveStore?.get("1")?.status, "completed");
  });

  it("skips published store when cwd targets a separate worktree", async () => {
    const marked = await autoMarkInProgress("1", worktreeDir, "s1");
    const completed = await autoCompleteTask("1", worktreeDir, "s1");
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
    assert.equal(await autoMarkInProgress(owner.id, rootDir, "s1"), false);
    assert.equal(await autoCompleteTask(owner.id, rootDir, "s1"), false);
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

    assert.equal(await autoMarkInProgress("1", worktreeDir, "s1"), false);
    assert.equal(await autoCompleteTask("1", worktreeDir, "s1"), false);
    assert.equal(readTaskStore(sessPath)[0].status, "pending");
    assert.equal(readTaskStore(globalPath)[0].status, "pending");
  });
});
