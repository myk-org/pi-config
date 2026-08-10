/**
 * Spawn-lock evaluation for pidiff daemon startup races.
 * Kept dependency-free so unit tests can import without pi-tui / ExtensionAPI.
 */
import * as fs from "node:fs";

/**
 * Evaluate a stale spawn lockfile and decide the recovery action.
 * Exported for testing.
 */
export function evaluateSpawnLock(
  lockPath: string,
  staleTimeoutMs: number,
): { action: "wait" | "recover" | "recover_pid_reuse"; reason: string } {
  try {
    const content = fs.readFileSync(lockPath, "utf-8").trim();
    const spawnerPid = parseInt(content, 10);

    if (!spawnerPid || isNaN(spawnerPid)) {
      // No valid PID — check age
      const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (lockAge > staleTimeoutMs) {
        return { action: "recover", reason: `no valid PID, age ${Math.round(lockAge / 1000)}s > timeout` };
      }
      return { action: "wait", reason: "no valid PID but lock is young" };
    }

    let isAlive = false;
    try {
      process.kill(spawnerPid, 0);
      isAlive = true;
    } catch {
      isAlive = false;
    }

    if (!isAlive) {
      return { action: "recover", reason: `PID ${spawnerPid} is dead` };
    }

    // PID alive — check for PID reuse (lock age > 2x timeout)
    const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (lockAge > staleTimeoutMs * 2) {
      return { action: "recover_pid_reuse", reason: `PID ${spawnerPid} alive but lock age ${Math.round(lockAge / 1000)}s > 2x timeout` };
    }

    return { action: "wait", reason: `PID ${spawnerPid} alive, lock age ${Math.round(lockAge / 1000)}s within threshold` };
  } catch {
    return { action: "recover", reason: "cannot read/stat lockfile" };
  }
}
