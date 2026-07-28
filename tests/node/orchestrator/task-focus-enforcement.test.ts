/**
 * Tests for task-focus enforcement in rules.ts.
 * Run with: npx tsx --test tests/node/orchestrator/task-focus-enforcement.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We can't easily test registerRules directly due to its complex pi dependency.
// Instead, test the core logic: reading task stores and accumulating active tasks.
// Extract the logic pattern and test it standalone.

describe("task-focus enforcement: store scanning", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "task-focus-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Replicate the core store-scanning logic from rules.ts */
  function scanTaskStores(cwd: string, sessionId?: string): Array<{ id: string; status: string; subject: string }> {
    const fs = require("node:fs");
    const path = require("node:path");
    const tasksDir = path.join(cwd, ".pi", "tasks");
    const taskCandidates: string[] = [];
    if (sessionId) taskCandidates.push(path.join(tasksDir, `tasks-${sessionId}.json`));
    taskCandidates.push(path.join(tasksDir, "tasks.json"));

    const seenIds = new Set<string>();
    const allActiveTasks: Array<{ id: string; status: string; subject: string }> = [];
    for (const taskFile of taskCandidates) {
      try {
        if (!fs.existsSync(taskFile)) continue;
        const data = JSON.parse(fs.readFileSync(taskFile, "utf-8"));
        const tasks = data.tasks || [];
        for (const t of tasks) {
          if ((t.status === "in_progress" || t.status === "pending") && !seenIds.has(String(t.id))) {
            seenIds.add(String(t.id));
            allActiveTasks.push(t);
          }
        }
      } catch { continue; }
    }
    return allActiveTasks;
  }

  it("finds active tasks in tasks.json", () => {
    const tasksDir = join(tmp, ".pi", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "tasks.json"), JSON.stringify({
      tasks: [
        { id: "1", status: "in_progress", subject: "Fix bug" },
        { id: "2", status: "completed", subject: "Done task" },
        { id: "3", status: "pending", subject: "Next task" },
      ],
    }));

    const result = scanTaskStores(tmp);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, "1");
    assert.equal(result[1].id, "3");
  });

  it("returns empty when no active tasks exist", () => {
    const tasksDir = join(tmp, ".pi", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "tasks.json"), JSON.stringify({
      tasks: [
        { id: "1", status: "completed", subject: "Done" },
      ],
    }));

    const result = scanTaskStores(tmp);
    assert.equal(result.length, 0);
  });

  it("returns empty when no task files exist", () => {
    const result = scanTaskStores(tmp);
    assert.equal(result.length, 0);
  });

  it("scans fallback tasks.json when session file has no active tasks", () => {
    const tasksDir = join(tmp, ".pi", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    // Session-scoped file: exists but no active tasks
    writeFileSync(join(tasksDir, "tasks-session123.json"), JSON.stringify({
      tasks: [
        { id: "1", status: "completed", subject: "Done in session" },
      ],
    }));
    // Fallback file: has active tasks
    writeFileSync(join(tasksDir, "tasks.json"), JSON.stringify({
      tasks: [
        { id: "2", status: "pending", subject: "Pending in fallback" },
      ],
    }));

    const result = scanTaskStores(tmp, "session123");
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "2");
    assert.equal(result[0].subject, "Pending in fallback");
  });

  it("deduplicates tasks by id across stores", () => {
    const tasksDir = join(tmp, ".pi", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    // Same task id in both files
    writeFileSync(join(tasksDir, "tasks-sess1.json"), JSON.stringify({
      tasks: [
        { id: "1", status: "in_progress", subject: "Task from session" },
      ],
    }));
    writeFileSync(join(tasksDir, "tasks.json"), JSON.stringify({
      tasks: [
        { id: "1", status: "pending", subject: "Task from fallback" },
        { id: "2", status: "pending", subject: "Another task" },
      ],
    }));

    const result = scanTaskStores(tmp, "sess1");
    assert.equal(result.length, 2);
    // id=1 should come from session (first seen)
    assert.equal(result[0].id, "1");
    assert.equal(result[0].subject, "Task from session");
    // id=2 from fallback
    assert.equal(result[1].id, "2");
  });

  it("skips malformed JSON files gracefully", () => {
    const tasksDir = join(tmp, ".pi", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "tasks-bad.json"), "not valid json");
    writeFileSync(join(tasksDir, "tasks.json"), JSON.stringify({
      tasks: [
        { id: "1", status: "pending", subject: "Still found" },
      ],
    }));

    const result = scanTaskStores(tmp, "bad");
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "1");
  });

  it("accumulates active tasks from both stores", () => {
    const tasksDir = join(tmp, ".pi", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "tasks-multi.json"), JSON.stringify({
      tasks: [
        { id: "1", status: "in_progress", subject: "Session task" },
      ],
    }));
    writeFileSync(join(tasksDir, "tasks.json"), JSON.stringify({
      tasks: [
        { id: "2", status: "pending", subject: "Global task" },
      ],
    }));

    const result = scanTaskStores(tmp, "multi");
    assert.equal(result.length, 2);
    assert.equal(result[0].id, "1");
    assert.equal(result[1].id, "2");
  });
});
