/**
 * Reap stale CLI session markers (t3 ProviderSessionReaper pattern).
 * Deletes bindings idle longer than inactivityThresholdMs.
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
   * Current pi session UUID. Running markers for this id are never reaped
   * (mid-session idle must not orphan the live CLI chat — issue #661).
   * Idle markers for other piSessionIds (or legacy `default`) may be reaped
   * even when status=running.
   */
  activePiSessionId?: string | null;
}

function isActivePiSessionMarker(
  recordPiSessionId: string,
  activePiSessionId: string | null | undefined,
): boolean {
  // Unknown active id → do not treat markers as protected; idle running may be
  // reaped so ~/.pi/cli-sessions/ cannot grow without bound.
  if (!activePiSessionId) return false;
  return recordPiSessionId === activePiSessionId;
}

/**
 * Remove idle session files.
 * Never deletes status=running for the *current* piSessionId.
 * Idle markers from other pi sessions (including legacy `default`) are reaped
 * even if still marked running — they cannot be the live chat for this session.
 */
export function reapStaleCliSessions(options?: ReapOptions): number {
  const threshold = Math.max(
    1,
    options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
  );
  const now = Date.now();
  const activeSid = options?.activePiSessionId ?? null;
  let reaped = 0;

  for (const { path, record } of listCliSessions()) {
    if (options?.cwd && record.cwd !== options.cwd) continue;

    const lastSeenMs = Date.parse(record.lastSeenAt);
    const idle =
      Number.isNaN(lastSeenMs) || now - lastSeenMs >= threshold;
    if (!idle) continue;

    if (
      record.status === "running" &&
      isActivePiSessionMarker(record.piSessionId, activeSid)
    ) {
      continue;
    }

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

/** Start periodic reaper (no-op if already running). */
export function startCliSessionReaper(options?: {
  inactivityThresholdMs?: number;
  sweepIntervalMs?: number;
  cwd?: string;
  /** Live pi session id (prefer over env — harness rarely sets PI_SESSION_ID). */
  getActivePiSessionId?: () => string | null;
}): void {
  if (reaperTimer) return;
  const sweepMs = Math.max(
    1,
    options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
  );
  const sweep = () => {
    const fromGetter = options?.getActivePiSessionId?.();
    const activePiSessionId =
      fromGetter != null && fromGetter !== ""
        ? fromGetter
        : process.env.PI_SESSION_ID || null;
    reapStaleCliSessions({
      inactivityThresholdMs: options?.inactivityThresholdMs,
      cwd: options?.cwd,
      activePiSessionId,
    });
  };
  // Immediate sweep once
  sweep();
  reaperTimer = setInterval(() => {
    try {
      sweep();
    } catch (err) {
      cliProviderLog("error", "session reaper sweep failed", err);
    }
  }, sweepMs);
  reaperTimer.unref?.();
}

export function stopCliSessionReaper(): void {
  if (!reaperTimer) return;
  clearInterval(reaperTimer);
  reaperTimer = null;
}
