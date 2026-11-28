/**
 * Shared utilities used across orchestrator modules.
 */

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../shared/logger.js";
import { getComsPeerName } from "../shared/session-bridge.js";
import {
  resolveMainCheckoutRoot as resolveMainCheckoutRootCore,
  tryResolveMainCheckoutRoot as tryResolveMainCheckoutRootCore,
} from "./project-settings.js";

const log = createLogger("utils");

/** Whether notify-send is available (false = ENOENT, never retry) */
let notifyAvailable: boolean | undefined;

export interface FormatNotificationTitleOptions {
  cwd?: string;
  argv?: readonly string[];
  peerName?: string | null;
  sessionKey?: string;
  resolveGitCommonDir?: (cwd: string) => string | null;
}

interface NotificationGitContext {
  repoName: string;
  worktreeName: string | null;
}

interface GitMarkerInfo {
  checkoutBase: string;
  isLinkedWorktree: boolean;
  commonDir: string | null;
}

let notifyExecOverride: ((args: [string, string]) => void) | null = null;

function repoNameFromCommonDir(commonDir: string): string {
  const base = path.basename(commonDir);
  if (base === ".git") return path.basename(path.dirname(commonDir));
  return base.endsWith(".git") && base.length > 4 ? base.slice(0, -4) : base;
}

function findGitMarker(resolvedCwd: string): GitMarkerInfo | null {
  let current = resolvedCwd;
  for (;;) {
    const dotGit = path.join(current, ".git");
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = null;
    }
    if (stat) {
      const checkoutBase = path.basename(current) || current;
      if (stat.isDirectory()) {
        return { checkoutBase, isLinkedWorktree: false, commonDir: dotGit };
      }
      if (stat.isFile()) {
        try {
          const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf-8"));
          const rawGitDir = match?.[1]?.trim();
          if (rawGitDir) {
            const gitDir = path.resolve(current, rawGitDir);
            const normalizedGitDir = gitDir.split(path.sep).join("/");
            if (normalizedGitDir.includes("/.git/modules/")) {
              return { checkoutBase, isLinkedWorktree: false, commonDir: null };
            }
            let commonDir: string | null = null;
            try {
              const commonRaw = fs.readFileSync(path.join(gitDir, "commondir"), "utf-8").trim();
              if (commonRaw) commonDir = path.resolve(gitDir, commonRaw);
            } catch {
              // Lightweight fixture or missing commondir: fall back to parsing `<common>/worktrees/<name>`
            }
            if (!commonDir) {
              const wtMatch = /^(.*(?:\/\.git|\.git))\/worktrees\/[^/]+$/.exec(normalizedGitDir);
              if (wtMatch) commonDir = path.resolve(wtMatch[1]);
            }
            if (commonDir) {
              return { checkoutBase, isLinkedWorktree: commonDir !== gitDir, commonDir };
            }
            // Separate Git directory (`git init --separate-git-dir`): valid repo without linked worktree suffix.
            return { checkoutBase, isLinkedWorktree: false, commonDir: gitDir };
          }
        } catch (err: unknown) {
          log.warn("notification_git_read_failed", {
            path: dotGit,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return { checkoutBase, isLinkedWorktree: false, commonDir: null };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveNotificationGitContext(
  resolvedCwd: string,
  resolveGitCommonDir?: (cwd: string) => string | null,
): NotificationGitContext {
  if (resolveGitCommonDir) {
    const commonDir = resolveGitCommonDir(resolvedCwd);
    if (!commonDir || !commonDir.trim()) {
      return { repoName: path.basename(resolvedCwd) || resolvedCwd, worktreeName: null };
    }
    const resolvedCommon = path.resolve(resolvedCwd, commonDir.trim());
    const repoRoot = path.basename(resolvedCommon) === ".git"
      ? path.dirname(resolvedCommon)
      : resolvedCommon;
    const repoName = repoNameFromCommonDir(resolvedCommon) || path.basename(resolvedCwd) || resolvedCwd;
    if (resolvedCwd === repoRoot) return { repoName, worktreeName: null };
    const marker = findGitMarker(resolvedCwd);
    if (marker) {
      return {
        repoName,
        worktreeName: marker.isLinkedWorktree && marker.checkoutBase !== repoName ? marker.checkoutBase : null,
      };
    }
    const cwdBase = path.basename(resolvedCwd);
    return { repoName, worktreeName: cwdBase && cwdBase !== repoName ? cwdBase : null };
  }

  const marker = findGitMarker(resolvedCwd);
  if (!marker) {
    return { repoName: path.basename(resolvedCwd) || resolvedCwd, worktreeName: null };
  }
  if (marker.commonDir) {
    const repoName = repoNameFromCommonDir(marker.commonDir) || marker.checkoutBase;
    return {
      repoName,
      worktreeName: marker.isLinkedWorktree && marker.checkoutBase !== repoName ? marker.checkoutBase : null,
    };
  }
  return { repoName: marker.checkoutBase, worktreeName: null };
}

function parseCnameFromArgv(argv: readonly string[]): string | null {
  let cname: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "--cname") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        const trimmed = next.trim();
        if (trimmed) cname = trimmed;
        i++;
      }
    } else if (arg.startsWith("--cname=")) {
      const trimmed = arg.slice("--cname=".length).trim();
      if (trimmed) cname = trimmed;
    }
  }
  return cname;
}

/** Format a desktop notification title with git repo name and COMS peer or linked worktree name. */
export function formatNotificationTitle(title: string, opts?: FormatNotificationTitleOptions): string {
  const resolvedCwd = path.resolve(opts?.cwd ?? process.cwd());
  const { repoName, worktreeName } = resolveNotificationGitContext(resolvedCwd, opts?.resolveGitCommonDir);
  const peerName = opts?.peerName !== undefined
    ? (opts.peerName?.trim() || null)
    : (getComsPeerName(opts?.sessionKey) ?? parseCnameFromArgv(opts?.argv ?? process.argv));
  const detail = peerName ?? worktreeName;
  const label = detail && detail !== repoName ? `${repoName} · ${detail}` : repoName;
  return `${title} (${label})`;
}

export function setTerminalNotifyExecForTests(fn: ((args: [string, string]) => void) | null): void {
  notifyExecOverride = fn;
  notifyAvailable = undefined;
}

/** Send a desktop notification via notify-send (Linux only, no-op if unavailable) */
export function terminalNotify(title: string, body: string, opts?: FormatNotificationTitleOptions): void {
  // Subagent children don't own a terminal (COMS peers intentionally keep desktop notifications on)
  if (process.env.PI_SUBAGENT_CHILD === "1") return;
  if (notifyAvailable === false) return;

  const formattedTitle = formatNotificationTitle(title, opts);
  if (notifyExecOverride) {
    notifyExecOverride([formattedTitle, body]);
    return;
  }

  const child = execFile("notify-send", [formattedTitle, body], {
    timeout: 2000,
  }, (err) => {
    if (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || /DBus\.Error|not activatable|No session bus/.test(err.message)) {
        notifyAvailable = false;
      } else {
        log.warn("notify_send_failed", { error: err.message });
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

/** Format elapsed milliseconds as compact whole-unit duration (`45s`, `3m12s`, `1h5m`). */
export function formatElapsedDuration(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

export function isRunningInContainer(): boolean {
  try {
    // Check for /.dockerenv (Docker) or /run/.containerenv (Podman)
    if (fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv"))
      return true;
    // Check cgroup for container runtimes (skip read on hosts without /proc, e.g. macOS)
    if (!fs.existsSync("/proc/1/cgroup")) return false;
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf-8");
    if (/docker|containerd|kubepods|libpod/.test(cgroup)) return true;
  } catch (e: any) { log.debug("container detection failed", { error: e?.message || String(e) }); }
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
 *  Delegates to the single canonical resolver in `project-settings.ts`. */
export function resolveRepoRoot(cwd: string): string {
  return resolveMainCheckoutRootCore(cwd);
}

/**
 * Resolve the main checkout root (the repo owning the worktree), or null when
 * `cwd` is not a git repo. Delegates to the single canonical implementation in
 * `project-settings.ts` so settings, memory, and data dirs never drift.
 */
export function tryResolveMainCheckoutRoot(cwd: string): string | null {
  const root = tryResolveMainCheckoutRootCore(cwd);
  if (root === null) {
    log.debug("tryResolveMainCheckoutRoot", { cwd: path.resolve(cwd), reason: "not a repo" });
  }
  return root;
}

/** Main checkout root, or `cwd` itself when not inside a git repo. */
export function resolveMainCheckoutRoot(cwd: string): string {
  return resolveMainCheckoutRootCore(cwd);
}

/**
 * Main checkout root for a worktree, or null when `root` is not a linked
 * worktree.
 *
 * Filesystem only, no git subprocess: read `<root>/.git` — a directory means
 * this IS the main checkout (null), a `gitdir:` pointer into
 * `<main>/.git/worktrees/<name>` means read that dir's `commondir` and return
 * the main checkout. Submodule gitdirs (`.git/modules/*`) are rejected, and
 * anything unreadable falls back to null.
 */
export function mainCheckoutRoot(root: string): string | null {
  const dotGit = path.join(root, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    log.debug("mainCheckoutRoot", { root, reason: "no .git" });
    return null;
  }
  if (stat.isDirectory()) return null;
  let pointer: string | null = null;
  try {
    pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf-8"))?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
  if (!pointer) return null;
  const gitdir = path.resolve(root, pointer);
  if (gitdir.split(path.sep).join("/").includes("/.git/modules/")) return null;
  // A linked worktree's gitdir holds `commondir` (usually `../..`) pointing at
  // `<main>/.git`; the main checkout is its parent.
  try {
    const common = fs.readFileSync(path.join(gitdir, "commondir"), "utf-8").trim();
    if (!common) return null;
    const main = path.dirname(path.resolve(gitdir, common));
    log.debug("mainCheckoutRoot", { root, main });
    return main;
  } catch {
    log.debug("mainCheckoutRoot", { root, reason: "no commondir" });
    return null;
  }
}

/** Resolve to the current worktree root (or repo root if not in a worktree).
 *  Uses --show-toplevel → returns THIS worktree's root, not the shared repo root.
 *  Use for per-worktree resources: pi-config-review-state.jsonl.
 *  For non-worktree repos, returns the same as resolveRepoRoot.
 *  @param cwd — Directory to resolve from (any path inside the worktree)
 *  @returns The worktree's top-level directory, or `cwd` as fallback */
const worktreeRootCache = new Map<string, string>();

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
 *  Pure throwaway — everything in it is deletable by construction. Runtime
 *  state that a live daemon owns belongs in getProjectRunDir (issue #1020).
 *  Deliberately NOT worktree-aware: pidiff runs one server per cwd — sharing
 *  that across worktrees would collide (issue #918: tmp stays per-cwd). */
export function getProjectTmpDir(cwd: string): string {
  const dir = path.join(cwd, ".pi", "tmp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Get project-scoped runtime-state dir under <cwd>/.pi/run/ — pids, ports,
 *  spawn locks and the reload handshake live here because they outlive the
 *  process that wrote them and must never be swept with .pi/tmp (#1020).
 *  Per-cwd for the same reason as getProjectTmpDir (issue #918). */
export function getProjectRunDir(cwd: string): string {
  const dir = path.join(cwd, ".pi", "run");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Pre-`.pi/run` location of the same control files — the read-only fallback
 *  for a daemon or session that started before the upgrade (#1020). New code
 *  writes here only for the two migration shims: the spawn lock a pre-#1020
 *  session is serialised on, and the `reload.done` mirror a pre-#1020
 *  requester polls. */
export function getProjectLegacyRunDir(cwd: string): string {
  return path.join(cwd, ".pi", "tmp");
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
 * 1.7.0: `--agent-dir`, `createAgentSessionServices()` diagnostics,
 * `models.generateImages()` `{ aspectRatio, size }` + Radius catalog,
 * idle RPC `ctx.shutdown()`, and native Pi 1.7 `ExtensionAPI` guarantees
 * (no pre-floor compatibility shims).
 */
export const MIN_PI_VERSION = "1.7.0";

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

function parseSemver(v: string): { core: number[]; pre: string[] } {
  const noBuild = v.split("+")[0];
  const dashIdx = noBuild.indexOf("-");
  const coreStr = dashIdx >= 0 ? noBuild.slice(0, dashIdx) : noBuild;
  const preStr = dashIdx >= 0 ? noBuild.slice(dashIdx + 1) : "";
  return {
    core: coreStr.split(".").map(Number),
    pre: preStr ? preStr.split(".") : [],
  };
}

/** Compare two semver strings per SemVer 2.0.0 precedence. Returns -1 if a < b, 0 if equal, 1 if a > b. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    const na = pa.core[i] || 0;
    const nb = pb.core[i] || 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  for (let i = 0; i < Math.min(pa.pre.length, pb.pre.length); i++) {
    const ia = pa.pre[i];
    const ib = pb.pre[i];
    if (ia === ib) continue;
    const aNum = /^\d+$/.test(ia);
    const bNum = /^\d+$/.test(ib);
    if (aNum && bNum) return Number(ia) < Number(ib) ? -1 : 1;
    if (aNum !== bNum) return aNum ? -1 : 1;
    return ia < ib ? -1 : 1;
  }
  if (pa.pre.length === pb.pre.length) return 0;
  return pa.pre.length < pb.pre.length ? -1 : 1;
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

/** Escape special regular-expression characters in a literal string. */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Sanitize a model ID for use in trailers/signatures. */
export function sanitizeModelId(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/[^a-zA-Z0-9._:@/ -]/g, "").trim() : "";
}

/** Resolve realpath of `target`, or of its nearest existing ancestor rejoined with the tail. */
export function realpathNearestExisting(target: string): string | null {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      const parent = path.dirname(current);
      if (parent === current) {
        log.warn("realpath_unsupported", { target, reason: String((err as Error)?.message ?? err).slice(0, 200) });
        return null;
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}
