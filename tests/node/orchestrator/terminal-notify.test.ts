/**
 * Unit tests for desktop notification title formatting and terminalNotify gating (#1464).
 *
 * Run with: npx tsx --test --test-concurrency=4 tests/node/orchestrator/terminal-notify.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  clearNotificationContextCache,
  formatNotificationTitle,
  setTerminalNotifyExecForTests,
  terminalNotify,
} from "../../../extensions/orchestrator/utils.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

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

function makeRealRepo(base: string, name: string): string {
  const repo = join(base, name);
  mkdirSync(repo, { recursive: true });
  git(["init", "-q"], repo);
  writeFileSync(join(repo, "README.md"), "hi\n", "utf-8");
  git(["add", "README.md"], repo);
  git(["commit", "-q", "-m", "init"], repo);
  return repo;
}

describe("formatNotificationTitle", () => {
  let base: string;

  beforeEach(() => {
    clearNotificationContextCache();
    base = makeTempDir("terminal-notify-");
  });

  afterEach(() => {
    clearNotificationContextCache();
  });

  it("formats main git checkout with repo name", () => {
    const repo = makeRealRepo(base, "my-repo");
    const title = formatNotificationTitle("pi", { cwd: repo, argv: ["node", "pi"] });
    assert.equal(title, "pi (my-repo)");
  });

  it("formats subdirectory of main git checkout with repo name", () => {
    const repo = makeRealRepo(base, "my-repo");
    const nested = join(repo, "packages", "sub");
    mkdirSync(nested, { recursive: true });
    const title = formatNotificationTitle("pi", { cwd: nested, argv: ["node", "pi"] });
    assert.equal(title, "pi (my-repo)");
  });

  it("formats real linked git worktree with repo plus worktree name", () => {
    const repo = makeRealRepo(base, "pi-config");
    const worktree = join(base, "issue-1449-turn-snapshots");
    git(["worktree", "add", "-q", worktree, "-b", "wt-branch"], repo);
    const title = formatNotificationTitle("pi", { cwd: worktree, argv: ["node", "pi"] });
    assert.equal(title, "pi (pi-config · issue-1449-turn-snapshots)");
  });

  it("formats linked worktree gitdir fixture with repo plus worktree name", () => {
    const worktree = join(base, "issue-1464-wt");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(
      join(worktree, ".git"),
      `gitdir: ${join(base, "pi-config", ".git", "worktrees", "issue-1464-wt")}\n`,
      "utf-8",
    );
    const title = formatNotificationTitle("pi", { cwd: worktree, argv: ["node", "pi"] });
    assert.equal(title, "pi (pi-config · issue-1464-wt)");
  });

  it("formats COMS peer from separate --cname flag", () => {
    const repo = makeRealRepo(base, "pi-config");
    const title = formatNotificationTitle("pi", {
      cwd: repo,
      argv: ["node", "pi", "--coms", "--cname", "peer-1449-snapshots"],
    });
    assert.equal(title, "pi (pi-config · peer-1449-snapshots)");
  });

  it("formats COMS peer from equals --cname flag", () => {
    const repo = makeRealRepo(base, "pi-config");
    const title = formatNotificationTitle("pi", {
      cwd: repo,
      argv: ["node", "pi", "--coms", "--cname=peer-foo"],
    });
    assert.equal(title, "pi (pi-config · peer-foo)");
  });

  it("prefers COMS peer name over linked worktree name", () => {
    const worktree = join(base, "issue-1449-turn-snapshots");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(
      join(worktree, ".git"),
      `gitdir: ${join(base, "pi-config", ".git", "worktrees", "issue-1449-turn-snapshots")}\n`,
      "utf-8",
    );
    const title = formatNotificationTitle("pi", {
      cwd: worktree,
      argv: ["node", "pi", "--coms", "--cname", "peer-1449-snapshots"],
    });
    assert.equal(title, "pi (pi-config · peer-1449-snapshots)");
  });

  it("avoids duplicate label when peer name matches repo name", () => {
    const repo = makeRealRepo(base, "pi-config");
    const title = formatNotificationTitle("pi", {
      cwd: repo,
      argv: ["node", "pi", "--coms", "--cname", "pi-config"],
    });
    assert.equal(title, "pi (pi-config)");
  });

  it("falls back to directory basename outside git repos", () => {
    const plain = join(base, "scratch-folder");
    mkdirSync(plain, { recursive: true });
    const title = formatNotificationTitle("pi", { cwd: plain, argv: ["node", "pi"] });
    assert.equal(title, "pi (scratch-folder)");
  });

  it("honors custom resolveGitCommonDir option", () => {
    const title = formatNotificationTitle("pi", {
      cwd: "/virtual/pi-config/.worktrees/feature-x",
      argv: ["node", "pi"],
      resolveGitCommonDir: () => "/virtual/pi-config/.git",
    });
    assert.equal(title, "pi (pi-config · feature-x)");
  });
});

describe("terminalNotify", () => {
  let savedSubagentChild: string | undefined;
  let savedSupervisedPeer: string | undefined;

  beforeEach(() => {
    savedSubagentChild = process.env.PI_SUBAGENT_CHILD;
    savedSupervisedPeer = process.env.PI_COMS_SUPERVISED_PEER;
    delete process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_COMS_SUPERVISED_PEER;
  });

  afterEach(() => {
    setTerminalNotifyExecForTests(null);
    if (savedSubagentChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = savedSubagentChild;
    if (savedSupervisedPeer === undefined) delete process.env.PI_COMS_SUPERVISED_PEER;
    else process.env.PI_COMS_SUPERVISED_PEER = savedSupervisedPeer;
  });

  it("suppresses notification for subagent children", () => {
    const calls: Array<[string, string]> = [];
    setTerminalNotifyExecForTests((args) => calls.push(args));
    process.env.PI_SUBAGENT_CHILD = "1";

    terminalNotify("pi", "Action required");

    assert.equal(calls.length, 0);
  });

  it("sends notification for supervised COMS peers", () => {
    const calls: Array<[string, string]> = [];
    setTerminalNotifyExecForTests((args) => calls.push(args));
    process.env.PI_COMS_SUPERVISED_PEER = "1";

    terminalNotify("pi", "Action required");

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [formatNotificationTitle("pi"), "Action required"]);
  });
});
