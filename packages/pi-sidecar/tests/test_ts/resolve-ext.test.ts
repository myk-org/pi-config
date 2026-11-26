import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveExtensionPath, resolveExtensionPathDetailed, resolveExt } from "../../src/provider-runtime.js";

const MONOREPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("resolveExt extension resolution chain", () => {
  const extensions = [
    { name: "vertex-claude", pkg: "@myk-org/pi-vertex-claude", entry: "index.ts", monorepo: "packages/pi-vertex-claude/index.ts" },
  ];

  for (const ext of extensions) {
    it(`resolves ${ext.name} via monorepo path`, () => {
      const monorepoPath = join(MONOREPO_ROOT, ext.monorepo);
      assert.ok(existsSync(monorepoPath), `monorepo path should exist: ${monorepoPath}`);
    });

    it(`env var override takes precedence for ${ext.name}`, () => {
      const envVar = `TEST_RESOLVE_EXT_${ext.name.toUpperCase().replaceAll("-", "_")}_${Date.now()}`;
      try {
        process.env[envVar] = "/custom/override/path.ts";
        const result = resolveExtensionPath(envVar, ext.pkg, ext.entry);
        assert.equal(result, "/custom/override/path.ts", "should use env var when set");
      } finally {
        delete process.env[envVar];
      }
    });
  }

  it("falls back to monorepo path when package is not resolvable", () => {
    // Use a non-existent package name to force the fallback
    const result = resolveExtensionPathDetailed(
      "UNUSED_ENV_" + Date.now(),
      "nonexistent-package-xyz-99999",
      "index.ts",
    );
    // Should not resolve (package doesn't exist)
    assert.equal(result.path, "", "non-existent package should not resolve");
    assert.ok(result.error, "should have error for non-existent package");

    // But monorepo path exists as fallback
    const fallbackPath = join(MONOREPO_ROOT, "packages/pi-vertex-claude/index.ts");
    assert.ok(existsSync(fallbackPath), "monorepo fallback should exist");
  });

  it("resolveExt returns env var override when set", () => {
    const envVar = "TEST_RESOLVE_EXT_DIRECT_" + Date.now();
    try {
      process.env[envVar] = "/override/path/index.ts";
      const result = resolveExt(envVar, "@myk-org/pi-vertex-claude", "index.ts", "packages/pi-vertex-claude/index.ts");
      assert.equal(result, resolve("/override/path/index.ts"), "should use resolved env var path");
    } finally {
      delete process.env[envVar];
    }
  });

  it("resolveExt falls back to monorepo path when package not found", () => {
    const envVar = "TEST_RESOLVE_EXT_FALLBACK_" + Date.now();
    const result = resolveExt(envVar, "nonexistent-pkg-xyz-99999", "index.ts", "packages/pi-vertex-claude/index.ts");
    // Should fall back to monorepo relative path
    assert.ok(result.length > 0, "should return a non-empty path");
    assert.ok(
      result.replaceAll("\\", "/").endsWith("packages/pi-vertex-claude/index.ts"),
      `should end with extension path, got: ${result}`,
    );
    assert.ok(existsSync(result), `monorepo fallback path should exist: ${result}`);
  });

  it("resolveExt resolves via @myk-org/pi-vertex-claude package", () => {
    const envVar = "TEST_RESOLVE_EXT_PKG_" + Date.now();
    const result = resolveExt(envVar, "@myk-org/pi-vertex-claude", "index.ts", "packages/pi-vertex-claude/index.ts");
    assert.ok(result.length > 0, "should resolve to a path");
    assert.ok(
      result.replaceAll("\\", "/").endsWith("index.ts"),
      `should end with extension path, got: ${result}`,
    );
    assert.ok(existsSync(result), `resolved path should exist: ${result}`);
  });
});
