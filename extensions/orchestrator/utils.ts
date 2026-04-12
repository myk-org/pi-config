/**
 * Shared utilities used across orchestrator modules.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Send a desktop notification via notify-send (Linux only, no-op if unavailable) */
export function terminalNotify(title: string, body: string): void {
  const project = path.basename(process.cwd());
  try {
    execFileSync("notify-send", [`${title} (${project})`, body], {
      timeout: 2000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {}
}

export function isRunningInContainer(): boolean {
  try {
    // Check for /.dockerenv (Docker) or /run/.containerenv (Podman)
    if (fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv"))
      return true;
    // Check cgroup for container runtimes
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf-8");
    if (/docker|containerd|kubepods|libpod/.test(cgroup)) return true;
  } catch {}
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
