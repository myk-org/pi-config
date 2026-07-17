/**
 * Tests for open-PR parsing / cache helpers used by the status line.
 * Run with: npx tsx --test tests/node/orchestrator/git-helpers-open-pr.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  clearOpenPrCache,
  getOpenPr,
  parseOpenPrJson,
  refreshOpenPr,
  seedOpenPrCacheForTests,
  setGhPrViewRunner,
} from "../../../extensions/orchestrator/git-helpers.js";

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

function initGithubRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "open-pr-"));
  execFileSync("git", ["init", "-b", "main"], {
    cwd: dir,
    stdio: "ignore",
    env: GIT_ENV,
  });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
    cwd: dir,
    stdio: "ignore",
    env: GIT_ENV,
  });
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://github.com/org/repo.git"],
    { cwd: dir, stdio: "ignore", env: GIT_ENV },
  );
  return dir;
}

function openPrJson(
  number: number,
  url = `https://github.com/org/repo/pull/${number}`,
  state = "OPEN",
): string {
  return JSON.stringify({ number, url, state });
}

describe("parseOpenPrJson", () => {
  it("parses valid open PR", () => {
    const pr = parseOpenPrJson(
      openPrJson(42, "https://github.com/org/repo/pull/42"),
    );
    assert.deepEqual(pr, {
      number: 42,
      url: "https://github.com/org/repo/pull/42",
    });
  });

  it("returns null for missing fields", () => {
    assert.equal(parseOpenPrJson(JSON.stringify({ number: 1 })), null);
    assert.equal(parseOpenPrJson(JSON.stringify({ url: "https://x" })), null);
    assert.equal(
      parseOpenPrJson(JSON.stringify({ number: 1, url: "", state: "OPEN" })),
      null,
    );
  });

  it("returns null for closed or merged state", () => {
    assert.equal(
      parseOpenPrJson(openPrJson(1, "https://github.com/org/repo/pull/1", "CLOSED")),
      null,
    );
    assert.equal(
      parseOpenPrJson(openPrJson(1, "https://github.com/org/repo/pull/1", "MERGED")),
      null,
    );
  });

  it("returns null for unsafe url or non-integer number", () => {
    assert.equal(
      parseOpenPrJson(
        JSON.stringify({ number: 1.5, url: "https://github.com/o/r/pull/1", state: "OPEN" }),
      ),
      null,
    );
    assert.equal(
      parseOpenPrJson(
        JSON.stringify({ number: 1, url: "javascript:alert(1)", state: "OPEN" }),
      ),
      null,
    );
  });

  it("returns null for invalid JSON", () => {
    assert.equal(parseOpenPrJson("not-json"), null);
  });
});

describe("clearOpenPrCache", () => {
  beforeEach(() => {
    clearOpenPrCache();
  });

  it("is safe to call when empty", () => {
    clearOpenPrCache();
  });
});

describe("getOpenPr / refreshOpenPr", () => {
  let repo: string;

  beforeEach(() => {
    clearOpenPrCache();
    setGhPrViewRunner(null);
    repo = initGithubRepo();
  });

  afterEach(() => {
    setGhPrViewRunner(null);
    clearOpenPrCache();
    rmSync(repo, { recursive: true, force: true });
  });

  it("returns null from empty cache without calling gh", () => {
    setGhPrViewRunner(async () => {
      throw new Error("gh should not run for sync getOpenPr");
    });
    assert.equal(getOpenPr(repo, "main"), null);
  });

  it("refreshOpenPr caches result for getOpenPr", async () => {
    setGhPrViewRunner(async () => openPrJson(7));
    const pr = await refreshOpenPr(repo, "main");
    assert.deepEqual(pr, {
      number: 7,
      url: "https://github.com/org/repo/pull/7",
    });
    assert.deepEqual(getOpenPr(repo, "main"), pr);
  });

  it("refreshOpenPr reuses cached PR within TTL", async () => {
    let nextNumber = 7;
    setGhPrViewRunner(async () => openPrJson(nextNumber++));
    assert.equal((await refreshOpenPr(repo, "main"))?.number, 7);
    assert.equal(
      (await refreshOpenPr(repo, "main"))?.number,
      7,
      "TTL hit must reuse cached PR",
    );
  });

  it("coalesces concurrent refreshOpenPr calls", async () => {
    let resolveGh!: (v: string) => void;
    const gate = new Promise<string>((r) => {
      resolveGh = r;
    });
    setGhPrViewRunner(async () => gate);
    const a = refreshOpenPr(repo, "main");
    const b = refreshOpenPr(repo, "main");
    resolveGh(openPrJson(9));
    const [pa, pb] = await Promise.all([a, b]);
    assert.deepEqual(pa, pb);
    assert.equal(pa?.number, 9);
  });

  it("refreshOpenPr stores null on gh failure", async () => {
    let shouldFail = true;
    setGhPrViewRunner(async () => {
      if (shouldFail) throw new Error("gh failed");
      return openPrJson(1);
    });
    assert.equal(await refreshOpenPr(repo, "main"), null);
    assert.equal(getOpenPr(repo, "main"), null);
    shouldFail = false;
    assert.equal(
      await refreshOpenPr(repo, "main"),
      null,
      "null result still cached for TTL",
    );
  });

  it("returns stale cache until refresh completes", async () => {
    seedOpenPrCacheForTests(repo, "main", {
      at: Date.now() - 60_000,
      pr: { number: 3, url: "https://github.com/org/repo/pull/3" },
    });
    assert.equal(getOpenPr(repo, "main")?.number, 3);

    setGhPrViewRunner(async () => openPrJson(4));
    const fresh = await refreshOpenPr(repo, "main");
    assert.equal(fresh?.number, 4);
    assert.equal(getOpenPr(repo, "main")?.number, 4);
  });
});
