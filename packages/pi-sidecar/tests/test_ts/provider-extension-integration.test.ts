import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accessSync } from "node:fs";

import { resolveExtensionPath, resolveExtensionPathDetailed } from "../../src/resolve-extension-path.js";

describe("unified provider extension integration", () => {
  it("resolves the providers extension path from pi-orchestrator-config (or gracefully skips when not yet available)", () => {
    const result = resolveExtensionPathDetailed(
      "UNUSED_ENV_" + Date.now(),
      "pi-orchestrator-config",
      "extensions/providers/index.ts",
    );
    if (!result.path) {
      // Package itself unresolved — assert sensible error, not a crash.
      assert.ok(result.error, "should have an error message when path cannot be resolved");
      return;
    }
    // resolveExtensionPathDetailed joins pkg root + entry without existence check.
    // Upstream may not have shipped extensions/providers/index.ts yet (pi-config#689).
    try {
      accessSync(result.path);
    } catch {
      assert.ok(
        result.path.replaceAll("\\", "/").endsWith("extensions/providers/index.ts"),
        `path should still end with entry file even when missing, got: ${result.path}`,
      );
      return;
    }
    assert.ok(result.path.length > 0, "extension path should resolve");
    assert.ok(
      result.path.replaceAll("\\", "/").endsWith("extensions/providers/index.ts"),
      `should end with extension entry file, got: ${result.path}`,
    );
  });

  it("respects SIDECAR_PROVIDER_EXTENSION_PATH env override", () => {
    const envVar = "TEST_PROVIDER_EXT_PATH_" + Date.now();
    try {
      process.env[envVar] = "/custom/override/providers/index.ts";
      const result = resolveExtensionPath(envVar, "pi-orchestrator-config", "extensions/providers/index.ts");
      assert.equal(result, "/custom/override/providers/index.ts", "should use env var when set");
    } finally {
      delete process.env[envVar];
    }
  });
});
