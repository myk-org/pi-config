/**
 * Shared daemon manager — reusable infrastructure for spawning, health-checking,
 * connecting to, and managing long-lived server daemons (pidash, pidiff, etc.).
 *
 * Used by pidash.ts and pidiff.ts to avoid duplicating the spawn/connect/reconnect logic.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLogger } from "./logger.js";
import { findJitiPath } from "./find-jiti.js";

const log = createLogger("daemon-manager");

const HEALTH_CHECK_TIMEOUT_MS = 2000;

// ── Health check ────────────────────────────────────────────────────

/** Statuses that mean "a daemon is listening here".
 *
 *  `degraded` is one of them: the server bound its port but a startup hook failed (the Discord bot
 *  could not be created). Treating it as "not running" made callers spawn a SECOND daemon, which
 *  then lost the occupied port and waited on a health check that never passed. */
export const DAEMON_UP_STATUSES = new Set(["ok", "degraded"]);

/** Parse a /api/health body into the daemon's state, or null when it is not a health response. */
export function parseHealth(body: string): { running: boolean; degraded: boolean; startupError: string | null } {
  try {
    const data = JSON.parse(body);
    const status = typeof data?.status === "string" ? data.status : "";
    const startupError = typeof data?.startupError === "string" ? data.startupError : null;
    return { running: DAEMON_UP_STATUSES.has(status), degraded: status === "degraded" || Boolean(startupError), startupError };
  } catch {
    return { running: false, degraded: false, startupError: null };
  }
}

export function checkHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/api/health", timeout: HEALTH_CHECK_TIMEOUT_MS },
      (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => resolve(parseHealth(body).running));
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ── UI build ────────────────────────────────────────────────────────

export function ensureUiBuilt(callerUrl: string, uiDirName: string, log: (msg: string) => void): void {
  const uiDir = path.resolve(
    path.dirname(fileURLToPath(callerUrl)),
    uiDirName,
  );
  const distDir = path.join(uiDir, "dist");
  if (fs.existsSync(distDir)) return;
  if (!fs.existsSync(path.join(uiDir, "package.json"))) return;

  log(`${uiDirName} dist/ not found, building...`);
  try {
    execSync("npm install --production=false && npm run build", {
      cwd: uiDir,
      stdio: "ignore",
      timeout: 60000,
    });
    log(`${uiDirName} build complete`);
  } catch (e: any) {
    log(`${uiDirName} build failed: ${e.message}`);
  }
}

export { findJitiPath, findJitiUnder } from "./find-jiti.js";

// ── Spawn daemon ────────────────────────────────────────────────────

export interface SpawnOptions {
  /** Path to the server .ts file (relative to scripts/) */
  serverScript: string;
  /** Log file path */
  logFile: string;
  /** Extra CLI args for the server */
  extraArgs?: string;
  /** Extra env vars */
  env?: Record<string, string>;
  /** Logger function */
  log: (msg: string) => void;
  /** Override jiti lookup (tests). Default: findJitiPath(). */
  resolveJiti?: () => string | undefined;
}

export function spawnDaemon(opts: SpawnOptions): void {
  const serverPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..", "..", "scripts", opts.serverScript,
  );

  const jitiPath = (opts.resolveJiti ?? findJitiPath)();
  opts.log(`jiti path: ${jitiPath || "NOT FOUND"}`);
  if (!jitiPath) {
    const msg =
      "jiti-cli.mjs not found — refusing to run .ts under node_modules (Node type-stripping is disabled there)";
    log.error("%s server=%s", msg, serverPath);
    log.debug("spawnDaemon refused — jiti missing server=%s", serverPath);
    opts.log(msg);
    return;
  }

  const nodeCmd = process.execPath;
  const serverArgs = `"${jitiPath}" "${serverPath}"${opts.extraArgs ? ` ${opts.extraArgs}` : ""}`;
  const cmd = `nohup "${nodeCmd}" ${serverArgs} > "${opts.logFile}" 2>&1 &`;
  opts.log(`spawning daemon: ${cmd}`);
  log.info("spawning daemon script=%s jiti=%s", opts.serverScript, jitiPath);

  try {
    execSync(cmd, {
      stdio: "ignore",
      env: { ...process.env, ...(opts.env || {}) },
    });
  } catch (e: any) {
    log.error("spawn error: %s", e.message);
    opts.log(`spawn error: ${e.message}`);
  }
}

// ── Kill daemon ─────────────────────────────────────────────────────

export function killDaemon(pattern: string, log: (msg: string) => void): void {
  try {
    execSync(`pkill -f "${pattern}"`, { stdio: "ignore" });
    log(`killed processes matching: ${pattern}`);
  } catch {}
}

// ── Kill daemon by PID ──────────────────────────────────────────────

/** Kill a daemon by its stored PID. Returns true if killed.
 *  `legacyPidFile` is the pre-`.pi/run` location: a daemon started before the
 *  move wrote its PID there, so it must still be found (#1020). */
export function killDaemonByPid(pidFile: string, log: (msg: string) => void, legacyPidFile?: string): boolean {
  try {
    if (!fs.existsSync(pidFile) && legacyPidFile && fs.existsSync(legacyPidFile)) pidFile = legacyPidFile;
    if (!fs.existsSync(pidFile)) return false;
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid)) { log(`invalid PID in ${pidFile}`); return false; }
    try { process.kill(pid, 0); } catch { log(`PID ${pid} not running`); fs.unlinkSync(pidFile); return false; }
    // Verify PID belongs to a pidiff-server to avoid killing unrelated processes
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
      if (!cmdline.includes("pidiff-server")) {
        log(`PID ${pid} is not a pidiff-server process — skipping kill`);
        fs.unlinkSync(pidFile);
        return false;
      }
    } catch { /* /proc not available (non-Linux) — proceed with kill */ }
    process.kill(pid, "SIGTERM");
    log(`killed daemon PID ${pid}`);
    // Wait briefly for process to exit
    // Sync sleep without spawning shell processes
    const waitBuf = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 10; i++) {
      try { process.kill(pid, 0); } catch { break; }
      Atomics.wait(waitBuf, 0, 0, 100);
    }
    // Force kill if still alive
    try { process.kill(pid, "SIGKILL"); } catch {}
    try { fs.unlinkSync(pidFile); } catch {}
    return true;
  } catch (e: any) { log(`killDaemonByPid error: ${e.message}`); return false; }
}

// ── Find free port ──────────────────────────────────────────────────

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

// ── Lockfile management ─────────────────────────────────────────────

/** Write a lockfile with port and PID. */
export function writeLockfile(lockDir: string, port: number, pid: number | null, log: (msg: string) => void): void {
  try {
    if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "pidiff.port"), String(port), { mode: 0o600 });
    if (pid !== null) fs.writeFileSync(path.join(lockDir, "pidiff.pid"), String(pid), { mode: 0o600 });
    log(`lockfile written: port=${port} pid=${pid}`);
  } catch (e: any) { log(`writeLockfile error: ${e.message}`); }
}

/** A pid file holds digits and a newline; anything bigger is not one. */
const MAX_PID_FILE_BYTES = 64;

/** True for a path that exists and is a regular file. Lockfiles are never FIFOs, and reading
 *  one would block the event loop, so every control-file read goes through this. */
function isRegularFile(target: string): boolean {
  try {
    return fs.lstatSync(target).isFile();
  } catch {
    return false;
  }
}

/** Read port from lockfile. Returns port number or null.
 *  `legacyDir` (`.pi/tmp`) is consulted only when the new dir has no lockfile:
 *  a daemon already running at upgrade time wrote its lockfile there (#1020).
 *  Reading never moves or deletes anything — moving a live daemon's record is what the
 *  sweep's liveness check exists to avoid. */
export function readLockfile(lockDir: string, legacyDir?: string): { port: number; pid: number | null } | null {
  const read = (dir: string): { port: number; pid: number | null } | null => {
    try {
      const portFile = path.join(dir, "pidiff.port");
      // Only a regular file is a lockfile: the dirs are project-controlled, and reading a
      // FIFO here would block the event loop for the whole session.
      if (!isRegularFile(portFile)) return null;
      const port = parseInt(fs.readFileSync(portFile, "utf-8").trim(), 10);
      if (isNaN(port)) return null;
      let pid: number | null = null;
      const pidFile = path.join(dir, "pidiff.pid");
      if (isRegularFile(pidFile)) {
        pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
        if (isNaN(pid)) pid = null;
      }
      return { port, pid };
    } catch (e: any) { log.debug("readLockfile error: %s", e?.message); return null; }
  };
  return read(lockDir) ?? (legacyDir ? read(legacyDir) : null);
}

/** Read the pid from a lockfile, refusing anything but a regular file: the legacy dir is
 *  project-controlled, and reading a FIFO there would block session startup. */
function readLegacyPid(pidFile: string): number | null {
  try {
    const st = fs.lstatSync(pidFile);
    if (!st.isFile()) {
      log.debug("legacy_pid_not_a_regular_file", { pidFile });
      return null;
    }
    // The file is project-controlled: a pid is a few bytes, so refuse anything larger rather
    // than reading an arbitrary file into memory during session start.
    if (st.size > MAX_PID_FILE_BYTES) {
      log.debug("legacy_pid_file_too_large", { pidFile, size: st.size });
      return null;
    }
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid) || pid <= 0) {
      log.debug("legacy_pid_unparseable", { pidFile });
      return null;
    }
    return pid;
  } catch (e: any) {
    log.debug("legacy_pid_unreadable", { pidFile, error: e?.message });
    return null;
  }
}

/** True when the legacy `.pi/tmp` lockfile belongs to a LIVE process. `EPERM` means the
 *  process exists under another user, so it counts as alive — treating it as dead would let
 *  the sweep delete a running daemon's files. */
export function legacyLockfileOwnerAlive(legacyDir: string): boolean {
  const pid = readLegacyPid(path.join(legacyDir, "pidiff.pid"));
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    if (e?.code === "EPERM") {
      log.debug("legacy_daemon_owned_by_another_user", { pid });
      return true;
    }
    log.debug("legacy_daemon_not_running", { pid, code: e?.code });
    return false;
  }
}

/** Control files a pre-`.pi/run` daemon owns inside the legacy dir. Private: the sweep asks
 *  `isLiveLegacyDaemonFile`, so neither module keeps a second copy of the names (#1020). */
const LEGACY_CONTROL_FILES = new Set(["pidiff.port", "pidiff.pid"]);

/** True when `name` is a legacy control file whose owner is still alive — the sweep's only
 *  exemption. A dead daemon's leftovers are ordinary throwaway. */
export function isLiveLegacyDaemonFile(legacyDir: string, name: string): boolean {
  if (!LEGACY_CONTROL_FILES.has(name)) return false;
  return legacyLockfileOwnerAlive(legacyDir);
}

/** First lockfile port (in `dirs` order) whose daemon answers /api/health, or
 *  null. Exported for testing. */
export async function findLiveLockfile(dirs: string[]): Promise<number | null> {
  for (const dir of dirs) {
    if (!dir) continue;
    const lock = readLockfile(dir);
    if (lock && await checkHealth(lock.port)) return lock.port;
  }
  return null;
}

/** Clean up lockfiles (new dir plus the legacy `.pi/tmp` copies). */
export function removeLockfile(lockDir: string, log: (msg: string) => void, legacyDir?: string): void {
  try {
    for (const dir of legacyDir ? [lockDir, legacyDir] : [lockDir]) {
      const portFile = path.join(dir, "pidiff.port");
      const pidFile = path.join(dir, "pidiff.pid");
      if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    }
    log("lockfiles removed");
  } catch (e: any) { log(`removeLockfile error: ${e.message}`); }
}

// ── Wait for daemon ─────────────────────────────────────────────────

export async function waitForDaemon(
  port: number,
  maxWaitSeconds: number,
  log: (msg: string) => void,
): Promise<boolean> {
  for (let i = 0; i < maxWaitSeconds; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await checkHealth(port)) {
      log(`daemon ready after ${i + 1}s`);
      return true;
    }
  }
  log(`daemon failed to start after ${maxWaitSeconds}s`);
  return false;
}
