/**
 * Shared daemon manager — reusable infrastructure for spawning, health-checking,
 * connecting to, and managing long-lived server daemons (pidash, pidiff, etc.).
 *
 * Used by pidash.ts and pidiff.ts to avoid duplicating the spawn/connect/reconnect logic.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { execSync } from "node:child_process";

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

export function ensureUiBuilt(uiDirName: string, log: (msg: string) => void): void {
  const uiDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
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
    let dir = path.dirname(new URL(import.meta.url).pathname);
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
  } catch (e: any) { console.debug("[pidiff-daemon] jiti path resolution failed:", e?.message || e); }
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
    path.dirname(new URL(import.meta.url).pathname),
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
