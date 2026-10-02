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
import { createLogger } from "../../../extensions/shared/logger.js";
import { registerEnforcement } from "../../../extensions/orchestrator/enforcement.js";
import { resolveEffectiveCwd, conflictCandidateDirs } from "../../../extensions/orchestrator/enforcement-helpers.js";
import {
  createsAndResolvesConflict,
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

const testLog = createLogger("conflict-guard-test");

function gitIn(repo: string, args: string[]): void {
  // Subcommand and branch only: a test repo path can carry a random suffix.
  testLog.debug("fixture_git", "subcommand", args[0], "branch", args.find((a) => a.startsWith("-b")) ?? "");
  execFileSync("git", args, { cwd: repo, env: GIT_ENV, stdio: ["pipe", "pipe", "pipe"] });
}

/** main: a.txt=base; branch: a.txt=theirs; main: a.txt=ours -> real merge conflict. */
function conflictedRepo(at?: string): string {
  testLog.debug("fixture_repo", "kind", "conflicted");
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
  testLog.debug("fixture_repo", "kind", "clean");
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
      "git rebase --skip",
      "git cherry-pick --skip",
      "git revert --continue",
      "git am --skip",
      "git checkout MERGE_HEAD -- a.txt",
      "git reset -- a.txt",
      "git reset",
    ];
    for (const cmd of resolutions) {
      assert.equal(isConflictResolutionCommand(cmd), true, cmd);
    }
  });

  it("leaves read-only commands unclassified", () => {
    for (const cmd of ["git status", "git diff", "git merge --abort", "git rebase --abort", "gh pr view 1"]) {
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

  it("follows a cd inside a nested shell script", async () => {
    const root = mkdtempSync(join(tmpdir(), "conflict-nested-shell-cd-"));
    gitIn(root, ["init", "-q", "-b", "main"]);
    writeFileSync(join(root, "keep.txt"), "clean\n");
    gitIn(root, ["add", "keep.txt"]);
    gitIn(root, ["commit", "-qm", "clean"]);
    conflictedRepo(join(root, "conflicted"));

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("bash -c 'cd conflicted && git add a.txt'", root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /Unresolved conflicts in .*a\.txt/);
    rmSync(root, { recursive: true, force: true });
  });

  it("classifies a path-qualified shell script argument", () => {
    assert.equal(isConflictResolutionCommand("/bin/bash -c 'git add a.txt'"), true);
    assert.equal(isConflictResolutionCommand("/usr/bin/env bash -c 'git add a.txt'"), true);
    assert.equal(isConflictResolutionCommand("/bin/bash -c 'git status'"), false);
  });

  it("sees a conflict outside the directory it runs from", async () => {
    // From a subdirectory, `git add ../a.txt` still stages the conflict at the
    // repository root — the lookup must not be scoped to the cwd.
    const root = mkdtempSync(join(tmpdir(), "conflict-subdir-"));
    conflictedRepo(root);
    mkdirSync(join(root, "sub"));

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const relative = await run("git add ../a.txt", join(root, "sub"));
    assert.equal(relative?.block, true);
    assert.match(relative!.reason, /Unresolved conflicts in .*a\.txt/);
    const whole = await run("git add -A", join(root, "sub"));
    assert.equal(whole?.block, true);
    rmSync(root, { recursive: true, force: true });
  });

  it("reads git only where a command runs", () => {
    // An argument that only prints an example is not an executed command.
    assert.equal(isConflictResolutionCommand("echo git add a.txt"), false);
    assert.equal(isConflictResolutionCommand("printf 'run git add a.txt now'"), false);
    // ...but words that execute what follows them do count.
    assert.equal(isConflictResolutionCommand("xargs git add"), true);
    assert.equal(isConflictResolutionCommand("find . -exec git add {} \\;"), true);
    assert.equal(isConflictResolutionCommand("git add a.txt"), true);
    assert.equal(isConflictResolutionCommand("cd x && git add a.txt"), true);
  });

  it("keeps the unquoted tail of a quoted directory name", () => {
    assert.equal(conflictCandidateDirs('cd "work tree"x && git add a.txt', "/root").all.join(","), "/root/work treex");
    assert.equal(conflictCandidateDirs('cd pre"fix" && git add a.txt', "/root").all.join(","), "/root/prefix");
  });

  it("treats an unreadable subcommand position as unsafe", () => {
    // The subcommand can come from a variable at run time.
    assert.equal(isConflictResolutionCommand('action=add; git "$action" a.txt'), true);
    assert.equal(isConflictResolutionCommand("git $cmd a.txt"), true);
    // Ordinary commands with a variable argument are unaffected.
    assert.equal(isConflictResolutionCommand('git add "$file"'), true);
    assert.equal(isConflictResolutionCommand("git status"), false);
  });

  it("reads -C only as a global option, not as a subcommand flag", () => {
    // `git commit -C <sha>` reuses a message; it does not change directory, and
    // treating it as one would send the safety guards after a nonexistent path.
    assert.equal(conflictCandidateDirs("git commit -C HEAD -F -", "/root").all.join(","), "/root");
    assert.equal(conflictCandidateDirs("git -c core.editor=vim commit -F -", "/root").all.join(","), "/root");
    assert.equal(conflictCandidateDirs("git -C sub commit -F -", "/root").all.join(","), "/root,/root/sub");
    assert.equal(conflictCandidateDirs('git -C "my repo" add x', "/root").all.join(","), "/root,/root/my repo");
  });

  it("reads an apostrophe inside a double-quoted span as a character", () => {
    // `it's` is not a quote; the substitution after it still runs.
    assert.equal(isConflictResolutionCommand('printf %s "it\'s $(git add a.txt)"'), true);
    assert.equal(isConflictResolutionCommand('echo "it\'s fine"'), false);
    assert.equal(isConflictResolutionCommand("cat <<'EOF'\nit's $(git add a.txt)\nEOF"), false);
  });

  it("classifies nothing after an unterminated quote, as bash does", () => {
    // bash reports an unexpected EOF and runs nothing, so neither do we.
    assert.equal(isConflictResolutionCommand("echo can't && git add a.txt"), false);
  });

  it("treats a here-string as data, not a heredoc", () => {
    assert.equal(isConflictResolutionCommand('cat <<<"git add a.txt"'), false);
    assert.equal(isConflictResolutionCommand("cat <<< 'git add a.txt'"), false);
    // ...but a substitution inside one still runs.
    assert.equal(isConflictResolutionCommand('cat <<<"$(git add a.txt)"'), true);
  });

  it("sees an index override only in assignment or option position", () => {
    const detect = (c: string) => conflictCandidateDirs(c, "/root").envOverride;
    assert.equal(detect("GIT_DIR=/x/.git git add a.txt"), "GIT_DIR");
    assert.equal(detect("env -i GIT_WORK_TREE=/x git add a.txt"), "GIT_WORK_TREE");
    assert.equal(detect("git --git-dir=/x/.git add a.txt"), "--git-dir");
    // A file named like an assignment, and one passed after `--`, are not overrides.
    assert.equal(detect("git add GIT_INDEX_FILE=notes"), null);
    assert.equal(detect("git add -- --work-tree=x"), null);
  });

  it("reads every directory a wrapper or redirection can move git into", () => {
    const dirs = (c: string) => conflictCandidateDirs(c, "/root").all;
    // `command cd` and `builtin cd` are still a cd.
    assert.ok(dirs("command cd /conflicted && git add a.txt").includes("/conflicted"));
    assert.ok(dirs("builtin cd /conflicted && git add a.txt").includes("/conflicted"));
    // A `pushd` displaces a directory that `popd` returns to.
    assert.ok(dirs("cd /a && pushd b && popd && git add a.txt").includes("/a/b"));
    // Redirection is not a background operator.
    assert.deepEqual(dirs("git add a.txt 2>&1"), ["/root"]);
    // An escaped `&` is part of the name.
    assert.ok(dirs("cd /a\\&b && git add a.txt").includes("/a&b"));
    // A directory literally named `-` is not the previous directory.
    assert.ok(dirs("git -C- add a.txt").includes("/root/-"));
    // `env -C` moves git without a shell cd.
    assert.ok(dirs("env -C /conflicted git add a.txt").includes("/conflicted"));
  });

  it("takes HOME from the command rather than from this process", () => {
    // The shell's own HOME decides where a bare cd goes, not the process's.
    assert.ok(conflictCandidateDirs("HOME=/h cd && git add a.txt", "/root").all.includes("/h"));
  });

  it("reads an exported index from the command itself", () => {
    const detect = (c: string) => conflictCandidateDirs(c, "/root").envOverride;
    // An export selects the index for later commands in the same shell.
    assert.equal(detect("export GIT_INDEX_FILE=/x/i\ngit add a.txt"), "GIT_INDEX_FILE");
    // `-i` takes no value, so the assignment after it still counts.
    assert.equal(detect("env -i GIT_WORK_TREE=/x git add a.txt"), "GIT_WORK_TREE");
    // A value-taking option consumes its value instead.
    assert.equal(detect("env -u GIT_INDEX_FILE git add a.txt"), null);
  });

  it("blocks a command that creates the conflict and stages it in one line", async () => {
    // The index is read before the command runs, so the conflict is invisible to
    // the check above; creating it and staging it together is the same bypass.
    const root = mkdtempSync(join(tmpdir(), "conflict-sequencer-"));
    gitIn(root, ["init", "-q", "-b", "main"]);
    writeFileSync(join(root, "a.txt"), "one\n");
    gitIn(root, ["add", "a.txt"]);
    gitIn(root, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "base"]);
    gitIn(root, ["checkout", "-q", "-b", "other"]);
    writeFileSync(join(root, "a.txt"), "other\n");
    gitIn(root, ["add", "a.txt"]);
    gitIn(root, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "other"]);
    gitIn(root, ["checkout", "-q", "main"]);
    writeFileSync(join(root, "a.txt"), "mine\n");
    gitIn(root, ["add", "a.txt"]);
    gitIn(root, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "mine"]);

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("git merge other && git add a.txt", root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /starts a merge/);
    // Starting a merge on its own is not a resolution and stays allowed.
    assert.notEqual((await run("git merge other", root))?.block, true);
    rmSync(root, { recursive: true, force: true });
  });

  it("reads an index override only where git actually runs", () => {
    const detect = (c: string) => conflictCandidateDirs(c, "/root").envOverride;
    // Printing the name is not selecting the index.
    assert.equal(detect("echo GIT_INDEX_FILE=/x"), null);
    // A wrapper in front of the assignment still selects it.
    assert.equal(detect("sudo GIT_DIR=/x/.git git add a.txt"), "GIT_DIR");
  });

  it("reads an index override behind a wrapper and env together", () => {
    assert.equal(conflictCandidateDirs("sudo env GIT_WORK_TREE=/x git add a.txt", "/root").envOverride, "GIT_WORK_TREE");
  });

  it("lets a literal path override an earlier unverifiable one", () => {
    // The first cd may expand at run time, but the second is certain.
    assert.equal(conflictCandidateDirs("cd $REPO; cd /known && git add a.txt", "/root").dynamicPath, null);
    // Still reported when nothing settles it.
    assert.ok(conflictCandidateDirs("cd $REPO; git add a.txt", "/root").dynamicPath);
    // A glob character the command escaped is part of the name, not a pattern.
    assert.equal(conflictCandidateDirs("cd /repo\\[1\\] && git add a.txt", "/root").dynamicPath, null);
  });
  it("reads a quoted or escaped spelling of a staging command", () => {
    // The subcommand itself may be quoted, and a global option that takes no
    // value must not swallow it.
    assert.equal(isConflictResolutionCommand('git "add" a.txt'), true);
    assert.equal(isConflictResolutionCommand("git 'add' a.txt"), true);
    assert.equal(isConflictResolutionCommand("git --no-pager add a.txt"), true);
    assert.equal(isConflictResolutionCommand("git -c core.x=1 add a.txt"), true);
    // A heredoc delimiter written with an escape is still a heredoc.
    assert.equal(isConflictResolutionCommand("git add a.txt <<\\EOF\nbody\nEOF\n"), true);
  });

  it("leaves commands that only name git alone", () => {
    // Sourcing a file called git is not running git, and a script of literal
    // escapes is not staging anything.
    assert.equal(isConflictResolutionCommand(". ./git"), false);
    assert.equal(isConflictResolutionCommand("source git"), false);
    assert.equal(isConflictResolutionCommand("bash -c 'echo \\n \\t'"), false);
  });

  it("does not carry a directory change across a pipe", () => {
    // Each pipeline component is its own subshell, so the right-hand side runs
    // where the shell already was, not where the left-hand side changed to.
    const dirs = conflictCandidateDirs("cd clean | git add a.txt", "/root").all;
    assert.ok(dirs.includes("/root"));
    assert.ok(dirs.includes("/root/clean"));
  });

  it("reads order, flags and scope when a command creates and stages", () => {
    const both = (c: string) => createsAndResolvesConflict(c);
    // The sequencer has to come first: staging before it is ordinary work.
    assert.equal(both("git merge main && git add a.txt"), true);
    assert.equal(both("git add a.txt && git merge main"), false);
    // A backout resolves nothing, and finishing one is the handoff's job.
    assert.equal(both("git merge --abort && git add a.txt"), false);
    assert.equal(both("git merge main --continue && git add a.txt"), false);
    // Reading the stash list is not starting anything; popping it can conflict.
    assert.equal(both("git stash list && git add a.txt"), false);
    assert.equal(both("git stash pop && git add a.txt"), true);
    // Two repositories are two unrelated trees.
    assert.equal(both("git -C repo-a merge branch && git -C repo-b add x"), false);
    assert.equal(both("git -C a merge x && git -C a add y"), true);
    // A pull merges; picking a side after it resolves.
    assert.equal(both("git pull origin main && git add a.txt"), true);
    assert.equal(both("git merge x && git checkout --ours a.txt"), true);
  });

  it("keeps walking past a subshell before the git command", () => {
    // A subshell that closes cannot move the shell, and it must not end the walk.
    assert.equal(resolveEffectiveCwd("(cd /tmp) && cd /repo && git add x", "/session"), "/repo");
    assert.equal(resolveEffectiveCwd("cd /repo && (cd /tmp) && git add x", "/session"), "/repo");
  });

  it("inherits an outer directory change into a subshell", () => {
    // The outer cd runs first, and the subshell starts where the shell is.
    assert.equal(resolveEffectiveCwd("cd /protected && (git add x)", "/session"), "/protected");
    // A cd inside the subshell still does not move the outer shell.
    assert.equal(resolveEffectiveCwd("(cd /tmp) && git add x", "/session"), "/session");
  });

  it("keeps an unresolved path when the move is relative or comes late", () => {
    // A relative move inherits whatever the expanded directory produced.
    assert.equal(conflictCandidateDirs("cd $REPO; cd nested; git add f", "/s").dynamicPath, "$REPO");
    // Git already ran while it was outstanding, so a later cd cannot settle it.
    assert.equal(conflictCandidateDirs('cd "$REPO"; git add a.txt; cd /', "/s").dynamicPath, "$REPO");
    // An absolute move before git does settle it.
    assert.equal(conflictCandidateDirs("cd $REPO; cd /known; git add f", "/s").dynamicPath, null);
  });

  it("reads a quoted directory path that spans a newline", () => {
    const dirs = conflictCandidateDirs('cd "conflicted\nrepo" && git add a.txt', "/s").all;
    assert.ok(dirs.includes("/s/conflicted\nrepo"));
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
    // Inside a repository whose index will not answer: fail closed.
    const root = mkdtempSync(join(tmpdir(), "conflict-badindex-"));
    gitIn(root, ["init", "-q", "-b", "main"]);
    writeFileSync(join(root, "keep.txt"), "clean\n");
    gitIn(root, ["add", "keep.txt"]);
    gitIn(root, ["commit", "-qm", "clean"]);
    writeFileSync(join(root, ".git", "index"), "not an index");

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("git add keep.txt", root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /conflict state is unknown/);
    rmSync(root, { recursive: true, force: true });
  });

  it("reads an escaped space in a -C value", async () => {
    const root = mkdtempSync(join(tmpdir(), "conflict-escaped-c-"));
    gitIn(root, ["init", "-q", "-b", "main"]);
    writeFileSync(join(root, "keep.txt"), "clean\n");
    gitIn(root, ["add", "keep.txt"]);
    gitIn(root, ["commit", "-qm", "clean"]);
    conflictedRepo(join(root, "conflicted repo"));

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("git -C conflicted\\ repo add a.txt", root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /Unresolved conflicts in .*a\.txt/);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses when one candidate repository cannot be read", async () => {
    // A readable candidate elsewhere must not excuse an unreadable target.
    const root = mkdtempSync(join(tmpdir(), "conflict-partial-read-"));
    gitIn(root, ["init", "-q", "-b", "main"]);
    writeFileSync(join(root, "keep.txt"), "clean\n");
    gitIn(root, ["add", "keep.txt"]);
    gitIn(root, ["commit", "-qm", "clean"]);
    const other = join(root, "other");
    mkdirSync(other);
    gitIn(other, ["init", "-q", "-b", "main"]);
    writeFileSync(join(other, "keep.txt"), "clean\n");
    gitIn(other, ["add", "keep.txt"]);
    gitIn(other, ["commit", "-qm", "clean"]);
    writeFileSync(join(other, ".git", "index"), "not an index");

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("git -C other add keep.txt", root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /Could not read the unmerged index/);
    rmSync(root, { recursive: true, force: true });
  });

  it("allows staging where there is no repository yet", async () => {
    // `git init && git add -A` has nothing to conflict with.
    const fresh = mkdtempSync(join(tmpdir(), "conflict-fresh-"));
    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("git init -q && git add -A", fresh);
    assert.equal(result?.block, undefined);
    rmSync(fresh, { recursive: true, force: true });
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
    assert.match(result!.reason, /selects the Git repository or index/);

    const viaOption = await run("git --git-dir=/somewhere/.git --work-tree=/somewhere add a.txt", root);
    assert.equal(viaOption?.block, true);
    assert.match(viaOption!.reason, /--git-dir/);

    // A path the shell expands is not something the guard can check.
    const viaVariable = await run('git -C "$REPO" add a.txt', root);
    assert.equal(viaVariable?.block, true);
    assert.match(viaVariable!.reason, /expanded by the shell/);
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

  it("follows a bare cd to the home directory", async () => {
    const priorHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "conflict-home-"));
    process.env.HOME = home;
    try {
      const root = mkdtempSync(join(tmpdir(), "conflict-home-session-"));
      gitIn(root, ["init", "-q", "-b", "main"]);
      writeFileSync(join(root, "keep.txt"), "clean\n");
      gitIn(root, ["add", "keep.txt"]);
      gitIn(root, ["commit", "-qm", "clean"]);
      conflictedRepo(home);

      process.env.PI_AGENT_NAME = "git-expert";
      process.env.PI_SUBAGENT_CHILD = "1";
      const result = await run("cd && git add a.txt", root);
      assert.equal(result?.block, true);
      assert.match(result!.reason, /Unresolved conflicts in .*a\.txt/);
      rmSync(root, { recursive: true, force: true });
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("follows cd - back to the previous directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "conflict-previous-"));
    mkdirSync(join(root, "clean"));
    gitIn(join(root, "clean"), ["init", "-q", "-b", "main"]);
    conflictedRepo(root);

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("cd clean && cd - && git add a.txt", root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /Unresolved conflicts in .*a\.txt/);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not follow a backgrounded cd into the foreground", async () => {
    // `cd clean &` runs in a subshell, so the staging happens where we already are.
    const root = mkdtempSync(join(tmpdir(), "conflict-background-"));
    mkdirSync(join(root, "clean"));
    gitIn(join(root, "clean"), ["init", "-q", "-b", "main"]);
    conflictedRepo(root);

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("cd clean & git add a.txt", root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /Unresolved conflicts in .*a\.txt/);
    rmSync(root, { recursive: true, force: true });
  });

  it("checks both directories when a cd may be skipped", async () => {
    // `false && cd clean` never runs, so the staging happens where we already are.
    const root = mkdtempSync(join(tmpdir(), "conflict-skipped-cd-"));
    mkdirSync(join(root, "clean"));
    gitIn(join(root, "clean"), ["init", "-q", "-b", "main"]);
    conflictedRepo(root);

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("false && cd clean; git add a.txt", root);
    assert.equal(result?.block, true);
    assert.match(result!.reason, /Unresolved conflicts in .*a\.txt/);
    rmSync(root, { recursive: true, force: true });
  });

  it("starts a new subshell from the outer directory", async () => {
    // The second subshell must not inherit the first one's directory.
    const root = mkdtempSync(join(tmpdir(), "conflict-two-subshells-"));
    mkdirSync(join(root, "clean"));
    gitIn(join(root, "clean"), ["init", "-q", "-b", "main"]);
    conflictedRepo(root);

    process.env.PI_AGENT_NAME = "git-expert";
    process.env.PI_SUBAGENT_CHILD = "1";
    const result = await run("(cd clean); (git add a.txt)", root);
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

  it("does not follow a cd that ran in a subshell", () => {
    // The cd happened in its own subshell; the shell that runs git never moved,
    // so the guards must read the session directory, not /tmp.
    assert.equal(resolveEffectiveCwd("(cd /tmp) && git add x", "/session"), "/session");
    // A cd in the same chain does count, and an `if` guard really does move it.
    assert.equal(resolveEffectiveCwd("cd /repo && git add x", "/session"), "/repo");
    assert.equal(resolveEffectiveCwd("if cd /x; then git add y; fi", "/session"), "/x");
  });

  it("anchors the effective directory on the segment that runs git", () => {
    // `cd ~/git/proj` contains the word without running git.
    assert.equal(resolveEffectiveCwd("cd /tmp/git/proj && git commit --signoff -F -", "/session"), "/tmp/git/proj");
  });

  it("anchors the candidate directories on the segment that runs git", () => {
    assert.equal(conflictCandidateDirs("cd /tmp/git/proj && git add a.txt", "/root").all.join(","), "/tmp/git/proj");
  });

  it("applies repeated -C values in order, as git does", () => {
    assert.equal(resolveEffectiveCwd("git -C worktree -C nested commit", "/root"), "/root/worktree/nested");
    assert.equal(resolveEffectiveCwd("git -C /repo -C ../other add x", "/root"), "/other");
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
