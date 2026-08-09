/**
 * Task lifecycle helpers — auto-complete / mark in_progress via owned taskStore.
 * Uses the exported store instance from extensions/pitasks when available.
 * Falls back to _storeFactory for unit testing.
 */

import * as path from "node:path";

/** Get the shared task store instance (lazy import to avoid circular deps). */
async function getStore(): Promise<any> {
  // Don't cache — pitasks reassigns taskStore during session upgrade/switch.
  // Always read the latest export.
  try {
    const mod = await import("../pitasks/index.js");
    return mod.taskStore ?? null;
  } catch { return null; }
}

/** Auto-complete a task (in-process, no AI involvement). */
export async function autoCompleteTask(taskId: string, cwd: string, sessionId?: string, _storeFactory?: (path: string) => any): Promise<boolean> {
  if (!taskId || taskId === "-1") return false;

  // TEST-ONLY: _storeFactory constructs file paths for unit test isolation.
  // Production code NEVER passes this — it falls through to getStore() below.
  if (_storeFactory) {
    const tasksDir = path.join(cwd, ".pi", "tasks");
    const candidates: string[] = [];
    if (sessionId) candidates.push(path.join(tasksDir, `tasks-${sessionId}.json`));
    candidates.push(path.join(tasksDir, "tasks.json"));
    for (const storePath of candidates) {
      try {
        const store = _storeFactory(storePath);
        const task = store.get(taskId);
        if (task) {
          if (task.status !== "completed") { store.update(taskId, { status: "completed" }); return true; }
          return false;
        }
      } catch { continue; }
    }
    return false;
  }

  const store = await getStore();
  if (!store) return false;
  try {
    const task = store.get(taskId);
    if (!task) return false;
    if (task.status !== "completed") { store.update(taskId, { status: "completed" }); return true; }
    return false;
  } catch (e: any) {
    console.debug(`[task-lifecycle] autoCompleteTask failed for task ${taskId}: ${e?.message?.slice(0, 100)}`);
    return false;
  }
}

/** Auto-mark a task in_progress (in-process, no AI involvement). */
export async function autoMarkInProgress(taskId: string, cwd: string, sessionId?: string, _storeFactory?: (path: string) => any): Promise<boolean> {
  if (!taskId || taskId === "-1") return false;

  // TEST-ONLY: _storeFactory constructs file paths for unit test isolation.
  // Production code NEVER passes this — it falls through to getStore() below.
  if (_storeFactory) {
    const tasksDir = path.join(cwd, ".pi", "tasks");
    const candidates: string[] = [];
    if (sessionId) candidates.push(path.join(tasksDir, `tasks-${sessionId}.json`));
    candidates.push(path.join(tasksDir, "tasks.json"));
    for (const storePath of candidates) {
      try {
        const store = _storeFactory(storePath);
        const task = store.get(taskId);
        if (task) {
          if (task.status === "pending") { store.update(taskId, { status: "in_progress" }); return true; }
          return false;
        }
      } catch { continue; }
    }
    return false;
  }

  const store = await getStore();
  if (!store) return false;
  try {
    const task = store.get(taskId);
    if (!task) return false;
    if (task.status === "pending") { store.update(taskId, { status: "in_progress" }); return true; }
    return false;
  } catch (e: any) {
    console.debug(`[task-lifecycle] autoMarkInProgress failed for task ${taskId}: ${e?.message?.slice(0, 100)}`);
    return false;
  }
}
