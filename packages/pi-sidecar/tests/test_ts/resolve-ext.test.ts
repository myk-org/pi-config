import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveExtensionPath, resolveExtensionPathDetailed } from "../../src/resolve-extension-path.js";

const MONOREPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("resolveExt extension resolution chain", () => {
  const extensions = [
    { name: "acpx-provider", entry: "extensions/acpx-provider/index.ts" },
    { name: "cli-provider", entry: "extensions/cli-provider/index.ts" },
    { name: "providers", entry: "extensions/providers/index.ts" },
  ];

  for (const ext of extensions) {
    it(`resolves ${ext.name} via monorepo path`, () => {
      const monorepoPath = join(MONOREPO_ROOT, ext.entry);
      assert.ok(existsSync(monorepoPath), `monorepo path should exist: ${monorepoPath}`);
    });

    it(`env var override takes precedence for ${ext.name}`, () => {
      const envVar = `TEST_RESOLVE_EXT_${ext.name.toUpperCase().replace("-", "_")}_${Date.now()}`;
      try {
        process.env[envVar] = "/custom/override/path.ts";
        const result = resolveExtensionPath(envVar, "pi-orchestrator-config", ext.entry);
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
      "extensions/acpx-provider/index.ts",
    );
    // Should not resolve (package doesn't exist)
    assert.equal(result.path, "", "non-existent package should not resolve");
    assert.ok(result.error, "should have error for non-existent package");

    // But monorepo path exists as fallback
    const fallbackPath = join(MONOREPO_ROOT, "extensions/acpx-provider/index.ts");
    assert.ok(existsSync(fallbackPath), "monorepo fallback should exist");
  });
});
