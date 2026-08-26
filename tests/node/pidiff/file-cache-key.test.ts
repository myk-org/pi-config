/**
 * Pierre MultiFileDiff cache keys must include contents, not just path.
 * Run with: npx tsx --test tests/node/pidiff/file-cache-key.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pierreFileCacheKey } from "../../../extensions/pidiff/pidiff-ui/src/lib/file-cache-key.ts";

describe("pierreFileCacheKey", () => {
  it("is stable for the same name and contents", () => {
    assert.equal(
      pierreFileCacheKey("src/App.tsx", "const x = 1;"),
      pierreFileCacheKey("src/App.tsx", "const x = 1;"),
    );
  });

  it("changes when contents change", () => {
    const a = pierreFileCacheKey("src/App.tsx", "const x = 1;");
    const b = pierreFileCacheKey("src/App.tsx", "const x = 2;");
    assert.notEqual(a, b);
  });

  it("changes when the path changes", () => {
    const a = pierreFileCacheKey("a.ts", "same");
    const b = pierreFileCacheKey("b.ts", "same");
    assert.notEqual(a, b);
  });

  it("includes the file name as a prefix", () => {
    const key = pierreFileCacheKey("foo/bar.ts", "hello");
    assert.ok(key.startsWith("foo/bar.ts:"));
  });

  it("is stable for empty contents", () => {
    assert.equal(pierreFileCacheKey("empty.ts", ""), pierreFileCacheKey("empty.ts", ""));
  });

  it("distinguishes empty contents from a non-empty file of the same name", () => {
    assert.notEqual(pierreFileCacheKey("a.ts", ""), pierreFileCacheKey("a.ts", "x"));
  });

  it("distinguishes empty names that share contents", () => {
    assert.notEqual(pierreFileCacheKey("", "same"), pierreFileCacheKey("named.ts", "same"));
  });

  it("does not collide on djb2 pairs such as Aa vs BB", () => {
    assert.notEqual(pierreFileCacheKey("f.ts", "Aa"), pierreFileCacheKey("f.ts", "BB"));
  });
});
