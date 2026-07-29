import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accessSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

import { resolveExtensionPath } from "../../src/resolve-extension-path.js";

const MONOREPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("cli-provider extension integration", () => {
  it("resolves the cli-provider extension path from monorepo root", () => {
    const extPath = join(MONOREPO_ROOT, "extensions/cli-provider/index.ts");
    assert.ok(extPath.length > 0, "extension path should resolve");
    assert.ok(
      extPath.replaceAll("\\", "/").endsWith("extensions/cli-provider/index.ts"),
      `should end with extension entry file, got: ${extPath}`,
    );
    assert.doesNotThrow(() => accessSync(extPath), `extension file should exist at: ${extPath}`);
  });

  it("respects SIDECAR_CLI_PROVIDER_EXTENSION_PATH-style env override", () => {
    const envVar = "TEST_CLI_PROVIDER_EXT_PATH_" + Date.now();
    try {
      process.env[envVar] = "/custom/override/cli-provider/index.ts";
      const result = resolveExtensionPath(envVar, "pi-orchestrator-config", "extensions/cli-provider/index.ts");
      assert.equal(result, "/custom/override/cli-provider/index.ts", "should use env var when set");
    } finally {
      delete process.env[envVar];
    }
  });

  it("exports discoverCliModels from the cli-provider entrypoint (no live CLI discovery in unit tests)", () => {
    const extPath = join(MONOREPO_ROOT, "extensions/cli-provider/index.ts");
    assert.ok(extPath.length > 0, "extension entry should resolve");

    // Load via the public entry (same path SessionStore uses) — do NOT call
    // discoverCliModels() here (that would spawn/query real CLI agents).
    const jiti = createJiti(import.meta.url);
    const mod = jiti(extPath) as {
      discoverCliModels?: (agent: string) => Promise<Array<{ id: string; name: string; provider: string }>>;
      default?: { discoverCliModels: (agent: string) => Promise<Array<{ id: string; name: string; provider: string }>> };
    };
    const discoverCliModels = mod.discoverCliModels ?? mod.default?.discoverCliModels;
    assert.equal(typeof discoverCliModels, "function", "discoverCliModels should be exported from index.ts");
  });
});
