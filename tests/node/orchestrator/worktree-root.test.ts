/**
 * Worktree resolution — the git probe both consumers depend on.
 *
 * tryResolveWorktreeRoot must distinguish a real worktree from a plain
 * directory, because resolveWorktreeRoot deliberately collapses the two: it
 * returns the cwd either way. Callers that care (Graft's not-a-worktree path)
 * use the try variant, and it had no direct test — the Graft tests inject a
 * replacement, so the real implementation was never exercised.
 *
 * Run with: npx tsx --test tests/node/orchestrator/worktree-root.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tryResolveWorktreeRoot, resolveWorktreeRoot } from "../../../extensions/orchestrator/utils.js";

let base: string;

function makeRepo(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
  return dir;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "worktree-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("tryResolveWorktreeRoot", () => {
  it("returns the toplevel for a real repository", () => {
    const repo = makeRepo("repo");
    // resolve to the real path: macOS temp dirs are symlinked (/var -> /private/var)
    const real = execFileSync("python3", ["-c", "import os,sys;print(os.path.realpath(sys.argv[1]))", repo], { encoding: "utf-8" }).trim();
    assert.equal(tryResolveWorktreeRoot(repo), real);
  });

  it("resolves from a subdirectory to the repo root", () => {
    const repo = makeRepo("sub");
    const nested = join(repo, "a", "b");
    mkdirSync(nested, { recursive: true });
    const real = execFileSync("python3", ["-c", "import os,sys;print(os.path.realpath(sys.argv[1]))", repo], { encoding: "utf-8" }).trim();
    assert.equal(tryResolveWorktreeRoot(nested), real);
  });

  it("returns null for a plain directory that is not a repository", () => {
    const plain = join(base, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    assert.equal(tryResolveWorktreeRoot(plain), null);
  });

  it("returns null for a non-existent path", () => {
    assert.equal(tryResolveWorktreeRoot(join(base, "does-not-exist")), null);
  });

  it("caches the negative result without re-probing", () => {
    const plain = join(base, "cached");
    mkdirSync(plain, { recursive: true });
    assert.equal(tryResolveWorktreeRoot(plain), null);
    // Turning the directory into a repo must not change the answer, which is how
    // a cache is verified without touching git: the second call short-circuits.
    execFileSync("git", ["init", "-q"], { cwd: plain, stdio: ["ignore", "pipe", "ignore"] });
    assert.equal(tryResolveWorktreeRoot(plain), null, "negative result is cached for the session");
  });
});

describe("resolveWorktreeRoot", () => {
  it("still falls back to the cwd, so existing callers are unaffected", () => {
    const plain = join(base, "fallback");
    mkdirSync(plain, { recursive: true });
    assert.equal(resolveWorktreeRoot(plain), plain);
  });
});
