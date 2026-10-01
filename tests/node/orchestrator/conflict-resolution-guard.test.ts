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
import { resolveEffectiveCwd } from "../../../extensions/orchestrator/enforcement-helpers.js";
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
    assert.deepEqual(listUnmergedFiles(cwd), { ok: true, files: ["a.txt"] });
  });

  it("reports no files from a clean repository", () => {
    assert.deepEqual(listUnmergedFiles(clean), { ok: true, files: [] });
  });

  it("marks an unreadable index as failed rather than clean", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "conflict-norepo-"));
    assert.deepEqual(listUnmergedFiles(notARepo), { ok: false, files: [] });
    rmSync(notARepo, { recursive: true, force: true });
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

  it("classifies a shell invocation with bundled or long options", () => {
    for (const cmd of ["bash -xc 'git add a.txt'", "bash --login -c 'git add a.txt'", "sh -euc \"git add a.txt\""]) {
      assert.equal(isConflictResolutionCommand(cmd), true, cmd);
    }
    assert.equal(isConflictResolutionCommand("bash config.sh"), false);
  });

  it("classifies an ANSI-C quoted script argument", () => {
    assert.equal(isConflictResolutionCommand("bash -c $'git add a.txt'"), true);
    assert.equal(isConflictResolutionCommand("echo $'git add a.txt'"), false);
  });

  it("treats nesting past the scan depth as a resolution", () => {
    // Six nested substitutions: the scanner cannot see the bottom, so it must
    // not report "no resolution command".
    let cmd = "git add a.txt";
    for (let i = 0; i < 7; i++) cmd = `echo $(echo ${cmd})`;
    assert.equal(isConflictResolutionCommand(cmd), true);
  });

  it("scans past a quoted paren inside a substitution", () => {
    assert.equal(isConflictResolutionCommand(`echo $(printf ')'; git add a.txt)`), true);
  });

  it("matches a heredoc terminator the way the shell does", () => {
    // With `  EOF` the shell keeps reading, so the next line is still data.
    assert.equal(isConflictResolutionCommand("cat <<EOF\n  EOF\ngit add a.txt\nEOF"), false);
    // `<<-` lets tabs indent the terminator, so the first tabbed EOF ends the
    // body and the following line really is executed.
    assert.equal(isConflictResolutionCommand("cat <<-EOF\n\tEOF\ngit add a.txt\n\tEOF"), true);
    // ...but without an early terminator the body stays data.
    assert.equal(isConflictResolutionCommand("cat <<-EOF\n\tbody\ngit add a.txt\n\tEOF"), false);
  });

  it("does not leak a second heredoc body into classification", () => {
    assert.equal(isConflictResolutionCommand("cat <<Afoo <<foo\nfirst\nAfoo\nplease git add a.txt\nfoo"), false);
  });

  it("does not leak quoted delimiter text into classification", () => {
    assert.equal(isConflictResolutionCommand("cat <<'x git add'\nbody\nx git add"), false);
  });

  it("treats a here-string as data, not a heredoc", () => {
    assert.equal(isConflictResolutionCommand('cat <<<"git add a.txt"'), false);
    assert.equal(isConflictResolutionCommand("cat <<< 'git add a.txt'"), false);
    // ...but a substitution inside one still runs.
    assert.equal(isConflictResolutionCommand('cat <<<"$(git add a.txt)"'), true);
  });

  it("classifies a resolution inside process substitution", () => {
    assert.equal(isConflictResolutionCommand("diff <(git add a.txt) <(git status)"), true);
  });

  it("does not treat a heredoc token in a comment as an opener", () => {
    const cmd = "# see <<EOF\ngit add a.txt\nEOF";
    assert.equal(isConflictResolutionCommand(cmd), true);
  });

  it("ignores staging mentioned only inside a comment", () => {
    assert.equal(isConflictResolutionCommand("git status # remember to git add a.txt"), false);
  });

  it("classifies a git name split by adjacent quotes", () => {
    for (const cmd of ["git'' add a.txt", "g''it add a.txt", "git 'add' a.txt", 'git "add" a.txt']) {
      assert.equal(isConflictResolutionCommand(cmd), true, cmd);
    }
    assert.equal(isConflictResolutionCommand("echo 'git add a.txt'"), false);
  });

  it("classifies a command split by a line continuation", () => {
    assert.equal(isConflictResolutionCommand("git \\\n  add a.txt"), true);
    assert.equal(isConflictResolutionCommand("git \\\n  status"), false);
  });

  it("classifies a nested shell script argument", () => {
    for (const cmd of ["bash -c 'git add a.txt'", "sh -c \"git add a.txt\"", "eval 'git rm a.txt'"]) {
      assert.equal(isConflictResolutionCommand(cmd), true, cmd);
    }
  });

  it("classifies a command substitution inside double quotes", () => {
    assert.equal(isConflictResolutionCommand('printf %s "$(git add a.txt)"'), true);
    assert.equal(isConflictResolutionCommand("echo `git add a.txt`"), true);
  });

  it("classifies a command that follows a heredoc delimiter on the opener line", () => {
    const cmd = "cat <<EOF; git add a.txt\nsome body mentioning git rm\nEOF";
    assert.equal(isConflictResolutionCommand(cmd), true);
  });

  it("classifies an unquoted heredoc body substitution", () => {
    assert.equal(isConflictResolutionCommand("cat <<EOF\n$(git add a.txt)\nEOF"), true);
  });

  it("ignores a quoted heredoc body entirely", () => {
    assert.equal(isConflictResolutionCommand("cat <<'EOF'\n$(git add a.txt)\nEOF"), false);
  });

  it("strips bodies for bare and punctuated heredoc delimiters", () => {
    for (const delim of ["EOF", "END-OF", "MSG_1"]) {
      assert.equal(isConflictResolutionCommand(`cat <<${delim}\nplease git add a.txt by hand\n${delim}`), false, delim);
    }
  });

  it("keeps a quoted git -C value parseable", () => {
    assert.equal(isConflictResolutionCommand('git -C "repo" add a.txt'), true);
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
    assert.match(result!.reason, /Unresolved conflicts in .*a\.txt/);
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

  it("blocks a resolution command when the conflict state cannot be read", async () => {
    // Fail closed: a broken lookup must not read as "no conflict".
    const notARepo = mkdtempSync(join(tmpdir(), "conflict-norepo-"));
    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("git add a.txt", notARepo);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /conflict state is unknown/);
    rmSync(notARepo, { recursive: true, force: true });
  });

  it("catches a conflict selected by an attached git -C path", async () => {
    const root = mkdtempSync(join(tmpdir(), "conflict-git-c-attached-"));
    gitIn(root, ["init", "-q", "-b", "main"]);
    writeFileSync(join(root, "keep.txt"), "clean\n");
    gitIn(root, ["add", "keep.txt"]);
    gitIn(root, ["commit", "-qm", "clean"]);
    conflictedRepo(join(root, "conflicted"));

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("git -Cconflicted add a.txt", root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /Unresolved conflicts in .*a\.txt/);
    rmSync(root, { recursive: true, force: true });
  });

  it("catches a conflict behind a second git -C override", async () => {
    const root = mkdtempSync(join(tmpdir(), "conflict-git-c-twice-"));
    mkdirSync(join(root, "clean"));
    gitIn(join(root, "clean"), ["init", "-q", "-b", "main"]);
    conflictedRepo(join(root, "conflicted"));

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("git -C clean -C ../conflicted add a.txt", root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /Unresolved conflicts in .*a\.txt/);
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves a relative -C against the directory in effect at that command", async () => {
    // The staging happens before the later cd, so -C resolves against the
    // earlier directory, not the final one.
    const root = mkdtempSync(join(tmpdir(), "conflict-git-c-order-"));
    mkdirSync(join(root, "clean"));
    gitIn(join(root, "clean"), ["init", "-q", "-b", "main"]);
    conflictedRepo(join(root, "inner", "conflicted"));

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("cd inner && git -C conflicted add a.txt && cd ../clean", root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /Unresolved conflicts in .*a\.txt/);
    rmSync(root, { recursive: true, force: true });
  });

  it("catches a conflict entered through a cd option", async () => {
    const root = mkdtempSync(join(tmpdir(), "conflict-cd-option-"));
    gitIn(root, ["init", "-q", "-b", "main"]);
    writeFileSync(join(root, "keep.txt"), "clean\n");
    gitIn(root, ["add", "keep.txt"]);
    gitIn(root, ["commit", "-qm", "clean"]);
    conflictedRepo(join(root, "conflicted"));

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("cd -- conflicted && git add a.txt", root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /Unresolved conflicts in .*a\.txt/);
    rmSync(root, { recursive: true, force: true });
  });

  it("catches a conflict entered by a cd in an if condition", async () => {
    const root = mkdtempSync(join(tmpdir(), "conflict-cd-if-"));
    gitIn(root, ["init", "-q", "-b", "main"]);
    writeFileSync(join(root, "keep.txt"), "clean\n");
    gitIn(root, ["add", "keep.txt"]);
    gitIn(root, ["commit", "-qm", "clean"]);
    conflictedRepo(join(root, "conflicted"));

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("if cd conflicted; then git add a.txt; fi", root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /Unresolved conflicts in .*a\.txt/);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses a resolution command that selects the index with an env var", async () => {
    const root = mkdtempSync(join(tmpdir(), "conflict-git-env-"));
    gitIn(root, ["init", "-q", "-b", "main"]);
    writeFileSync(join(root, "keep.txt"), "clean\n");
    gitIn(root, ["add", "keep.txt"]);
    gitIn(root, ["commit", "-qm", "clean"]);

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("GIT_DIR=/somewhere/.git git add a.txt", root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /selects the Git index/);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not block staging that leaves a conflicted session repo", async () => {
    // The session repo is conflicted but the command runs elsewhere entirely.
    const root = mkdtempSync(join(tmpdir(), "conflict-clean-target-"));
    mkdirSync(join(root, "clean"));
    gitIn(join(root, "clean"), ["init", "-q", "-b", "main"]);
    conflictedRepo(root);

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("cd clean && git add keep.txt", root);
    assert.equal(result?.block, undefined);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not fail closed on a trailing change of directory", async () => {
    // Staging runs in the session repo; /tmp is not a repository at all.
    const root = mkdtempSync(join(tmpdir(), "conflict-trailing-cd-"));
    gitIn(root, ["init", "-q", "-b", "main"]);
    writeFileSync(join(root, "keep.txt"), "clean\n");
    gitIn(root, ["add", "keep.txt"]);
    gitIn(root, ["commit", "-qm", "clean"]);

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("git add keep.txt && cd /tmp", root);
    assert.equal(result?.block, undefined);
    rmSync(root, { recursive: true, force: true });
  });

  it("follows the directory git actually runs in, not the first cd", async () => {
    // (cd clean && cd conflicted && git add a.txt): chained relative cds
    // compose, so the conflict is only found if each is applied to the running
    // directory rather than to the session root.
    const root = mkdtempSync(join(tmpdir(), "conflict-second-cd-"));
    mkdirSync(join(root, "clean"));
    gitIn(join(root, "clean"), ["init", "-q", "-b", "main"]);
    conflictedRepo(join(root, "clean", "conflicted"));

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("(cd clean && cd conflicted && git add a.txt)", root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /Unresolved conflicts in .*a\.txt/);
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves a git -C override over the shell directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "conflict-git-c-"));
    mkdirSync(join(root, "clean"));
    gitIn(join(root, "clean"), ["init", "-q", "-b", "main"]);
    conflictedRepo(join(root, "conflicted"));

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("cd clean && git -C ../conflicted add a.txt", root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /Unresolved conflicts in .*a\.txt/);
    rmSync(root, { recursive: true, force: true });
  });

  it("catches a conflict behind a conditional branch", async () => {
    // `cd conflicted || cd .` - the second branch may never run, so the guard
    // must not settle on it.
    const root = mkdtempSync(join(tmpdir(), "conflict-conditional-"));
    conflictedRepo(join(root, "conflicted"));

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("cd conflicted || cd . && git add a.txt", root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /Unresolved conflicts in .*a\.txt/);
    rmSync(root, { recursive: true, force: true });
  });

  it("catches a conflict behind a completed subshell", async () => {
    // `(cd clean)` cannot move the outer shell, so staging runs in the session
    // repo - which is the conflicted one here.
    const root = mkdtempSync(join(tmpdir(), "conflict-subshell-scope-"));
    mkdirSync(join(root, "clean"));
    gitIn(join(root, "clean"), ["init", "-q", "-b", "main"]);
    conflictedRepo(root);

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("(cd clean) && git add a.txt", root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /Unresolved conflicts in .*a\.txt/);
    rmSync(root, { recursive: true, force: true });
  });

  it("catches a conflict behind an earlier read-only git command", async () => {
    const root = mkdtempSync(join(tmpdir(), "conflict-two-git-"));
    mkdirSync(join(root, "clean"));
    gitIn(join(root, "clean"), ["init", "-q", "-b", "main"]);
    conflictedRepo(join(root, "conflicted"));

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("cd clean && git status && cd ../conflicted && git add a.txt", root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /Unresolved conflicts in .*a\.txt/);
    rmSync(root, { recursive: true, force: true });
  });

  it("reads a quoted cd target containing spaces", async () => {
    // Truncating at the space would check a directory that does not exist.
    const root = mkdtempSync(join(tmpdir(), "conflict-space-"));
    mkdirSync(join(root, "clean"));
    conflictedRepo(join(root, "work tree"));

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run('(cd "work tree" && git add a.txt)', root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /Unresolved conflicts in .*a\.txt/);
    rmSync(root, { recursive: true, force: true });
  });

  it("ignores a cd that only appears inside a quoted argument", () => {
    // The commit runs in the session repo; the guard must read it there too.
    const quoted = 'git commit -m "' + '(cd /tmp)' + '"';
    assert.equal(resolveEffectiveCwd(quoted, "/session"), "/session");
    assert.equal(resolveEffectiveCwd("echo 'cd /tmp' && git add a.txt", "/session"), "/session");
  });

  it("keeps the pre-git directory when a trailing cd follows", () => {
    assert.equal(resolveEffectiveCwd("cd /repo && git " + "commit --signoff && cd /tmp", "/session"), "/repo");
    assert.equal(resolveEffectiveCwd("cd /first && cd /second && pytest", "/session"), "/first");
  });

  it("applies chained relative directory changes in order", () => {
    assert.equal(resolveEffectiveCwd("cd a && cd b && git add x", "/session"), "/session/a/b");
    assert.equal(resolveEffectiveCwd("cd /repo && cd . && git add x", "/session"), "/repo");
  });

  it("blocks a resolution hidden inside a nested shell", async () => {
    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("bash -c 'git add a.txt'");
    assert.equal(result?.block, true);
    assert.match(result!.reason, /Unresolved conflicts in .*a\.txt/);
  });

  it("blocks a resolution hidden in a command substitution", async () => {
    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run('printf %s "$(git add a.txt)"');
    assert.equal(result?.block, true);
    assert.match(result!.reason, /Unresolved conflicts in .*a\.txt/);
  });

  it("lets conflict-resolver stage its own resolution", async () => {
    process.env.PI_AGENT_NAME = "conflict-resolver";
    process.env.PI_SUBAGENT_CHILD = "1";
    assert.equal((await run("git add a.txt"))?.block, undefined);
  });
});
