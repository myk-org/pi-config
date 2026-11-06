/**
 * Session-start sweep of `<cwd>/.pi/tmp`.
 *
 * Size is the only trigger, age is the safety floor: above `project_tmp_max_size`
 * the oldest entries are deleted (only ones older than `project_tmp_retention_days`)
 * until the directory is back under the cap. A project under the cap is never
 * touched, no matter how old its entries are. Creator-side cleanup cannot be the
 * mechanism — whatever crashes before its own cleanup lives forever.
 *
 * Every fs call in the traversal and the deletions is async: the sweep runs on Pi's
 * event loop, so a multi-GB tree must yield between entries instead of freezing input.
 */

import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isLiveLegacyDaemonFile } from "../shared/daemon-manager.js";
import { createLogger } from "../shared/logger.js";
import { isPiOneshotInvocation } from "../shared/oneshot.js";
import { getGlobalSettingsPath, getSettingDynamic, getSettingsPath, SETTINGS_KEYS } from "./project-settings.js";
import { readSettingsObject } from "./settings-source.js";
import { getProjectRunDir, getProjectTmpDir } from "./utils.js";

const log = createLogger("tmp_cleanup");

const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Defaults live in `settings-keys.json` only — never restated here. */
export const DEFAULT_MAX_SIZE = String(SETTINGS_KEYS.project_tmp_max_size.default);
export const DEFAULT_RETENTION_DAYS = Number(SETTINGS_KEYS.project_tmp_retention_days.default);
/** Lives in `.pi/run`, never in the swept dir. */
export const TMP_SWEEP_LOCK = ".tmp-sweep.lock";
/** A crashed sweep would otherwise block every later session forever. */
const LOCK_STALE_MS = 60 * 60 * 1000;

/** Accepted suffixes. A bare number is MB (`2048` = 2G). */
const UNITS: Record<string, number> = {
  "": MB,
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: MB,
  mb: MB,
  mib: MB,
  g: 1024 * MB,
  gb: 1024 * MB,
  gib: 1024 * MB,
  t: 1024 * 1024 * MB,
  tb: 1024 * 1024 * MB,
  tib: 1024 * 1024 * MB,
};

/**
 * Parse a size setting (`2G`, `2GiB`, `2048M`, `1.5G`, bare `2048` = MB, `0` = off).
 * Returns undefined for anything else — callers must then delete nothing: a bad
 * value may only ever clean less, never more.
 */
export function parseSize(raw: string | number | null | undefined): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([a-z]*)$/.exec(String(raw ?? "").trim().toLowerCase());
  if (!match) return undefined;
  const unit = UNITS[match[2]];
  if (unit === undefined) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.round(value * unit) : undefined;
}

export interface TmpSweepResult {
  beforeMb: number;
  afterMb: number;
  deleted: number;
  skippedYoung: number;
  elapsedMs: number;
  /** Set when the run did nothing: cap disabled, unparsable value, another process holds the lock (or the run dir is unusable), or the tmp dir resolves outside the checkout. */
  skipped?: "disabled" | "invalid_max_size" | "locked" | "outside_checkout";
}

export interface TmpSweepOptions {
  tmpDir: string;
  maxBytes: number;
  retentionDays: number;
  now?: number;
}

function toMb(bytes: number): number {
  return Math.round((bytes / MB) * 10) / 10;
}

/**
 * Byte size and newest mtime of a path, never following a symlink (the link's own
 * size stands in). The newest nested mtime is what decides the age floor — a
 * top-level directory's own mtime does not move when a nested file is rewritten.
 */
async function entryStats(target: string): Promise<{ bytes: number; newestMs: number }> {
  let stat: fs.Stats;
  try {
    stat = await fsp.lstat(target);
  } catch {
    return { bytes: 0, newestMs: 0 };
  }
  if (!stat.isDirectory()) return { bytes: stat.size, newestMs: stat.mtimeMs };
  let total = 0;
  let newestMs = stat.mtimeMs;
  let names: string[];
  try {
    names = await fsp.readdir(target);
  } catch {
    return { bytes: total, newestMs };
  }
  for (const name of names) {
    const child = await entryStats(path.join(target, name));
    total += child.bytes;
    newestMs = Math.max(newestMs, child.newestMs);
  }
  return { bytes: total, newestMs };
}

/** True when `target` resolves strictly inside `base` — refuses any path escape. */
function isInside(base: string, target: string): boolean {
  return target !== base && target.startsWith(base + path.sep);
}

/**
 * True while `target` still resolves to itself. `target` is always a realpath here, so a
 * false answer means it was swapped for a symlink (or is gone) after it was validated.
 */
async function isUnswapped(target: string): Promise<boolean> {
  try {
    return (await fsp.realpath(target)) === target;
  } catch {
    return false;
  }
}

/**
 * Delete oldest-first from `.pi/tmp` until it fits under `maxBytes`, only touching
 * entries older than `retentionDays`. Deletion units are the top-level entries, so
 * a cloned repo or task dir goes as a whole instead of file by file.
 */
export async function sweepProjectTmp(opts: TmpSweepOptions): Promise<TmpSweepResult> {
  const started = Date.now();
  const now = opts.now ?? started;
  const result: TmpSweepResult = { beforeMb: 0, afterMb: 0, deleted: 0, skippedYoung: 0, elapsedMs: 0 };
  const base = path.resolve(opts.tmpDir);

  let names: string[];
  try {
    names = await fsp.readdir(base);
  } catch (error: any) {
    if (error?.code !== "ENOENT") log.warn("tmp_sweep_scan_failed", { tmpDir: base, error: error?.message });
    return result;
  }

  const rows: Array<{ target: string; bytes: number; newestMs: number; symlink: boolean; dev: number; ino: number }> = [];
  let total = 0;
  for (const name of names) {
    const target = path.join(base, name);
    if (!isInside(base, target)) continue;
    // One exemption, decided by the daemon layer: a pre-`.pi/run` daemon that is still ALIVE
    // owns its lockfile here, and sweeping it makes the next connect() spawn a duplicate on
    // that port. A dead daemon's leftovers are throwaway like everything else (#1020).
    if (isLiveLegacyDaemonFile(base, name)) {
      log.debug("tmp_sweep_kept_live_legacy_daemon", { tmpDir: base, name });
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = await fsp.lstat(target);
    } catch {
      continue;
    }
    const { bytes, newestMs } = stat.isDirectory()
      ? await entryStats(target)
      : { bytes: stat.size, newestMs: stat.mtimeMs };
    total += bytes;
    rows.push({ target, bytes, newestMs, symlink: stat.isSymbolicLink(), dev: stat.dev, ino: stat.ino });
  }

  result.beforeMb = result.afterMb = toMb(total);
  if (total <= opts.maxBytes) {
    result.elapsedMs = Date.now() - started;
    log.debug("tmp_sweep_under_cap", { tmpDir: base, before_mb: result.beforeMb, cap_bytes: opts.maxBytes });
    return result;
  }

  // The scan is async: `.pi/tmp` itself may have been swapped for an outside-pointing
  // symlink since it was validated. Destructive phase, so resolve it again — a swapped
  // base does not resolve to itself.
  if (!(await isUnswapped(base))) {
    log.warn("tmp_sweep_outside_checkout", { tmpDir: base, phase: "delete" });
    result.elapsedMs = Date.now() - started;
    return { ...result, skipped: "outside_checkout" };
  }

  const cutoff = now - opts.retentionDays * DAY_MS;
  let remaining = total;
  for (const row of rows.sort((left, right) => left.newestMs - right.newestMs)) {
    if (remaining <= opts.maxBytes) break;
    if (row.newestMs >= cutoff) {
      result.skippedYoung++;
      continue;
    }
    // A task may have replaced this entry since we sized it; delete only the inode the
    // age and size decisions were made for, never whatever now sits at the pathname.
    let live: fs.Stats;
    try {
      live = await fsp.lstat(row.target);
    } catch {
      continue; // already gone
    }
    if (live.dev !== row.dev || live.ino !== row.ino) {
      log.warn("tmp_sweep_entry_replaced", { target: row.target });
      continue;
    }
    try {
      if (row.symlink) await fsp.unlink(row.target);
      else await fsp.rm(row.target, { recursive: true, force: true });
    } catch (error: any) {
      log.warn("tmp_sweep_delete_failed", { target: row.target, error: error?.message });
      continue;
    }
    remaining -= row.bytes;
    result.deleted++;
  }

  result.afterMb = toMb(remaining);
  result.elapsedMs = Date.now() - started;
  log.info("tmp_sweep", {
    before_mb: result.beforeMb,
    after_mb: result.afterMb,
    deleted: result.deleted,
    skipped_young: result.skippedYoung,
    elapsed_ms: result.elapsedMs,
  });
  return result;
}

/** O_EXCL lock; returns the release callback, or null when another session holds it. */
function acquireLock(lockPath: string): (() => void) | null {
  const pid = String(process.pid);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeSync(fd, pid);
      fs.closeSync(fd);
      return () => {
        try {
          // Unlink only our own lock: a stale reclaim may have handed it to another session.
          if (fs.readFileSync(lockPath, "utf8") !== pid) return;
          fs.unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      };
    } catch (error: any) {
      // The run dir vanished after it was created: sweeping without the lock is the one
      // thing this function must never do, so treat it as contended.
      if (error?.code === "ENOENT") {
        log.warn("tmp_sweep_lock_failed", { lockPath, error: error?.message });
        return null;
      }
      if (error?.code !== "EEXIST") {
        log.warn("tmp_sweep_lock_failed", { lockPath, error: error?.message });
        return null;
      }
      let held: fs.Stats;
      try {
        held = fs.statSync(lockPath);
      } catch {
        continue; // holder released — retry the create
      }
      if (Date.now() - held.mtimeMs <= LOCK_STALE_MS) return null;
      // Reclaim by rename: exactly one of N racing sessions wins, and the inode check
      // rejects a lock another session created between our stat and the rename.
      const reclaimPath = `${lockPath}.${process.pid}.reclaim`;
      try {
        fs.renameSync(lockPath, reclaimPath);
      } catch {
        continue;
      }
      let moved: fs.Stats | undefined;
      try {
        moved = fs.statSync(reclaimPath);
      } catch {
        moved = undefined;
      }
      if (!moved || moved.dev !== held.dev || moved.ino !== held.ino) {
        // We moved a lock that is not the stale one we stat'ed — it belongs to a session
        // that took the pathname in between. Restore it without ever overwriting a third
        // session's lock (`link` refuses an existing path), then treat the lock as held.
        try {
          fs.linkSync(reclaimPath, lockPath);
        } catch {
          /* a third session holds the pathname; its lock wins */
        }
        try {
          fs.unlinkSync(reclaimPath);
        } catch {
          /* already gone */
        }
        log.warn("tmp_sweep_lock_reclaim_raced", { lockPath });
        return null;
      }
      try {
        fs.unlinkSync(reclaimPath);
      } catch {
        /* already gone */
      }
    }
  }
  return null;
}

/**
 * The settings getter skips a wrong-typed value and returns the default, which here
 * would re-enable deletion — so read the raw file value too. A numeric `0` meant as
 * "off" then means off, and any other type is unparsable (deletes nothing).
 */
function rawSizeSetting(cwd: string): unknown {
  for (const file of [getSettingsPath(cwd), getGlobalSettingsPath()]) {
    const value = readSettingsObject(file, "project_tmp_max_size").project_tmp_max_size;
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Resolve the settings, take the lock, sweep. Never throws. */
export async function runProjectTmpSweep(
  cwd: string,
  opts: { tmpDir?: string; now?: number } = {},
): Promise<TmpSweepResult> {
  const empty: TmpSweepResult = { beforeMb: 0, afterMb: 0, deleted: 0, skippedYoung: 0, elapsedMs: 0 };
  const configured = rawSizeSetting(cwd) ?? getSettingDynamic(cwd, "project_tmp_max_size");
  const raw = String(configured ?? DEFAULT_MAX_SIZE);
  const maxBytes = parseSize(configured as string | number | null | undefined);
  if (maxBytes === undefined) {
    // Spec says "fall back to the default AND clean nothing" — the two cannot both
    // hold in one run, and "a bad value must never delete more, only less" decides it.
    log.warn("tmp_sweep_invalid_max_size", {
      value: raw,
      default_max_size: DEFAULT_MAX_SIZE,
      default_used: false,
      deleted: 0,
    });
    return { ...empty, skipped: "invalid_max_size" };
  }
  if (maxBytes === 0) {
    log.debug("tmp_sweep_disabled", {});
    return { ...empty, skipped: "disabled" };
  }

  const retention = Number(getSettingDynamic(cwd, "project_tmp_retention_days"));
  const retentionDays = Number.isFinite(retention) && retention >= 1 ? Math.min(Math.floor(retention), 365) : DEFAULT_RETENTION_DAYS;

  const tmpDir = path.resolve(opts.tmpDir ?? getProjectTmpDir(cwd));
  let checkout: string;
  let base: string;
  try {
    [checkout, base] = await Promise.all([fsp.realpath(cwd), fsp.realpath(tmpDir)]);
  } catch {
    return empty; // no `.pi/tmp` yet
  }
  // A symlinked `.pi` would otherwise let a sweep in this checkout delete old files
  // in whatever directory the link points at.
  if (!isInside(checkout, base)) {
    log.warn("tmp_sweep_outside_checkout", { tmpDir: base, cwd: checkout });
    return { ...empty, skipped: "outside_checkout" };
  }

  // The lock lives in `.pi/run`, outside the directory being swept: a lock file inside
  // the swept dir is itself sweepable data. No run dir, no lock, no sweep — an unwritable
  // or full disk must never degrade into an unlocked sweep.
  let lockPath: string;
  try {
    lockPath = path.join(getProjectRunDir(cwd), TMP_SWEEP_LOCK);
  } catch (error: any) {
    log.warn("tmp_sweep_run_dir_failed", { cwd, error: error?.message });
    return { ...empty, skipped: "locked" };
  }
  // Nothing slow between the checks above and this write, and the same check runs again
  // before the deletions — every use of the pathname is validated at the point of use.
  if (!(await isUnswapped(base))) {
    log.warn("tmp_sweep_outside_checkout", { tmpDir: base, phase: "lock" });
    return { ...empty, skipped: "outside_checkout" };
  }
  const release = acquireLock(lockPath);
  if (!release) {
    log.info("tmp_sweep_skipped_locked", { tmpDir: base, lockPath });
    return { ...empty, skipped: "locked" };
  }
  try {
    return await sweepProjectTmp({ tmpDir: base, maxBytes, retentionDays, now: opts.now });
  } finally {
    release();
  }
}

/**
 * Wire the sweep to session start: deferred past startup, and every fs call inside it
 * is async, so a multi-GB unlink cannot delay or freeze the first prompt. Never a
 * timer — only the cwd string is captured, so no stale `ctx` is touched after
 * `/reload`. Oneshot invocations (`pi -p`, `--mode json`, piped print sessions) skip
 * it: they must exit without extra work.
 */
export function registerTmpCleanup(pi: ExtensionAPI): void {
  pi.on("session_start", (_event: any, ctx: any) => {
    // argv alone cannot see `echo | pi` / `pi | cat`, so the session mode decides too.
    if (ctx?.mode === "print" || ctx?.mode === "json" || isPiOneshotInvocation()) return;
    const cwd = ctx?.cwd;
    if (typeof cwd !== "string" || !cwd) return;
    setImmediate(async () => {
      try {
        await runProjectTmpSweep(cwd);
      } catch (error: any) {
        log.warn("tmp_sweep_failed", { error: error?.message });
      }
    });
  });
}
