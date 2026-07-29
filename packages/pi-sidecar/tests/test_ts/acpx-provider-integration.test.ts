import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accessSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

import { resolveExtensionPath } from "../../src/resolve-extension-path.js";

const MONOREPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("acpx-provider extension integration", () => {
  it("resolves the acpx-provider extension path from monorepo root", () => {
    const extPath = join(MONOREPO_ROOT, "extensions/acpx-provider/index.ts");
    assert.ok(extPath.length > 0, "extension path should resolve");
    assert.ok(
      extPath.replaceAll("\\", "/").endsWith("extensions/acpx-provider/index.ts"),
      `should end with extension entry file, got: ${extPath}`,
    );
    assert.doesNotThrow(() => accessSync(extPath), `extension file should exist at: ${extPath}`);
  });

  it("respects SIDECAR_ACPX_EXTENSION_PATH-style env override", () => {
    const envVar = "TEST_ACPX_PROVIDER_EXT_PATH_" + Date.now();
    try {
      process.env[envVar] = "/custom/override/acpx-provider/index.ts";
      const result = resolveExtensionPath(envVar, "pi-orchestrator-config", "extensions/acpx-provider/index.ts");
      assert.equal(result, "/custom/override/acpx-provider/index.ts", "should use env var when set");
    } finally {
      delete process.env[envVar];
    }
  });

  it("exports discoverAcpxModels from the same entry file used for the extension (no separate discover.ts)", () => {
    const extPath = join(MONOREPO_ROOT, "extensions/acpx-provider/index.ts");
    assert.ok(extPath.length > 0, "extension path should resolve");

    // Load the module only to assert the export shape — do NOT call
    // discoverAcpxModels() here (that would hit acpx/runtime / real agents).
    const jiti = createJiti(import.meta.url);
    const mod = jiti(extPath) as {
      discoverAcpxModels?: (agent: string, cwd?: string) => Promise<Array<{ id: string; name: string; provider: string }>>;
      default?: { discoverAcpxModels: (agent: string, cwd?: string) => Promise<Array<{ id: string; name: string; provider: string }>> };
    };
    const discoverAcpxModels = mod.discoverAcpxModels ?? mod.default?.discoverAcpxModels;
    assert.equal(typeof discoverAcpxModels, "function", "discoverAcpxModels should be exported");
  });
});
