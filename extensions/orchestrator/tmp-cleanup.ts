/**
 * Session-start sweep of `<cwd>/.pi/tmp`.
 *
 * Size is the only trigger, age is the safety floor: above `project_tmp_max_size`
 * the oldest entries are deleted (only ones older than `project_tmp_retention_days`)
 * until the directory is back under the cap. A project under the cap is never
 * touched, no matter how old its entries are. Creator-side cleanup cannot be the
 * mechanism — whatever crashes before its own cleanup lives forever.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { isPiOneshotInvocation } from "../shared/oneshot.js";
import { getSettingDynamic } from "./project-settings.js";
import { getProjectTmpDir } from "./utils.js";

const log = createLogger("tmp_cleanup");

const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_MAX_SIZE = "2G";
export const DEFAULT_RETENTION_DAYS = 7;
/** Daemon-owned control files in `.pi/tmp` — never deleted, whatever their age. */
export const TMP_PROTECTED_NAMES = new Set([
  "pidiff.pid",
  "pidiff.port",
  "reload.flag",
  "reload.done",
  "reload.pending",
  ".tmp-sweep.lock",
]);
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
  /** Set when the run did nothing: cap disabled, unparsable value, or another process holds the lock. */
  skipped?: "disabled" | "invalid_max_size" | "locked";
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

/** Byte size of a path, never following a symlink (the link's own size stands in). */
function entryBytes(target: string): number {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  let names: string[];
  try {
    names = fs.readdirSync(target);
  } catch {
    return 0;
  }
  for (const name of names) total += entryBytes(path.join(target, name));
  return total;
}

/** True when `target` resolves strictly inside `base` — refuses any path escape. */
function isInside(base: string, target: string): boolean {
  return target !== base && target.startsWith(base + path.sep);
}

/**
 * Delete oldest-first from `.pi/tmp` until it fits under `maxBytes`, only touching
 * entries older than `retentionDays`. Deletion units are the top-level entries, so
 * a cloned repo or task dir goes as a whole instead of file by file.
 */
export function sweepProjectTmp(opts: TmpSweepOptions): TmpSweepResult {
  const started = Date.now();
  const now = opts.now ?? started;
  const result: TmpSweepResult = { beforeMb: 0, afterMb: 0, deleted: 0, skippedYoung: 0, elapsedMs: 0 };
  const base = path.resolve(opts.tmpDir);

  let names: string[];
  try {
    names = fs.readdirSync(base);
  } catch (error: any) {
    if (error?.code !== "ENOENT") log.warn("tmp_sweep_scan_failed", { tmpDir: base, error: error?.message });
    return result;
  }

  const rows: Array<{ target: string; bytes: number; mtimeMs: number; symlink: boolean }> = [];
  let total = 0;
  for (const name of names) {
    const target = path.join(base, name);
    if (!isInside(base, target) || TMP_PROTECTED_NAMES.has(name)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch {
      continue;
    }
    const bytes = stat.isDirectory() ? entryBytes(target) : stat.size;
    total += bytes;
    rows.push({ target, bytes, mtimeMs: stat.mtimeMs, symlink: stat.isSymbolicLink() });
  }

  result.beforeMb = result.afterMb = toMb(total);
  if (total <= opts.maxBytes) {
    result.elapsedMs = Date.now() - started;
    log.debug("tmp_sweep_under_cap", { tmpDir: base, before_mb: result.beforeMb, cap_bytes: opts.maxBytes });
    return result;
  }

  const cutoff = now - opts.retentionDays * DAY_MS;
  let remaining = total;
  for (const row of rows.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
    if (remaining <= opts.maxBytes) break;
    if (row.mtimeMs >= cutoff) {
      result.skippedYoung++;
      continue;
    }
    try {
      if (row.symlink) fs.unlinkSync(row.target);
      else fs.rmSync(row.target, { recursive: true, force: true });
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
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") {
        log.warn("tmp_sweep_lock_failed", { lockPath, error: error?.message });
        return null;
      }
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS;
      } catch {
        stale = false;
      }
      if (!stale) return null;
      try {
        fs.unlinkSync(lockPath);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Resolve the settings, take the lock, sweep. Never throws. */
export function runProjectTmpSweep(cwd: string, opts: { tmpDir?: string; now?: number } = {}): TmpSweepResult {
  const empty: TmpSweepResult = { beforeMb: 0, afterMb: 0, deleted: 0, skippedYoung: 0, elapsedMs: 0 };
  const raw = String(getSettingDynamic(cwd, "project_tmp_max_size") ?? DEFAULT_MAX_SIZE);
  const maxBytes = parseSize(raw);
  if (maxBytes === undefined) {
    log.warn("tmp_sweep_invalid_max_size", { value: raw, fallback: DEFAULT_MAX_SIZE, deleted: 0 });
    return { ...empty, skipped: "invalid_max_size" };
  }
  if (maxBytes === 0) {
    log.debug("tmp_sweep_disabled", {});
    return { ...empty, skipped: "disabled" };
  }

  const retention = Number(getSettingDynamic(cwd, "project_tmp_retention_days"));
  const retentionDays = Number.isFinite(retention) && retention >= 1 ? Math.min(Math.floor(retention), 365) : DEFAULT_RETENTION_DAYS;

  const tmpDir = opts.tmpDir ?? getProjectTmpDir(cwd);
  const lockPath = path.join(tmpDir, TMP_SWEEP_LOCK);
  const release = acquireLock(lockPath);
  if (!release) {
    log.info("tmp_sweep_skipped_locked", { tmpDir });
    return { ...empty, skipped: "locked" };
  }
  try {
    return sweepProjectTmp({ tmpDir, maxBytes, retentionDays, now: opts.now });
  } finally {
    release();
  }
}

/**
 * Wire the sweep to session start: deferred past startup so a multi-GB unlink cannot
 * delay the first prompt, and never a timer — only the cwd string is captured, so no
 * stale `ctx` is touched after `/reload`. Oneshot invocations (`pi -p`, `--mode json`)
 * skip it: they must exit without extra work.
 */
export function registerTmpCleanup(pi: ExtensionAPI): void {
  pi.on("session_start", (_event: any, ctx: any) => {
    if (isPiOneshotInvocation()) return;
    const cwd = ctx?.cwd;
    if (typeof cwd !== "string" || !cwd) return;
    setImmediate(() => {
      try {
        runProjectTmpSweep(cwd);
      } catch (error: any) {
        log.warn("tmp_sweep_failed", { error: error?.message });
      }
    });
  });
}
