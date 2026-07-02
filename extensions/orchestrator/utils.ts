/**
 * Shared utilities used across orchestrator modules.
 */

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

const require = createRequire(import.meta.url);

/** Whether notify-send is available (false = ENOENT, never retry) */
let notifyAvailable: boolean | undefined;

/** Send a desktop notification via notify-send (Linux only, no-op if unavailable) */
export function terminalNotify(title: string, body: string): void {
  // Subagent children and coms peers don't own a terminal
  if (process.env.PI_SUBAGENT_CHILD === "1") return;
  if (notifyAvailable === false) return;

  const project = path.basename(process.cwd());
  const child = execFile("notify-send", [`${title} (${project})`, body], {
    timeout: 2000,
  }, (err) => {
    if (err) {
      if ((err as any).code === "ENOENT" || /DBus\.Error|not activatable|No session bus/.test(err.message)) {
        notifyAvailable = false;
      } else {
        console.debug("[utils] notify-send failed:", err.message);
      }
    } else {
      notifyAvailable = true;
    }
  });
  child.unref();
}

/** Set SSH timeout for git operations — prevents hung connections */
export function ensureGitSshTimeout(): void {
  if (!process.env.GIT_SSH_COMMAND) {
    process.env.GIT_SSH_COMMAND = "ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10";
  }
}

/** Format a Date as HH:MM (24h clock). */
export const clockHHMM = (d: Date = new Date()): string =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export function isRunningInContainer(): boolean {
  try {
    // Check for /.dockerenv (Docker) or /run/.containerenv (Podman)
    if (fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv"))
      return true;
    // Check cgroup for container runtimes
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf-8");
    if (/docker|containerd|kubepods|libpod/.test(cgroup)) return true;
  } catch (e: any) { console.debug("[utils] container detection failed:", e?.message || e); }
  return false;
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const s = process.argv[1];
  if (s && fs.existsSync(s))
    return { command: process.execPath, args: [s, ...args] };
  const e = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(e))
    return { command: process.execPath, args };
  return { command: "pi", args };
}

/** Resolve to the main git repo root when cwd is a worktree. */
const repoRootCache = new Map<string, string>();

export function resolveRepoRoot(cwd: string): string {
  const key = path.resolve(cwd);
  const cached = repoRootCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (gitCommonDir && !gitCommonDir.startsWith("fatal")) {
      const root = path.dirname(path.resolve(cwd, gitCommonDir));
      repoRootCache.set(key, root);
      return root;
    }
  } catch {}
  repoRootCache.set(key, cwd);
  return cwd;
}

/** Get project-scoped temp dir under <cwd>/.pi/tmp/ */
export function getProjectTmpDir(cwd: string): string {
  const dir = path.join(cwd, ".pi", "tmp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Parse start time (field 22) from /proc stat content — handles comm fields with spaces */
export function parseProcStartTime(statContent: string): string | null {
  // Field 2 (comm) is wrapped in parens and may contain spaces/parens.
  // Find the LAST ')' to reliably skip it, then split remaining fields.
  const closeParenIdx = statContent.lastIndexOf(")");
  if (closeParenIdx < 0) return null;
  const fields = statContent.slice(closeParenIdx + 2).split(" ");
  // After comm: field 3=state(idx 0), field 4=ppid(idx 1), ... field 22=starttime(idx 19)
  return fields[19] || null;
}

/** Safely call ctx.getSystemPromptOptions() — returns null if unavailable. */
export function tryGetSystemPromptOptions(ctx: any): { contextFiles?: any[]; skills?: any[]; selectedTools?: any[]; promptGuidelines?: any[] } | null {
  try {
    return ctx.getSystemPromptOptions?.() ?? null;
  } catch (e: any) {
    console.debug("[utils] getSystemPromptOptions failed:", e?.message);
    return null;
  }
}

/** Minimum pi version required by this pi-config version. */
export const MIN_PI_VERSION = "0.80.3";

/** Get the installed pi version from its package.json. */
export function getPiVersion(): string | null {
  try {
    // Resolve from pi's own install location (process.argv[1] → dist/cli.js → package root)
    const piScript = process.argv[1];
    if (piScript) {
      const realPath = fs.realpathSync(piScript);
      const piPkgPath = path.join(path.dirname(path.dirname(realPath)), "package.json");
      if (fs.existsSync(piPkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(piPkgPath, "utf-8"));
        if (pkg.name === "@earendil-works/pi-coding-agent" && pkg.version) return pkg.version;
      }
    }
  } catch {}
  return null;
}

/** Compare two semver strings. Returns -1 if a < b, 0 if equal, 1 if a > b. */
export function compareSemver(a: string, b: string): number {
  // Strip prerelease/build metadata (e.g., '0.80.4-beta.1' → '0.80.4')
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

/** Check if installed pi version meets minimum requirement. */
export function checkMinPiVersion(minVersion: string = MIN_PI_VERSION): { ok: boolean; installed: string | null; required: string } {
  const installed = getPiVersion();
  if (!installed) return { ok: false, installed: null, required: minVersion };
  return { ok: compareSemver(installed, minVersion) >= 0, installed, required: minVersion };
}
