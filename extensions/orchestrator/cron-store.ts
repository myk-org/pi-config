/** Durable cron storage and local-filesystem leader locks. Delivery is at-least-once. */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseProcStartTime } from "./utils.js";
import { createLogger } from "../shared/logger.js";

export type CronScope = "session" | "project";
export interface DurableCronTask {
  id: string;
  scope: "project";
  cwd: string;
  description: string;
  task: string;
  intervalMs?: number;
  atHour?: number;
  atMinute?: number;
  createdAt: number;
  lastRun?: number;
  nextRun?: number;
}
export interface DurableCronEnvelope { version: 1; tasks: DurableCronTask[]; }
export interface CronLockOwner { pid: number; process_start_token: string; instance_id: string; heartbeat_at: string; fd?: number; }

type StartTokenDeps = { readFileSync: (path: string, encoding: BufferEncoding) => string; execFileSync: (file: string, args: readonly string[], options: { encoding: BufferEncoding; windowsHide: boolean }) => string; platform: NodeJS.Platform };
const startTokenDeps: StartTokenDeps = { readFileSync: fs.readFileSync, execFileSync, platform: process.platform };
const log = createLogger("cron_store");
const STALE_LOCK_MS = 30_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms: number) { Atomics.wait(sleepCell, 0, 0, ms); }

/** Return an OS-issued token which changes when a PID is reused, or null when unavailable. */
export function resolveProcessStartToken(pid: number, deps: StartTokenDeps = startTokenDeps): string | null {
  try {
    const procToken = parseProcStartTime(deps.readFileSync(`/proc/${pid}/stat`, "utf8"));
    if (procToken) { log.debug("cron_process_token", { pid, platform: deps.platform, source: "proc" }); return `proc:${procToken}`; }
  } catch (error: any) { log.debug("cron_process_token_proc_failed", { pid, platform: deps.platform, code: error?.code }); }
  if (deps.platform !== "win32") { log.warn("cron_process_token_unavailable", { pid, platform: deps.platform }); return null; }
  try {
    const output = deps.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`], { encoding: "utf8", windowsHide: true }).trim();
    const token = /^\d{17,}$/.test(output) ? `win:${output}` : null;
    log.debug("cron_process_token_windows", { pid, valid: !!token });
    return token;
  } catch (error: any) { log.warn("cron_process_token_windows_failed", { pid, code: error?.code }); return null; }
}
export function processStartToken(pid = process.pid): string { return resolveProcessStartToken(pid) || "unknown"; }
export function durableCronSupported(): boolean { const supported = resolveProcessStartToken(process.pid) !== null; log.debug("durable_cron_supported", { platform: process.platform, supported }); return supported; }
function lockPath(store: string, kind: "mutation" | "leader") { return `${store}.${kind}.lock`; }
function ownerPath(dir: string) { return path.join(dir, "owner.json"); }
/** True only when the OS can prove this record cannot still own the lock. */
function ownerIsProvenDead(owner: CronLockOwner): boolean {
  if (!owner?.pid || !Number.isInteger(owner.pid) || owner.pid < 1) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error: any) {
    // EPERM means the process exists but is not signalable; all other failures
    // are treated conservatively except the OS's definitive "no such process".
    return error?.code === "ESRCH";
  }
  if (!owner.process_start_token || owner.process_start_token === "unknown") return false;
  const token = resolveProcessStartToken(owner.pid);
  // An unavailable identity source fails closed. A different issued token
  // proves PID reuse, so this record belongs to a dead process.
  return token !== null && token !== owner.process_start_token;
}
function readOwner(dir: string): CronLockOwner | null {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath(dir), "utf8"));
    const valid = owner && typeof owner.pid === "number" && typeof owner.process_start_token === "string" && typeof owner.instance_id === "string" && typeof owner.heartbeat_at === "string";
    if (!valid) log.warn("cron_lock_owner_invalid", { dir, reason: "invalid_owner" });
    return valid ? owner : null;
  } catch (error: any) { log.debug("cron_lock_owner_unreadable", { dir, reason: error?.code || "parse_error" }); return null; }
}
function sameOwner(a: CronLockOwner | null, b: CronLockOwner) {
  return !!a && a.instance_id === b.instance_id && a.pid === b.pid && a.process_start_token === b.process_start_token;
}
function serializedOwner(owner: CronLockOwner) {
  const { fd: _fd, ...record } = owner;
  return JSON.stringify(record);
}
function claimIsOld(claim: string) {
  try {
    const ageMs = Date.now() - fs.statSync(claim).mtimeMs;
    const old = ageMs >= STALE_LOCK_MS;
    log.debug("cron_lock_claim_age", { claim, age_ms: ageMs, old });
    return old;
  } catch (error: any) { log.warn("cron_lock_claim_stat_failed", { claim, reason: error?.code || "stat_error" }); return false; }
}
function restoreClaim(claim: string, dir: string) {
  try { fs.renameSync(claim, dir); } catch { log.warn("cron_lock_claim_restore_failed", { claim, dir }); }
}
/** Read the canonical record first; detach and delete only that proven-stale record. */
function reclaimStaleLock(dir: string, instanceId: string, kind: "leader" | "mutation"): boolean {
  const expected = readOwner(dir);
  if (!(expected ? ownerIsProvenDead(expected) : claimIsOld(dir))) return false;
  const claim = `${dir}.claim-${randomUUID()}`;
  try { fs.renameSync(dir, claim); } catch { return false; }
  const current = readOwner(claim);
  if (expected ? !sameOwner(current, expected) : current || !claimIsOld(claim)) { restoreClaim(claim, dir); return false; }
  try { fs.rmSync(claim, { recursive: true, force: false }); log.info(`cron_${kind}_lock_reclaim`, { dir, instance_id: instanceId, outcome: "reclaimed" }); return true; }
  catch (error: any) { log.warn(`cron_${kind}_lock_reclaim`, { dir, instance_id: instanceId, outcome: "failed", reason: error?.code || "remove_error" }); restoreClaim(claim, dir); return false; }
}
function safelyRemoveLock(dir: string, expected?: CronLockOwner): boolean {
  if (expected && !sameOwner(readOwner(dir), expected)) return false;
  const claim = `${dir}.claim-${randomUUID()}`;
  try { fs.renameSync(dir, claim); } catch { return false; }
  if (expected && !sameOwner(readOwner(claim), expected)) { restoreClaim(claim, dir); return false; }
  try { fs.rmSync(claim, { recursive: true, force: false }); return true; } catch { restoreClaim(claim, dir); return false; }
}
function acquireDirectoryLock(dir: string, instanceId: string, reclaimStale: boolean, deps = startTokenDeps): CronLockOwner | null {
  const token = resolveProcessStartToken(process.pid, deps);
  // Without a PID-reuse-safe token, durable leadership is disabled rather than unsafe.
  if (!token) { log.warn("cron_leader_lock_unavailable", { dir, instance_id: instanceId, reason: "no_process_token" }); return null; }
  const owner: CronLockOwner = { pid: process.pid, process_start_token: token, instance_id: instanceId, heartbeat_at: new Date().toISOString() };
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    owner.fd = fs.openSync(ownerPath(dir), "wx", 0o600);
    fs.writeFileSync(owner.fd, serializedOwner(owner));
    const acquired = sameOwner(readOwner(dir), owner);
    log.info("cron_leader_lock_acquire", { dir, instance_id: instanceId, outcome: acquired ? "acquired" : "verification_failed" });
    if (acquired) return owner;
    safelyRemoveLock(dir, owner);
    if (owner.fd !== undefined) try { fs.closeSync(owner.fd); } catch {}
    return null;
  } catch (error: any) {
    if (owner.fd !== undefined) try { fs.closeSync(owner.fd); } catch {}
    if (error?.code !== "EEXIST" || !reclaimStale) { (error?.code === "EEXIST" ? log.debug : log.warn)("cron_leader_lock_acquire", { dir, instance_id: instanceId, outcome: "failed", reason: error?.code || "lock_error" }); return null; }
    if (!reclaimStaleLock(dir, instanceId, "leader")) return null;
    return acquireDirectoryLock(dir, instanceId, false);
  }
}
export function readDurableCronStore(store: string): DurableCronEnvelope {
  try {
    const value = JSON.parse(fs.readFileSync(store, "utf8"));
    if (value?.version === 1 && Array.isArray(value.tasks)) return value;
    if (Array.isArray(value)) return { version: 1, tasks: value };
  } catch {}
  return { version: 1, tasks: [] };
}
export function validateDurableCronTask(task: unknown): asserts task is DurableCronTask {
  const value = task as DurableCronTask;
  if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id || typeof value.cwd !== "string" || !value.cwd || typeof value.description !== "string" || typeof value.task !== "string" || !value.task.trim() || value.scope !== "project" || !Number.isFinite(value.createdAt)) throw new Error("Invalid durable cron task");
  if (value.intervalMs !== undefined && (!Number.isFinite(value.intervalMs) || value.intervalMs < 10_000)) throw new Error("Invalid durable cron interval");
  if (value.atHour !== undefined && (!Number.isInteger(value.atHour) || value.atHour < 0 || value.atHour > 23)) throw new Error("Invalid durable cron hour");
  if (value.atMinute !== undefined && (!Number.isInteger(value.atMinute) || value.atMinute < 0 || value.atMinute > 59 || value.atHour === undefined)) throw new Error("Invalid durable cron minute");
  if (value.intervalMs === undefined && value.atHour === undefined) throw new Error("Invalid durable cron schedule");
  if ((value.lastRun !== undefined && !Number.isFinite(value.lastRun)) || (value.nextRun !== undefined && !Number.isFinite(value.nextRun))) throw new Error("Invalid durable cron timestamp");
}
function validate(tasks: DurableCronTask[]) { for (const task of tasks) validateDurableCronTask(task); }
function atomicWrite(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, file);
}
function acquireMutationLock(dir: string, instanceId = randomUUID()): CronLockOwner | null {
  const token = resolveProcessStartToken(process.pid);
  if (!token) { log.warn("cron_mutation_lock_unavailable", { dir, instance_id: instanceId, reason: "no_process_token" }); return null; }
  const owner: CronLockOwner = { pid: process.pid, process_start_token: token, instance_id: instanceId, heartbeat_at: new Date().toISOString() };
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(ownerPath(dir), serializedOwner(owner), { flag: "wx", mode: 0o600 });
    const acquired = sameOwner(readOwner(dir), owner);
    log.debug("cron_mutation_lock_acquire", { dir, instance_id: instanceId, outcome: acquired ? "acquired" : "verification_failed" });
    return acquired ? owner : null;
  } catch (error: any) {
    if (error?.code !== "EEXIST") { log.warn("cron_mutation_lock_acquire", { dir, instance_id: instanceId, outcome: "failed", reason: error?.code || "lock_error" }); return null; }
    if (!reclaimStaleLock(dir, instanceId, "mutation")) return null;
    return acquireMutationLock(dir, instanceId);
  }
}
function releaseMutationLock(dir: string, owner: CronLockOwner) { safelyRemoveLock(dir, owner); }
export function mutateDurableCronStore(store: string, change: (tasks: DurableCronTask[]) => DurableCronTask[]): DurableCronEnvelope {
  const lock = lockPath(store, "mutation"); let owner: CronLockOwner | null = null;
  for (let attempt = 0; attempt < 100; attempt++) { owner = acquireMutationLock(lock); if (owner) break; sleep(20); }
  if (!owner) throw new Error("Timed out waiting for cron storage lock");
  try {
    // Corrupt records must not prevent valid tasks from being updated. Schedulers
    // log each skipped record before calling here.
    const current = readDurableCronStore(store).tasks.filter((task) => { try { validateDurableCronTask(task); return true; } catch { return false; } });
    const tasks = change(current); validate(tasks); const envelope: DurableCronEnvelope = { version: 1, tasks }; atomicWrite(store, JSON.stringify(envelope)); return envelope;
  }
  finally { releaseMutationLock(lock, owner); }
}
export function acquireLeaderLock(store: string, instanceId: string, deps: StartTokenDeps = startTokenDeps): CronLockOwner | null { return acquireDirectoryLock(lockPath(store, "leader"), instanceId, true, deps); }
export function refreshLeaderLock(store: string, owner: CronLockOwner): boolean {
  const dir = lockPath(store, "leader");
  if (owner.fd === undefined || !sameOwner(readOwner(dir), owner)) return false;
  owner.heartbeat_at = new Date().toISOString();
  try {
    // Write through the exclusively-created inode, never a lock pathname that
    // could have been atomically reclaimed and recreated by another process.
    fs.ftruncateSync(owner.fd, 0); fs.writeSync(owner.fd, serializedOwner(owner), 0, "utf8"); fs.fsyncSync(owner.fd);
    return sameOwner(readOwner(dir), owner);
  } catch { return false; }
}
export function releaseLeaderLock(store: string, owner: CronLockOwner) {
  const released = safelyRemoveLock(lockPath(store, "leader"), owner);
  if (released && owner.fd !== undefined) try { fs.closeSync(owner.fd); } catch {}
  return released;
}
