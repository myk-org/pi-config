/**
 * Task lifecycle helpers — auto-complete / mark in_progress via pi-tasks TaskStore.
 * Kept separate from async-agents.ts so unit tests can import without loading
 * @earendil-works/pi-coding-agent (unavailable in the tsx test harness).
 */

import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

let TaskStoreClass: any = null;
const taskStoreReady: Promise<void> = (async () => {
  const candidates = [
    "@tintinweb/pi-tasks/dist/task-store.js",
    pathToFileURL(path.join(os.homedir(), ".pi/agent/npm/node_modules/@tintinweb/pi-tasks/dist/task-store.js")).href,
  ];
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      if (mod.TaskStore) { TaskStoreClass = mod.TaskStore; break; }
    } catch { continue; }
  }
  if (!TaskStoreClass) {
    throw new Error("[task-lifecycle] FATAL: TaskStore not found — @tintinweb/pi-tasks is required but failed to load");
  }
})();

/** Auto-complete a task via pi-tasks TaskStore (in-process, no AI involvement). */
export async function autoCompleteTask(taskId: string, cwd: string, sessionId?: string, _storeFactory?: (path: string) => any): Promise<boolean> {
  if (!taskId || taskId === "-1") return false;
  await taskStoreReady;

  const tasksDir = path.join(cwd, ".pi", "tasks");
  const candidates: string[] = [];
  if (sessionId) candidates.push(path.join(tasksDir, `tasks-${sessionId}.json`));
  candidates.push(path.join(tasksDir, "tasks.json"));

  for (const storePath of candidates) {
    try {
      const factory = _storeFactory ?? ((p: string) => new TaskStoreClass(p));
      const store = factory(storePath);
      const task = store.get(taskId);
      if (task) {
        // Task found in this store — do not fall through to later candidates
        if (task.status !== "completed") {
          store.update(taskId, { status: "completed" });
          return true;
        }
        return false;
      }
    } catch (e: any) {
      console.debug(`[task-lifecycle] autoCompleteTask failed for task ${taskId}: ${e?.message?.slice(0, 100)}`);
      continue;
    }
  }
  return false;
}

/** Auto-mark a task in_progress via pi-tasks TaskStore (in-process, no AI involvement). */
export async function autoMarkInProgress(taskId: string, cwd: string, sessionId?: string, _storeFactory?: (path: string) => any): Promise<boolean> {
  if (!taskId || taskId === "-1") return false;
  await taskStoreReady;

  const tasksDir = path.join(cwd, ".pi", "tasks");
  const candidates: string[] = [];
  if (sessionId) candidates.push(path.join(tasksDir, `tasks-${sessionId}.json`));
  candidates.push(path.join(tasksDir, "tasks.json"));

  for (const storePath of candidates) {
    try {
      const factory = _storeFactory ?? ((p: string) => new TaskStoreClass(p));
      const store = factory(storePath);
      const task = store.get(taskId);
      if (task) {
        // Task found in this store — do not fall through to later candidates
        if (task.status === "pending") {
          store.update(taskId, { status: "in_progress" });
          return true;
        }
        return false;
      }
    } catch (e: any) {
      console.debug(`[task-lifecycle] autoMarkInProgress failed for task ${taskId}: ${e?.message?.slice(0, 100)}`);
      continue;
    }
  }
  return false;
}
