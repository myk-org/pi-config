/**
 * Spawn-lock evaluation for pidiff daemon startup races.
 * No pi-tui / ExtensionAPI deps — unit tests can import directly.
 */
import * as fs from "node:fs";
import { createLogger } from "../shared/logger.js";

const log = createLogger("pidiff");

/**
 * Evaluate a stale spawn lockfile and decide the recovery action.
 * Exported for testing.
 */
export function evaluateSpawnLock(
  lockPath: string,
  staleTimeoutMs: number,
): { action: "wait" | "recover" | "recover_pid_reuse"; reason: string } {
  log.debug("evaluate_spawn_lock", "lockPath", lockPath, "staleTimeoutMs", staleTimeoutMs);
  const effectiveTimeout = Math.max(staleTimeoutMs, 1000); // Floor at 1s to prevent thrashing
  let result: { action: "wait" | "recover" | "recover_pid_reuse"; reason: string };

  try {
    const content = fs.readFileSync(lockPath, "utf-8").trim();
    const spawnerPid = /^\d+$/.test(content) ? parseInt(content, 10) : NaN;

    if (!spawnerPid || isNaN(spawnerPid)) {
      // No valid PID — check age
      const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (lockAge > effectiveTimeout) {
        result = { action: "recover", reason: `no valid PID, age ${Math.round(lockAge / 1000)}s > timeout` };
      } else {
        result = { action: "wait", reason: "no valid PID but lock is young" };
      }
    } else {
      let isAlive = false;
      try {
        process.kill(spawnerPid, 0);
        isAlive = true;
      } catch (e: any) {
        // EPERM = process exists but we can't signal it — treat as alive
        isAlive = e?.code === "EPERM";
      }

      if (!isAlive) {
        result = { action: "recover", reason: `PID ${spawnerPid} is dead` };
      } else {
        // PID alive — check for PID reuse (lock age > 2x timeout)
        const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (lockAge > effectiveTimeout * 2) {
          result = { action: "recover_pid_reuse", reason: `PID ${spawnerPid} alive but lock age ${Math.round(lockAge / 1000)}s > 2x timeout` };
        } else {
          result = { action: "wait", reason: `PID ${spawnerPid} alive, lock age ${Math.round(lockAge / 1000)}s within threshold` };
        }
      }
    }
  } catch {
    result = { action: "recover", reason: "cannot read/stat lockfile" };
  }

  log.debug("evaluate_spawn_lock", result.action, result.reason);
  return result;
}
