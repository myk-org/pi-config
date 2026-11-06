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

export function checkHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/api/health", timeout: HEALTH_CHECK_TIMEOUT_MS },
      (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => {
          try { resolve(JSON.parse(body).status === "ok"); } catch { resolve(false); }
        });
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

/** Read port from lockfile. Returns port number or null.
 *  `legacyDir` (`.pi/tmp`) is consulted only when the new dir has no lockfile:
 *  a daemon already running at upgrade time wrote its lockfile there (#1020).
 *  A legacy lockfile found this way is MOVED into `lockDir`, so `.pi/tmp` stops
 *  holding state a sweep would have to protect — the daemon stays found because the
 *  next read hits the new path. */
export function readLockfile(lockDir: string, legacyDir?: string): { port: number; pid: number | null } | null {
  const read = (dir: string): { port: number; pid: number | null } | null => {
    try {
      const portFile = path.join(dir, "pidiff.port");
      if (!fs.existsSync(portFile)) return null;
      const port = parseInt(fs.readFileSync(portFile, "utf-8").trim(), 10);
      if (isNaN(port)) return null;
      let pid: number | null = null;
      const pidFile = path.join(dir, "pidiff.pid");
      if (fs.existsSync(pidFile)) {
        pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
        if (isNaN(pid)) pid = null;
      }
      return { port, pid };
    } catch (e: any) { log.debug("readLockfile error: %s", e?.message); return null; }
  };
  return read(lockDir) ?? (legacyDir ? migrateLegacyLockfile(read(legacyDir), lockDir, legacyDir) : null);
}

/** Move a legacy `.pi/tmp` lockfile into the run dir. Returns the lock unchanged, so a
 *  pre-upgrade daemon stays reachable; a failure to migrate only logs (the legacy copy
 *  is still readable next time). */
function migrateLegacyLockfile(
  lock: { port: number; pid: number | null } | null,
  lockDir: string,
  legacyDir: string,
): { port: number; pid: number | null } | null {
  if (!lock) return null;
  try {
    writeLockfile(lockDir, lock.port, lock.pid, (msg) => log.debug("lockfile_migrated", { legacyDir, message: msg }));
    for (const name of ["pidiff.port", "pidiff.pid"]) {
      const legacyPath = path.join(legacyDir, name);
      if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
    }
  } catch (e: any) {
    log.debug("lockfile_migration_failed", { legacyDir, error: e?.message });
  }
  return lock;
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
