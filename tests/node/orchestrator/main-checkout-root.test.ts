/**
 * Main-checkout resolution for shared project dirs (issue #918).
 *
 * .pi/memory and .pi/data are gitignored, so sessions running inside
 * .worktrees/<name> would otherwise see empty stores and both
 * review-learning parts would silently no-op. getProjectMemoryDir and
 * getProjectDataDir must resolve through the main checkout (like the Python
 * get_project_root()) so the TS and Python sides agree on one shared store.
 *
 * Run with: npx tsx --test tests/node/orchestrator/main-checkout-root.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  tryResolveMainCheckoutRoot,
  resolveMainCheckoutRoot,
  getProjectMemoryDir,
  getProjectDataDir,
} from "../../../extensions/orchestrator/utils.js";

let base: string;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "ignore"] });
}

/** Resolve to the real path: macOS temp dirs are symlinked (/var -> /private/var). */
function realpath(p: string): string {
  return execFileSync("python3", ["-c", "import os,sys;print(os.path.realpath(sys.argv[1]))", p], { encoding: "utf8" }).trim();
}

function makeRepo(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  git(["init", "-q"], dir);
  return dir;
}

function makeRepoWithWorktree(repoName: string, wtName: string): { repo: string; worktree: string } {
  const repo = makeRepo(repoName);
  // worktree add requires at least one commit
  mkdirSync(join(repo, "file.txt").replace(/file\.txt$/, ""), { recursive: true });
  execFileSync("sh", ["-c", "echo hi > file.txt"], { cwd: repo });
  git(["add", "file.txt"], repo);
  git(["commit", "-q", "-m", "init"], repo);
  const worktree = join(base, wtName);
  git(["worktree", "add", "-q", worktree, "-b", "wt"], repo);
  return { repo, worktree };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "main-checkout-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("tryResolveMainCheckoutRoot", () => {
  it("returns the repo root in a plain repository", () => {
    const repo = makeRepo("repo");
    assert.equal(tryResolveMainCheckoutRoot(repo), realpath(repo));
  });

  it("returns the MAIN checkout root from inside a worktree", () => {
    const { repo, worktree } = makeRepoWithWorktree("main", "wt");
    assert.equal(tryResolveMainCheckoutRoot(worktree), realpath(repo));
    // and it must differ from the worktree root itself
    assert.notEqual(tryResolveMainCheckoutRoot(worktree), realpath(worktree));
  });

  it("returns null for a plain directory that is not a repository", () => {
    const plain = join(base, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    assert.equal(tryResolveMainCheckoutRoot(plain), null);
  });
});

describe("resolveMainCheckoutRoot", () => {
  it("falls back to cwd when not a git repo", () => {
    const plain = join(base, "fallback");
    mkdirSync(plain, { recursive: true });
    assert.equal(resolveMainCheckoutRoot(plain), realpath(plain));
  });
});

describe("getProjectMemoryDir", () => {
  it("resolves under the repo root in a plain repo and creates the dir", () => {
    const repo = makeRepo("mem-repo");
    const dir = getProjectMemoryDir(repo);
    assert.equal(dir, join(realpath(repo), ".pi", "memory"));
    assert.ok(existsSync(dir));
  });

  it("resolves to the MAIN checkout from a worktree, not the worktree", () => {
    const { repo, worktree } = makeRepoWithWorktree("mem-main", "mem-wt");
    const dir = getProjectMemoryDir(worktree);
    assert.equal(dir, join(realpath(repo), ".pi", "memory"));
    assert.notEqual(dir, join(realpath(worktree), ".pi", "memory"));
  });

  it("falls back to <cwd>/.pi/memory when not a git repo", () => {
    const plain = join(base, "plain-mem");
    mkdirSync(plain, { recursive: true });
    assert.equal(getProjectMemoryDir(plain), join(realpath(plain), ".pi", "memory"));
  });
});

describe("getProjectDataDir", () => {
  it("resolves under the repo root in a plain repo and creates the dir", () => {
    const repo = makeRepo("data-repo");
    const dir = getProjectDataDir(repo);
    assert.equal(dir, join(realpath(repo), ".pi", "data"));
    assert.ok(existsSync(dir));
  });

  it("resolves to the MAIN checkout from a worktree, not the worktree", () => {
    const { repo, worktree } = makeRepoWithWorktree("data-main", "data-wt");
    const dir = getProjectDataDir(worktree);
    assert.equal(dir, join(realpath(repo), ".pi", "data"));
    assert.notEqual(dir, join(realpath(worktree), ".pi", "data"));
  });

  it("falls back to <cwd>/.pi/data when not a git repo", () => {
    const plain = join(base, "plain-data");
    mkdirSync(plain, { recursive: true });
    assert.equal(getProjectDataDir(plain), join(realpath(plain), ".pi", "data"));
  });
});
