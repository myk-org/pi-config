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

const MANAGED_VERSION_RE = /^[0-9A-Za-z._+-]+$/;
const VERSIONED_RELEASE_RE = /^(.*\/install)\/releases\/([^/]+)(?:\/|$)/;
const WINDOWS_SCRIPT_EXT_RE = /\.(cmd|bat)$/i;

export interface VersionedReleaseInfo {
  installRoot: string;
  version: string;
  releaseDir: string;
}

export interface ActivePiInstall {
  command: string;
  realPath: string;
  installRoot?: string;
  releaseDir?: string;
}

export interface ResolveActivePiOptions {
  expectedInstallRoot?: string;
  platform?: NodeJS.Platform;
}

export interface PiInvocationOptions {
  argv1?: string;
  execPath?: string;
  envPath?: string;
  platform?: NodeJS.Platform;
}

function canonicalPath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/** Extract `<installRoot>/releases/<version>` metadata when a path points into a managed Pi release. */
export function extractVersionedReleaseInfo(filePath: string): VersionedReleaseInfo | null {
  const normalized = path.resolve(filePath).replace(/\\/g, "/");
  const match = VERSIONED_RELEASE_RE.exec(normalized);
  if (!match) return null;
  const installRoot = path.resolve(match[1]);
  const version = match[2];
  return {
    installRoot,
    version,
    releaseDir: path.join(installRoot, "releases", version),
  };
}

/** Read `<installRoot>/current-version` and return its existing release directory, if valid. */
export function readManagedCurrentReleaseDir(installRoot: string): string | undefined {
  try {
    const ver = fs.readFileSync(path.join(installRoot, "current-version"), "utf8").trim();
    if (!ver || ver === "." || ver === ".." || !MANAGED_VERSION_RE.test(ver)) return undefined;
    const releaseDir = path.join(installRoot, "releases", ver);
    return fs.existsSync(releaseDir) ? releaseDir : undefined;
  } catch {
    return undefined;
  }
}

function findExecutablesOnPath(
  name: string,
  envPath: string | undefined = process.env.PATH,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (!envPath) return [];
  const delimiter = platform === "win32" ? ";" : ":";
  // Prefer directly spawnable binaries over command scripts on Windows.
  const candidates = platform === "win32"
    ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`]
    : [name];
  const found: string[] = [];
  for (const dir of envPath.split(delimiter)) {
    if (!dir) continue;
    for (const file of candidates) {
      const full = path.join(dir, file);
      try {
        const st = fs.statSync(full);
        if (st.isFile() && (platform === "win32" || (st.mode & 0o111) !== 0)) {
          found.push(full);
          break;
        }
      } catch {
        // Missing or unreadable candidate — keep scanning PATH.
      }
    }
  }
  return found;
}

function inspectPiCandidate(command: string): ActivePiInstall {
  const realPath = canonicalPath(command);

  const directRelease = extractVersionedReleaseInfo(realPath);
  if (directRelease && fs.existsSync(directRelease.releaseDir)) {
    return {
      command,
      realPath,
      installRoot: directRelease.installRoot,
      releaseDir: directRelease.releaseDir,
    };
  }

  // Managed Pi launcher (`<agentDir>/bin/pi` or `pi.cmd`/`pi.exe`) reads `<agentDir>/install/current-version`.
  const siblingInstallRoot = path.join(path.dirname(path.dirname(realPath)), "install");
  const managedReleaseDir = readManagedCurrentReleaseDir(siblingInstallRoot);
  if (managedReleaseDir) {
    return {
      command,
      realPath,
      installRoot: siblingInstallRoot,
      releaseDir: managedReleaseDir,
    };
  }

  return { command, realPath };
}

/**
 * Locate an active `pi` executable on PATH and resolve its real path and managed
 * install metadata. When `expectedInstallRoot` is set, only candidates belonging
 * to that canonical managed install root are returned.
 */
export function resolveActivePiOnPath(
  envPath: string | undefined = process.env.PATH,
  opts?: ResolveActivePiOptions,
): ActivePiInstall | undefined {
  const candidates = findExecutablesOnPath("pi", envPath, opts?.platform);
  if (candidates.length === 0) return undefined;

  if (!opts?.expectedInstallRoot) {
    return inspectPiCandidate(candidates[0]);
  }

  const targetRoot = canonicalPath(opts.expectedInstallRoot);
  for (const command of candidates) {
    const info = inspectPiCandidate(command);
    if (info.installRoot && canonicalPath(info.installRoot) === targetRoot) {
      return info;
    }
  }
  return undefined;
}

function resolveReleaseEntryBin(releaseDir: string, platform: NodeJS.Platform): string | undefined {
  const cliJs = path.join(releaseDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  if (platform === "win32") {
    // On Windows, node_modules/.bin/pi is a POSIX sh shim; only spawn the JS bundle with node/bun.
    return fs.existsSync(cliJs) ? cliJs : undefined;
  }
  const dotBin = path.join(releaseDir, "node_modules", ".bin", "pi");
  return fs.existsSync(dotBin) ? dotBin : (fs.existsSync(cliJs) ? cliJs : undefined);
}

function resolveDirectInvocationForPi(
  pi: ActivePiInstall | undefined,
  execPath: string,
  isJsRuntime: boolean,
  platform: NodeJS.Platform,
  args: string[],
): { command: string; args: string[] } | undefined {
  if (!pi) return undefined;
  if (!(platform === "win32" && WINDOWS_SCRIPT_EXT_RE.test(pi.command))) {
    return { command: pi.command, args };
  }
  // Never spawn Windows .cmd/.bat directly (EINVAL with shell: false) or via cmd.exe
  // (task prompts carry arbitrary quotes/metacharacters). Resolve its JS bundle instead.
  if (!isJsRuntime) return undefined;
  const searchRoots = [
    ...(pi.releaseDir ? [pi.releaseDir] : []),
    path.dirname(pi.realPath),
    path.dirname(pi.command),
  ];
  for (const root of searchRoots) {
    const cliJs = resolveReleaseEntryBin(root, platform);
    if (cliJs) return { command: execPath, args: [cliJs, ...args] };
  }
  return undefined;
}

export function getPiInvocation(args: string[], opts?: PiInvocationOptions): { command: string; args: string[] } {
  const s = opts?.argv1 !== undefined ? opts.argv1 : process.argv[1];
  const execPath = opts?.execPath ?? process.execPath;
  const envPath = opts && "envPath" in opts ? opts.envPath : process.env.PATH;
  const platform = opts?.platform ?? process.platform;

  const execBase = (platform === "win32" ? path.win32 : path.posix).basename(execPath).toLowerCase();
  const isJsRuntime = /^(node(?:js|[-.]?\d+(?:\.\d+)*)?|bun)(\.exe)?$/.test(execBase);

  if (s) {
    const exists = fs.existsSync(s);
    const releaseInfo = extractVersionedReleaseInfo(s)
      ?? (exists ? extractVersionedReleaseInfo(canonicalPath(s)) : null);

    if (releaseInfo) {
      const ownCurrentReleaseDir = readManagedCurrentReleaseDir(releaseInfo.installRoot);
      const matchingPi = resolveActivePiOnPath(envPath, {
        expectedInstallRoot: releaseInfo.installRoot,
        platform,
      });
      const activeReleaseDir = ownCurrentReleaseDir ?? matchingPi?.releaseDir;

      const fallbackForRelease = (
        reason: "pruned_release" | "superseded_release",
      ): { command: string; args: string[] } => {
        const matchingLauncherValid = matchingPi && (
          !activeReleaseDir
          || !matchingPi.releaseDir
          || canonicalPath(matchingPi.releaseDir) === canonicalPath(activeReleaseDir)
        );

        // 1. Prefer a directly spawnable PATH launcher (or its JS bundle on Windows)
        //    verified to belong to this managed install.
        if (matchingLauncherValid) {
          const direct = resolveDirectInvocationForPi(matchingPi, execPath, isJsRuntime, platform, args);
          if (direct) {
            log.warn("pi_invocation_release_fallback", {
              reason,
              argv1: s,
              releaseDir: releaseInfo.releaseDir,
              activeReleaseDir,
              fallback: direct.command === execPath ? direct.args[0] : direct.command,
            });
            return direct;
          }
        }

        // 2. Prefer this managed install's own current-version entry under node/bun
        //    over any unrelated pi earlier on PATH.
        if (activeReleaseDir && isJsRuntime) {
          const releaseBin = resolveReleaseEntryBin(activeReleaseDir, platform);
          if (releaseBin) {
            log.warn("pi_invocation_release_fallback", {
              reason,
              argv1: s,
              releaseDir: releaseInfo.releaseDir,
              activeReleaseDir,
              fallback: releaseBin,
            });
            return { command: execPath, args: [releaseBin, ...args] };
          }
        }

        // 3. Last resort when this install has no valid current-version release:
        //    pick a directly spawnable pi (or its JS bundle on Windows) from PATH,
        //    never delegating to cmd.exe with untrusted task arguments.
        let inv: { command: string; args: string[] } | undefined;
        for (const candidate of findExecutablesOnPath("pi", envPath, platform)) {
          inv = resolveDirectInvocationForPi(inspectPiCandidate(candidate), execPath, isJsRuntime, platform, args);
          if (inv) break;
        }
        const resolved = inv ?? { command: "pi", args };
        log.warn("pi_invocation_release_fallback", {
          reason,
          argv1: s,
          releaseDir: releaseInfo.releaseDir,
          activeReleaseDir,
          fallback: resolved.command === execPath ? resolved.args[0] : resolved.command,
        });
        return resolved;
      };

      if (!exists || !fs.existsSync(releaseInfo.releaseDir)) {
        return fallbackForRelease("pruned_release");
      }
      if (activeReleaseDir && canonicalPath(activeReleaseDir) !== canonicalPath(releaseInfo.releaseDir)) {
        return fallbackForRelease("superseded_release");
      }
      return { command: execPath, args: [s, ...args] };
    }

    if (exists) {
      return { command: execPath, args: [s, ...args] };
    }
  }

  if (!isJsRuntime)
    return { command: execPath, args };
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

export {
  MIN_PI_VERSION,
  assertMinPiVersionOnLoad,
  checkMinPiVersion,
  compareSemver,
  formatMinPiVersionError,
  getPiVersion,
  resetPiVersionCache,
  setPiVersionResolverForTests,
  type PiVersionCheckResult,
  type PiVersionDetectionOptions,
} from "../shared/pi-version.js";

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
