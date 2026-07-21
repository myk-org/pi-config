/**
 * Reap stale CLI session markers (t3 ProviderSessionReaper pattern).
 * Deletes idle *stopped* bindings only — never status=running, so concurrent
 * pi sessions in the same cwd keep CLI --resume continuity.
 */

import { unlinkSync } from "node:fs";
import { cliProviderLog } from "../shared/file-logger.js";
import { listCliSessions } from "./sessions.js";

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
    if (options?.cwd && record.cwd !== options.cwd) continue;

    // Concurrent pi sessions share ~/.pi/cli-sessions for the same cwd.
    // Deleting another session's running marker breaks its --resume.
    if (record.status === "running") continue;

    const lastSeenMs = Date.parse(record.lastSeenAt);
    const idle =
      Number.isNaN(lastSeenMs) || now - lastSeenMs >= threshold;
    if (!idle) continue;

    try {
      unlinkSync(path);
      reaped += 1;
      cliProviderLog(
        "info",
        `reaped session ${record.agent}/${record.model} ` +
          `(status=${record.status}, piSessionId=${record.piSessionId}, ` +
          `lastSeen=${record.lastSeenAt})`,
      );
    } catch (err) {
      cliProviderLog(
        "error",
        `failed to reap session ${record.agent}/${record.model} at ${path}`,
        err,
      );
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
  const sweep = () => {
    reapStaleCliSessions({
      inactivityThresholdMs: opts?.inactivityThresholdMs,
      cwd: opts?.cwd,
      activePiSessionId: resolveReaperActivePiSessionId(
        opts?.getActivePiSessionId,
      ),
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
