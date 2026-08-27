/**
 * Regression tests for the merged-branch guard documented in git-expert.
 * Run with: npx tsx --test tests/node/orchestrator/git-expert-merged-branch-guard.test.ts
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  GIT_DIR: _GIT_DIR,
  GIT_WORK_TREE: _GIT_WORK_TREE,
  GIT_INDEX_FILE: _GIT_INDEX_FILE,
  GIT_COMMON_DIR: _GIT_COMMON_DIR,
  GIT_CEILING_DIRECTORIES: _GIT_CEILING_DIRECTORIES,
  ...baseEnv
} = process.env;

const GIT_ENV = {
  ...baseEnv,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const repos: string[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", env: GIT_ENV }).trim();
}

function createRepo(defaultBranch: string): string {
  const repo = mkdtempSync(join(tmpdir(), "git-expert-guard-"));
  repos.push(repo);
  git(repo, ["init", "-b", defaultBranch]);
  git(repo, ["commit", "--allow-empty", "-m", "initial"]);
  git(repo, ["remote", "add", "origin", "https://example.test/repo.git"]);
  return repo;
}

function setRemoteRef(repo: string, branch: string, revision: string): void {
  git(repo, ["update-ref", `refs/remotes/origin/${branch}`, revision]);
}

function setRemoteDefault(repo: string, branch: string): void {
  git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`]);
}

function mergedBranchGuard(): string {
  const agent = readFileSync(join(process.cwd(), "agents/git-expert.md"), "utf8");
  const match = agent.match(/```bash\n\s+(current_branch=[\s\S]*?)\n\s*```/);
  assert.ok(match, "git-expert must document an executable merged-branch guard");
  return match[1];
}

function runGuard(repo: string): ReturnType<typeof spawnSync> {
  return spawnSync("bash", ["-c", mergedBranchGuard()], {
    cwd: repo,
    encoding: "utf8",
    env: GIT_ENV,
  });
}

describe("git-expert merged-branch guard", () => {
  it("allows a fresh pushed branch whose remote tip equals the default tip", () => {
    const repo = createRepo("main");
    const tip = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "-b", "feature/fresh"]);
    setRemoteRef(repo, "main", tip);
    setRemoteRef(repo, "feature/fresh", tip);
    setRemoteDefault(repo, "main");

    const result = runGuard(repo);

    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  it("uses a non-main default branch from origin HEAD", () => {
    const repo = createRepo("trunk");
    const trunkTip = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "-b", "main"]);
    git(repo, ["commit", "--allow-empty", "-m", "main-only"]);
    const mainTip = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "-b", "feature/on-trunk", trunkTip]);
    setRemoteRef(repo, "trunk", trunkTip);
    setRemoteRef(repo, "main", mainTip);
    setRemoteRef(repo, "feature/on-trunk", trunkTip);
    setRemoteDefault(repo, "trunk");

    const result = runGuard(repo);

    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  it("blocks a distinct remote feature tip that is merged into the default branch", () => {
    const repo = createRepo("main");
    const featureTip = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["commit", "--allow-empty", "-m", "main advance"]);
    const mainTip = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "-b", "feature/merged", featureTip]);
    setRemoteRef(repo, "main", mainTip);
    setRemoteRef(repo, "feature/merged", featureTip);
    setRemoteDefault(repo, "main");

    const result = runGuard(repo);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /BLOCK: origin\/feature\/merged is already merged into main/);
  });
});
