/**
 * Tests for async porcelain=v1 -b git status parsing and equality check (#1168).
 */
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getGitStatus,
  gitStatusEqual,
  parseGitStatusPorcelainB,
  shouldPublishPeriodicGitStatus,
} from "../../../extensions/pidash/pidash.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";

describe("parseGitStatusPorcelainB", () => {
  it("parses clean branch with upstream", () => {
    assert.deepEqual(parseGitStatusPorcelainB("## main...origin/main\n"), {
      branch: "main",
      dirty: false,
      changes: 0,
    });
  });

  it("parses dirty branch with ahead/behind metadata", () => {
    assert.deepEqual(
      parseGitStatusPorcelainB("## perf/wt6...origin/perf/wt6 [ahead 1, behind 2]\n M a.ts\n?? b.ts\n"),
      { branch: "perf/wt6", dirty: true, changes: 2 },
    );
  });

  it("parses unborn branch header", () => {
    assert.deepEqual(parseGitStatusPorcelainB("## No commits yet on main\nA  init.ts\n"), {
      branch: "main",
      dirty: true,
      changes: 1,
    });
  });

  it("returns empty branch for detached HEAD", () => {
    assert.deepEqual(parseGitStatusPorcelainB("## HEAD (no branch)\n M foo.ts\n"), {
      branch: "",
      dirty: true,
      changes: 1,
    });
  });

  it("handles empty output", () => {
    assert.deepEqual(parseGitStatusPorcelainB(""), {
      branch: "",
      dirty: false,
      changes: 0,
    });
  });
});

describe("gitStatusEqual", () => {
  it("treats null as unequal and compares all fields", () => {
    const base = { branch: "main", dirty: false, changes: 0 };
    assert.equal(gitStatusEqual(null, base), false);
    assert.equal(gitStatusEqual(base, { branch: "main", dirty: false, changes: 0 }), true);
    assert.equal(gitStatusEqual(base, { branch: "dev", dirty: false, changes: 0 }), false);
    assert.equal(gitStatusEqual(base, { branch: "main", dirty: true, changes: 1 }), false);
  });
});

describe("shouldPublishPeriodicGitStatus", () => {
  it("drops stale async results when sessionEpoch changed during await", () => {
    const base = {
      shuttingDown: false,
      connected: true,
      sameSocket: true,
      startEpoch: 1,
      currentEpoch: 1,
      lastGitStatus: { branch: "old", dirty: false, changes: 0 },
      nextGitStatus: { branch: "new", dirty: true, changes: 1 },
    };
    assert.equal(shouldPublishPeriodicGitStatus(base), true);
    assert.equal(shouldPublishPeriodicGitStatus({ ...base, currentEpoch: 2 }), false);
    assert.equal(shouldPublishPeriodicGitStatus({ ...base, sameSocket: false }), false);
    assert.equal(
      shouldPublishPeriodicGitStatus({ ...base, nextGitStatus: { branch: "old", dirty: false, changes: 0 } }),
      false,
    );
  });
});

describe("getGitStatus", () => {
  it("reads branch and dirty state asynchronously in a real git repo", async () => {
    const dir = makeTempDir("pidash-git-status-");
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
      writeFileSync(join(dir, "a.txt"), "hello\n");
      execFileSync("git", ["add", "a.txt"], { cwd: dir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });

      assert.deepEqual(await getGitStatus(dir), { branch: "main", dirty: false, changes: 0 });

      writeFileSync(join(dir, "b.txt"), "untracked\n");
      assert.deepEqual(await getGitStatus(dir), { branch: "main", dirty: true, changes: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
