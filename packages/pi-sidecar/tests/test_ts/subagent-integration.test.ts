import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accessSync } from "node:fs";

import { resolveExtensionPath } from "../../src/resolve-extension-path.js";

describe("subagent extension integration", () => {
  it("resolves the subagent extension path from @earendil-works/pi-coding-agent", () => {
    const extPath = resolveExtensionPath(
      "UNUSED_ENV_" + Date.now(),
      "@earendil-works/pi-coding-agent",
      "examples/extensions/subagent/index.ts",
    );
    assert.ok(extPath.length > 0, "extension path should resolve");
    assert.ok(
      extPath.replaceAll("\\", "/").endsWith("examples/extensions/subagent/index.ts"),
      `should end with extension entry file, got: ${extPath}`,
    );
    // Verify the file actually exists on disk
    assert.doesNotThrow(() => accessSync(extPath), `extension file should exist at: ${extPath}`);
  });

  it("resolves the agents.ts companion module alongside the extension", () => {
    const extPath = resolveExtensionPath(
      "UNUSED_ENV_" + Date.now(),
      "@earendil-works/pi-coding-agent",
      "examples/extensions/subagent/agents.ts",
    );
    assert.ok(extPath.length > 0, "agents.ts path should resolve");
    assert.doesNotThrow(() => accessSync(extPath), `agents.ts should exist at: ${extPath}`);
  });

  it("respects env var override", () => {
    const envVar = "TEST_SUBAGENT_EXT_PATH_" + Date.now();
    try {
      process.env[envVar] = "/custom/override/path.ts";
      const result = resolveExtensionPath(envVar, "@earendil-works/pi-coding-agent", "examples/extensions/subagent/index.ts");
      assert.equal(result, "/custom/override/path.ts", "should use env var when set");
    } finally {
      delete process.env[envVar];
    }
  });

  it("returns empty string for nonexistent package (prerequisite for subagent validation)", async () => {
    // Verifies resolveExtensionPath returns "" for a missing package.
    // The runtime validation in SessionStore.create() uses this to reject
    // sessions requesting tools: ["subagent"] when the extension is unavailable.
    const result = resolveExtensionPath(
      "UNUSED_ENV_" + Date.now(),
      "nonexistent-package-that-will-never-exist-12345",
      "index.ts",
    );
    assert.equal(result, "", "nonexistent package should return empty string");
  });
});
