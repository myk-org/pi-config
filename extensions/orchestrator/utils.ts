/**
 * Shared utilities used across orchestrator modules.
 */

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../shared/logger.js";

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
export function resolveRepoRoot(cwd: string): string {
  return resolveMainCheckoutRoot(cwd);
}

const mainCheckoutRootCache = new Map<string, string>();

/**
 * Resolve the main checkout root (the repo owning the worktree), or null when
 * `cwd` is not a git repo.
 *
 * Runs `git rev-parse --path-format=absolute --git-common-dir` and returns the
 * PARENT of the git-common-dir. In the main checkout itself the common dir is
 * `<root>/.git`, so this equals the repo root — callers can use it
 * unconditionally. `.pi/memory` and `.pi/data` are gitignored, so worktree
 * sessions must resolve them here to see the shared stores (issue #918).
 */
export function tryResolveMainCheckoutRoot(cwd: string): string | null {
  const key = path.resolve(cwd);
  const cached = mainCheckoutRootCache.get(key);
  if (cached !== undefined) return cached === "" ? null : cached;
  let root: string | null = null;
  const runGit = (args: string[]): string | null => {
    try {
      const out = execFileSync("git", args, {
        cwd, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out && !out.startsWith("fatal") ? out : null;
    } catch {
      return null;
    }
  };
  // Preferred form: absolute path, any git version ≥ 2.31.
  let gitCommonDir = runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  // Older git releases reject --path-format — fall back to the plain form
  // (relative to cwd) and resolve it, mirroring Python's _get_git_root.
  if (gitCommonDir === null) gitCommonDir = runGit(["rev-parse", "--git-common-dir"]);
  if (gitCommonDir !== null) {
    // Plain-form output may be cwd-relative (older git) — resolve against the
    // queried cwd, never process.cwd().
    root = path.dirname(path.resolve(key, gitCommonDir));
  } else {
    // Expected whenever the cwd is not a git repo — debug line in a file log,
    // never console.*, which would dump it into the chat transcript.
    log.debug("tryResolveMainCheckoutRoot", { cwd: key, reason: "git rev-parse failed (not a repo?)" });
  }
  mainCheckoutRootCache.set(key, root ?? "");
  return root;
}

/** Main checkout root, or `cwd` itself when not inside a git repo. */
export function resolveMainCheckoutRoot(cwd: string): string {
  return tryResolveMainCheckoutRoot(cwd) ?? path.resolve(cwd);
}

/** Resolve to the current worktree root (or repo root if not in a worktree).
 *  Uses --show-toplevel → returns THIS worktree's root, not the shared repo root.
 *  Use for per-worktree resources: pi-config-review-state.jsonl.
 *  For non-worktree repos, returns the same as resolveRepoRoot.
 *  @param cwd — Directory to resolve from (any path inside the worktree)
 *  @returns The worktree's top-level directory, or `cwd` as fallback */
const worktreeRootCache = new Map<string, string>();

const log = createLogger("utils");

/**
 * Resolve the worktree root, or null when `cwd` is not inside a git worktree.
 *
 * Prefer this over {@link resolveWorktreeRoot} when the difference matters: that
 * function deliberately falls back to `cwd`, so a plain directory and a repo
 * root are indistinguishable in its return value, and a caller cannot tell
 * "no graph possible here" from "the graph build failed".
 */
export function tryResolveWorktreeRoot(cwd: string): string | null {
  const key = path.resolve(cwd);
  const cached = worktreeRootCache.get(key);
  if (cached !== undefined) return cached === "" ? null : cached;
  let root: string | null = null;
  try {
    const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (toplevel && !toplevel.startsWith("fatal")) root = path.resolve(toplevel);
  } catch (e: any) {
    // Expected whenever the cwd is not a git repo, so this is a debug line in a
    // file log — never console.*, which would dump it into the chat transcript.
    log.debug("resolveWorktreeRoot", { cwd: key, reason: e?.message?.slice(0, 200) });
  }
  // "" is the not-a-worktree sentinel; resolveWorktreeRoot maps it back to cwd.
  worktreeRootCache.set(key, root ?? "");
  return root;
}

export function resolveWorktreeRoot(cwd: string): string {
  return tryResolveWorktreeRoot(cwd) ?? cwd;
}

/** Get project-scoped temp dir under <cwd>/.pi/tmp/
 *  Deliberately NOT worktree-aware: pidiff runs one server per cwd and tracks
 *  its port in .pi/tmp/pidiff.port — sharing that across worktrees would
 *  collide (issue #918 decided to leave tmp per-cwd on purpose). */
export function getProjectTmpDir(cwd: string): string {
  const dir = path.join(cwd, ".pi", "tmp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Get the shared project data dir under <main-checkout>/.pi/data/.
 *  Resolves through the main checkout (like Python get_project_root()) so the
 *  TS and Python sides agree on one .pi/data/reviews.db from worktrees too. */
export function getProjectDataDir(cwd: string): string {
  const dir = path.join(resolveMainCheckoutRoot(cwd), ".pi", "data");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Get the shared project memory dir under <main-checkout>/.pi/memory/.
 *  Worktree sessions resolve to the main checkout's memory (issue #918):
 *  .pi/memory is gitignored, so a .worktrees/ session would otherwise start
 *  from an empty store and both review-learning parts would silently no-op. */
export function getProjectMemoryDir(cwd: string): string {
  const dir = path.join(resolveMainCheckoutRoot(cwd), ".pi", "memory");
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

/**
 * Minimum pi version required by this pi-config version.
 *
 * 0.99.0: `builtin:mcp` replaces the external `mcpc` binary (so MCP servers are
 * read from ~/.pi/agent/mcp.json by pi itself), and the built-in MCP/codemode/
 * tool-search extensions become the ones we must not collide with.
 */
export const MIN_PI_VERSION = "0.99.0";

/** Get the installed pi version from its package.json. */
export function getPiVersion(): string | null {
  // 1) Resolve from the running binary — walk up until we find the package
  // root (works for any layout: dist/cli.js, dist/bundle/cli.js, src/…).
  try {
    const piScript = process.argv[1];
    if (piScript) {
      let dir = path.dirname(fs.realpathSync(piScript));
      while (dir !== path.dirname(dir)) {
        const pkgPath = path.join(dir, "package.json");
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          if (pkg.name === "@earendil-works/pi-coding-agent" && pkg.version) return pkg.version;
        }
        dir = path.dirname(dir);
      }
    }
  } catch {}
  // 2) Ask the CLI the user actually runs — authoritative for wrapper/bundle layouts.
  try {
    const out = execFileSync("pi", ["--version"], { timeout: 5000, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const m = out.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/);
    if (m) return m[0];
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

export {
  isPiOneshotInvocation,
  shouldSkipOneshotRegister,
  shouldSkipOneshotShutdownDream,
} from "../shared/oneshot.js";
