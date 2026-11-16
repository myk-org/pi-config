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

/** Disk store candidate: the session's own file, or the project list when nothing scopes the
 *  lookup. The project list is deliberately NOT a fallback behind the session file — a restored
 *  job whose store no longer holds its task would otherwise finish a different task with the
 *  same numeric id (Qodo 42ab2269). */
function candidateStorePaths(cwd: string, sessionId?: string): string[] {
  const tasksDir = path.join(cwd, ".pi", "tasks");
  const fileName = sessionId ? `tasks-${sessionId.replace(/[/\\]/g, "_")}.json` : "tasks.json";
  return [path.join(tasksDir, fileName)];
}

/** Resolve the live pitasks store when it belongs to `cwd` (bridge first, module binding second). */
async function resolveLiveStore(cwd: string): Promise<any> {
  let store: any = publishedTaskStore();
  if (!store) {
    try {
      const mod = await import("../pitasks/index.js");
      store = mod.taskStore ?? null;
    } catch (e: any) {
      log.warn("task_lifecycle_live_store_unavailable", { error: String(e?.message ?? e).slice(0, 120) });
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

/** Write one status transition through a store-like object. The preconditions are read as late
 *  as possible and re-verified after the write: `TaskStore.update` re-loads the file under its
 *  lock and applies the status blindly, so a concurrent writer would otherwise be overridden. */
function writeStatus(
  store: any,
  taskId: string,
  shouldUpdate: (status: string) => boolean,
  nextStatus: "in_progress" | "completed",
  ownerRefusedEvent: string,
): "written" | "refused" | "missing" {
  const task = store.get(taskId);
  if (!task) return "missing";
  if (task.assignee === "user") {
    log.debug(ownerRefusedEvent, { taskId });
    return "refused";
  }
  if (!shouldUpdate(task.status)) return "refused";
  const written = store.update(taskId, { status: nextStatus });
  if (Array.isArray(written?.changedFields) && !written.changedFields.includes("status")) {
    // The task vanished under the store's lock — the write did not happen.
    log.warn("task_lifecycle_status_write_refused", { taskId, targetStatus: nextStatus, changedFields: written.changedFields });
    return "refused";
  }
  // `update` offers no compare-and-set, so the last word is a re-read: a status we did not
  // write means another writer won and our value is already gone (Qodo 51023909).
  const after = store.get(taskId);
  if (after && after.status !== nextStatus) {
    log.warn("task_lifecycle_concurrent_update_reverted", { taskId, targetStatus: nextStatus, observedStatus: after.status });
    return "refused";
  }
  return "written";
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
        const outcome = writeStatus(store, taskId, shouldUpdate, nextStatus, ownerRefusedEvent);
        if (outcome === "written") return true;
        if (outcome === "refused") return false;
      } catch (e: any) {
        log.warn("task_lifecycle_status_write_failed", { label, via: "factory", taskId, targetStatus: nextStatus, storePath, errorType: e?.name ?? typeof e, error: String(e?.message ?? e).slice(0, 120) });
        continue;
      } finally { if (store && typeof store.close === "function") store.close(); }
    }
    return false;
  }

  const store = await resolveLiveStore(cwd);
  if (store) {
    try {
      const outcome = writeStatus(store, taskId, shouldUpdate, nextStatus, ownerRefusedEvent);
      if (outcome !== "written") return false;
      await notifyTaskTelemetry(taskId, telemetryActive);
      return true;
    } catch (e: any) {
      log.warn("task_lifecycle_status_write_failed", { label, via: "live", taskId, targetStatus: nextStatus, errorType: e?.name ?? typeof e, error: String(e?.message ?? e).slice(0, 120) });
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
      const outcome = writeStatus(diskStore, taskId, shouldUpdate, nextStatus, ownerRefusedEvent);
      if (outcome === "written") return true;
      if (outcome === "refused") return false;
    } catch (e: any) {
      log.warn("task_lifecycle_status_write_failed", { label, via: "disk", taskId, targetStatus: nextStatus, storePath, errorType: e?.name ?? typeof e, error: String(e?.message ?? e).slice(0, 120) });
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
