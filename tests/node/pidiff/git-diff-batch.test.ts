/**
 * Tests for batched git cat-file reading, diff status parsing, and worktree parsing (#1263, #1273).
 * Run with: npx tsx --test tests/node/pidiff/git-diff-batch.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  batchReadGitObjects,
  parseCatFileBatch,
  parseDiffEntries,
  parseWorktreeList,
} from "../../../scripts/pidiff-git-diff.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";

describe("parseDiffEntries", () => {
  it("parses added, modified, deleted, and renamed entries", () => {
    const raw = [
      "A\tnew.ts",
      "M\texisting.ts",
      "D\told.ts",
      "R100\tsrc/old-name.ts\tsrc/new-name.ts",
      "",
    ].join("\n");
    assert.deepStrictEqual(parseDiffEntries(raw), [
      { name: "new.ts", oldName: "new.ts", status: "added" },
      { name: "existing.ts", oldName: "existing.ts", status: "modified" },
      { name: "old.ts", oldName: "old.ts", status: "deleted" },
      { name: "src/new-name.ts", oldName: "src/old-name.ts", status: "renamed" },
    ]);
  });
});

describe("parseCatFileBatch", () => {
  it("slices by UTF-8 byte length and handles missing/non-blob entries", () => {
    const utf8Text = "hello 🚀 日本語 ── world\n";
    const utf8Bytes = Buffer.from(utf8Text, "utf-8");
    const asciiText = "plain";
    const asciiBytes = Buffer.from(asciiText, "utf-8");

    const output = Buffer.concat([
      Buffer.from(`abc123 blob ${utf8Bytes.length}\n`, "utf-8"),
      utf8Bytes,
      Buffer.from("\n", "utf-8"),
      Buffer.from("HEAD:missing.ts missing\n", "utf-8"),
      Buffer.from(`def456 tree 4\n1234\n`, "utf-8"),
      Buffer.from(`7890ab blob ${asciiBytes.length}\n`, "utf-8"),
      asciiBytes,
      Buffer.from("\n", "utf-8"),
    ]);

    const parsed = parseCatFileBatch(
      ["HEAD:utf8.ts", "HEAD:missing.ts", "HEAD:dir", "HEAD:ascii.ts"],
      output,
    );
    assert.equal(parsed.get("HEAD:utf8.ts"), utf8Text);
    assert.equal(parsed.has("HEAD:missing.ts"), false);
    assert.equal(parsed.has("HEAD:dir"), false);
    assert.equal(parsed.get("HEAD:ascii.ts"), asciiText);
  });
});

describe("batchReadGitObjects", () => {
  it("reads committed and staged blobs in one git cat-file --batch call", () => {
    const dir = makeTempDir("pidiff-catfile-");
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    try {
      git(["init"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test"]);

      const utf8Content = "const greeting = 'שלום 🌍 — café';\n";
      writeFileSync(join(dir, "a.ts"), "v1\n", "utf-8");
      writeFileSync(join(dir, "u.ts"), utf8Content, "utf-8");
      git(["add", "a.ts", "u.ts"]);
      git(["commit", "-m", "init"]);

      // Stage a change to a.ts without committing so :a.ts differs from HEAD:a.ts
      writeFileSync(join(dir, "a.ts"), "v2-staged\n", "utf-8");
      git(["add", "a.ts"]);

      const blobs = batchReadGitObjects("git", dir, [
        "HEAD:a.ts",
        ":a.ts",
        "HEAD:u.ts",
        "HEAD:u.ts", // duplicate spec
        "HEAD:does-not-exist.ts",
      ]);

      assert.equal(blobs.get("HEAD:a.ts"), "v1\n");
      assert.equal(blobs.get(":a.ts"), "v2-staged\n");
      assert.equal(blobs.get("HEAD:u.ts"), utf8Content);
      assert.equal(blobs.has("HEAD:does-not-exist.ts"), false);
      assert.equal(batchReadGitObjects("git", dir, []).size, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("matches git show for a changed gitlink whose commit object is locally available", () => {
    const dir = makeTempDir("pidiff-gitlink-");
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    try {
      git(["init"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test"]);

      writeFileSync(join(dir, "readme.txt"), "root\n", "utf-8");
      git(["add", "readme.txt"]);
      git(["commit", "-m", "base commit"]);
      const localCommit = git(["rev-parse", "HEAD"]).trim();

      // Add a gitlink (mode 160000) pointing at a commit object present in this repo's ODB
      git(["update-index", "--add", "--cacheinfo", `160000,${localCommit},submod`]);
      git(["commit", "-m", "add gitlink"]);

      const expected = git(["show", "HEAD:submod"]);
      const blobs = batchReadGitObjects("git", dir, ["HEAD:submod", "HEAD:readme.txt"]);
      assert.equal(blobs.get("HEAD:readme.txt"), "root\n");
      assert.equal(blobs.get("HEAD:submod"), expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseWorktreeList", () => {
  it("parses main, linked, and detached worktrees from porcelain output", () => {
    const raw = [
      "worktree /repo/main",
      "HEAD 1111111",
      "branch refs/heads/main",
      "",
      "worktree /repo/wt-feature",
      "HEAD 2222222",
      "branch refs/heads/feat/demo",
      "",
      "worktree /repo/wt-detached",
      "HEAD 3333333",
      "detached",
      "",
    ].join("\n");

    assert.deepStrictEqual(parseWorktreeList(raw), [
      { path: "/repo/main", head: "1111111", branch: "main", isMain: true },
      { path: "/repo/wt-feature", head: "2222222", branch: "feat/demo", isMain: false },
      { path: "/repo/wt-detached", head: "3333333", branch: "(detached)", isMain: false },
    ]);
  });
});
