/**
 * Gitignored path filter for pidiff chokidar watches.
 * Run with: npx tsx --test tests/node/pidiff/gitignore-parse.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isGitIgnoredRelPath,
  parseGitIgnoredWatchFilter,
} from "../../../scripts/pidiff-git-ignore.ts";

describe("parseGitIgnoredWatchFilter", () => {
  it("treats slash-free paths as whole top-level dirs", () => {
    const raw = ".venv/\ndist/\n__pycache__/\n.pi/\n";
    const f = parseGitIgnoredWatchFilter(raw);
    assert.deepStrictEqual(f.topLevel, new Set([".venv", "dist", "__pycache__", ".pi"]));
    assert.deepStrictEqual(f.nested, []);
  });

  it("keeps nested ignores as prefixes, not their top-level parent", () => {
    const raw = "extensions/pidiff/pidiff-ui/node_modules/\nextensions/pidiff/pidiff-ui/dist/\n";
    const f = parseGitIgnoredWatchFilter(raw);
    assert.equal(f.topLevel.size, 0);
    assert.deepStrictEqual(f.nested, [
      "extensions/pidiff/pidiff-ui/dist",
      "extensions/pidiff/pidiff-ui/node_modules",
    ]);
  });

  it("handles empty output", () => {
    const f = parseGitIgnoredWatchFilter("");
    assert.equal(f.topLevel.size, 0);
    assert.deepStrictEqual(f.nested, []);
  });

  it("handles whitespace-only output", () => {
    const f = parseGitIgnoredWatchFilter("   \n  \n");
    assert.equal(f.topLevel.size, 0);
  });

  it("handles paths without trailing slash", () => {
    const f = parseGitIgnoredWatchFilter("node_modules\n.venv\n");
    assert.deepStrictEqual(f.topLevel, new Set(["node_modules", ".venv"]));
  });
});

describe("isGitIgnoredRelPath", () => {
  const filter = parseGitIgnoredWatchFilter(
    "node_modules/\nextensions/pidiff/pidiff-ui/node_modules/\nextensions/pidiff/pidiff-ui/dist/\n",
  );

  it("still skips always-ignored node_modules at repo root", () => {
    assert.equal(isGitIgnoredRelPath("node_modules/foo", filter), true);
  });

  it("does not skip files under extensions/", () => {
    assert.equal(
      isGitIgnoredRelPath("extensions/pidiff/pidiff-ui/src/lib/file-cache-key.ts", filter),
      false,
    );
  });

  it("skips nested node_modules under pidiff-ui", () => {
    assert.equal(
      isGitIgnoredRelPath("extensions/pidiff/pidiff-ui/node_modules/foo/index.js", filter),
      true,
    );
  });
});
