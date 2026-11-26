import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accessSync } from "node:fs";

import { resolveExtensionPath, resolveExtensionPathDetailed } from "../../src/provider-runtime.js";

describe("provider extension integration", () => {
  it("resolves the vertex-claude extension path from @myk-org/pi-vertex-claude", () => {
    const result = resolveExtensionPathDetailed(
      "UNUSED_ENV_" + Date.now(),
      "@myk-org/pi-vertex-claude",
      "index.ts",
    );
    assert.equal(result.error, undefined, `should resolve without error, got: ${result.error}`);
    assert.ok(result.path.length > 0, "extension path should resolve");
    assert.ok(
      result.path.replaceAll("\\", "/").endsWith("index.ts"),
      `should end with extension entry file, got: ${result.path}`,
    );
    assert.doesNotThrow(() => accessSync(result.path), `extension file should exist at: ${result.path}`);
  });

  it("respects env var override for provider extension path", () => {
    const envVar = "TEST_VERTEX_EXT_PATH_" + Date.now();
    try {
      process.env[envVar] = "/custom/override/vertex/index.ts";
      const result = resolveExtensionPath(envVar, "@myk-org/pi-vertex-claude", "index.ts");
      assert.equal(result, "/custom/override/vertex/index.ts", "should use env var when set");
    } finally {
      delete process.env[envVar];
    }
  });
});
