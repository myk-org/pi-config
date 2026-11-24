/**
 * Git utility functions for enforcement and status line.
 */

import { execFile, execFileSync, execSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createLogger } from "../shared/logger.js";

const gitLog = createLogger("git-helpers");

export function runGit(
  args: string[],
  cwd?: string,
  input?: string,
): { stdout: string; code: number } {
  try {
    const stdout = execFileSync("git", ["--no-optional-locks", ...args], {
      cwd,
      input,
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
      },
    });
    return { stdout: stdout.trimEnd(), code: 0 };
  } catch (e: any) {
    const rawOut = typeof e?.stdout === "string"
      ? e.stdout
      : Buffer.isBuffer(e?.stdout)
        ? e.stdout.toString("utf-8")
        : "";
    return { stdout: rawOut.trimEnd(), code: e?.status || 1 };
  }
}

export type GitAsyncResult = { stdout: string; stderr?: string; code: number };
export type GitAsyncRunner = (args: string[], cwd?: string) => Promise<GitAsyncResult>;

/** Async `git --no-optional-locks` runner (non-interactive, 5s timeout). */
export function runGitAsync(args: string[], cwd?: string): Promise<GitAsyncResult> {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      ["--no-optional-locks", ...args],
      {
        cwd,
        timeout: 5000,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "Never",
        },
      },
      (err, stdout, stderr) => {
        const out = (typeof stdout === "string" ? stdout : "").trimEnd();
        const errOut = (typeof stderr === "string" ? stderr : "").trimEnd();
        if (err) {
          const exitCode = typeof (err as any).code === "number" ? (err as any).code : 1;
          resolvePromise({ stdout: out, stderr: errOut, code: exitCode });
        } else {
          resolvePromise({ stdout: out, stderr: errOut, code: 0 });
        }
      },
    );
  });
}

// ── Worktree helpers ────────────────────────────────────────────────────────

export interface WorktreeDirtySummary {
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
  total: number;
}

export interface WorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  isMain: boolean;
  isCurrent: boolean;
  locked: boolean;
  lockedReason?: string;
  prunable: boolean;
  prunableReason?: string;
  dirty?: WorktreeDirtySummary;
}

export interface ListWorktreesOptions {
  /** Include dirty file counts per non-bare, non-prunable worktree (default false). */
  includeDirty?: boolean;
  /** Bypass TTL cache and run `git worktree list --porcelain` immediately. */
  forceRefresh?: boolean;
  /** Cache TTL in milliseconds (default 5000). */
  ttlMs?: number;
  /** Override async git runner (used by status-line and unit tests). */
  runGitAsync?: GitAsyncRunner;
}

/** Normalize a filesystem path for prefix comparisons, resolving symlinks when present. */
export function normalizePathForMatch(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Match `targetPath` to the most specific (longest-prefix) worktree containing it. */
export function matchPathToWorktrees<T extends { path: string }>(
  targetPath: string | null | undefined,
  worktrees: readonly T[],
): T | null {
  if (!targetPath || worktrees.length === 0) return null;
  const normTarget = normalizePathForMatch(targetPath);
  let best: T | null = null;
  let bestLen = -1;
  for (const wt of worktrees) {
    const normWt = normalizePathForMatch(wt.path);
    const prefix = normWt.endsWith(sep) ? normWt : `${normWt}${sep}`;
    if (normTarget === normWt || normTarget.startsWith(prefix)) {
      if (normWt.length > bestLen) {
        best = wt;
        bestLen = normWt.length;
      }
    }
  }
  return best;
}

/** Parse `git status --porcelain` output into dirty counters. */
export function parseGitStatusPorcelain(stdout: string): WorktreeDirtySummary {
  let modified = 0;
  let added = 0;
  let deleted = 0;
  let untracked = 0;
  let total = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    total++;
    const xy = line.slice(0, 2);
    if (xy.includes("?")) untracked++;
    else if (xy.includes("D")) deleted++;
    else if (xy.includes("A")) added++;
    else if (xy.includes("M") || xy.includes("R") || xy.includes("C")) modified++;
    else modified++;
  }
  return { modified, added, deleted, untracked, total };
}

/** Parse `git worktree list --porcelain` stdout into structured entries. */
export function parseWorktreePorcelain(raw: string, cwd?: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | null = null;

  const flush = () => {
    if (!current?.path) return;
    entries.push({
      path: current.path,
      head: current.head ?? "",
      branch: current.branch ?? null,
      detached: current.detached ?? false,
      bare: current.bare ?? false,
      isMain: entries.length === 0,
      isCurrent: false,
      locked: current.locked ?? false,
      ...(current.lockedReason ? { lockedReason: current.lockedReason } : {}),
      prunable: current.prunable ?? false,
      ...(current.prunableReason ? { prunableReason: current.prunableReason } : {}),
    });
    current = null;
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length).trim() };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line === "detached") {
      current.detached = true;
      current.branch = null;
    } else if (line === "bare") {
      current.bare = true;
      current.branch = null;
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
      const reason = line.slice("locked".length).trim();
      if (reason) current.lockedReason = reason;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      current.prunable = true;
      const reason = line.slice("prunable".length).trim();
      if (reason) current.prunableReason = reason;
    }
  }
  flush();

  if (cwd && entries.length > 0) {
    const matched = matchPathToWorktrees(cwd, entries);
    if (matched) matched.isCurrent = true;
  }

  return entries;
}

const WORKTREE_TTL_MS = 5_000;
const WORKTREE_CACHE_MAX = 50;

type WorktreeCacheEntry = { at: number; entries: WorktreeEntry[] };
const worktreeCache = new Map<string, WorktreeCacheEntry>();
const worktreeInFlight = new Map<string, Promise<WorktreeEntry[]>>();
const worktreeGen = new Map<string, number>();
const runnerWorktreeCaches = new WeakMap<GitAsyncRunner, Map<string, WorktreeCacheEntry>>();
const runnerWorktreeInFlight = new WeakMap<GitAsyncRunner, Map<string, Promise<WorktreeEntry[]>>>();
const runnerWorktreeGen = new WeakMap<GitAsyncRunner, Map<string, number>>();

function getWorktreeCacheStore(runner?: GitAsyncRunner): {
  cache: Map<string, WorktreeCacheEntry>;
  inFlight: Map<string, Promise<WorktreeEntry[]>>;
  gen: Map<string, number>;
} {
  if (!runner || runner === runGitAsync) {
    return { cache: worktreeCache, inFlight: worktreeInFlight, gen: worktreeGen };
  }
  let cache = runnerWorktreeCaches.get(runner);
  if (!cache) {
    cache = new Map();
    runnerWorktreeCaches.set(runner, cache);
  }
  let inFlight = runnerWorktreeInFlight.get(runner);
  if (!inFlight) {
    inFlight = new Map();
    runnerWorktreeInFlight.set(runner, inFlight);
  }
  let gen = runnerWorktreeGen.get(runner);
  if (!gen) {
    gen = new Map();
    runnerWorktreeGen.set(runner, gen);
  }
  return { cache, inFlight, gen };
}

function worktreeCacheKey(cwd?: string): string {
  return resolve(cwd || process.cwd());
}

/**
 * Fast filesystem check for linked worktrees without spawning git.
 * Returns `true` when `.git` is a file (linked worktree) or `.git/worktrees` is non-empty,
 * `false` when `.git` is a directory with no/empty `worktrees/` (single checkout),
 * or `null` when indeterminate (e.g. `GIT_DIR` override, path not on disk, or I/O error).
 */
export function detectWorktreePresence(cwd: string): boolean | null {
  if (!cwd || process.env.GIT_DIR || process.env.GIT_WORK_TREE) return null;
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, ".git");
    try {
      const st = lstatSync(dotGit);
      if (st.isFile()) return true;
      if (st.isDirectory()) {
        try {
          return readdirSync(join(dotGit, "worktrees")).length > 0;
        } catch (e: any) {
          if (e?.code === "ENOENT") return false;
          return null;
        }
      }
      return null;
    } catch (e: any) {
      if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Invalidate cached worktree listings for `cwd` (or all cached repos when omitted). */
export function invalidateWorktreeCache(cwd?: string): void {
  const bumpGen = (k: string) => {
    worktreeGen.set(k, (worktreeGen.get(k) ?? 0) + 1);
  };
  if (!cwd) {
    for (const k of worktreeCache.keys()) bumpGen(k);
    for (const k of worktreeInFlight.keys()) bumpGen(k);
    worktreeCache.clear();
    worktreeInFlight.clear();
    return;
  }
  const key = worktreeCacheKey(cwd);
  bumpGen(key);
  worktreeCache.delete(key);
  worktreeInFlight.delete(key);
  // Also invalidate any sibling worktree keys that belong to the same repo
  const norm = normalizePathForMatch(cwd);
  for (const [cachedKey, entry] of worktreeCache) {
    if (entry.entries.some((wt) => normalizePathForMatch(wt.path) === norm)) {
      bumpGen(cachedKey);
      worktreeCache.delete(cachedKey);
      worktreeInFlight.delete(cachedKey);
    }
  }
}

/** True when `cwd` resolved to a linked (non-main) worktree. */
export function isInLinkedWorktree(worktrees: readonly WorktreeEntry[]): boolean {
  return worktrees.some((wt) => wt.isCurrent && !wt.isMain);
}

/** Number of linked (non-main) worktrees in a listing. */
export function countLinkedWorktrees(worktrees: readonly WorktreeEntry[]): number {
  let count = 0;
  for (const wt of worktrees) {
    if (!wt.isMain) count++;
  }
  return count;
}

/**
 * List git worktrees via `git worktree list --porcelain` with a short TTL cache.
 * Shared by status-line, `/worktree`, `/status`, and `/review-status` autocomplete.
 */
export async function listWorktreesAsync(
  cwd?: string,
  opts: ListWorktreesOptions = {},
): Promise<WorktreeEntry[]> {
  const runner = opts.runGitAsync ?? runGitAsync;
  const ttlMs = opts.ttlMs ?? WORKTREE_TTL_MS;
  const effectiveCwd = cwd || process.cwd();
  const key = worktreeCacheKey(effectiveCwd);
  const { cache, inFlight, gen } = getWorktreeCacheStore(runner);

  const loadBase = async (): Promise<WorktreeEntry[]> => {
    const now = Date.now();
    if (!opts.forceRefresh) {
      const cached = cache.get(key);
      if (cached && now - cached.at < ttlMs) {
        return cached.entries.map((e) => ({ ...e }));
      }
      const pending = inFlight.get(key);
      if (pending) {
        const res = await pending;
        return res.map((e) => ({ ...e }));
      }
    }

    const myGen = (gen.get(key) ?? 0) + 1;
    gen.set(key, myGen);

    let promise!: Promise<WorktreeEntry[]>;
    promise = (async (): Promise<WorktreeEntry[]> => {
      try {
        const r = await runner(["worktree", "list", "--porcelain"], effectiveCwd);
        if (r.code !== 0) return [];
        const parsed = r.stdout ? parseWorktreePorcelain(r.stdout, effectiveCwd) : [];
        if (gen.get(key) === myGen) {
          cache.delete(key);
          cache.set(key, { at: Date.now(), entries: parsed });
          while (cache.size > WORKTREE_CACHE_MAX) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
          }
        }
        return parsed;
      } catch (e: any) {
        gitLog.debug("worktree_list_failed", { cwd: effectiveCwd, error: e?.message || String(e) });
        return [];
      }
    })().finally(() => {
      if (inFlight.get(key) === promise) {
        inFlight.delete(key);
      }
    });

    inFlight.set(key, promise);
    const entries = await promise;
    return entries.map((e) => ({ ...e }));
  };

  const entries = await loadBase();
  if (!opts.includeDirty || entries.length === 0) {
    return entries;
  }

  await Promise.all(
    entries.map(async (wt) => {
      if (wt.bare || wt.prunable) return;
      try {
        const st = await runner(["status", "--porcelain"], wt.path);
        if (st.code === 0) {
          wt.dirty = parseGitStatusPorcelain(st.stdout);
        }
      } catch (e: any) {
        gitLog.debug("worktree_dirty_check_failed", { path: wt.path, error: e?.message || String(e) });
      }
    }),
  );

  return entries;
}

export function getCurrentBranch(cwd?: string): string | null {
  const r = runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (r.code === 0 && r.stdout && r.stdout !== "HEAD") return r.stdout;
  const s = runGit(["symbolic-ref", "HEAD"], cwd);
  if (s.code === 0 && s.stdout.startsWith("refs/heads/"))
    return s.stdout.slice("refs/heads/".length);
  return null;
}

export function getMainBranch(cwd?: string): string | null {
  for (const b of ["main", "master"])
    if (
      runGit(["rev-parse", "--verify", "--end-of-options", b], cwd).code === 0
    )
      return b;
  return null;
}

export function isGitRepo(cwd?: string): boolean {
  return runGit(["rev-parse", "--git-dir"], cwd).code === 0;
}

export function isGithubRepo(cwd?: string): boolean {
  const r = runGit(["remote", "get-url", "origin"], cwd);
  return r.code === 0 && r.stdout.toLowerCase().includes("github.com");
}

export function getHeadSha(cwd?: string): string | null {
  const r = runGit(["rev-parse", "HEAD"], cwd);
  return r.code === 0 && r.stdout ? r.stdout.trim() : null;
}

export function getOriginUrl(cwd?: string): string | null {
  const r = runGit(["remote", "get-url", "origin"], cwd);
  return r.code === 0 && r.stdout ? r.stdout.trim() : null;
}

/** Parse `{ owner, repo }` from a git remote URL (https, ssh://, git://, or SCP-like).
 *  When `githubOnly` is true, only `github.com` hosts match. */
export function parseRemoteRepo(
  remoteUrl: string | null | undefined,
  options?: { githubOnly?: boolean },
): { owner: string; repo: string } | null {
  if (typeof remoteUrl !== "string") return null;
  let url = remoteUrl.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!url) return null;
  // SCP-like: [user@]host:owner/repo (skip scheme URLs containing "://")
  if (!url.includes("://")) {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(url);
    if (scp) url = `https://${scp[1]}/${scp[2]}`;
  }
  const urlMatch = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?([^/\s]+)\/(.+)$/.exec(url);
  if (!urlMatch) return null;
  const host = urlMatch[1]!.replace(/:\d+$/, "").toLowerCase();
  if (options?.githubOnly && host !== "github.com") return null;
  const segments = urlMatch[2]!.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const repo = segments.pop()!;
  const owner = segments.pop()!;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo };
}

export function isBranchMerged(branch: string, main: string, cwd?: string): boolean {
  const u = runGit(["rev-list", "--count", `${main}..${branch}`], cwd);
  if (u.code !== 0) return false;
  const n = parseInt(u.stdout, 10);
  if (isNaN(n) || n === 0) return false;
  return runGit(["merge-base", "--is-ancestor", branch, main], cwd).code === 0;
}

export function isBranchAhead(cwd?: string): boolean {
  if (
    runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd)
      .code !== 0
  )
    return true;
  const s = runGit(["status", "--short", "--branch"], cwd);
  return s.code === 0 && s.stdout.includes("ahead");
}

export function getPrMergeStatus(
  branch: string,
  cwd?: string,
): { merged: boolean | null; info: string | null } {
  if (!isGithubRepo(cwd)) return { merged: false, info: null };
  try {
    const out = execSync(
      `gh pr list --head "${branch}" --state merged --json number --limit 1`,
      {
        cwd,
        timeout: 5000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const data = JSON.parse(out);
    if (Array.isArray(data) && data.length > 0)
      return { merged: true, info: String(data[0].number || "") };
    return { merged: false, info: null };
  } catch {
    return { merged: null, info: "Could not check PR status" };
  }
}

export type OpenPr = { number: number; url: string };

const OPEN_PR_TTL_MS = 30_000;
const OPEN_PR_CACHE_MAX = 50;
const SAFE_PR_URL = /^https:\/\/[^\x00-\x1f]+$/;

type OpenPrCacheEntry = { at: number; pr: OpenPr | null };
const openPrCache = new Map<string, OpenPrCacheEntry>();
const openPrInFlight = new Map<string, Promise<OpenPr | null>>();
/** Keys with an active scheduleOpenPrStatusRefresh .then subscription. */
const openPrSchedulePending = new Set<string>();

type GhPrViewRunner = (cwd?: string) => Promise<string>;

const defaultGhPrView: GhPrViewRunner = (cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "gh",
      ["pr", "view", "--json", "number,url,state"],
      { cwd, timeout: 5000, encoding: "utf-8", maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(typeof stdout === "string" ? stdout : String(stdout));
      },
    );
  });

let ghPrViewRunner: GhPrViewRunner = defaultGhPrView;

/** Override `gh pr view` runner (tests). Pass null to restore default. */
export function setGhPrViewRunner(runner: GhPrViewRunner | null): void {
  ghPrViewRunner = runner ?? defaultGhPrView;
}

/** Parse `gh pr view --json number,url,state` output (OPEN only). */
export function parseOpenPrJson(out: string): OpenPr | null {
  try {
    const data = JSON.parse(out);
    if (
      data &&
      Number.isInteger(data.number) &&
      data.number > 0 &&
      typeof data.url === "string" &&
      SAFE_PR_URL.test(data.url) &&
      data.state === "OPEN"
    ) {
      return { number: data.number, url: data.url };
    }
  } catch {
    // invalid JSON
  }
  return null;
}

/** Clear open-PR cache and in-flight lookups (tests). */
export function clearOpenPrCache(): void {
  openPrCache.clear();
  openPrInFlight.clear();
  openPrSchedulePending.clear();
}

/** Seed cache entry (tests) — use past `at` to exercise TTL / SWR. */
export function seedOpenPrCacheForTests(
  cwd: string,
  branch: string,
  entry: { at: number; pr: OpenPr | null },
): void {
  openPrCache.set(openPrCacheKey(cwd, branch), entry);
}

/** Evict oldest keys when over max size (LRU via touch-on-hit). */
function enforceOpenPrCacheMax(): void {
  while (openPrCache.size > OPEN_PR_CACHE_MAX) {
    const oldest = openPrCache.keys().next().value;
    if (oldest === undefined) break;
    openPrCache.delete(oldest);
  }
}

function openPrCacheKey(cwd: string | undefined, branch: string): string {
  return `${cwd || process.cwd()}:${branch}`;
}

function touchOpenPrCache(key: string, entry: OpenPrCacheEntry): void {
  openPrCache.delete(key);
  openPrCache.set(key, entry);
  enforceOpenPrCacheMax();
}

/**
 * Cached open PR only — never calls `gh`.
 * Returns stale entries past TTL (stale-while-revalidate); kick
 * {@link refreshOpenPr} to refresh asynchronously.
 * Pass `assumeGithub: true` when the caller already verified the remote.
 */
export function getOpenPr(
  cwd?: string,
  branch?: string | null,
  opts?: { assumeGithub?: boolean },
): OpenPr | null {
  const b = branch ?? getCurrentBranch(cwd);
  if (!b) return null;
  if (!opts?.assumeGithub && !isGithubRepo(cwd)) return null;

  const key = openPrCacheKey(cwd, b);
  const cached = openPrCache.get(key);
  if (!cached) return null;
  // Touch for LRU even on stale hits so hot keys survive eviction.
  touchOpenPrCache(key, cached);
  return cached.pr;
}

/**
 * Async `gh pr view` for the current (or given) branch.
 * Coalesces in-flight lookups per cwd+branch; caches result for 30s.
 * Status-line callers must use {@link getOpenPr} synchronously and only
 * await this to refresh — never block the update path on `gh`.
 * Pass `assumeGithub: true` when the caller already verified the remote.
 */
export function refreshOpenPr(
  cwd?: string,
  branch?: string | null,
  opts?: { assumeGithub?: boolean },
): Promise<OpenPr | null> {
  const b = branch ?? getCurrentBranch(cwd);
  if (!b) return Promise.resolve(null);
  if (!opts?.assumeGithub && !isGithubRepo(cwd)) return Promise.resolve(null);

  const now = Date.now();
  const key = openPrCacheKey(cwd, b);
  const cached = openPrCache.get(key);
  if (cached && now - cached.at < OPEN_PR_TTL_MS) {
    touchOpenPrCache(key, cached);
    return Promise.resolve(cached.pr);
  }

  const inflight = openPrInFlight.get(key);
  if (inflight) return inflight;

  const pending = (async (): Promise<OpenPr | null> => {
    let pr: OpenPr | null = null;
    try {
      const out = await ghPrViewRunner(cwd);
      pr = parseOpenPrJson(out.trim());
    } catch {
      pr = null;
    }
    touchOpenPrCache(key, { at: Date.now(), pr });
    return pr;
  })().finally(() => {
    openPrInFlight.delete(key);
  });

  openPrInFlight.set(key, pending);
  return pending;
}

/** True when an async open-PR refresh still matches the active cwd/branch. */
export function shouldApplyOpenPrRefresh(
  lastCtx: { cwd?: string } | null,
  lastBranch: string | null,
  refreshKey: string,
): boolean {
  if (!lastCtx || lastBranch == null) return false;
  return `${lastCtx.cwd || ""}:${lastBranch}` === refreshKey;
}

export type OpenPrRefreshDecision = "skip" | "rerender";

/** Decide whether a finished refresh should re-run the status-line update. */
export function decideOpenPrRefreshRerender(args: {
  lastCtx: { cwd?: string } | null;
  lastBranch: string | null;
  refreshKey: string;
  shownKey: string;
  fresh: OpenPr | null;
}): OpenPrRefreshDecision {
  if (
    !shouldApplyOpenPrRefresh(args.lastCtx, args.lastBranch, args.refreshKey)
  ) {
    return "skip";
  }
  const freshKey = args.fresh
    ? `${args.fresh.number}\0${args.fresh.url}`
    : "";
  if (freshKey === args.shownKey) return "skip";
  return "rerender";
}

/**
 * Status-line open-PR refresh callback wiring (no TUI deps).
 * Schedules refreshOpenPr and optionally re-renders when the result applies.
 */
export function scheduleOpenPrStatusRefresh(opts: {
  cwd?: string;
  branch: string;
  shownPr: OpenPr | null;
  getState: () => {
    lastCtx: { cwd?: string } | null;
    lastBranch: string | null;
  };
  onRerender: (ctx: { cwd?: string }) => void;
  assumeGithub?: boolean;
  refresh?: typeof refreshOpenPr;
}): void {
  const refreshKey = `${opts.cwd || ""}:${opts.branch}`;
  // One .then per in-flight key — refreshOpenPr coalesces Promises but
  // repeated schedule calls would otherwise all fire onRerender.
  if (openPrSchedulePending.has(refreshKey)) return;
  openPrSchedulePending.add(refreshKey);

  const shownKey = opts.shownPr
    ? `${opts.shownPr.number}\0${opts.shownPr.url}`
    : "";
  const refresh = opts.refresh ?? refreshOpenPr;
  try {
    void refresh(opts.cwd, opts.branch, {
      assumeGithub: opts.assumeGithub,
    })
      .then((fresh) => {
        const { lastCtx, lastBranch } = opts.getState();
        if (
          decideOpenPrRefreshRerender({
            lastCtx,
            lastBranch,
            refreshKey,
            shownKey,
            fresh,
          }) !== "rerender"
        ) {
          return;
        }
        if (!lastCtx) return;
        try {
          opts.onRerender(lastCtx);
        } catch (e: any) {
          console.debug(
            "[status-line] open-PR refresh update failed:",
            e?.message || e,
          );
        }
      })
      .finally(() => {
        openPrSchedulePending.delete(refreshKey);
      })
      .catch((e: any) => {
        console.debug(
          "[status-line] open-PR refresh failed:",
          refreshKey,
          e?.message || e,
        );
      });
  } catch {
    openPrSchedulePending.delete(refreshKey);
  }
}

// Cache protected branches per repo (fetched once per session)
const protectedBranchesCache = new Map<string, Set<string>>();

export function getProtectedBranches(cwd?: string): Set<string> {
  const repoKey = cwd || process.cwd();
  if (protectedBranchesCache.has(repoKey)) return protectedBranchesCache.get(repoKey)!;

  const fallback = new Set(["main", "master"]);

  // Single git call for remote URL instead of calling isGithubRepo() + runGit()
  const remote = runGit(["remote", "get-url", "origin"], cwd);
  if (remote.code !== 0 || !remote.stdout.toLowerCase().includes("github.com")) {
    protectedBranchesCache.set(repoKey, fallback);
    return fallback;
  }

  const match = remote.stdout.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  if (!match) {
    protectedBranchesCache.set(repoKey, fallback);
    return fallback;
  }

  const repo = match[1];
  try {
    const out = execFileSync(
      "gh",
      ["api", `repos/${repo}/branches`, "--paginate", "--jq", ".[] | select(.protected==true) | .name"],
      { cwd, timeout: 10000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const branches = new Set(
      out.split("\n").map((b) => b.trim()).filter(Boolean),
    );
    // Always include main/master as fallback
    branches.add("main");
    branches.add("master");
    protectedBranchesCache.set(repoKey, branches);
    return branches;
  } catch {
    protectedBranchesCache.set(repoKey, fallback);
    return fallback;
  }
}

/**
 * Files with an unmerged index entry (merge/rebase/cherry-pick in progress).
 *
 * `ok` distinguishes "the index is clean" from "git would not answer". Callers
 * enforcing a block must fail closed on `ok: false` — treating an unreadable
 * index as an empty one turns a broken check into a silent pass.
 */
/**
 * Is this directory inside a git work tree at all? Distinguishes "no repository
 * yet" — `git init && git add -A`, a fresh clone — from "a repository whose
 * index cannot be read", which is the case worth failing closed on.
 */
export function isInsideGitWorkTree(cwd?: string): boolean {
  const r = runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  gitLog.debug("inside_work_tree", "code", r.code);
  return r.code === 0 && r.stdout.trim() === "true";
}

export function listUnmergedFiles(cwd?: string): { ok: boolean; files: string[] } {
  // `-- :/` is the whole repository, and `--full-name` makes the paths
  // repo-relative. Without them git lists only what is under the current
  // directory, so `git add ../a.txt` from a subdirectory would read as clean
  // while staging a conflict higher up.
  const r = runGit(["ls-files", "--unmerged", "--full-name", "--", ":/"], cwd);
  if (r.code !== 0) {
    // warn, not debug: this is the check failing, and it gates a block.
    gitLog.warn("unmerged_lookup_failed", "code", r.code, "repo", Boolean(cwd));
    return { ok: false, files: [] };
  }
  const files = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    // <mode> <sha> <stage>\t<path>
    const path = line.slice(line.indexOf("\t") + 1).trim();
    if (path) files.add(path);
  }
  gitLog.debug("unmerged_lookup", "count", files.size);
  return { ok: true, files: [...files] };
}
