/**
 * git-expert must not resolve conflicts: enforcement blocks the write commands
 * while the index has unmerged entries, and points the caller at conflict-resolver.
 * Run with: npx tsx --test tests/node/orchestrator/conflict-resolution-guard.test.ts
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** main: a.txt=base; branch: a.txt=theirs; main: a.txt=ours -> real merge conflict. */
function conflictedRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "conflict-guard-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, env: GIT_ENV, stdio: ["pipe", "pipe", "pipe"] });
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

describe("conflict-resolution guard", () => {
  let cwd: string;
  let cleanRepo: string;
  const hooks = new Map<string, Function>();
  const prior = { ...process.env };

  before(() => {
    cwd = conflictedRepo();
    cleanRepo = mkdtempSync(join(tmpdir(), "conflict-clean-"));
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
    rmSync(cleanRepo, { recursive: true, force: true });
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

  it("sees the unmerged file and classifies resolution commands", () => {
    assert.deepEqual(listUnmergedFiles(cwd), ["a.txt"]);
    assert.deepEqual(listUnmergedFiles(cleanRepo), []);
    for (const cmd of ["git add a.txt", "git restore --source=HEAD a.txt", "git checkout --theirs a.txt", "git rebase --continue"]) {
      assert.equal(isConflictResolutionCommand(cmd), true, cmd);
    }
    for (const cmd of ["git status", "git diff", "git merge --abort", "gh pr view 1"]) {
      assert.equal(isConflictResolutionCommand(cmd), false, cmd);
    }
  });

  it("blocks git-expert from staging a resolution and names the resolver agent", async () => {
    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("git add a.txt");
    assert.equal(result?.block, true);
    assert.match(result!.reason, /Unresolved conflicts in a\.txt/);
    assert.match(result!.reason, /conflict-resolver/);
  });

  it("still lets git-expert read the conflict and abort", async () => {
    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    assert.equal((await run("git status"))?.block, undefined);
    assert.equal((await run("git merge --abort"))?.block, undefined);
  });

  it("does not fire without an in-progress conflict", async () => {
    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    assert.equal((await run("git add a.txt", cleanRepo))?.block, undefined);
  });

  it("lets conflict-resolver stage its own resolution", async () => {
    process.env.PI_AGENT_NAME = "conflict-resolver";
    process.env.PI_SUBAGENT_CHILD = "1";
    assert.equal((await run("git add a.txt"))?.block, undefined);
  });
});
