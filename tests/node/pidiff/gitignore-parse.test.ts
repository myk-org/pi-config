/**
 * Tests for pidiff gitignore parsing logic.
 * Validates the output parsing used by getGitIgnoredDirs() in pidiff-server.ts.
 * Run with: npx tsx --test tests/node/pidiff/gitignore-parse.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Replicates the parsing logic from getGitIgnoredDirs() in scripts/pidiff-server.ts.
 * Extracts top-level directory names from `git ls-files -oi --directory --exclude-standard` output.
 */
function parseGitIgnoredDirs(raw: string): Set<string> {
  const dirs = new Set<string>();
  if (!raw.trim()) return dirs;
  for (const line of raw.split("\n")) {
    const trimmed = line.replace(/\/$/, "");
    if (trimmed) {
      // Use "/" not path.sep — git always outputs POSIX separators
      const topLevel = trimmed.split("/")[0];
      if (topLevel) dirs.add(topLevel);
    }
  }
  return dirs;
}

describe("parseGitIgnoredDirs", () => {
  it("extracts top-level dirs from git output", () => {
    const raw = ".venv/\ndist/\n__pycache__/\n.pi/\n";
    const dirs = parseGitIgnoredDirs(raw);
    assert.deepStrictEqual(dirs, new Set([".venv", "dist", "__pycache__", ".pi"]));
  });

  it("handles nested paths — extracts only top-level", () => {
    const raw = "build/lib/\nbuild/dist/\n.tox/py313/\ncoverage/html/\n";
    const dirs = parseGitIgnoredDirs(raw);
    assert.deepStrictEqual(dirs, new Set(["build", ".tox", "coverage"]));
  });

  it("handles empty output", () => {
    const dirs = parseGitIgnoredDirs("");
    assert.strictEqual(dirs.size, 0);
  });

  it("handles whitespace-only output", () => {
    const dirs = parseGitIgnoredDirs("   \n  \n");
    assert.strictEqual(dirs.size, 0);
  });

  it("handles paths without trailing slash", () => {
    const raw = "node_modules\n.venv\n";
    const dirs = parseGitIgnoredDirs(raw);
    assert.deepStrictEqual(dirs, new Set(["node_modules", ".venv"]));
  });

  it("uses POSIX separator — handles Windows-style paths correctly", () => {
    // git always outputs POSIX separators even on Windows
    const raw = "dist/build/\n.venv/lib/python3.13/\n";
    const dirs = parseGitIgnoredDirs(raw);
    assert.deepStrictEqual(dirs, new Set(["dist", ".venv"]));
  });

  it("deduplicates same top-level from multiple nested entries", () => {
    const raw = "dist/\ndist/css/\ndist/js/\ndist/index.html\n";
    const dirs = parseGitIgnoredDirs(raw);
    assert.deepStrictEqual(dirs, new Set(["dist"]));
  });
});
