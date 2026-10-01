/**
 * git-expert must not resolve conflicts: enforcement blocks the write commands
 * while the index has unmerged entries, and points the caller at conflict-resolver.
 * Run with: npx tsx --test tests/node/orchestrator/conflict-resolution-guard.test.ts
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerEnforcement } from "../../../extensions/orchestrator/enforcement.js";
import {
  isConflictResolutionCommand,
  listUnmergedFiles,
} from "../../../extensions/orchestrator/git-helpers.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@e.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@e.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function gitIn(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, env: GIT_ENV, stdio: ["pipe", "pipe", "pipe"] });
}

/** main: a.txt=base; branch: a.txt=theirs; main: a.txt=ours -> real merge conflict. */
function conflictedRepo(at?: string): string {
  const repo = at ?? mkdtempSync(join(tmpdir(), "conflict-guard-"));
  if (at) mkdirSync(repo, { recursive: true });
  const git = (args: string[]) => gitIn(repo, args);
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "base\n");
  git(["add", "a.txt"]);
  git(["commit", "-qm", "base"]);
  git(["checkout", "-qb", "feature"]);
  writeFileSync(join(repo, "a.txt"), "theirs\n");
  git(["commit", "-qam", "theirs"]);
  git(["checkout", "-q", "main"]);
  writeFileSync(join(repo, "a.txt"), "ours\n");
  git(["commit", "-qam", "ours"]);
  try {
    git(["merge", "feature"]);
  } catch {
    /* expected: leaves the index unmerged */
  }
  return repo;
}

/** A real repo with a clean index — a failed `git` call must not be what makes a test pass. */
function cleanRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "conflict-clean-"));
  gitIn(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "clean\n");
  gitIn(repo, ["add", "a.txt"]);
  gitIn(repo, ["commit", "-qm", "clean"]);
  return repo;
}

describe("conflict-resolution guard", () => {
  let cwd: string;
  let clean: string;
  const hooks = new Map<string, Function>();
  const prior = { ...process.env };

  before(() => {
    cwd = conflictedRepo();
    clean = cleanRepo();
    registerEnforcement({
      on: (name: string, handler: Function) => hooks.set(name, handler),
      registerTool: () => {},
      registerCommand: () => {},
    } as any);
  });

  after(() => {
    for (const [k, v] of Object.entries(prior)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(clean, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env.PI_AGENT_NAME;
    delete process.env.PI_SUBAGENT_CHILD;
  });

  async function run(command: string, dir = cwd) {
    const tool = hooks.get("tool_call")!;
    return (await tool({ type: "tool_call", toolName: "bash", input: { command } }, { cwd: dir, model: { id: "m", provider: "openai" } })) as
      | { block: true; reason: string }
      | undefined;
  }

  it("reports the unmerged file from a conflicted index", () => {
    assert.deepEqual(listUnmergedFiles(cwd), ["a.txt"]);
  });

  it("reports no files from a clean repository", () => {
    assert.deepEqual(listUnmergedFiles(clean), []);
  });

  it("classifies staging, deletion, side-selection, and continuation commands", () => {
    const resolutions = [
      "git add a.txt",
      "git restore --source=HEAD a.txt",
      "git rm a.txt",
      "git checkout --ours a.txt",
      "git checkout --theirs a.txt",
      "git checkout -m a.txt",
      "git merge --continue",
      "git rebase --continue",
      "git cherry-pick --continue",
    ];
    for (const cmd of resolutions) {
      assert.equal(isConflictResolutionCommand(cmd), true, cmd);
    }
  });

  it("leaves read-only commands unclassified", () => {
    for (const cmd of ["git status", "git diff", "git merge --abort", "gh pr view 1"]) {
      assert.equal(isConflictResolutionCommand(cmd), false, cmd);
    }
  });

  it("ignores resolution commands inside quoted text", () => {
    assert.equal(isConflictResolutionCommand("echo 'git add a.txt'"), false);
    assert.equal(isConflictResolutionCommand('echo "run git checkout --theirs a.txt"'), false);
  });

  it("ignores resolution commands inside a heredoc body", () => {
    const heredoc = "git commit -F - <<'EOF'\nfix: stop staging by hand, git add is manual\nEOF";
    assert.equal(isConflictResolutionCommand(heredoc), false);
  });

  it("still classifies a real invocation whose path is quoted", () => {
    assert.equal(isConflictResolutionCommand('git add "a b.txt"'), true);
  });

  it("blocks git-expert from staging a resolution", async () => {
    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("git add a.txt");
    assert.equal(result?.block, true);
  });

  it("names the conflict-resolver agent in the block message", async () => {
    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("git add a.txt");
    assert.match(result!.reason, /Unresolved conflicts in a\.txt/);
    assert.match(result!.reason, /conflict-resolver/);
  });

  it("blocks a conflicting deletion instead of letting git rm stage it", async () => {
    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("git rm a.txt");
    assert.equal(result?.block, true);
  });

  it("lets git-expert read the conflicted tree", async () => {
    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    assert.equal((await run("git status"))?.block, undefined);
  });

  it("lets git-expert abort the operation", async () => {
    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    assert.equal((await run("git merge --abort"))?.block, undefined);
  });

  it("does not fire without an in-progress conflict", async () => {
    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    assert.equal((await run("git add a.txt", clean))?.block, undefined);
  });

  it("follows a subshell cd into a conflicted worktree", async () => {
    // Session cwd is clean; the conflict lives in the worktree the subshell enters.
    const root = mkdtempSync(join(tmpdir(), "conflict-subshell-"));
    mkdirSync(join(root, ".worktrees"));
    conflictedRepo(join(root, ".worktrees", "conflicted"));

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run(`(cd .worktrees/conflicted && git add a.txt)`, root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /conflict-resolver/);
    rmSync(root, { recursive: true, force: true });
  });

  it("lets conflict-resolver stage its own resolution", async () => {
    process.env.PI_AGENT_NAME = "conflict-resolver";
    process.env.PI_SUBAGENT_CHILD = "1";
    assert.equal((await run("git add a.txt"))?.block, undefined);
  });
});
