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
  /** Only reap sessions matching this pi session id (optional). */
  piSessionId?: string | null;
}

/**
 * Remove stale / stopped session files. Returns number reaped.
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
    if (
      options?.piSessionId != null &&
      options.piSessionId !== "" &&
      record.piSessionId !== options.piSessionId &&
      record.piSessionId !== "default"
    ) {
      // Keep other pi sessions' markers
      continue;
    }

    const lastSeenMs = Date.parse(record.lastSeenAt);
    const idle =
      Number.isNaN(lastSeenMs) || now - lastSeenMs >= threshold;
    const stopped = record.status === "stopped";

    if (!idle && !stopped) continue;

    try {
      unlinkSync(path);
      reaped += 1;
      cliProviderLog(
        "info",
        `reaped session ${record.agent}/${record.model} ` +
          `(status=${record.status}, lastSeen=${record.lastSeenAt})`,
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
}): void {
  if (reaperTimer) return;
  const sweepMs = Math.max(
    1,
    options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
  );
  // Immediate sweep once
  reapStaleCliSessions({
    inactivityThresholdMs: options?.inactivityThresholdMs,
    cwd: options?.cwd,
    piSessionId: process.env.PI_SESSION_ID || null,
  });
  reaperTimer = setInterval(() => {
    try {
      reapStaleCliSessions({
        inactivityThresholdMs: options?.inactivityThresholdMs,
        cwd: options?.cwd,
        piSessionId: process.env.PI_SESSION_ID || null,
      });
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
