/**
 * Task lifecycle helpers — auto-complete / mark in_progress via owned taskStore.
 *
 * The store is never guessed. Whoever starts a task records the store file once, from the
 * live owner (`resolveTaskStorePath`), and every later write lands in the live published
 * store when that is the recorded file, else in exactly the recorded file, else nowhere:
 * the current env cannot tell where an already-running job's task lives, and a guess can
 * complete a same-numbered task in a different list (Qodo db702025, f796c6c1).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../shared/logger.js";
import { resolveStorePath } from "../pitasks/task-store.js";
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

/** The store a task belongs to right now: the published pitasks store, else pitasks' own
 *  resolution for this cwd/session. Callers record the result when the work starts — that
 *  string is the only thing a later write may trust. */
export function resolveTaskStorePath(cwd: string, sessionId?: string): string | undefined {
  const live = publishedTaskStore(sessionId) as { filePath?: string } | null;
  if (typeof live?.filePath === "string") return live.filePath;
  return resolveStorePath(sessionId, { cwd });
}

/** Resolve the live pitasks store when it is the recorded one (bridge first, module binding
 *  second). Without a recorded path, a store in another directory is the wrong list. */
async function resolveLiveStore(cwd: string, storePath?: string, sessionId?: string): Promise<any> {
  let store: any = publishedTaskStore(sessionId);
  if (!store) {
    try {
      const mod = await import("../pitasks/index.js");
      store = mod.taskStore ?? null;
    } catch (e: any) {
      log.warn("task_lifecycle_live_store_unavailable", { error: String(e?.message ?? e).slice(0, 120) });
      return null;
    }
  }
  if (!store) {
    log.debug("task_lifecycle_live_store_unavailable", { reason: "not_published", cwd });
    return null;
  }
  if (!store.filePath) return store;
  if (storePath) {
    if (canonicalPath(store.filePath) === canonicalPath(storePath)) return store;
    log.debug("task_lifecycle_live_store_unavailable", { reason: "recorded_path_mismatch", cwd, storePath: store.filePath, recorded: storePath });
    return null;
  }
  if (process.env.PI_TASKS || !cwd) return store;
  if (canonicalPath(path.dirname(store.filePath)) === canonicalPath(path.join(cwd, ".pi", "tasks"))) return store;
  log.debug("task_lifecycle_live_store_unavailable", { reason: "cwd_mismatch", cwd, storePath: store.filePath });
  return null;
}

/** No store is known for this task, so no file may be touched — say so instead of guessing. */
function unknownStore(label: string, taskId: string, nextStatus: string): false {
  log.warn("task_lifecycle_store_unknown", { taskId, reason: "no_store_recorded", label, targetStatus: nextStatus });
  return false;
}

/** Activate or deactivate task telemetry via the published bridge (falling back to local import). */
async function notifyTaskTelemetry(taskId: string, active: boolean, sessionId?: string): Promise<void> {
  const bridged = publishedTaskTelemetryActive(sessionId);
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
    mod.setTaskTelemetryActive(taskId, active, sessionId);
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
  storePath: string | undefined,
  shouldUpdate: (status: string) => boolean,
  nextStatus: "in_progress" | "completed",
  telemetryActive: boolean,
  _storeFactory?: (path: string) => any,
  sessionId?: string,
): Promise<boolean> {
  if (!taskId || taskId === "-1") return false;
  const ownerRefusedEvent = nextStatus === "completed"
    ? "task_auto_complete_owner_refused"
    : "task_auto_start_owner_refused";

  if (_storeFactory) {
    if (!storePath) return unknownStore(label, taskId, nextStatus);
    let store: any;
    try {
      store = _storeFactory(storePath);
      return writeStatus(store, taskId, shouldUpdate, nextStatus, ownerRefusedEvent) === "written";
    } catch (e: any) {
      log.warn("task_lifecycle_status_write_failed", { label, via: "factory", taskId, targetStatus: nextStatus, storePath, errorType: e?.name ?? typeof e, error: String(e?.message ?? e).slice(0, 120) });
      return false;
    } finally { if (store && typeof store.close === "function") store.close(); }
  }

  const store = await resolveLiveStore(cwd, storePath, sessionId);
  if (store) {
    try {
      const outcome = writeStatus(store, taskId, shouldUpdate, nextStatus, ownerRefusedEvent);
      if (outcome !== "written") return false;
      await notifyTaskTelemetry(taskId, telemetryActive, sessionId);
      return true;
    } catch (e: any) {
      log.warn("task_lifecycle_status_write_failed", { label, via: "live", taskId, targetStatus: nextStatus, errorType: e?.name ?? typeof e, error: String(e?.message ?? e).slice(0, 120) });
      return false;
    }
  }

  if (!storePath) return unknownStore(label, taskId, nextStatus);
  const { TaskStore } = await import("../pitasks/task-store.js");
  let diskStore: any;
  try {
    diskStore = new TaskStore(storePath);
    return writeStatus(diskStore, taskId, shouldUpdate, nextStatus, ownerRefusedEvent) === "written";
  } catch (e: any) {
    log.warn("task_lifecycle_status_write_failed", { label, via: "disk", taskId, targetStatus: nextStatus, storePath, errorType: e?.name ?? typeof e, error: String(e?.message ?? e).slice(0, 120) });
    return false;
  } finally {
    if (diskStore && typeof diskStore.close === "function") diskStore.close();
  }
}

/** Auto-complete a task (in-process, no AI involvement). `storePath` is the file the job
 *  recorded at spawn time — without it nothing is written. */
export async function autoCompleteTask(taskId: string, cwd: string, storePath?: string, _storeFactory?: (path: string) => any, sessionId?: string): Promise<boolean> {
  return transitionTaskStatus("autoCompleteTask", taskId, cwd, storePath, (status) => status !== "completed", "completed", false, _storeFactory, sessionId);
}

/** Auto-mark a task in_progress (in-process, no AI involvement). */
export async function autoMarkInProgress(taskId: string, cwd: string, storePath?: string, _storeFactory?: (path: string) => any, sessionId?: string): Promise<boolean> {
  return transitionTaskStatus("autoMarkInProgress", taskId, cwd, storePath, (status) => status === "pending", "in_progress", true, _storeFactory, sessionId);
}
