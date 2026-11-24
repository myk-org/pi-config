/**
 * Dedicated pidiff lockfile, PID, port-probe, and spawn-lock module.
 *
 * Owns all per-project `.pi/run/pidiff.{port,pid,spawning}` control files (plus
 * read-only compatibility with pre-#1020 `.pi/tmp/` copies). Zero pi-tui or
 * ExtensionAPI runtime dependencies so `pidiff.ts`, `scripts/pidiff-server.ts`,
 * `tmp-cleanup.ts`, and unit tests can all import it directly.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { checkHealth } from "../shared/daemon-manager.js";
import { isPidAlive, syncSleep } from "../shared/file-lock.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("pidiff");

export const PIDIFF_PORT_FILE = "pidiff.port";
export const PIDIFF_PID_FILE = "pidiff.pid";
export const PIDIFF_SPAWN_LOCK_FILE = "pidiff.spawning";

/** A pid file holds digits and a newline; anything bigger is not one. */
const MAX_PID_FILE_BYTES = 64;

/** Control files a pre-`.pi/run` daemon owns inside the legacy dir. Private: the sweep asks
 *  `isLiveLegacyDaemonFile`, so neither module keeps a second copy of the names (#1020). */
const LEGACY_CONTROL_FILES = new Set([PIDIFF_PORT_FILE, PIDIFF_PID_FILE]);

function emitDebug(message: string, onLog?: (msg: string) => void): void {
  log.debug(message);
  onLog?.(message);
}

/** True for a path that exists and is a regular file. Lockfiles are never FIFOs, and reading
 *  one would block the event loop, so every control-file read goes through this. */
function isRegularFile(target: string): boolean {
  try {
    return fs.lstatSync(target).isFile();
  } catch {
    return false;
  }
}

/** Read a positive integer PID from a bounded regular file, or null if absent/invalid. */
function readRegularPidFile(pidFile: string): number | null {
  try {
    const st = fs.lstatSync(pidFile);
    if (!st.isFile()) {
      log.debug("pid_file_not_regular", { pidFile });
      return null;
    }
    // Project-controlled dir: refuse large files rather than reading arbitrary data at startup.
    if (st.size > MAX_PID_FILE_BYTES) {
      log.debug("pid_file_too_large", { pidFile, size: st.size });
      return null;
    }
    const raw = fs.readFileSync(pidFile, "utf-8").trim();
    const pid = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    if (isNaN(pid) || pid <= 0) {
      log.debug("pid_file_unparseable", { pidFile });
      return null;
    }
    return pid;
  } catch (e: any) {
    log.debug("pid_file_unreadable", { pidFile, error: e?.message });
    return null;
  }
}

// ── Port discovery & probing ────────────────────────────────────────

/** Find a free TCP port by binding to port 0. */
export function findFreePort(op = "listen"): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr !== "object" || addr === null) {
        // Unexpected address shape — the port-0 fallback below silently picks
        // an arbitrary port, so leave a diagnostic for operators (Qodo PR #954).
        log.warn("find_free_port_unexpected_address", { op, address: String(addr) });
      }
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** Return true if `port` can be bound on 127.0.0.1. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => {
      try { srv.close(); } catch {}
      resolve(false);
    });
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

/** Reuse preferred port if free; otherwise allocate a new one. */
export async function resolveSpawnPort(preferred: number | null | undefined): Promise<number> {
  if (!preferred) {
    const port = await findFreePort();
    log.debug(`allocated new port: ${port}`);
    return port;
  }
  if (await isPortFree(preferred)) {
    log.debug(`reusing lockfile port: ${preferred}`);
    return preferred;
  }
  log.debug(`lockfile port ${preferred} in use, allocating new port`);
  const port = await findFreePort();
  log.debug(`allocated new port: ${port}`);
  return port;
}

// ── Lockfile management ─────────────────────────────────────────────

/** Write pidiff port (and optional PID) lockfiles into `lockDir`. */
export function writeLockfile(
  lockDir: string,
  port: number,
  pid: number | null,
  onLog?: (msg: string) => void,
): void {
  try {
    if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, PIDIFF_PORT_FILE), String(port), { mode: 0o600 });
    if (pid !== null) fs.writeFileSync(path.join(lockDir, PIDIFF_PID_FILE), String(pid), { mode: 0o600 });
    emitDebug(`lockfile written: port=${port} pid=${pid}`, onLog);
  } catch (e: any) {
    log.warn("write_lockfile_error", { lockDir, error: e?.message });
    onLog?.(`writeLockfile error: ${e.message}`);
  }
}

/** Read port and optional PID from lockfile. Returns null when absent/invalid.
 *  `legacyDir` (`.pi/tmp`) is consulted only when the new dir has no lockfile:
 *  a daemon already running at upgrade time wrote its lockfile there (#1020).
 *  Reading never moves or deletes anything — moving a live daemon's record is what the
 *  sweep's liveness check exists to avoid. */
export function readLockfile(lockDir: string, legacyDir?: string): { port: number; pid: number | null } | null {
  const read = (dir: string): { port: number; pid: number | null } | null => {
    try {
      const portFile = path.join(dir, PIDIFF_PORT_FILE);
      // Only a regular file is a lockfile: reading a FIFO here would block the event loop.
      if (!isRegularFile(portFile)) return null;
      const port = parseInt(fs.readFileSync(portFile, "utf-8").trim(), 10);
      if (isNaN(port)) return null;
      let pid: number | null = null;
      const pidFile = path.join(dir, PIDIFF_PID_FILE);
      if (isRegularFile(pidFile)) {
        pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
        if (isNaN(pid)) pid = null;
      }
      return { port, pid };
    } catch (e: any) {
      log.debug("readLockfile error: %s", e?.message);
      return null;
    }
  };
  return read(lockDir) ?? (legacyDir ? read(legacyDir) : null);
}

/** True when the legacy `.pi/tmp` lockfile belongs to a LIVE process. `EPERM` means the
 *  process exists under another user, so it counts as alive — treating it as dead would let
 *  the sweep delete a running daemon's files. */
export function legacyLockfileOwnerAlive(legacyDir: string): boolean {
  const pid = readRegularPidFile(path.join(legacyDir, PIDIFF_PID_FILE));
  if (pid === null) return false;
  const alive = isPidAlive(pid);
  if (!alive) log.debug("legacy_daemon_not_running", { pid });
  return alive;
}

/** True when `name` is a legacy control file whose owner is still alive — the sweep's only
 *  exemption. A dead daemon's leftovers are ordinary throwaway. */
export function isLiveLegacyDaemonFile(legacyDir: string, name: string): boolean {
  if (!LEGACY_CONTROL_FILES.has(name)) return false;
  return legacyLockfileOwnerAlive(legacyDir);
}

/** First lockfile port (in `dirs` order) whose daemon answers /api/health, or
 *  null. Ports in `skipPorts` or already probed in an earlier dir are skipped
 *  so dead ports are never probed twice. */
export async function findLiveLockfile(
  dirs: string[],
  skipPorts?: ReadonlySet<number>,
  probe: (port: number) => Promise<boolean> = checkHealth,
): Promise<number | null> {
  const probed = new Set<number>(skipPorts);
  for (const dir of dirs) {
    if (!dir) continue;
    const lock = readLockfile(dir);
    if (!lock || probed.has(lock.port)) continue;
    probed.add(lock.port);
    if (await probe(lock.port)) return lock.port;
  }
  return null;
}

/** Port of a pidiff daemon that answers /api/health, or null. `preferred` (this
 *  session's known port) is probed first; otherwise the lockfile records are
 *  tried `.pi/run` → legacy `.pi/tmp`. Reading only the FIRST record would let a
 *  stale `.pi/run` port hide a live pre-#1020 daemon, and the caller would then
 *  spawn a duplicate on top of it (#1020). Shared by connect() and `/pidiff start`. */
export async function findRunningPidiffPort(
  lockDir: string,
  legacyLockDir: string,
  preferred = 0,
  probe: (port: number) => Promise<boolean> = checkHealth,
): Promise<number | null> {
  if (preferred && await probe(preferred)) return preferred;
  const skipPorts = preferred ? new Set([preferred]) : undefined;
  return findLiveLockfile([lockDir, legacyLockDir], skipPorts, probe);
}

/** Clean up lockfiles (new dir plus optional legacy `.pi/tmp` copies). */
export function removeLockfile(lockDir: string, onLog?: (msg: string) => void, legacyDir?: string): void {
  try {
    for (const dir of legacyDir ? [lockDir, legacyDir] : [lockDir]) {
      if (!dir) continue;
      const portFile = path.join(dir, PIDIFF_PORT_FILE);
      const pidFile = path.join(dir, PIDIFF_PID_FILE);
      if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    }
    emitDebug("lockfiles removed", onLog);
  } catch (e: any) {
    log.warn("remove_lockfile_error", { lockDir, error: e?.message });
    onLog?.(`removeLockfile error: ${e.message}`);
  }
}

// ── PID lifecycle & daemon termination ──────────────────────────────

/** Kill a pidiff daemon by its stored PID. Returns true if killed.
 *  `legacyPidFile` is the pre-`.pi/run` location: a daemon started before the
 *  move wrote its PID there, so it must still be found (#1020). */
export function killDaemonByPid(
  pidFile: string,
  onLog?: (msg: string) => void,
  legacyPidFile?: string,
): boolean {
  try {
    if (!fs.existsSync(pidFile) && legacyPidFile && fs.existsSync(legacyPidFile)) pidFile = legacyPidFile;
    if (!isRegularFile(pidFile)) return false;
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid) || pid <= 0) {
      emitDebug(`invalid PID in ${pidFile}`, onLog);
      return false;
    }
    try {
      process.kill(pid, 0);
    } catch {
      emitDebug(`PID ${pid} not running`, onLog);
      fs.unlinkSync(pidFile);
      return false;
    }
    // Verify PID belongs to a pidiff-server to avoid killing unrelated processes
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
      if (!cmdline.includes("pidiff-server")) {
        emitDebug(`PID ${pid} is not a pidiff-server process — skipping kill`, onLog);
        fs.unlinkSync(pidFile);
        return false;
      }
    } catch { /* /proc not available (non-Linux) — proceed with kill */ }
    process.kill(pid, "SIGTERM");
    log.info("killed_pidiff_daemon", { pid });
    onLog?.(`killed daemon PID ${pid}`);
    // Wait briefly for process to exit without spawning shell processes
    for (let i = 0; i < 10; i++) {
      try { process.kill(pid, 0); } catch { break; }
      syncSleep(100);
    }
    // Force kill if still alive
    try { process.kill(pid, "SIGKILL"); } catch {}
    try { fs.unlinkSync(pidFile); } catch {}
    return true;
  } catch (e: any) {
    log.warn("kill_daemon_by_pid_error", { pidFile, error: e?.message });
    onLog?.(`killDaemonByPid error: ${e.message}`);
    return false;
  }
}

/** Stop any running pidiff daemon (current `.pi/run` and legacy `.pi/tmp`) and remove lockfiles. */
export function stopPidiffDaemon(
  lockDir: string,
  legacyLockDir: string,
  onLog?: (msg: string) => void,
): void {
  const pidFile = lockDir ? path.join(lockDir, PIDIFF_PID_FILE) : "";
  const legacyPidFile = legacyLockDir ? path.join(legacyLockDir, PIDIFF_PID_FILE) : "";
  if (pidFile) killDaemonByPid(pidFile, onLog, legacyPidFile || undefined);
  // A pre-#1020 daemon may run alongside a new-dir daemon — stop it too.
  if (legacyPidFile) killDaemonByPid(legacyPidFile, onLog);
  if (lockDir || legacyLockDir) removeLockfile(lockDir, onLog, legacyLockDir || undefined);
}

/** Drop the pre-#1020 PID file in `legacyRunDir`, but never while another live daemon owns it. */
export function removeDeadLegacyPidFile(
  legacyRunDir: string,
  currentPid = process.pid,
  onLog?: (msg: string) => void,
): boolean {
  if (!legacyRunDir) return false;
  const legacy = path.join(legacyRunDir, PIDIFF_PID_FILE);
  if (!isRegularFile(legacy)) return false;
  const legacyPid = readRegularPidFile(legacy);
  if (legacyPid !== null && legacyPid !== currentPid && isPidAlive(legacyPid)) {
    return false;
  }
  try {
    fs.unlinkSync(legacy);
    emitDebug(`legacy PID file removed: ${legacy}`, onLog);
    return true;
  } catch {
    return false;
  }
}

/** Write the server PID file into `<projectCwd>/.pi/run/pidiff.pid`, clean any dead legacy
 *  PID file, and return an exit cleanup callback that unlinks the file if it still belongs
 *  to `pid`. Used by `scripts/pidiff-server.ts`. */
export function registerServerPidFile(
  projectCwd: string,
  onLog?: (msg: string) => void,
  pid = process.pid,
): () => void {
  if (!projectCwd) return () => {};
  const runDir = path.join(projectCwd, ".pi", "run");
  const legacyRunDir = path.join(projectCwd, ".pi", "tmp");
  const pidFile = path.join(runDir, PIDIFF_PID_FILE);
  try {
    if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(pidFile, String(pid), { mode: 0o600 });
    log.info("server_pid_file_written", { pidFile, pid });
    onLog?.(`PID file written: ${pidFile} (PID ${pid})`);
    removeDeadLegacyPidFile(legacyRunDir, pid, onLog);
  } catch (e: any) {
    log.warn("server_pid_file_write_error", { pidFile, error: e?.message });
    onLog?.(`PID file write error: ${e.message}`);
    return () => {};
  }

  return () => {
    try {
      const owner = readRegularPidFile(pidFile);
      if (owner !== null && owner !== pid && isPidAlive(owner)) return;
      fs.unlinkSync(pidFile);
    } catch {}
  };
}

// ── Concurrent-spawn lock ───────────────────────────────────────────

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
    const file = path.join(dir, PIDIFF_SPAWN_LOCK_FILE);
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

/** Evaluate a stale spawn lockfile and decide the recovery action. */
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
      const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (lockAge > effectiveTimeout) {
        result = { action: "recover", reason: `no valid PID, age ${Math.round(lockAge / 1000)}s > timeout` };
      } else {
        result = { action: "wait", reason: "no valid PID but lock is young" };
      }
    } else if (!isPidAlive(spawnerPid)) {
      result = { action: "recover", reason: `PID ${spawnerPid} is dead` };
    } else {
      // PID alive — check for PID reuse (lock age > timeout)
      const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (lockAge > effectiveTimeout) {
        result = {
          action: "recover_pid_reuse",
          reason: `PID ${spawnerPid} alive but lock age ${Math.round(lockAge / 1000)}s > timeout (likely PID reuse)`,
        };
      } else {
        result = {
          action: "wait",
          reason: `PID ${spawnerPid} alive, lock age ${Math.round(lockAge / 1000)}s within threshold`,
        };
      }
    }
  } catch {
    result = { action: "recover", reason: "cannot read/stat lockfile" };
  }

  log.debug("evaluate_spawn_lock", result.action, result.reason);
  return result;
}
