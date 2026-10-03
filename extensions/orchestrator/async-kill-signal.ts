/**
 * Pure signalling helpers for killing async workers.
 *
 * Kept free of pi/TUI deps so the kill decision is unit-testable: a failed signal must
 * never be mistaken for a successful one, and one target's failure must not be charged
 * to the next.
 */

/** Signal each pid, returning those still alive afterwards. */
export function signalAndReportSurvivors(
  pids: ReadonlyArray<number>,
  signal: (pid: number) => void,
  isAlive: (pid: number) => boolean,
): number[] {
  const unsignalled: number[] = [];
  for (const pid of pids) {
    try {
      signal(pid);
    } catch {
      unsignalled.push(pid);
    }
  }
  // Only the pids we FAILED to signal need a liveness check. A pid that was signalled
  // successfully is gone, and re-probing it would let one target's leftovers leak into
  // the next target's verdict.
  return unsignalled.filter(isAlive);
}

/**
 * Whether a pid is still running.
 *
 * Only an explicit ESRCH proves the process is gone. Any other failure — EPERM above all —
 * means we were denied, not that the process exited, and treating it as "gone" reports a
 * live worker as killed.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code !== "ESRCH";
  }
}
