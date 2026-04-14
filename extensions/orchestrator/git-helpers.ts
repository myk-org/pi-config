/**
 * Git utility functions for enforcement and status line.
 */

import { execSync } from "node:child_process";

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
  /\brm\s+(-rf?|--recursive)/i,
  /\bsudo\b/i,
  /\b(chmod|chown)\b.*777/i,
  /\bmkfs\b/i,
  /\bdd\b.*\bof=\/dev\//i,
];
