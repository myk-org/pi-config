/**
 * Git utility functions for enforcement and status line.
 */

import { execFile, execSync } from "node:child_process";

export function runGit(
  args: string[],
  cwd?: string,
): { stdout: string; code: number } {
  try {
    const stdout = execSync(`git --no-optional-locks ${args.join(" ")}`, {
      cwd,
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
      },
    });
    return { stdout: stdout.trim(), code: 0 };
  } catch (e: any) {
    return { stdout: (e.stdout || "").trim(), code: e.status || 1 };
  }
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

  if (!isGithubRepo(cwd)) {
    protectedBranchesCache.set(repoKey, fallback);
    return fallback;
  }

  // Get owner/repo from remote URL
  const remote = runGit(["remote", "get-url", "origin"], cwd);
  if (remote.code !== 0) {
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
    const out = execSync(
      `gh api repos/${repo}/branches --paginate --jq '.[] | select(.protected==true) | .name'`,
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

export function hasGitSub(command: string, sub: string): boolean {
  return new RegExp(
    `\\bgit\\b(?:\\s+(?:-[a-zA-Z]\\s+\\S+|-\\S+))*\\s+${sub}\\b`,
  ).test(command);
}

export const DANGEROUS = [
  /\brm\s+(?:-[a-zA-Z]+\s+)*(-[a-zA-Z]*r[a-zA-Z]*|--recursive)/i,
  /\bsudo\b/i,
  /\b(chmod|chown)\b.*777/i,
  /\bmkfs\b/i,
  /\bdd\b.*\bof=\/dev\//i,
  /\bgit\b[\s\S]*\breset\b[\s\S]*--hard\b/i,
  /\bgit\b[\s\S]*\bclean\b[\s\S]*(?:--force|-\S*f)/i,
  /\bfind\b[\s\S]*\s-delete\b/i,
  /\bfind\b[\s\S]*-exec(?:dir)?\s+(?:\/\S+\/)?rm\b/i,
  /\bxargs\s+(?:-\S+\s+)*(?:\/\S+\/)?rm\b/i,
  /(?:^|[\s|])(ba|da|z|k|c|tc|fi)?sh\s*$/i,
];
