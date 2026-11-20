/**
 * Reap stale CLI session markers (t3 ProviderSessionReaper pattern).
 * Deletes idle *stopped* bindings only — never status=running, so concurrent
 * pi sessions in the same cwd keep CLI --resume continuity.
 */

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../shared/logger.js";
import {
  cliSessionsDir,
  listCliSessions,
  parseCliSessionRecord,
  type CliSessionRecord,
} from "./sessions.js";

const log = createLogger("cli_provider");

export const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
export const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface ReapOptions {
  inactivityThresholdMs?: number;
  /** Only reap sessions matching this cwd (optional). */
  cwd?: string;
  /**
   * Current pi session UUID (informational / future scoping).
   * Running markers are never reaped regardless of this value — concurrent
   * sessions in the same cwd must keep --resume (issue #661).
   */
  activePiSessionId?: string | null;
}

const REAP_BATCH_SIZE = 64;

function shouldReapRecord(
  record: CliSessionRecord,
  now: number,
  threshold: number,
  cwd?: string,
): boolean {
  if (cwd && record.cwd !== cwd) return false;
  // Concurrent pi sessions share ~/.pi/cli-sessions for the same cwd.
  // Deleting another session's running marker breaks its --resume.
  if (record.status === "running") return false;
  const lastSeenMs = Date.parse(record.lastSeenAt);
  return Number.isNaN(lastSeenMs) || now - lastSeenMs >= threshold;
}

/**
 * Remove idle *stopped* session files only.
 * Never deletes status=running (own or other piSessionId) so two pi processes
 * on the same project both keep CLI --resume after idle timeouts.
 */
export function reapStaleCliSessions(options?: ReapOptions): number {
  const threshold = Math.max(
    1,
    options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
  );
  const now = Date.now();
  let reaped = 0;

  for (const { path, record } of listCliSessions()) {
    if (!shouldReapRecord(record, now, threshold, options?.cwd)) continue;

    try {
      unlinkSync(path);
      reaped += 1;
      log.info(`reaped session ${record.agent}/${record.model} ` +
          `(status=${record.status}, piSessionId=${record.piSessionId}, ` +
          `lastSeen=${record.lastSeenAt})`,
      );
    } catch (err) {
      log.error(`failed to reap session ${record.agent}/${record.model} at ${path}`,
        err,
      );
    }
  }

  return reaped;
}

/**
 * Asynchronous bounded-batch variant used by the periodic reaper timer so
 * large ~/.pi/cli-sessions directories never stall the event loop.
 */
export async function reapStaleCliSessionsAsync(
  options?: ReapOptions,
): Promise<number> {
  const threshold = Math.max(
    1,
    options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
  );
  const dir = cliSessionsDir();
  let names: string[];
  try {
    names = await fsPromises.readdir(dir);
  } catch {
    return 0;
  }

  const jsonFiles = names.filter((name) => name.endsWith(".json"));
  if (jsonFiles.length === 0) return 0;

  const now = Date.now();
  let reaped = 0;

  for (let i = 0; i < jsonFiles.length; i += REAP_BATCH_SIZE) {
    const batch = jsonFiles.slice(i, i + REAP_BATCH_SIZE);
    const counts = await Promise.all(
      batch.map(async (name) => {
        const path = join(dir, name);
        let raw: string;
        try {
          raw = await fsPromises.readFile(path, "utf-8");
        } catch {
          return 0;
        }
        const record = parseCliSessionRecord(raw);
        if (!record || !shouldReapRecord(record, now, threshold, options?.cwd)) {
          return 0;
        }
        // Atomic claim-and-verify: if a writer refreshed the marker to running
        // concurrently, restore via link (never clobbering newer writes) instead of deleting.
        const claimPath = `${path}.${randomUUID()}.reap-claim`;
        try {
          await fsPromises.rename(path, claimPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
          log.error(`failed to claim session ${record.agent}/${record.model} at ${path}`, err);
          return 0;
        }

        try {
          const claimedRaw = await fsPromises.readFile(claimPath, "utf-8");
          const recheck = parseCliSessionRecord(claimedRaw);
          if (!recheck || !shouldReapRecord(recheck, Date.now(), threshold, options?.cwd)) {
            try {
              await fsPromises.link(claimPath, path);
            } catch (linkErr) {
              if ((linkErr as NodeJS.ErrnoException).code !== "EEXIST") {
                log.warn(`failed to restore refreshed session marker at ${path}`, linkErr);
              }
            }
            return 0;
          }
          await fsPromises.unlink(claimPath);
          log.info(`reaped session ${recheck.agent}/${recheck.model} ` +
              `(status=${recheck.status}, piSessionId=${recheck.piSessionId}, ` +
              `lastSeen=${recheck.lastSeenAt})`,
          );
          return 1;
        } catch (err) {
          log.error(`failed to reap session ${record.agent}/${record.model} at ${path}`,
            err,
          );
          return 0;
        } finally {
          await fsPromises.unlink(claimPath).catch(() => {});
        }
      }),
    );
    for (const c of counts) reaped += c;

    if (i + REAP_BATCH_SIZE < jsonFiles.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  return reaped;
}

let reaperTimer: ReturnType<typeof setInterval> | null = null;

/** Prefer getter over env when resolving which pi session the reaper protects. */
export function resolveReaperActivePiSessionId(
  getActivePiSessionId?: () => string | null,
  envPiSessionId: string | null | undefined = process.env.PI_SESSION_ID,
): string | null {
  // Getter provided (even if temporarily null) → do not fall back to env.
  // Startup window before session_start must stay "unknown" so all running
  // markers stay protected (/reload continuity).
  if (typeof getActivePiSessionId === "function") {
    const fromGetter = getActivePiSessionId();
    return fromGetter != null && fromGetter !== "" ? fromGetter : null;
  }
  return envPiSessionId != null && envPiSessionId !== ""
    ? envPiSessionId
    : null;
}

export function startCliSessionReaper(opts?: {
  sweepIntervalMs?: number;
  inactivityThresholdMs?: number;
  cwd?: string;
  getActivePiSessionId?: () => string | null;
}): void {
  stopCliSessionReaper();
  const interval = Math.max(
    1,
    opts?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
  );
  let sweeping = false;
  const sweep = () => {
    if (sweeping) return;
    sweeping = true;
    void reapStaleCliSessionsAsync({
      inactivityThresholdMs: opts?.inactivityThresholdMs,
      cwd: opts?.cwd,
      activePiSessionId: resolveReaperActivePiSessionId(
        opts?.getActivePiSessionId,
      ),
    })
      .catch((err) => {
        log.warn("async cli session reaper sweep failed", err);
      })
      .finally(() => {
        sweeping = false;
      });
  };
  // Do not sweep immediately — activePiSessionId is usually still unset at
  // extension load; waiting one interval avoids racing session_start.
  reaperTimer = setInterval(sweep, interval);
  if (reaperTimer.unref) reaperTimer.unref();
}

export function stopCliSessionReaper(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}
