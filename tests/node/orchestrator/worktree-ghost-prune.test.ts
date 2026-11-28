/**
 * #1504 — Unit tests for unregistered `.pi/` / `graft` ghost directory cleanup
 * under `.worktrees/` on `executeGuardedWorktreeRemove`, `runWorktreePrune`,
 * `worktree_status(action="prune")`, and PiDash `pruneWorktreesOp`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitAsyncRunner } from "../../../extensions/orchestrator/git-helpers.js";
import { getProjectTmpDir } from "../../../extensions/orchestrator/utils.js";
import {
  executeGuardedWorktreeRemove,
  pruneOrphanedWorktreeShells,
  registerWorktree,
  runWorktreePrune,
} from "../../../extensions/orchestrator/worktree.js";
import { classifyGhostWorktreeDir } from "../../../extensions/orchestrator/worktree-helpers.js";
import { pruneWorktreesOp } from "../../../extensions/pidash/browser-ops.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

function initTempGitRepo(rootDir: string): string {
  const repoDir = join(rootDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "ignore" });
  writeFileSync(join(repoDir, ".gitignore"), ".pi/\ngraft\n");
  writeFileSync(join(repoDir, "README.md"), "# repo\n");
  execFileSync("git", ["add", ".gitignore", "README.md"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: repoDir, stdio: "ignore" });
  return repoDir;
}

describe("classifyGhostWorktreeDir (#1504)", () => {
  it("accepts a directory containing only .pi", () => {
    const dir = makeTempDir("wt-ghost-cls-");
    try {
      const ghost = join(dir, "ghost");
      mkdirSync(join(ghost, ".pi", "tmp"), { recursive: true });
      writeFileSync(join(ghost, ".pi", "tmp", "run.log"), "ok\n");
      const res = classifyGhostWorktreeDir(ghost);
      assert.equal(res.safe, true);
      if (res.safe) assert.deepEqual(res.entries, [".pi"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a directory containing only graft", () => {
    const dir = makeTempDir("wt-ghost-cls-");
    try {
      const ghost = join(dir, "ghost");
      mkdirSync(ghost, { recursive: true });
      writeFileSync(join(ghost, "graft"), "meta\n");
      const res = classifyGhostWorktreeDir(ghost);
      assert.equal(res.safe, true);
      if (res.safe) assert.deepEqual(res.entries, ["graft"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a directory containing .pi with graft", () => {
    const dir = makeTempDir("wt-ghost-cls-");
    try {
      const ghost = join(dir, "ghost");
      mkdirSync(join(ghost, ".pi", "data"), { recursive: true });
      writeFileSync(join(ghost, "graft"), "meta\n");
      const res = classifyGhostWorktreeDir(ghost);
      assert.equal(res.safe, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an empty directory", () => {
    const dir = makeTempDir("wt-ghost-cls-");
    try {
      const empty = join(dir, "empty");
      mkdirSync(empty, { recursive: true });
      const res = classifyGhostWorktreeDir(empty);
      assert.equal(res.safe, false);
      if (!res.safe) assert.equal(res.reason, "empty");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a directory containing user files alongside .pi", () => {
    const dir = makeTempDir("wt-ghost-cls-");
    try {
      const mixed = join(dir, "mixed");
      mkdirSync(join(mixed, ".pi", "tmp"), { recursive: true });
      writeFileSync(join(mixed, "notes.txt"), "keep me\n");
      const res = classifyGhostWorktreeDir(mixed);
      assert.equal(res.safe, false);
      if (!res.safe) {
        assert.equal(res.reason, "unexpected_entries");
        assert.deepEqual(res.unexpectedEntries, ["notes.txt"]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a symlink", () => {
    const dir = makeTempDir("wt-ghost-cls-");
    try {
      const target = join(dir, "outside");
      mkdirSync(join(target, ".pi"), { recursive: true });
      const link = join(dir, "link");
      symlinkSync(target, link, "dir");
      const res = classifyGhostWorktreeDir(link);
      assert.equal(res.safe, false);
      if (!res.safe) assert.equal(res.reason, "symlink");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pruneOrphanedWorktreeShells / runWorktreePrune (#1504)", () => {
  it("removes an unregistered .pi-only ghost directory under .worktrees during prune", async () => {
    const dir = makeTempDir("wt-ghost-prune-");
    try {
      const repoDir = initTempGitRepo(dir);
      const ghostDir = join(repoDir, ".worktrees", "ghost-pi");
      mkdirSync(join(ghostDir, ".pi", "tmp"), { recursive: true });
      mkdirSync(join(ghostDir, ".pi", "data"), { recursive: true });
      writeFileSync(join(ghostDir, ".pi", "tmp", "scratch.txt"), "tmp\n");

      const res = await runWorktreePrune(repoDir);
      assert.equal(res.ok, true);
      assert.deepEqual(res.removedGhosts, ["ghost-pi"]);
      assert.deepEqual(res.skippedGhosts, []);
      assert.equal(existsSync(ghostDir), false);
      assert.match(res.message, /ghost-pi/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes an unregistered graft-only ghost directory under .worktrees during prune", async () => {
    const dir = makeTempDir("wt-ghost-prune-");
    try {
      const repoDir = initTempGitRepo(dir);
      const ghostDir = join(repoDir, ".worktrees", "ghost-graft");
      mkdirSync(ghostDir, { recursive: true });
      writeFileSync(join(ghostDir, "graft"), "leftover\n");

      const res = await runWorktreePrune(repoDir);
      assert.equal(res.ok, true);
      assert.deepEqual(res.removedGhosts, ["ghost-graft"]);
      assert.equal(existsSync(ghostDir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never removes a registered worktree even if its filesystem only holds .pi", async () => {
    const dir = makeTempDir("wt-ghost-reg-");
    try {
      const repoDir = initTempGitRepo(dir);
      const registeredWt = join(repoDir, ".worktrees", "active-wt");
      mkdirSync(join(registeredWt, ".pi", "tmp"), { recursive: true });

      const porcelain = [
        `worktree ${repoDir}`,
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "",
        `worktree ${registeredWt}`,
        "HEAD 2222222222222222222222222222222222222222",
        "branch refs/heads/feat/active",
        "",
      ].join("\n");
      const mockRunner: GitAsyncRunner = async (args) => {
        if (args[0] === "worktree" && args[1] === "list") return { stdout: porcelain, stderr: "", code: 0 };
        if (args[0] === "worktree" && args[1] === "prune") return { stdout: "", stderr: "", code: 0 };
        return { stdout: "", stderr: "", code: 0 };
      };

      const res = await runWorktreePrune(repoDir, { runGitAsync: mockRunner });
      assert.equal(res.ok, true);
      assert.deepEqual(res.removedGhosts, []);
      assert.equal(existsSync(registeredWt), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips an unregistered directory containing user files under .worktrees", async () => {
    const dir = makeTempDir("wt-ghost-userfile-");
    try {
      const repoDir = initTempGitRepo(dir);
      const userDir = join(repoDir, ".worktrees", "keep-notes");
      mkdirSync(join(userDir, ".pi", "tmp"), { recursive: true });
      writeFileSync(join(userDir, "notes.txt"), "important user data\n");

      const res = await runWorktreePrune(repoDir);
      assert.equal(res.ok, true);
      assert.deepEqual(res.removedGhosts, []);
      assert.deepEqual(res.skippedGhosts, ["keep-notes"]);
      assert.equal(existsSync(join(userDir, "notes.txt")), true);
      assert.match(res.message, /Skipped 1 unregistered dir/);
      assert.match(res.message, /keep-notes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips an unregistered directory containing a source subdirectory under .worktrees", async () => {
    const dir = makeTempDir("wt-ghost-srcdir-");
    try {
      const repoDir = initTempGitRepo(dir);
      const srcDir = join(repoDir, ".worktrees", "keep-src");
      mkdirSync(join(srcDir, "src"), { recursive: true });
      writeFileSync(join(srcDir, "src", "index.ts"), "export const x = 1;\n");

      const res = await runWorktreePrune(repoDir);
      assert.equal(res.ok, true);
      assert.deepEqual(res.removedGhosts, []);
      assert.deepEqual(res.skippedGhosts, ["keep-src"]);
      assert.equal(existsSync(join(srcDir, "src", "index.ts")), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never follows or deletes a symlink under .worktrees pointing outside the repo", async () => {
    const dir = makeTempDir("wt-ghost-symlink-");
    try {
      const repoDir = initTempGitRepo(dir);
      const outsideDir = join(dir, "outside-target");
      mkdirSync(join(outsideDir, ".pi", "tmp"), { recursive: true });
      writeFileSync(join(outsideDir, ".pi", "tmp", "precious.txt"), "do not touch\n");

      const worktreesDir = join(repoDir, ".worktrees");
      mkdirSync(worktreesDir, { recursive: true });
      const linkPath = join(worktreesDir, "escape-link");
      symlinkSync(outsideDir, linkPath, "dir");

      const res = await runWorktreePrune(repoDir);
      assert.equal(res.ok, true);
      assert.deepEqual(res.removedGhosts, []);
      assert.deepEqual(res.skippedGhosts, ["escape-link"]);
      assert.equal(existsSync(linkPath), true);
      assert.equal(readFileSync(join(outsideDir, ".pi", "tmp", "precious.txt"), "utf-8"), "do not touch\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed without deleting ghost directories when git worktree list fails", async () => {
    const dir = makeTempDir("wt-ghost-failclosed-");
    try {
      const repoDir = initTempGitRepo(dir);
      const ghostDir = join(repoDir, ".worktrees", "ghost-untouched");
      mkdirSync(join(ghostDir, ".pi", "tmp"), { recursive: true });

      const failingListRunner: GitAsyncRunner = async (args) => {
        if (args[0] === "worktree" && args[1] === "prune") return { stdout: "", stderr: "", code: 0 };
        if (args[0] === "worktree" && args[1] === "list") {
          return { stdout: "", stderr: "fatal: lock file exists", code: 128 };
        }
        return { stdout: "", stderr: "", code: 0 };
      };

      const direct = await pruneOrphanedWorktreeShells(repoDir, { runGitAsync: failingListRunner });
      assert.equal(direct.ok, false);
      assert.deepEqual(direct.removed, []);
      assert.equal(existsSync(ghostDir), true);

      const pruned = await runWorktreePrune(repoDir, { runGitAsync: failingListRunner });
      assert.equal(pruned.ok, false);
      assert.deepEqual(pruned.removedGhosts, []);
      assert.equal(existsSync(ghostDir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sweeps ghost directories under the main repo .worktrees when invoked from a linked worktree", async () => {
    const dir = makeTempDir("wt-ghost-from-linked-");
    try {
      const repoDir = initTempGitRepo(dir);
      const linkedWt = join(repoDir, ".worktrees", "live-linked");
      execFileSync("git", ["worktree", "add", "-q", "-b", "feat/live", linkedWt], { cwd: repoDir, stdio: "ignore" });
      const ghostDir = join(repoDir, ".worktrees", "dead-ghost");
      mkdirSync(join(ghostDir, ".pi", "memory"), { recursive: true });

      const res = await runWorktreePrune(linkedWt);
      assert.equal(res.ok, true);
      assert.deepEqual(res.removedGhosts, ["dead-ghost"]);
      assert.equal(existsSync(ghostDir), false);
      assert.equal(existsSync(linkedWt), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes removedGhosts through worktree_status prune tool", async () => {
    const dir = makeTempDir("wt-ghost-tool-");
    try {
      const repoDir = initTempGitRepo(dir);
      const ghostDir = join(repoDir, ".worktrees", "tool-ghost");
      mkdirSync(join(ghostDir, ".pi", "tmp"), { recursive: true });

      let toolDef: any = null;
      const mockPi: any = {
        registerCommand() {},
        registerTool(def: any) {
          if (def.name === "worktree_status") toolDef = def;
        },
        events: { emit() {} },
      };
      withSubagentChildEnv(undefined, () => {
        registerWorktree(mockPi);
      });
      assert.ok(toolDef, "worktree_status tool should be registered");

      const result = await toolDef.execute("call-1", { action: "prune" }, undefined, undefined, { cwd: repoDir });
      assert.equal(result.details.ok, true);
      assert.deepEqual(result.details.removedGhosts, ["tool-ghost"]);
      assert.equal(existsSync(ghostDir), false);
      assert.match(result.content[0].text, /tool-ghost/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes removedGhosts through PiDash pruneWorktreesOp", async () => {
    const dir = makeTempDir("wt-ghost-pidash-");
    try {
      const repoDir = initTempGitRepo(dir);
      const ghostDir = join(repoDir, ".worktrees", "pidash-ghost");
      mkdirSync(join(ghostDir, ".pi", "tmp"), { recursive: true });

      const res = await pruneWorktreesOp(repoDir);
      assert.equal(res.op, "prune");
      assert.equal(res.ok, true);
      assert.deepEqual(res.removedGhosts, ["pidash-ghost"]);
      assert.deepEqual(res.skippedGhosts, []);
      assert.equal(existsSync(ghostDir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("executeGuardedWorktreeRemove ghost cleanup (#1504)", () => {
  it("cleans up leftover .pi ghost directory after git worktree remove unregisters the worktree", async () => {
    const dir = makeTempDir("wt-remove-ghost-");
    try {
      const repoDir = initTempGitRepo(dir);
      const targetWt = join(repoDir, ".worktrees", "feat-ghost");
      mkdirSync(join(targetWt, ".pi", "tmp"), { recursive: true });
      writeFileSync(join(targetWt, ".pi", "tmp", "leftover.log"), "leftover\n");

      let registered = true;
      let changed = 0;
      const runner: GitAsyncRunner = async (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          const blocks = [
            `worktree ${repoDir}\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n`,
          ];
          if (registered) {
            blocks.push(
              `worktree ${targetWt}\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/feat/ghost\n`,
            );
          }
          return { stdout: blocks.join("\n"), stderr: "", code: 0 };
        }
        if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
        if (args[0] === "worktree" && args[1] === "remove") {
          // Simulate git unregistering the worktree then failing rmdir due to .pi/ leftovers
          registered = false;
          return {
            stdout: "",
            stderr: `error: failed to delete '${targetWt}': Directory not empty`,
            code: 255,
          };
        }
        return { stdout: "", stderr: "", code: 0 };
      };

      const res = await executeGuardedWorktreeRemove(repoDir, targetWt, {
        runGitAsync: runner,
        readLivePeers: () => [],
        onWorktreesChanged: () => { changed++; },
      });
      assert.equal(res.ok, true);
      assert.equal(res.cleanedGhost, true);
      assert.equal(existsSync(targetWt), false);
      assert.equal(changed, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses ghost cleanup when git worktree remove fails before unregistering", async () => {
    const dir = makeTempDir("wt-remove-stillreg-");
    try {
      const repoDir = initTempGitRepo(dir);
      const targetWt = join(repoDir, ".worktrees", "still-reg");
      mkdirSync(join(targetWt, ".pi", "tmp"), { recursive: true });

      const porcelain = [
        `worktree ${repoDir}`,
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "",
        `worktree ${targetWt}`,
        "HEAD 2222222222222222222222222222222222222222",
        "branch refs/heads/feat/still-reg",
        "",
      ].join("\n");
      const runner: GitAsyncRunner = async (args) => {
        if (args[0] === "worktree" && args[1] === "list") return { stdout: porcelain, stderr: "", code: 0 };
        if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
        if (args[0] === "worktree" && args[1] === "remove") {
          return { stdout: "", stderr: "fatal: working trees containing submodules cannot be moved or removed", code: 128 };
        }
        return { stdout: "", stderr: "", code: 0 };
      };

      const res = await executeGuardedWorktreeRemove(repoDir, targetWt, {
        runGitAsync: runner,
        readLivePeers: () => [],
      });
      assert.equal(res.ok, false);
      assert.equal(existsSync(targetWt), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses ghost cleanup when leftover directory contains non-allowlisted user files", async () => {
    const dir = makeTempDir("wt-remove-nonallow-");
    try {
      const repoDir = initTempGitRepo(dir);
      const targetWt = join(repoDir, ".worktrees", "has-notes");
      mkdirSync(join(targetWt, ".pi", "tmp"), { recursive: true });
      writeFileSync(join(targetWt, "notes.txt"), "do not delete\n");

      let registered = true;
      const runner: GitAsyncRunner = async (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          const blocks = [
            `worktree ${repoDir}\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n`,
          ];
          if (registered) {
            blocks.push(
              `worktree ${targetWt}\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/feat/notes\n`,
            );
          }
          return { stdout: blocks.join("\n"), stderr: "", code: 0 };
        }
        if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
        if (args[0] === "worktree" && args[1] === "remove") {
          registered = false;
          return { stdout: "", stderr: "error: failed to delete: Directory not empty", code: 255 };
        }
        return { stdout: "", stderr: "", code: 0 };
      };

      const res = await executeGuardedWorktreeRemove(repoDir, targetWt, {
        runGitAsync: runner,
        readLivePeers: () => [],
      });
      assert.equal(res.ok, false);
      assert.equal(existsSync(join(targetWt, "notes.txt")), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("per-worktree getProjectTmpDir isolation (#1504)", () => {
  it("preserves per-worktree getProjectTmpDir isolation", () => {
    const dir = makeTempDir("wt-tmpdir-iso-");
    try {
      const repoDir = initTempGitRepo(dir);
      const wtDir = join(repoDir, ".worktrees", "isolated-wt");
      execFileSync("git", ["worktree", "add", "-q", "-b", "feat/iso", wtDir], { cwd: repoDir, stdio: "ignore" });

      const mainTmp = getProjectTmpDir(repoDir);
      const wtTmp = getProjectTmpDir(wtDir);
      assert.equal(mainTmp, join(repoDir, ".pi", "tmp"));
      assert.equal(wtTmp, join(wtDir, ".pi", "tmp"));
      assert.notEqual(mainTmp, wtTmp);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
