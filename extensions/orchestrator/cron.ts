/** Cron tasks with session and project scopes. Durable project delivery is at-least-once. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getProjectTmpDir } from "./utils.js";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { formatCronSchedule, formatCronStatusSlot, cronStateLabel, toCronStatusTaskView, type CronPauseResult, type CronScopeResult } from "./cron-status-format.js";
import { parseModelOverride } from "./parse-model-override.js";
import { openCronStatusOverlay } from "./cron-status-ui.js";
import { setSlot } from "./status-bar.js";
import { isBrowserDispatch } from "../shared/live-ctx.js";
import { acquireLeaderLock, durableCronSupported, isLeaderLockCurrent, mutateDurableCronStore, readDurableCronStore, readDurableCronStoreOutcome, refreshLeaderLock, releaseLeaderLock, setDurableCronPaused, validateDurableCronTask, type CronLockOwner, type CronScope, type DurableCronTask } from "./cron-store.js";

const log = createLogger("cron");
export interface CronTask { id: string; scope: CronScope; cwd: string; description: string; task: string; intervalMs?: number; atHour?: number; atMinute?: number; /** "provider/model-id" or bare "model-id"; undefined inherits the normal resolution chain. */ model?: string; /** Paused by the user: kept, never armed (issue #1087). */ paused?: boolean; createdAt: number; lastRun?: number; nextRun?: number; leader?: boolean; }
type Timer = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
const durable = (scope: CronScope) => scope === "project";
let sessionStore = "";
function sessionStoreFor(ctx: any): string {
  let id: unknown;
  try { id = ctx.sessionManager?.getSessionId?.(); } catch { return ""; }
  // A process ID survives /new. Only pi's session ID preserves session scope across /reload.
  return typeof id === "string" && id ? path.join(getProjectTmpDir(ctx.cwd), `cron-${createHash("sha256").update(id).digest("hex")}.json`) : "";
}
function readSessionTasks(file: string): unknown[] {
  try { const value = JSON.parse(fs.readFileSync(file, "utf8")); return Array.isArray(value) ? value : []; } catch { return []; }
}
function validateSessionCronTask(task: unknown): asserts task is CronTask {
  const value = task as CronTask;
  if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id || typeof value.description !== "string" || typeof value.task !== "string" || !value.task.trim() || !Number.isFinite(value.createdAt)) throw new Error("Invalid session cron task");
  validateSchedule({ interval_seconds: value.intervalMs === undefined ? undefined : value.intervalMs / 1000, at_hour: value.atHour, at_minute: value.atMinute });
  if (value.model !== undefined && (typeof value.model !== "string" || !parseModelOverride(value.model))) throw new Error("Invalid session cron model");
  if (value.paused !== undefined && typeof value.paused !== "boolean") throw new Error("Invalid session cron paused flag");
  if ((value.lastRun !== undefined && !Number.isFinite(value.lastRun)) || (value.nextRun !== undefined && !Number.isFinite(value.nextRun))) throw new Error("Invalid session cron timestamp");
}
function writeSessionTasks(file: string, tasks: Iterable<CronTask>) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify([...tasks]), { mode: 0o600 });
}
export const qualifyCronId = (task: Pick<CronTask, "scope" | "id">) => `${task.scope === "project" ? "persist" : "session"}:${task.id}`;
function parseQualifiedId(qualified: string): { scope: CronScope; id: string } | null {
  const [kind, id] = qualified.split(":", 2);
  const scope = kind === "persist" ? "project" : kind as CronScope;
  return id && (scope === "session" || scope === "project") ? { scope, id } : null;
}
function syncTaskFields(target: CronTask, source: CronTask): void {
  target.description = source.description;
  target.task = source.task;
  target.intervalMs = source.intervalMs;
  target.atHour = source.atHour;
  target.atMinute = source.atMinute;
  target.model = source.model;
  target.paused = source.paused;
  target.lastRun = source.lastRun;
  target.nextRun = source.nextRun;
  target.leader = source.leader;
}
function sameSchedule(
  a: Pick<CronTask, "intervalMs" | "atHour" | "atMinute">,
  b: Pick<CronTask, "intervalMs" | "atHour" | "atMinute">,
): boolean {
  return a.intervalMs === b.intervalMs && a.atHour === b.atHour && a.atMinute === b.atMinute;
}
function projectStore(cwd: string) { return path.join(cwd, ".pi", "cron", "crons.json"); }
function validateSchedule(details: any) {
  const interval = details.interval_seconds;
  const hour = details.at_hour;
  const minute = details.at_minute;
  if (interval !== undefined && (hour !== undefined || minute !== undefined)) throw new Error("specify either interval_seconds or at_hour/at_minute, not both");
  if (interval !== undefined && (!Number.isFinite(interval) || interval < 10)) throw new Error("interval_seconds must be finite and at least 10 seconds");
  if (hour !== undefined && (!Number.isInteger(hour) || hour < 0 || hour > 23)) throw new Error("at_hour must be an integer from 0 to 23");
  if (minute !== undefined && (!Number.isInteger(minute) || minute < 0 || minute > 59)) throw new Error("at_minute must be an integer from 0 to 59");
  if (minute !== undefined && hour === undefined) throw new Error("at_minute requires at_hour");
}
function applyCronPatch<T extends CronTask | DurableCronTask>(current: T, details: any): { updated: T; scheduleChanged: boolean } {
  const hasEdit = ["description", "task", "model", "interval_seconds", "at_hour", "at_minute"].some((key) => details[key] !== undefined);
  if (!hasEdit) throw new Error("at least one field to update is required (description, task, model, interval_seconds, at_hour, at_minute)");

  const taskText = details.task !== undefined ? details.task : current.task;
  if (typeof taskText !== "string" || !taskText.trim()) throw new Error("task must be a non-empty string");

  const description = details.description !== undefined ? details.description : current.description;
  if (typeof description !== "string" || !description.trim()) throw new Error("description must be a non-empty string");

  const model = details.model !== undefined ? normalizeModel(details.model) : current.model;

  let intervalMs = current.intervalMs;
  let atHour = current.atHour;
  let atMinute = current.atMinute;
  if (details.interval_seconds !== undefined || details.at_hour !== undefined || details.at_minute !== undefined) {
    if (details.interval_seconds !== undefined && (details.at_hour !== undefined || details.at_minute !== undefined)) {
      throw new Error("specify either interval_seconds or at_hour/at_minute, not both");
    }
    if (details.interval_seconds !== undefined) {
      validateSchedule({ interval_seconds: details.interval_seconds });
      intervalMs = details.interval_seconds * 1000;
      atHour = undefined;
      atMinute = undefined;
    } else if (details.at_hour !== undefined) {
      validateSchedule({ at_hour: details.at_hour, at_minute: details.at_minute });
      intervalMs = undefined;
      atHour = details.at_hour;
      atMinute = details.at_minute ?? 0;
    } else {
      if (current.atHour === undefined) throw new Error("at_minute requires at_hour");
      validateSchedule({ at_hour: current.atHour, at_minute: details.at_minute });
      atMinute = details.at_minute;
    }
  }

  const scheduleChanged = intervalMs !== current.intervalMs || atHour !== current.atHour || atMinute !== current.atMinute;
  const updated: T = {
    ...current,
    description,
    task: taskText,
    intervalMs,
    atHour,
    atMinute,
    model,
    nextRun: scheduleChanged ? undefined : current.nextRun,
  };
  return { updated, scheduleChanged };
}
/** Normalize a "provider/model-id" or "model-id" override; undefined means inherit. */
function normalizeModel(spec: unknown): string | undefined {
  if (typeof spec !== "string" || !spec.trim()) { log.debug("cron_model_absent", { reason: typeof spec === "string" ? "blank" : "missing" }); return undefined; }
  const parsed = parseModelOverride(spec);
  if (!parsed) { log.warn("cron_model_rejected", { spec: spec.slice(0, 120) }); throw new Error('model must be "provider/model-id" or "model-id"'); }
  log.debug("cron_model_normalized", { spec: spec.trim().slice(0, 120), provider: parsed.provider, model: parsed.model });
  return parsed.provider ? `${parsed.provider}/${parsed.model}` : parsed.model!;
}
function nextDelay(task: CronTask) { if (task.intervalMs) return task.intervalMs; const target = new Date(); target.setHours(task.atHour!, task.atMinute!, 0, 0); if (+target <= Date.now()) target.setDate(target.getDate() + 1); return +target - Date.now(); }

/** What the scheduler may do with a task right now; a paused task keeps its definition and no timer. */
export function decideCronArm(task: { paused?: boolean; scope: CronScope; leader?: boolean }): "skip" | "arm" {
  if (task.paused) return "skip";
  if (task.scope === "project" && !task.leader) return "skip";
  return "arm";
}

export function registerCron(pi: ExtensionAPI, spawnAsyncAgent: any): {
  getCronTasks: () => CronTask[];
  togglePaused: (id: string) => CronPauseResult;
  setScope: (id: string, targetScope: CronScope) => CronScopeResult;
  syncProjectCrons: () => void;
} {
  if (process.env.PI_SUBAGENT_CHILD === "1") {
    return {
      getCronTasks: () => [],
      togglePaused: () => ({ ok: false, paused: false }),
      setScope: (_id, scope) => ({ ok: false, scope, error: "Unavailable in subagent child" }),
      syncProjectCrons: () => {},
    };
  }
  const tasks = new Map<string, CronTask>(); const timers = new Map<string, Timer>();
  const owned = new Map<string, CronLockOwner>(); const instanceId = randomUUID(); let ctx: any; let watchers: fs.FSWatcher[] = []; let health: ReturnType<typeof setInterval> | undefined;
  function cleanupRuntime(releaseLocks = true) {
    log.debug("cron_cleanup_runtime", { timers: timers.size, watchers: watchers.length, locks: owned.size, releaseLocks });
    if (health) clearInterval(health); health = undefined;
    for (const id of [...timers.keys()]) stop(id);
    for (const watcher of watchers) try { watcher.close(); } catch (error: any) { log.warn("cron_watcher_close_failed", { code: error?.code }); }
    watchers = [];
    if (releaseLocks) for (const [file, owner] of owned) {
      releaseLeaderLock(file, owner);
      owned.delete(file);
    }
    else owned.clear();
  }
  const stores = () => ctx ? [{ scope: "project" as const, file: projectStore(ctx.cwd) }] : [];
  function updateStatus() {
    try { if (ctx?.hasUI) setSlot("crons", formatCronStatusSlot([...tasks.values()], ctx.ui.theme), ctx); } catch {}
    pi.events.emit("pidash:cron-status", { count: tasks.size, tasks: [...tasks.values()].map(t => ({ id: qualifyCronId(t), scope: t.scope, description: t.description, schedule: formatCronSchedule(t), lastRun: t.lastRun, nextRun: t.nextRun, leader: t.leader, paused: t.paused === true })) });
  }
  /** Persist run timestamps without clobbering peer edits, `paused`, or a changed schedule (#1089, #1381). */
  function persist(task: CronTask, kind: "lastRun" | "nextRun"): boolean {
    try {
      if (task.scope === "session") { if (sessionStore) writeSessionTasks(sessionStore, [...tasks.values()].filter(t => t.scope === "session")); return true; }
      const file = projectStore(task.cwd);
      const owner = owned.get(file);
      if (!task.leader || !owner || !isLeaderLockCurrent(file, owner)) {
        log.warn("cron_persist_fenced", { id: qualifyCronId(task), kind, reason: "leader_lease_lost" });
        return false;
      }
      let scheduleMismatch = false;
      mutateDurableCronStore(file, old => old.map(t => {
        if (t.id !== task.id) return t;
        if (kind === "lastRun") return { ...t, lastRun: task.lastRun } as DurableCronTask;
        if (!sameSchedule(t, task)) { scheduleMismatch = true; return t; }
        return { ...t, nextRun: task.nextRun } as DurableCronTask;
      }));
      if (scheduleMismatch) {
        log.info("cron_persist_schedule_mismatch", { id: qualifyCronId(task) });
        syncStore("project", file);
        return false;
      }
      return true;
    } catch (error: any) { log.error("cron_persist_failed", qualifyCronId(task), error?.message || error); return false; }
  }
  /** Write only the `paused` flag of the stored record; true when it reached the store. */
  function persistPaused(task: CronTask, paused: boolean): boolean {
    try {
      if (durable(task.scope)) return setDurableCronPaused(projectStore(task.cwd), task.id, paused);
      if (sessionStore) writeSessionTasks(sessionStore, [...tasks.values()].filter(t => t.scope === "session").map(t => (t.id === task.id ? { ...t, paused } : t)));
      return true;
    } catch (error: any) { log.error("cron_pause_write_failed", { id: qualifyCronId(task), paused, reason: error?.message || error }); return false; }
  }
  type StoredTaskState = "active" | "paused" | "removed" | "read_error";
  /** Re-read and validate a durable task's record so peer edits, pauses, removals, and read errors stay accurate. */
  function storedTaskState(task: CronTask): StoredTaskState {
    if (!durable(task.scope)) return task.paused === true ? "paused" : "active";
    const file = projectStore(task.cwd);
    const outcome = readDurableCronStoreOutcome(file);
    if (outcome.status === "read_error") {
      log.warn("cron_store_transient_error", { id: qualifyCronId(task), file, reason: outcome.reason });
      return "read_error";
    }
    const stored = outcome.status === "ok" ? outcome.tasks.find(t => t?.id === task.id) : undefined;
    if (!stored) {
      log.debug("cron_record_missing", { id: qualifyCronId(task), file, status: outcome.status });
      return "removed";
    }
    try { validateDurableCronTask(stored); } catch (error: any) {
      log.warn("cron_store_invalid_record", { id: qualifyCronId(task), file, reason: error?.message || error });
      return "read_error";
    }
    syncTaskFields(task, { ...stored, leader: task.leader });
    return task.paused === true ? "paused" : "active";
  }
  async function execute(task: CronTask, isCurrent: () => boolean) {
    try {
      if (durable(task.scope)) {
        const file = projectStore(task.cwd); const owner = owned.get(file);
        if (!task.leader || !owner || !refreshLeaderLock(file, owner)) {
          log.warn("cron_execution_fenced", { id: qualifyCronId(task), reason: "leader_lease_lost" });
          election(); return;
        }
      }
      task.lastRun = Date.now(); persist(task, "lastRun"); updateStatus(); log.info("cron_execute", qualifyCronId(task));
      const cmd = task.task.trim();
      if (cmd.startsWith("/")) {
        if (durable(task.scope) && !refreshLeaderLock(projectStore(task.cwd), owned.get(projectStore(task.cwd))!)) {
          log.warn("cron_execution_fenced", { id: qualifyCronId(task), reason: "leader_lease_lost_before_dispatch" });
          election(); return;
        }
        pi.sendUserMessage(cmd, { deliverAs: "followUp" }); return;
      }
      const { discoverAgents } = await import("./agents.js");
      if (!isCurrent()) { log.debug("cron_execution_fenced", { id: qualifyCronId(task), reason: "stale_timer" }); return; }
      const stateAfterDiscovery = storedTaskState(task);
      if (stateAfterDiscovery !== "active") {
        if (stateAfterDiscovery === "removed") { stop(task.id); tasks.delete(task.id); updateStatus(); }
        (stateAfterDiscovery === "read_error" ? log.warn : log.debug)("cron_execution_fenced", { id: qualifyCronId(task), reason: stateAfterDiscovery });
        return;
      }
      const liveCmd = task.task.trim();
      if (liveCmd.startsWith("/")) {
        if (durable(task.scope) && !refreshLeaderLock(projectStore(task.cwd), owned.get(projectStore(task.cwd))!)) {
          log.warn("cron_execution_fenced", { id: qualifyCronId(task), reason: "leader_lease_lost_before_dispatch" });
          election(); return;
        }
        pi.sendUserMessage(liveCmd, { deliverAs: "followUp" }); return;
      }
      const liveExplicit = parseModelOverride(task.model);
      log.debug("cron_dispatch", { id: qualifyCronId(task), model: task.model || "inherit" });
      const { agents } = discoverAgents(task.cwd, "user");
      if (durable(task.scope) && !refreshLeaderLock(projectStore(task.cwd), owned.get(projectStore(task.cwd))!)) {
        log.warn("cron_execution_fenced", { id: qualifyCronId(task), reason: "leader_lease_lost_before_dispatch" });
        election(); return;
      }
      spawnAsyncAgent("worker", liveCmd, task.cwd, agents, { name: `Cron: ${task.description.slice(0, 40)}`, ...(liveExplicit ? { explicit: liveExplicit } : {}) });
    } catch (error: any) { log.error("cron_execute_failed", qualifyCronId(task), error?.message || error); }
  }
  function stop(id: string) { const timer = timers.get(id); if (timer) { clearTimeout(timer as any); clearInterval(timer as any); timers.delete(id); } }
  function start(task: CronTask) {
    stop(task.id);
    if (decideCronArm(task) === "skip") { log.debug("cron_timer_skipped", { id: qualifyCronId(task), paused: task.paused === true, leader: task.leader !== false }); return; }
    const canRearm = () => !durable(task.scope) || (Boolean(task.leader) && owned.has(projectStore(task.cwd)));
    const schedule = (runAt = task.nextRun ?? Date.now() + nextDelay(task), persistRun = true) => {
      const delay = Math.max(0, runAt - Date.now());
      const armedSchedule = { intervalMs: task.intervalMs, atHour: task.atHour, atMinute: task.atMinute };
      // A pause stored by a peer reaches this replica only through the store, so the CURRENT
      // stored flag is read BEFORE dispatch: a post-run check cannot undo a run (#1087).
      // The tracked handle also fences continuations invalidated while execute() awaits discovery.
      const isCurrent = () => timers.get(task.id) === timer;
      const fire = async () => {
        try {
          if (!isCurrent()) { log.debug("cron_timer_stale", { id: qualifyCronId(task) }); return; }
          const beforeRun = storedTaskState(task);
          if (beforeRun === "removed") { stop(task.id); tasks.delete(task.id); updateStatus(); log.debug("cron_skipped_removed", { id: qualifyCronId(task) }); return; }
          if (beforeRun === "paused") { log.debug("cron_skipped_paused", { id: qualifyCronId(task) }); return; }
          if (beforeRun === "read_error") {
            log.warn("cron_skipped_read_error", { id: qualifyCronId(task), willRearm: canRearm() });
            if (canRearm()) schedule(Date.now() + nextDelay(task), false);
            return;
          }
          if (!sameSchedule(armedSchedule, task)) {
            log.info("cron_rescheduled_before_fire", { id: qualifyCronId(task) });
            if (canRearm()) schedule(task.nextRun ?? Date.now() + nextDelay(task), task.nextRun === undefined);
            else { stop(task.id); updateStatus(); }
            return;
          }
          await execute(task, isCurrent);
          if (!isCurrent()) { log.debug("cron_rearm_skipped", { id: qualifyCronId(task), reason: "stale_timer" }); return; }
          const afterRun = storedTaskState(task);
          if (afterRun === "removed") { stop(task.id); tasks.delete(task.id); updateStatus(); log.debug("cron_rearm_skipped", { id: qualifyCronId(task), reason: "removed_during_run" }); return; }
          if (afterRun === "paused") { log.debug("cron_rearm_skipped", { id: qualifyCronId(task), reason: "paused_during_run" }); return; }
          if (canRearm()) schedule(Date.now() + nextDelay(task), afterRun === "active");
        } catch (error: any) { log.error("cron_timer_failed", qualifyCronId(task), error?.message || error); }
        finally { if (timers.get(task.id) === timer) timers.delete(task.id); }
      };
      const timer = setTimeout(fire, delay);
      task.nextRun = runAt; timer.unref?.(); timers.set(task.id, timer);
      if (persistRun) persist(task, "nextRun");
      updateStatus();
    };
    schedule();
  }
  function syncStore(scope: "project", file: string) {
    const leader = owned.has(file);
    const outcome = readDurableCronStoreOutcome(file);
    if (outcome.status === "read_error") {
      log.warn("cron_sync_skipped_read_error", { scope, file, leader, reason: outcome.reason });
      if (!leader) for (const old of tasks.values()) if (old.scope === scope) { old.leader = false; stop(old.id); }
      return;
    }
    const disk = outcome.status === "ok" ? outcome.tasks : [];
    for (const old of [...tasks.values()]) if (old.scope === scope && !disk.some(t => t?.id === old.id)) { stop(old.id); tasks.delete(old.id); }
    for (const raw of disk) {
      try { validateDurableCronTask(raw); } catch (error: any) { log.error("invalid durable cron ignored", raw && typeof raw === "object" ? (raw as any).id : "unknown", error?.message || error); continue; }
      const task: CronTask = { ...raw, leader }; const existing = tasks.get(task.id);
      if (!existing) { tasks.set(task.id, task); start(task); } else {
        const changed = existing.intervalMs !== task.intervalMs || existing.atHour !== task.atHour || existing.atMinute !== task.atMinute || existing.paused !== task.paused || existing.leader !== leader;
        const resumed = existing.paused === true && task.paused !== true;
        // Explicit assignment clears optional fields removed by a peer edit (JSON omits undefined keys).
        syncTaskFields(existing, task);
        const disarmed = decideCronArm(existing) === "arm" && !timers.has(existing.id);
        if (resumed || (disarmed && existing.lastRun !== undefined && existing.nextRun !== undefined && existing.nextRun <= existing.lastRun)) existing.nextRun = undefined;
        if (!changed && disarmed) log.warn("cron_timer_self_healed", { id: qualifyCronId(existing), file });
        if (changed || disarmed) start(existing);
      }
    }
  }
  function election() {
    for (const { scope, file } of stores()) {
      let owner = owned.get(file);
      // fs.watch also observes our own heartbeat writes; only the health tick
      // renews eagerly. Other elections renew only when the lease is aging.
      if (owner && (Date.now() - Date.parse(owner.heartbeat_at) >= 5_000 || !isLeaderLockCurrent(file, owner))) {
        if (!refreshLeaderLock(file, owner)) { releaseLeaderLock(file, owner); owned.delete(file); owner = undefined; }
      }
      if (!owner) { owner = acquireLeaderLock(file, instanceId) || undefined; if (owner) { owned.set(file, owner); log.info("cron_leader_acquired", scope); } }
      syncStore(scope, file);
    }
    updateStatus();
  }
  const isProjectTrusted = () => typeof ctx?.isProjectTrusted !== "function" || ctx.isProjectTrusted() === true;
  function add(scope: CronScope, details: any) {
    if (scope !== "session" && scope !== "project") throw new Error("scope must be session or project");
    if (durable(scope) && !durableCronSupported()) throw new Error("Persistent cron scheduling is unavailable on this platform");
    validateSchedule(details);
    const task: CronTask = { id: randomUUID(), scope, cwd: ctx?.cwd || process.cwd(), description: details.description || details.task.slice(0, 60), task: details.task, intervalMs: details.interval_seconds !== undefined ? details.interval_seconds * 1000 : undefined, atHour: details.at_hour, atMinute: details.at_minute ?? (details.at_hour !== undefined ? 0 : undefined), model: normalizeModel(details.model), createdAt: Date.now(), leader: scope === "session" };
    if (!task.task || (!task.intervalMs && task.atHour === undefined)) throw new Error("task and a schedule are required");
    if (durable(scope)) mutateDurableCronStore(projectStore(task.cwd), old => [...old, task as DurableCronTask]);
    tasks.set(task.id, task);
    // We may already own the relevant lock; schedule synchronously rather than waiting for fs.watch.
    // Never run leader election or arm project crons in an untrusted checkout.
    if (scope === "session") { task.leader = true; start(task); }
    else if (!isProjectTrusted()) { task.leader = false; log.info("cron_created_untrusted", { id: qualifyCronId(task) }); }
    else if (owned.has(projectStore(task.cwd)) && isLeaderLockCurrent(projectStore(task.cwd), owned.get(projectStore(task.cwd))!)) { task.leader = true; start(task); }
    else election();
    if (scope === "session") persist(task, "nextRun");
    updateStatus(); log.info("cron_created", { scope, id: qualifyCronId(task) }); return task;
  }
  function edit(qualified: string, details: any): CronTask | null {
    const parsed = parseQualifiedId(qualified);
    if (!parsed) return null;
    if (parsed.scope === "session") {
      const existing = tasks.get(parsed.id);
      if (!existing || existing.scope !== "session") return null;
      const { updated, scheduleChanged } = applyCronPatch(existing, details);
      validateSessionCronTask(updated);
      // Persist the patched snapshot BEFORE mutating live memory so a failed write leaves state intact.
      if (sessionStore) {
        writeSessionTasks(
          sessionStore,
          [...tasks.values()].filter(t => t.scope === "session").map(t => t.id === existing.id ? updated : t),
        );
      }
      syncTaskFields(existing, updated);
      if (scheduleChanged) start(existing);
      updateStatus();
      log.info("cron_edited", { scope: "session", id: qualifyCronId(existing), scheduleChanged });
      return existing;
    }
    // Fail fast on missing update fields before acquiring the durable flock.
    if (!["description", "task", "model", "interval_seconds", "at_hour", "at_minute"].some((key) => details[key] !== undefined)) {
      throw new Error("at least one field to update is required (description, task, model, interval_seconds, at_hour, at_minute)");
    }
    const file = projectStore(ctx?.cwd || process.cwd());
    let updated: DurableCronTask | undefined;
    let scheduleChanged = false;
    mutateDurableCronStore(file, old => old.map(t => {
      if (t.id !== parsed.id) return t;
      const patched = applyCronPatch(t, details);
      updated = patched.updated;
      scheduleChanged = patched.scheduleChanged;
      return updated;
    }));
    if (!updated) return null;
    const leader = owned.has(file) && isLeaderLockCurrent(file, owned.get(file)!);
    const existing = tasks.get(updated.id);
    const nextTask: CronTask = { ...updated, leader };
    if (existing) syncTaskFields(existing, nextTask);
    else tasks.set(updated.id, nextTask);
    const target = tasks.get(updated.id)!;
    if (scheduleChanged || !existing) start(target);
    updateStatus();
    log.info("cron_edited", { scope: "project", id: qualifyCronId(target), scheduleChanged });
    return target;
  }
  function remove(qualified: string) {
    const parsed = parseQualifiedId(qualified); if (!parsed) return false;
    const { scope, id } = parsed;
    const task = tasks.get(id); if (scope === "session") { if (!task) return false; stop(id); tasks.delete(id); if (sessionStore) writeSessionTasks(sessionStore, [...tasks.values()].filter(t => t.scope === "session")); } else { const file = projectStore(ctx.cwd); let found = false; mutateDurableCronStore(file, old => { found = old.some(t => t.id === id); return old.filter(t => t.id !== id); }); if (!found) return false; if (task) { stop(id); tasks.delete(id); } }
    updateStatus(); return true;
  }
  type CronSetPausedResult = CronPauseResult & { already?: boolean; notFound?: boolean };
  /** Set a cron's paused state idempotently: the definition is kept and only the timer changes (#1087, #1381). */
  function setPaused(qualified: string, paused: boolean): CronSetPausedResult {
    const parsed = parseQualifiedId(qualified);
    if (!parsed) { log.warn("cron_pause_missing", { id: qualified }); return { ok: false, paused: false, notFound: true }; }
    let task = tasks.get(parsed.id);
    if (!task && parsed.scope === "project" && ctx) {
      syncStore("project", projectStore(ctx.cwd));
      task = tasks.get(parsed.id);
    }
    if (!task || task.scope !== parsed.scope) { log.warn("cron_pause_missing", { id: qualified }); return { ok: false, paused: false, notFound: true }; }
    let scheduleChanged = false;
    if (durable(task.scope)) {
      const prevSchedule = { intervalMs: task.intervalMs, atHour: task.atHour, atMinute: task.atMinute };
      const state = storedTaskState(task);
      if (state === "removed") { stop(task.id); tasks.delete(task.id); updateStatus(); log.warn("cron_pause_missing", { id: qualified }); return { ok: false, paused: false, notFound: true }; }
      if (state === "read_error") { log.error("cron_pause_unchanged", { id: qualifyCronId(task), paused }); return { ok: false, paused: task.paused === true }; }
      scheduleChanged = !sameSchedule(prevSchedule, task);
    }
    const currentPaused = task.paused === true;
    if (currentPaused === paused) {
      if (paused && timers.has(task.id)) { stop(task.id); updateStatus(); }
      else if (!paused && decideCronArm(task) === "arm" && (!timers.has(task.id) || scheduleChanged)) { task.nextRun = undefined; start(task); updateStatus(); }
      log.debug("cron_pause_noop", { id: qualifyCronId(task), paused });
      return { ok: true, paused, already: true };
    }
    // The in-memory flip is kept off the write: a failed write must leave the row showing the state
    // the store still holds, never one it never accepted.
    if (!persistPaused(task, paused)) { log.error("cron_pause_unchanged", { id: qualifyCronId(task), paused }); return { ok: false, paused: currentPaused }; }
    task.paused = paused;
    // Resuming starts a FRESH interval: occurrences missed while paused are not caught up (#1087).
    if (paused) stop(task.id); else { task.nextRun = undefined; start(task); }
    updateStatus(); log.info("cron_paused", { id: qualifyCronId(task), paused }); return { ok: true, paused };
  }
  /** Pause/resume a cron: the definition is kept and only the timer changes (#1087). */
  function togglePaused(qualified: string): CronPauseResult {
    const parsed = parseQualifiedId(qualified);
    const task = parsed ? tasks.get(parsed.id) : undefined;
    if (!task || !parsed || task.scope !== parsed.scope) { log.warn("cron_pause_missing", { id: qualified }); return { ok: false, paused: false }; }
    const result = setPaused(qualified, !task.paused);
    return { ok: result.ok, paused: result.paused };
  }
  pi.registerTool({ name: "cron_manage", description: "Manage scheduled tasks (add, list, edit, pause, resume, remove). Use edit with id to modify an existing cron in place (preserves ID, history, and paused state; pass only changed fields, or model=\"\" to clear a pinned model). Use pause/resume with id to temporarily stop or re-arm a cron without deleting it (resume starts a fresh interval). Set persist=true on add to keep a task across Pi sessions in this project. Set model to \"provider/model-id\" (or a bare \"model-id\") to pin that cron's model.", parameters: Type.Object({ action: Type.Union([Type.Literal("add"), Type.Literal("list"), Type.Literal("edit"), Type.Literal("pause"), Type.Literal("resume"), Type.Literal("remove")]), persist: Type.Optional(Type.Boolean()), description: Type.Optional(Type.String()), task: Type.Optional(Type.String()), model: Type.Optional(Type.String()), interval_seconds: Type.Optional(Type.Number()), at_hour: Type.Optional(Type.Number()), at_minute: Type.Optional(Type.Number()), id: Type.Optional(Type.String()) }), async execute(_id: string, params: any) {
    const scope: CronScope = params.persist ? "project" : "session";
    try {
      if (params.action === "add" && (ctx?.mode === "print" || ctx?.mode === "json")) return { content: [{ type: "text", text: "Error: Cron scheduling is unavailable in one-shot mode." }] };
      if (params.action === "add") { const task = add(scope, params); return { content: [{ type: "text", text: `Cron ${qualifyCronId(task)} created: ${formatCronSchedule(task)} → ${task.description}${task.model ? ` [${task.model}]` : ""}` }] }; }
      if (params.action === "edit") {
        const task = edit(params.id || "", params);
        if (!task) return { content: [{ type: "text", text: "Task not found." }] };
        return { content: [{ type: "text", text: `Cron ${qualifyCronId(task)} updated: ${formatCronSchedule(task)} → ${task.description}${task.model ? ` [${task.model}]` : ""}${task.paused ? " (paused)" : ""}` }] };
      }
      if (params.action === "pause" || params.action === "resume") {
        const wantPaused = params.action === "pause";
        const id = params.id || "";
        const res = setPaused(id, wantPaused);
        if (res.notFound) return { content: [{ type: "text", text: "Task not found." }] };
        if (!res.ok) return { content: [{ type: "text", text: `Error: Failed to ${params.action} cron.` }] };
        if (res.already) return { content: [{ type: "text", text: `Cron ${id} is already ${wantPaused ? "paused" : "active"}.` }] };
        return { content: [{ type: "text", text: `Cron ${id} ${wantPaused ? "paused" : "resumed"}.` }] };
      }
      if (params.action === "remove") return { content: [{ type: "text", text: remove(params.id || "") ? "Cron removed." : "Task not found." }] };
      const selected = [...tasks.values()].filter(t => !params.persist || t.scope === "project");
      return { content: [{ type: "text", text: selected.length ? selected.map(t => `${qualifyCronId(t)} | ${formatCronSchedule(t)} | ${t.description} | ${t.model || "inherited model"} | ${cronStateLabel(t)}`).join("\n") : "No scheduled tasks." }] };
    } catch (error: any) { return { content: [{ type: "text", text: `Error: ${error.message}` }] }; }
  }, } as any);
  /** Move a cron safely between session and durable project storage, preserving all task fields. */
  function setScope(qualified: string, targetScope: CronScope): CronScopeResult {
    const parsed = parseQualifiedId(qualified);
    if (!parsed) {
      log.warn("cron_scope_missing", { id: qualified, targetScope });
      return { ok: false, scope: targetScope, error: "Task not found." };
    }
    let task = tasks.get(parsed.id);
    if (!task && parsed.scope === "project" && ctx) {
      syncStore("project", projectStore(ctx.cwd));
      task = tasks.get(parsed.id);
    }
    if (!task || task.scope !== parsed.scope) {
      log.warn("cron_scope_missing", { id: qualified, targetScope });
      return { ok: false, scope: parsed.scope, error: "Task not found." };
    }
    if (task.scope === targetScope) {
      return { ok: true, scope: targetScope, id: qualifyCronId(task) };
    }
    if (targetScope === "project") {
      if (!isProjectTrusted()) {
        log.warn("cron_scope_untrusted", { id: qualified });
        return { ok: false, scope: "session", error: "Project is not trusted — cannot persist crons here." };
      }
      if (!durableCronSupported()) {
        log.warn("cron_scope_durable_unsupported", { id: qualified });
        return { ok: false, scope: "session", error: "Persistent cron scheduling is unavailable on this platform" };
      }
      const { leader: _leader, ...base } = task;
      const durableTask: DurableCronTask = { ...base, scope: "project" };
      const file = projectStore(task.cwd);
      let wroteDurable = false;
      try {
        validateDurableCronTask(durableTask);
        // Write to destination store FIRST, then remove from session store; roll back durable write on failure
        // so the cron can never exist in both stores simultaneously.
        mutateDurableCronStore(file, old => [...old.filter(t => t.id !== task.id), durableTask]);
        wroteDurable = true;
        if (sessionStore) {
          writeSessionTasks(sessionStore, [...tasks.values()].filter(t => t.scope === "session" && t.id !== task.id));
        }
      } catch (error: any) {
        if (wroteDurable) {
          try { mutateDurableCronStore(file, old => old.filter(t => t.id !== task.id)); }
          catch (rollbackErr: any) {
            log.error("cron_scope_persist_rollback_failed", { id: qualified, error: rollbackErr?.message || String(rollbackErr) });
          }
        }
        log.error("cron_scope_persist_failed", { id: qualified, error: error?.message || String(error) });
        return { ok: false, scope: "session", error: error?.message || "Failed to persist cron" };
      }
      task.scope = "project";
      if (owned.has(file) && isLeaderLockCurrent(file, owned.get(file)!)) {
        task.leader = true;
        start(task);
      } else {
        task.leader = false;
        stop(task.id);
        election();
      }
      updateStatus();
      log.info("cron_scope_moved", { id: qualifyCronId(task), from: "session", to: "project" });
      return { ok: true, scope: "project", id: qualifyCronId(task) };
    }

    // Moving project -> session: re-read durable store first so peer edits/pauses are preserved.
    const state = storedTaskState(task);
    if (state === "removed") {
      stop(task.id); tasks.delete(task.id); updateStatus();
      log.warn("cron_scope_missing_durable", { id: qualified });
      return { ok: false, scope: "project", error: "Task no longer exists." };
    }
    if (state === "read_error") {
      log.error("cron_scope_durable_unreadable", { id: qualified });
      return { ok: false, scope: "project", error: "Could not read project cron store." };
    }
    const sessionTask: CronTask = { ...task, scope: "session", leader: true };
    let wroteSession = false;
    try {
      validateSessionCronTask(sessionTask);
      // Write to session store FIRST so a failure preserves the durable record.
      if (sessionStore) {
        writeSessionTasks(sessionStore, [...[...tasks.values()].filter(t => t.scope === "session"), sessionTask]);
        wroteSession = true;
      }
      mutateDurableCronStore(projectStore(task.cwd), old => old.filter(t => t.id !== task.id));
    } catch (error: any) {
      if (wroteSession && sessionStore) {
        try { writeSessionTasks(sessionStore, [...tasks.values()].filter(t => t.scope === "session")); } catch {}
      }
      log.error("cron_scope_to_session_failed", { id: qualified, error: error?.message || String(error) });
      return { ok: false, scope: "project", error: error?.message || "Failed to move cron to session" };
    }
    task.scope = "session";
    task.leader = true;
    start(task);
    updateStatus();
    log.info("cron_scope_moved", { id: qualifyCronId(task), from: "project", to: "session" });
    return { ok: true, scope: "session", id: qualifyCronId(task) };
  }
  function formatCronPlainText(): string {
    const all = [...tasks.values()];
    if (all.length === 0) return "No scheduled tasks.";
    return all
      .map(t => `${qualifyCronId(t)} | ${formatCronSchedule(t)} | ${t.description} | ${t.model || "inherited model"} | ${cronStateLabel(t)}`)
      .join("\n");
  }
  pi.registerCommand("cron", {
    description: "Open the cron tasks TUI overlay",
    handler: async (_args, commandCtx) => {
      ctx = commandCtx;
      log.debug("cron_command_open", { hasUI: !!ctx?.hasUI, browser: isBrowserDispatch(ctx), count: tasks.size });
      if (!ctx.hasUI || isBrowserDispatch(ctx)) {
        ctx.ui?.notify(formatCronPlainText(), "info");
        return;
      }
      await openCronStatusOverlay(ctx, {
        title: "Cron tasks",
        listTasks: () =>
          [...tasks.values()].map(t =>
            toCronStatusTaskView(t, {
              overlayId: qualifyCronId(t),
              isLocal: t.scope === "session",
              sessionLabel: t.scope === "project" && t.leader === false ? "persist (waiting for leader)" : t.scope === "project" ? "persist" : "session",
            }),
          ),
        removeTask: remove,
        togglePaused,
        setScope,
        addTask: (input) => {
          try {
            const created = add(input.scope, input);
            return { ok: true, id: qualifyCronId(created) };
          } catch (error: any) {
            return { ok: false, error: error?.message || String(error) };
          }
        },
        editTask: (id, patch) => {
          try {
            const updated = edit(id, patch);
            if (!updated) return { ok: false, error: "Task not found." };
            return { ok: true, id: qualifyCronId(updated) };
          } catch (error: any) {
            return { ok: false, error: error?.message || String(error) };
          }
        },
      });
    },
  });
  pi.events.on("pidash:cron-kill", (target: unknown) => {
    if (target !== "all") { if (typeof target === "string") remove(target); return; }
    const byStore = new Map<string, Set<string>>();
    for (const task of tasks.values()) if (durable(task.scope)) {
      const file = projectStore(task.cwd);
      const ids = byStore.get(file) || new Set<string>(); ids.add(task.id); byStore.set(file, ids);
    }
    for (const [file, ids] of byStore) mutateDurableCronStore(file, old => old.filter(task => !ids.has(task.id)));
    for (const id of [...timers.keys()]) stop(id);
    tasks.clear();
    if (sessionStore) writeSessionTasks(sessionStore, []);
    updateStatus();
  });
  pi.on("session_start", (_event, newCtx) => {
    cleanupRuntime(); tasks.clear(); ctx = newCtx; sessionStore = sessionStoreFor(ctx);
    if (ctx.mode === "print" || ctx.mode === "json") return;
    for (const raw of readSessionTasks(sessionStore)) {
      try { validateSessionCronTask(raw); tasks.set(raw.id, { ...raw, scope: "session", cwd: ctx.cwd, leader: true }); }
      catch (error: any) { log.error("invalid session cron ignored", error?.message || error); }
    }
    const projectCronCount = readDurableCronStore(projectStore(ctx.cwd)).tasks.length;
    const trusted = typeof ctx.isProjectTrusted !== "function" || ctx.isProjectTrusted() === true;
    for (const task of [...tasks.values()]) start(task);
    if (trusted) {
      for (const store of stores()) { fs.mkdirSync(path.dirname(store.file), { recursive: true, mode: 0o700 }); try { const w = fs.watch(path.dirname(store.file), () => election()); w.unref?.(); watchers.push(w); } catch (e: any) { log.warn("cron_watch_failed", { code: e?.code }); } }
      election();
      health = setInterval(() => { try { election(); } catch (error: any) { log.error("cron_election_failed", error?.message || error); } }, 10_000); health.unref?.();
    } else syncStore("project", projectStore(ctx.cwd));
    if (projectCronCount > 0 && ctx.hasUI) {
      const leader = trusted && owned.has(projectStore(ctx.cwd));
      ctx.ui.notify(`Loaded ${projectCronCount} project cron${projectCronCount === 1 ? "" : "s"} (${leader ? "executing" : trusted ? "waiting for leader" : "untrusted"}).`, "info");
      log.info("project_crons_loaded", { count: projectCronCount, leader, trusted });
    }
  });
  pi.on("session_shutdown", (event: any) => {
    cleanupRuntime();
    if (["new", "fork", "quit"].includes(event?.reason) && sessionStore) {
      try { fs.unlinkSync(sessionStore); } catch (error: any) { if (error?.code !== "ENOENT") log.warn("cron session cleanup failed", error?.message || error); }
    }
  });
  return { getCronTasks: () => [...tasks.values()], togglePaused, setScope, syncProjectCrons: () => { for (const s of stores()) syncStore(s.scope, s.file); } };
}
