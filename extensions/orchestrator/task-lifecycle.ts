/**
 * Task lifecycle helpers — auto-complete / mark in_progress via owned taskStore.
 * Uses the published pitasks store when it owns `cwd`, falling back to disk stores
 * under `<cwd>/.pi/tasks/` (or `_storeFactory` in unit tests).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../shared/logger.js";
import { publishedTaskStore, publishedTaskTelemetryActive } from "../shared/task-store-bridge.js";

const log = createLogger("task-lifecycle");

function canonicalPath(target: string): string {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function candidateStorePaths(cwd: string, sessionId?: string): string[] {
  const tasksDir = path.join(cwd, ".pi", "tasks");
  const candidates: string[] = [];
  if (sessionId) candidates.push(path.join(tasksDir, `tasks-${sessionId.replace(/[/\\]/g, "_")}.json`));
  candidates.push(path.join(tasksDir, "tasks.json"));
  return candidates;
}

/** Resolve the live pitasks store when it belongs to `cwd` (bridge first, module binding second). */
async function resolveLiveStore(cwd: string): Promise<any> {
  let store: any = publishedTaskStore();
  if (!store) {
    try {
      const mod = await import("../pitasks/index.js");
      store = mod.taskStore ?? null;
    } catch {
      return null;
    }
  }
  if (!store) return null;
  if (!store.filePath || process.env.PI_TASKS || !cwd) return store;
  return canonicalPath(path.dirname(store.filePath)) === canonicalPath(path.join(cwd, ".pi", "tasks"))
    ? store
    : null;
}

/** Activate or deactivate task telemetry via the published bridge (falling back to local import). */
async function notifyTaskTelemetry(taskId: string, active: boolean): Promise<void> {
  const bridged = publishedTaskTelemetryActive();
  if (bridged) {
    try {
      log.debug("task_lifecycle_telemetry", { taskId, active, via: "bridge" });
      bridged(taskId, active);
    } catch (e: any) {
      log.debug("task_lifecycle_telemetry_failed", { taskId, active, error: e?.message?.slice(0, 100) });
    }
    return;
  }
  try {
    const mod = await import("../pitasks/index.js");
    log.debug("task_lifecycle_telemetry", { taskId, active, via: "module" });
    mod.setTaskTelemetryActive(taskId, active);
  } catch (e: any) {
    log.debug("task_lifecycle_telemetry_unavailable", { taskId, active, error: e?.message?.slice(0, 100) });
  }
}

async function transitionTaskStatus(
  label: string,
  taskId: string,
  cwd: string,
  sessionId: string | undefined,
  shouldUpdate: (status: string) => boolean,
  nextStatus: "in_progress" | "completed",
  telemetryActive: boolean,
  _storeFactory?: (path: string) => any,
): Promise<boolean> {
  if (!taskId || taskId === "-1") return false;
  const ownerRefusedEvent = nextStatus === "completed"
    ? "task_auto_complete_owner_refused"
    : "task_auto_start_owner_refused";

  if (_storeFactory) {
    for (const storePath of candidateStorePaths(cwd, sessionId)) {
      let store: any;
      try {
        store = _storeFactory(storePath);
        const task = store.get(taskId);
        if (task) {
          if (task.assignee === "user") { log.debug(ownerRefusedEvent, { taskId }); return false; }
          if (shouldUpdate(task.status)) { store.update(taskId, { status: nextStatus }); return true; }
          return false;
        }
      } catch { continue; }
      finally { if (store && typeof store.close === "function") store.close(); }
    }
    return false;
  }

  const store = await resolveLiveStore(cwd);
  if (store) {
    try {
      const task = store.get(taskId);
      if (!task) return false;
      if (task.assignee === "user") { log.debug(ownerRefusedEvent, { taskId }); return false; }
      if (shouldUpdate(task.status)) {
        store.update(taskId, { status: nextStatus });
        await notifyTaskTelemetry(taskId, telemetryActive);
        return true;
      }
      return false;
    } catch (e: any) {
      log.debug(`${label} failed for task`, taskId, e?.message?.slice(0, 100));
      return false;
    }
  }

  if (!cwd) return false;
  const candidates = candidateStorePaths(cwd, sessionId).filter((p) => fs.existsSync(p));
  if (candidates.length === 0) return false;
  const { TaskStore } = await import("../pitasks/task-store.js");
  for (const storePath of candidates) {
    let diskStore: any;
    try {
      diskStore = new TaskStore(storePath);
      const task = diskStore.get(taskId);
      if (task) {
        if (task.assignee === "user") { log.debug(ownerRefusedEvent, { taskId }); return false; }
        if (shouldUpdate(task.status)) { diskStore.update(taskId, { status: nextStatus }); return true; }
        return false;
      }
    } catch (e: any) {
      log.debug(`${label} disk fallback failed for task`, taskId, e?.message?.slice(0, 100));
      continue;
    } finally {
      if (diskStore && typeof diskStore.close === "function") diskStore.close();
    }
  }
  return false;
}

/** Auto-complete a task (in-process, no AI involvement). */
export async function autoCompleteTask(taskId: string, cwd: string, sessionId?: string, _storeFactory?: (path: string) => any): Promise<boolean> {
  return transitionTaskStatus("autoCompleteTask", taskId, cwd, sessionId, (status) => status !== "completed", "completed", false, _storeFactory);
}

/** Auto-mark a task in_progress (in-process, no AI involvement). */
export async function autoMarkInProgress(taskId: string, cwd: string, sessionId?: string, _storeFactory?: (path: string) => any): Promise<boolean> {
  return transitionTaskStatus("autoMarkInProgress", taskId, cwd, sessionId, (status) => status === "pending", "in_progress", true, _storeFactory);
}
