/**
 * Shared utilities used across orchestrator modules.
 */

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { createLogger } from "../shared/logger.js";

const require = createRequire(import.meta.url);
const log = createLogger("orchestrator");

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

/** Resolve to the main git repo root when cwd is a worktree.
 *  Uses --git-common-dir → always returns the SHARED repo root.
 *  Use for shared resources: project settings, reviews.db. */
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

/** Resolve to the current worktree root (or repo root if not in a worktree).
 *  Uses --show-toplevel → returns THIS worktree's root, not the shared repo root.
 *  Use for per-worktree resources: pi-config-review-state.jsonl.
 *  For non-worktree repos, returns the same as resolveRepoRoot.
 *  @param cwd — Directory to resolve from (any path inside the worktree)
 *  @returns The worktree's top-level directory, or `cwd` as fallback */
const worktreeRootCache = new Map<string, string>();

export function resolveWorktreeRoot(cwd: string): string {
  const key = path.resolve(cwd);
  const cached = worktreeRootCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (toplevel && !toplevel.startsWith("fatal")) {
      const root = path.resolve(toplevel);
      worktreeRootCache.set(key, root);
      return root;
    }
  } catch (e: any) {
    console.debug("[utils] resolveWorktreeRoot failed:", e?.message);
  }
  worktreeRootCache.set(key, cwd);
  return cwd;
}

/** Get project-scoped temp dir under <cwd>/.pi/tmp/ */
export function getProjectTmpDir(cwd: string): string {
  const dir = path.join(cwd, ".pi", "tmp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Get project-scoped data dir under <cwd>/.pi/data/ */
export function getProjectDataDir(cwd: string): string {
  const dir = path.join(cwd, ".pi", "data");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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
export const MIN_PI_VERSION = "0.84.0";

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

/** DJB2 hash — deterministic string → number hash for session IDs. */
export function djb2Hash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * True when this process is a pi --help / --version (or -h / -v) invocation.
 * Pi still loads extensions before printing meta output, so providers should
 * skip expensive model discovery and registration in that case.
 *
 * Only true when every arg before `--` is a meta flag (no other options/values),
 * so prompt values like `-p --help` do not false-positive.
 */
export function isPiMetaInvocation(argv: string[] = process.argv): boolean {
  let sawMeta = false;
  for (const arg of argv.slice(2)) {
    if (arg === "--") break;
    if (
      arg === "--help" ||
      arg === "-h" ||
      arg === "--version" ||
      arg === "-v"
    ) {
      sawMeta = true;
      continue;
    }
    return false;
  }
  return sawMeta;
}

/**
 * Value-taking flags from pi `parseArgs` (`@earendil-works/pi-coding-agent`
 * `dist/cli/args.js`). `--mode` is handled separately. Keep this list in
 * sync when upgrading pi. Next token is always a value, even if it starts
 * with `-` (including `--`).
 */
const ONESHOT_VALUE_FLAGS = new Set([
  "--model",
  "--models",
  "--provider",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--name",
  "-n",
  "--session",
  "--session-id",
  "--fork",
  "--session-dir",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--thinking",
  "--export",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
]);

const PI_MODES = new Set(["text", "json", "rpc"]);

/**
 * True when argv is a oneshot pi invocation (`-p` / `--print` / `--mode json`).
 * Session extras must not register — watchers and sockets keep the event loop
 * alive after the reply.
 *
 * Mirrors pi `parseArgs` + `resolveAppMode` (without TTY): last valid
 * `--mode <text|json|rpc>` wins; rpc is never oneshot; json is; print flag
 * is oneshot unless last mode is rpc. `--mode=json` / `--mode=rpc` are unknown
 * flags in pi (not mode). Value-aware so `--mode -p` does not treat `-p`
 * as the print flag (pi consumes it as an invalid mode value). No `--`
 * end-of-options (parseArgs has none).
 *
 * CLI/ACPX providers still load. Non-TTY stdin or stdout print (`echo | pi`,
 * `pi | cat`) without those flags is not detected here — argv has no flags;
 * use `ctx.mode` after session_start.
 */
export function isPiOneshotInvocation(argv: string[] = process.argv): boolean {
  const args = argv.slice(2);
  let lastMode: string | undefined;
  let print = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-p" || arg === "--print") {
      print = true;
      continue;
    }
    if (arg === "--mode") {
      const value = args[i + 1];
      if (value !== undefined) {
        i += 1;
        if (PI_MODES.has(value)) lastMode = value;
      }
      continue;
    }
    if (ONESHOT_VALUE_FLAGS.has(arg) && args[i + 1] !== undefined) {
      i += 1;
    }
  }
  const oneshot = lastMode === "rpc" ? false : lastMode === "json" || print;
  log.debug("oneshot argv", { oneshot, lastMode, print });
  return oneshot;
}

/** True when pitasks/pidash/pidiff/coms should skip register. Caller returns if true. */
export function shouldSkipOneshotRegister(
  logger: { info: (msg: string) => void },
  argv: string[] = process.argv,
): boolean {
  const skip = isPiOneshotInvocation(argv);
  log.debug("shouldSkipOneshotRegister", { skip });
  if (!skip) return false;
  logger.info("skip register: oneshot print/json");
  return true;
}

/**
 * Shutdown dream runs `runDreamAsync` → `spawnAsyncAgent` (not detached/unref'd).
 * Skip when argv is oneshot OR session `mode` is print/json so `pi -p` can exit.
 * Does not skip rpc/tui unless argv is oneshot (`-p` + `--mode rpc` is not oneshot).
 */
export function shouldSkipOneshotShutdownDream(
  mode?: string | null,
  argv: string[] = process.argv,
): boolean {
  const oneshot = isPiOneshotInvocation(argv);
  const printOrJson = mode === "print" || mode === "json";
  const skip = oneshot || printOrJson;
  log.debug("skip shutdown dream?", { skip, oneshot, mode });
  return skip;
}
