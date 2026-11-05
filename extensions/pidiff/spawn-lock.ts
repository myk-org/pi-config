/**
 * Spawn-lock evaluation for pidiff daemon startup races.
 * No pi-tui / ExtensionAPI deps — unit tests can import directly.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../shared/logger.js";

const log = createLogger("pidiff");

/** Take the spawn lock in EVERY dir, or none of them.
 *  A session running pre-#1020 code only checks `.pi/tmp`, so a lock it never
 *  looks at cannot exclude it: if each side locked its own dir, both would
 *  spawn a server for the same project (#1020). Order matters — the legacy dir
 *  comes first so an old spawner already holding it is waited on.
 *  A missing dir means no lockfile can be there — not contention: on a fresh
 *  project `.pi/tmp` does not exist and creating it just to take the lock would
 *  defeat the migration, so such dirs are skipped (#1020). */
export function acquireSpawnLocks(dirs: string[]): { held: string[]; contended: string | null } {
  const held: string[] = [];
  for (const dir of dirs) {
    if (!dir) continue;
    const file = path.join(dir, "pidiff.spawning");
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      held.push(file);
    } catch (e: any) {
      // ENOENT: dir missing (or removed under us) — nobody can hold a lock there.
      if (e?.code === "ENOENT") continue;
      releaseSpawnLocks(held);
      return { held: [], contended: file };
    }
  }
  return { held, contended: null };
}

/** Release every lock `acquireSpawnLocks` took. Best effort. */
export function releaseSpawnLocks(held: string[]): void {
  for (const file of held) {
    try { fs.unlinkSync(file); } catch {}
  }
}

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
        // PID alive — check for PID reuse (lock age > timeout)
        const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (lockAge > effectiveTimeout) {
          result = { action: "recover_pid_reuse", reason: `PID ${spawnerPid} alive but lock age ${Math.round(lockAge / 1000)}s > timeout (likely PID reuse)` };
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
