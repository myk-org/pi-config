/**
 * Tests for autoCompleteTask() and autoMarkInProgress() task lifecycle helpers.
 * Run with: npx tsx --test tests/node/orchestrator/auto-task-lifecycle.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  autoCompleteTask,
  autoMarkInProgress,
} from "../../../extensions/orchestrator/task-lifecycle.js";

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
    tmp = mkdtempSync(join(tmpdir(), "auto-complete-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("completes a pending task in tasks.json", async () => {
    const storePath = writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "pending", subject: "Test task" },
    ]);
    const result = await autoCompleteTask("1", tmp);
    assert.equal(result, true);
    const tasks = readTaskStore(storePath);
    assert.equal(tasks[0].status, "completed");
  });

  it("completes an in_progress task", async () => {
    const storePath = writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "in_progress", subject: "Test task" },
    ]);
    const result = await autoCompleteTask("1", tmp);
    assert.equal(result, true);
    const tasks = readTaskStore(storePath);
    assert.equal(tasks[0].status, "completed");
  });

  it("skips already completed task", async () => {
    writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "completed", subject: "Test task" },
    ]);
    const result = await autoCompleteTask("1", tmp);
    assert.equal(result, false);
  });

  it("returns false for non-existent task", async () => {
    writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "pending", subject: "Test task" },
    ]);
    const result = await autoCompleteTask("99", tmp);
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

  it("finds task in session-scoped store when sessionId provided", async () => {
    const storePath = writeTaskStore(tmp, "tasks-sess1.json", [
      { id: "1", status: "pending", subject: "Session task" },
    ]);
    const result = await autoCompleteTask("1", tmp, "sess1");
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
    const result = await autoCompleteTask("1", tmp, "sess1");
    assert.equal(result, true);
    const tasks = readTaskStore(storePath);
    assert.equal(tasks[0].status, "completed");
  });

  it("returns false when no store files exist", async () => {
    const result = await autoCompleteTask("1", tmp);
    assert.equal(result, false);
  });
});

describe("autoMarkInProgress", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "auto-mark-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("marks a pending task as in_progress", async () => {
    const storePath = writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "pending", subject: "Test task" },
    ]);
    const result = await autoMarkInProgress("1", tmp);
    assert.equal(result, true);
    const tasks = readTaskStore(storePath);
    assert.equal(tasks[0].status, "in_progress");
  });

  it("does not mark already in_progress task", async () => {
    writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "in_progress", subject: "Test task" },
    ]);
    const result = await autoMarkInProgress("1", tmp);
    assert.equal(result, false);
  });

  it("does not mark completed task", async () => {
    writeTaskStore(tmp, "tasks.json", [
      { id: "1", status: "completed", subject: "Test task" },
    ]);
    const result = await autoMarkInProgress("1", tmp);
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

  it("finds task in session-scoped store", async () => {
    const storePath = writeTaskStore(tmp, "tasks-sess2.json", [
      { id: "1", status: "pending", subject: "Session task" },
    ]);
    const result = await autoMarkInProgress("1", tmp, "sess2");
    assert.equal(result, true);
    const tasks = readTaskStore(storePath);
    assert.equal(tasks[0].status, "in_progress");
  });

  it("returns false when no store files exist", async () => {
    const result = await autoMarkInProgress("1", tmp);
    assert.equal(result, false);
  });
});

describe("autoCompleteTask call-site guard (subagent-tool pattern)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "call-site-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function simulateSubagentCompletion(chainTaskId: string | undefined, cwd: string): Promise<boolean> {
    // Replicate the guard from subagent-tool.ts[870-873]
    if (chainTaskId && chainTaskId !== "-1") {
      return autoCompleteTask(chainTaskId, cwd).catch(() => false);
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
    tmp = mkdtempSync(join(tmpdir(), "lifecycle-err-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns false for malformed store", async () => {
    const tasksDir = join(tmp, ".pi", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "tasks.json"), "not valid json at all");
    const result = await autoCompleteTask("1", tmp);
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
    const result = await autoCompleteTask("1", tmp, "s1");
    assert.equal(result, false);
    // Verify global store was NOT mutated
    const globalTasks = readTaskStore(globalPath);
    assert.equal(globalTasks[0].status, "pending");
  });
});

describe("autoMarkInProgress error handling", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lifecycle-err-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns false for malformed store", async () => {
    const tasksDir = join(tmp, ".pi", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "tasks.json"), "not valid json at all");
    const result = await autoMarkInProgress("1", tmp);
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
    const result = await autoMarkInProgress("1", tmp, "s2");
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
    const result = await autoMarkInProgress("1", tmp, "s3");
    assert.equal(result, false);
    // Global NOT mutated
    const globalTasks = readTaskStore(globalPath);
    assert.equal(globalTasks[0].status, "pending");
  });
});
