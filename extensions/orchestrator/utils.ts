/**
 * Shared utilities used across orchestrator modules.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

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
export function resolveRepoRoot(cwd: string): string {
  try {
    const gitCommonDir = require("node:child_process")
      .execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf-8", timeout: 3000 })
      .trim();
    if (gitCommonDir && !gitCommonDir.startsWith("fatal")) {
      return path.dirname(path.resolve(cwd, gitCommonDir));
    }
  } catch {}
  return cwd;
}

/** Get project-scoped temp dir under <cwd>/.pi/tmp/ */
export function getProjectTmpDir(cwd: string): string {
  const dir = path.join(resolveRepoRoot(cwd), ".pi", "tmp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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
