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

const HEALTH_CHECK_TIMEOUT_MS = 2000;

// ── Logging ─────────────────────────────────────────────────────────

export function createLogger(logPath: string, prefix: string) {
  return (msg: string) => {
    try { fs.appendFileSync(logPath, `${new Date().toISOString()} [${prefix}] ${msg}\n`); } catch {}
  };
}

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

// ── Find jiti ───────────────────────────────────────────────────────

export function findJitiPath(): string | undefined {
  let jitiPath: string | undefined;
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
      const candidate = path.join(dir, "node_modules", "jiti", "lib", "jiti-cli.mjs");
      if (fs.existsSync(candidate)) { jitiPath = candidate; break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!jitiPath) {
      const globalCandidate = path.join(
        path.dirname(process.execPath), "..", "lib", "node_modules",
        "@earendil-works", "pi-coding-agent", "node_modules",
        "jiti", "lib", "jiti-cli.mjs",
      );
      if (fs.existsSync(globalCandidate)) jitiPath = globalCandidate;
    }
  } catch (e: any) { console.debug("[pidash-daemon] jiti path resolution failed:", e?.message || e); }
  return jitiPath;
}

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
}

export function spawnDaemon(opts: SpawnOptions): void {
  const serverPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..", "..", "scripts", opts.serverScript,
  );

  const jitiPath = findJitiPath();
  opts.log(`jiti path: ${jitiPath || "NOT FOUND"}`);

  const nodeCmd = process.execPath;
  const serverArgs = jitiPath
    ? `"${jitiPath}" "${serverPath}"${opts.extraArgs ? ` ${opts.extraArgs}` : ""}`
    : `"${serverPath}"${opts.extraArgs ? ` ${opts.extraArgs}` : ""}`;
  const cmd = `nohup "${nodeCmd}" ${serverArgs} > "${opts.logFile}" 2>&1 &`;
  opts.log(`spawning daemon: ${cmd}`);

  try {
    execSync(cmd, {
      stdio: "ignore",
      env: { ...process.env, ...(opts.env || {}) },
    });
  } catch (e: any) {
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

/** Kill a daemon by its stored PID. Returns true if killed. */
export function killDaemonByPid(pidFile: string, log: (msg: string) => void): boolean {
  try {
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
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
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

/** Read port from lockfile. Returns port number or null. */
export function readLockfile(lockDir: string): { port: number; pid: number | null } | null {
  try {
    const portFile = path.join(lockDir, "pidiff.port");
    if (!fs.existsSync(portFile)) return null;
    const port = parseInt(fs.readFileSync(portFile, "utf-8").trim(), 10);
    if (isNaN(port)) return null;
    let pid: number | null = null;
    const pidFile = path.join(lockDir, "pidiff.pid");
    if (fs.existsSync(pidFile)) {
      pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      if (isNaN(pid)) pid = null;
    }
    return { port, pid };
  } catch (e: any) { console.debug(`[daemon-manager] readLockfile error: ${e?.message}`); return null; }
}

/** Clean up lockfiles. */
export function removeLockfile(lockDir: string, log: (msg: string) => void): void {
  try {
    const portFile = path.join(lockDir, "pidiff.port");
    const pidFile = path.join(lockDir, "pidiff.pid");
    if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
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
