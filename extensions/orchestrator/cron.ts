/** Cron tasks with session and project scopes. Durable project delivery is at-least-once. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getProjectTmpDir } from "./utils.js";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { decideAsyncLlmDispatch } from "./async-capability.js";
import { formatCronSchedule, toCronStatusTaskView } from "./cron-status-format.js";
import { openCronStatusOverlay } from "./cron-status-ui.js";
import { setSlot } from "./status-bar.js";
import { acquireLeaderLock, durableCronSupported, mutateDurableCronStore, readDurableCronStore, refreshLeaderLock, releaseLeaderLock, validateDurableCronTask, type CronLockOwner, type CronScope, type DurableCronTask } from "./cron-store.js";

const log = createLogger("cron");
export interface CronTask { id: string; scope: CronScope; cwd: string; description: string; task: string; intervalMs?: number; atHour?: number; atMinute?: number; createdAt: number; lastRun?: number; nextRun?: number; leader?: boolean; }
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
  if ((value.lastRun !== undefined && !Number.isFinite(value.lastRun)) || (value.nextRun !== undefined && !Number.isFinite(value.nextRun))) throw new Error("Invalid session cron timestamp");
}
function writeSessionTasks(file: string, tasks: Iterable<CronTask>) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify([...tasks]), { mode: 0o600 });
}
export const qualifyCronId = (task: Pick<CronTask, "scope" | "id">) => `${task.scope === "project" ? "persist" : "session"}:${task.id}`;
let currentCronTasks: () => Iterable<CronTask> = () => [];
export function cronRemoveAutocompleteItems(tasks: Iterable<Pick<CronTask, "scope" | "id" | "description" | "task">>) {
  const seen = new Set<string>();
  const items = [];
  for (const task of tasks) {
    const id = qualifyCronId(task);
    if (!seen.has(id)) { seen.add(id); items.push({ value: id, label: id, description: task.description || task.task }); }
  }
  return items;
}
export function getCronRemoveAutocompleteItems() { return cronRemoveAutocompleteItems(currentCronTasks()); }
export function parseCronScope(args: string[]): { scope: CronScope; rest: string[]; error?: string } {
  let scope: CronScope = "session"; const rest: string[] = [];
  for (const arg of args) {
    if (arg === "--persist") { scope = "project"; continue; }
    if (arg === "--scope" || arg === "--project") return { scope, rest, error: `"${arg}" is not supported; use --persist for a persistent cron` };
    rest.push(arg);
  }
  return { scope, rest };
}
function projectStore(cwd: string) { return path.join(cwd, ".pi", "cron", "crons.json"); }
function validateSchedule(details: any) {
  const interval = details.interval_seconds;
  const hour = details.at_hour;
  const minute = details.at_minute;
  if (interval !== undefined && (!Number.isFinite(interval) || interval < 10)) throw new Error("interval_seconds must be finite and at least 10 seconds");
  if (hour !== undefined && (!Number.isInteger(hour) || hour < 0 || hour > 23)) throw new Error("at_hour must be an integer from 0 to 23");
  if (minute !== undefined && (!Number.isInteger(minute) || minute < 0 || minute > 59)) throw new Error("at_minute must be an integer from 0 to 59");
  if (minute !== undefined && hour === undefined) throw new Error("at_minute requires at_hour");
}
function nextDelay(task: CronTask) { if (task.intervalMs) return task.intervalMs; const target = new Date(); target.setHours(task.atHour!, task.atMinute!, 0, 0); if (+target <= Date.now()) target.setDate(target.getDate() + 1); return +target - Date.now(); }

export function registerCron(pi: ExtensionAPI, spawnAsyncAgent: any): { getCronTasks: () => CronTask[] } {
  if (process.env.PI_SUBAGENT_CHILD === "1") return { getCronTasks: () => [] };
  const tasks = new Map<string, CronTask>(); const timers = new Map<string, Timer>();
  currentCronTasks = () => tasks.values();
  const owned = new Map<string, CronLockOwner>(); const instanceId = randomUUID(); let ctx: any; let watchers: fs.FSWatcher[] = []; let health: ReturnType<typeof setInterval> | undefined;
  function cleanupRuntime(releaseLocks = true) {
    log.debug("cron_cleanup_runtime", { timers: timers.size, watchers: watchers.length, locks: owned.size, releaseLocks });
    if (health) clearInterval(health); health = undefined;
    for (const id of [...timers.keys()]) stop(id);
    for (const watcher of watchers) try { watcher.close(); } catch (error: any) { log.warn("cron_watcher_close_failed", { code: error?.code }); }
    watchers = [];
    if (releaseLocks) for (const [file, owner] of owned) releaseLeaderLock(file, owner);
    owned.clear();
  }
  const stores = () => ctx ? [{ scope: "project" as const, file: projectStore(ctx.cwd) }] : [];
  function updateStatus() {
    try { if (ctx?.hasUI) setSlot("crons", ctx.ui.theme.fg("muted", `⏰ ${tasks.size} cron${tasks.size === 1 ? "" : "s"}`), ctx); } catch {}
    pi.events.emit("pidash:cron-status", { count: tasks.size, tasks: [...tasks.values()].map(t => ({ id: qualifyCronId(t), scope: t.scope, description: t.description, schedule: formatCronSchedule(t), lastRun: t.lastRun, nextRun: t.nextRun, leader: t.leader })) });
  }
  function persist(task: CronTask) {
    try {
      if (task.scope === "session") { if (sessionStore) writeSessionTasks(sessionStore, [...tasks.values()].filter(t => t.scope === "session")); return; }
      mutateDurableCronStore(projectStore(task.cwd), old => old.map(t => t.id === task.id ? task as DurableCronTask : t));
    } catch (error: any) { log.error("cron_persist_failed", qualifyCronId(task), error?.message || error); }
  }
  async function execute(task: CronTask) {
    try {
      if (durable(task.scope) && !task.leader) return;
      task.lastRun = Date.now(); persist(task); updateStatus(); log.info("cron_execute", qualifyCronId(task));
      const cmd = task.task.trim();
      if (cmd.startsWith("/")) { pi.sendUserMessage(cmd, { deliverAs: "followUp" }); return; }
      const dispatch = decideAsyncLlmDispatch({ parentProvider: ctx?.model?.provider, cwd: task.cwd, mustAsync: true });
      if (dispatch.action === "skip") { log.error("cron_error", qualifyCronId(task), dispatch.note); return; }
      const { discoverAgents } = await import("./agents.js");
      const { agents } = discoverAgents(task.cwd, "user");
      spawnAsyncAgent("worker", cmd, task.cwd, agents, { name: `Cron: ${task.description.slice(0, 40)}`, ...(dispatch.action === "sidecar-async" ? { parentProvider: dispatch.sidecar.provider, parentModelId: dispatch.sidecar.model } : {}) });
    } catch (error: any) { log.error("cron_execute_failed", qualifyCronId(task), error?.message || error); }
  }
  function stop(id: string) { const timer = timers.get(id); if (timer) { clearTimeout(timer as any); clearInterval(timer as any); timers.delete(id); } }
  function start(task: CronTask) {
    stop(task.id); if (durable(task.scope) && !task.leader) return;
    const schedule = (runAt = task.nextRun ?? Date.now() + nextDelay(task)) => {
      const delay = Math.max(0, runAt - Date.now());
      const timer = setTimeout(async () => { try { await execute(task); schedule(Date.now() + nextDelay(task)); } catch (error: any) { log.error("cron_timer_failed", qualifyCronId(task), error?.message || error); } }, delay);
      task.nextRun = runAt; persist(task); updateStatus(); timer.unref?.(); timers.set(task.id, timer);
    };
    schedule();
  }
  function syncStore(scope: "project", file: string) {
    const leader = owned.has(file); const disk = readDurableCronStore(file).tasks;
    for (const old of [...tasks.values()]) if (old.scope === scope && !disk.some(t => t.id === old.id)) { stop(old.id); tasks.delete(old.id); }
    for (const raw of disk) {
      try { validateDurableCronTask(raw); } catch (error: any) { log.error("invalid durable cron ignored", raw && typeof raw === "object" ? (raw as any).id : "unknown", error?.message || error); continue; }
      const task: CronTask = { ...raw, leader }; const existing = tasks.get(task.id);
      if (!existing) { tasks.set(task.id, task); start(task); } else { const changed = existing.intervalMs !== task.intervalMs || existing.atHour !== task.atHour || existing.atMinute !== task.atMinute || existing.leader !== leader; Object.assign(existing, task); if (changed) start(existing); }
    }
  }
  function election() {
    for (const { scope, file } of stores()) {
      let owner = owned.get(file); if (owner && !refreshLeaderLock(file, owner)) { owned.delete(file); owner = undefined; }
      if (!owner) { owner = acquireLeaderLock(file, instanceId) || undefined; if (owner) { owned.set(file, owner); log.info("cron_leader_acquired", scope); } }
      syncStore(scope, file);
    }
    updateStatus();
  }
  function add(scope: CronScope, details: any) {
    if (scope !== "session" && scope !== "project") throw new Error("scope must be session or project");
    if (durable(scope) && !durableCronSupported()) throw new Error("Persistent cron scheduling is unavailable on this platform");
    validateSchedule(details);
    const task: CronTask = { id: randomUUID(), scope, cwd: ctx?.cwd || process.cwd(), description: details.description || details.task.slice(0, 60), task: details.task, intervalMs: details.interval_seconds !== undefined ? details.interval_seconds * 1000 : undefined, atHour: details.at_hour, atMinute: details.at_minute ?? (details.at_hour !== undefined ? 0 : undefined), createdAt: Date.now(), leader: scope === "session" };
    if (!task.task || (!task.intervalMs && task.atHour === undefined)) throw new Error("task and a schedule are required");
    if (durable(scope)) mutateDurableCronStore(projectStore(task.cwd), old => [...old, task as DurableCronTask]);
    tasks.set(task.id, task);
    // We may already own the relevant lock; schedule synchronously rather than waiting for fs.watch.
    if (scope === "session" || owned.has(projectStore(task.cwd))) { task.leader = true; start(task); }
    else election();
    if (scope === "session") persist(task);
    updateStatus(); return task;
  }
  function remove(qualified: string) {
    const [kind, id] = qualified.split(":", 2); const scope = kind === "persist" ? "project" : kind as CronScope; if (!id || !["session", "project"].includes(scope)) return false;
    const task = tasks.get(id); if (scope === "session") { if (!task) return false; stop(id); tasks.delete(id); if (sessionStore) writeSessionTasks(sessionStore, [...tasks.values()].filter(t => t.scope === "session")); } else { const file = projectStore(ctx.cwd); let found = false; mutateDurableCronStore(file, old => { found = old.some(t => t.id === id); return old.filter(t => t.id !== id); }); if (!found) return false; if (task) { stop(id); tasks.delete(id); } }
    updateStatus(); return true;
  }
  pi.registerTool({ name: "cron_manage", description: "Manage scheduled tasks. Set persist=true to keep a task across Pi sessions in this project.", parameters: Type.Object({ action: Type.Union([Type.Literal("add"), Type.Literal("list"), Type.Literal("remove")]), persist: Type.Optional(Type.Boolean()), description: Type.Optional(Type.String()), task: Type.Optional(Type.String()), interval_seconds: Type.Optional(Type.Number()), at_hour: Type.Optional(Type.Number()), at_minute: Type.Optional(Type.Number()), id: Type.Optional(Type.String()) }), async execute(_id, params: any) {
    const scope: CronScope = params.persist ? "project" : "session";
    try { if (params.action === "add" && (ctx?.mode === "print" || ctx?.mode === "json")) return { content: [{ type: "text", text: "Error: Cron scheduling is unavailable in one-shot mode." }] }; if (params.action === "add") { const task = add(scope, params); return { content: [{ type: "text", text: `Cron ${qualifyCronId(task)} created: ${formatCronSchedule(task)} → ${task.description}` }] }; } if (params.action === "remove") return { content: [{ type: "text", text: remove(params.id || "") ? "Cron removed." : "Task not found." }] }; const selected = [...tasks.values()].filter(t => !params.persist || t.scope === "project"); return { content: [{ type: "text", text: selected.length ? selected.map(t => `${qualifyCronId(t)} | ${formatCronSchedule(t)} | ${t.description} | ${t.leader === false ? "waiting for leader" : "active"}`).join("\n") : "No scheduled tasks." }] }; } catch (error: any) { return { content: [{ type: "text", text: `Error: ${error.message}` }] }; }
  }, } as any);
  pi.registerCommand("cron", { description: "Schedule tasks: add, list, list-all, remove; use --persist to keep a cron", handler: async (args, commandCtx) => { ctx = commandCtx; const parsed = parseCronScope((args || "").trim().split(/\s+/).filter(Boolean)); if (parsed.error) { ctx.ui?.notify(parsed.error, "warning"); return; } const [sub, ...rest] = parsed.rest; if (sub === "list" || sub === "list-all") { const showAll = sub === "list-all"; if (ctx.hasUI) await openCronStatusOverlay(ctx, { title: showAll ? "All cron tasks" : "Cron tasks", listTasks: () => [...tasks.values()].filter(t => showAll || !args.includes("--persist") || t.scope === "project").map(t => toCronStatusTaskView(t, { overlayId: qualifyCronId(t), isLocal: t.scope === "session", sessionLabel: t.leader === false ? `${t.scope} (waiting for leader)` : t.scope })), removeTask: remove }); return; } if (["remove", "rm", "delete"].includes(sub) && rest[0]) { ctx.ui?.notify(remove(rest[0]) ? "Cron removed." : "Task not found.", "info"); return; } pi.sendUserMessage(`Schedule this cron request using cron_manage. Set persist to ${parsed.scope === "project"}. Use persistence only when the user requests it. User request: "${parsed.rest.join(" ")}"`, { deliverAs: "followUp" }); }});
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
  return { getCronTasks: () => [...tasks.values()] };
}
