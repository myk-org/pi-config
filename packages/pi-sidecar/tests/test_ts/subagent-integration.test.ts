import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accessSync, rmSync } from "node:fs";

import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";

import { logger } from "../../src/logger.js";
import { resolveExtensionPath } from "../../src/resolve-extension-path.js";
import { SessionStore } from "../../src/sessions.js";
import { makeTempDir } from "./helpers/temp-dirs.js";

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

  it("omits Vertex/Subagent extensions for default sessions and caches Subagent resolution when requested (#1195)", async () => {
    const cwd = makeTempDir("sidecar-ext-cache-");
    const faux = fauxProvider({ provider: "test-ext-cache", models: [{ id: "local" }] });
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    const store = new SessionStore();
    Object.assign(store, {
      internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} },
      modelRuntime: runtime,
      modelRegistry: new ModelRegistry(runtime),
      _ready: true,
    });
    try {
      // 1. Default tools (no "subagent"): loads 0 per-session extensions (neither Vertex nor Subagent).
      const defaultId = await store.create({
        provider: "test-ext-cache",
        model: "local",
        systemPrompt: "hi",
        cwd,
        agentDir: cwd,
      });
      const defaultSession = (store as any).sessions.get(defaultId).session;
      const defaultExts = defaultSession.resourceLoader.getExtensions().extensions;
      assert.equal(defaultExts.length, 0, "default session must not load Vertex or Subagent extensions");
      assert.ok(!defaultSession.getActiveToolNames().includes("subagent"));

      // 2. Requesting "subagent" loads only Subagent (still omits Vertex) and caches resolution across creates.
      const logMessages: string[] = [];
      const origLog = logger.log;
      logger.log = (...args: unknown[]) => {
        logMessages.push(args.map(String).join(" "));
      };
      try {
        const subId1 = await store.create({
          provider: "test-ext-cache",
          model: "local",
          systemPrompt: "hi",
          cwd,
          agentDir: cwd,
          tools: ["read", "subagent"],
        });
        const subId2 = await store.create({
          provider: "test-ext-cache",
          model: "local",
          systemPrompt: "hi",
          cwd,
          agentDir: cwd,
          tools: ["subagent"],
        });
        const subSession1 = (store as any).sessions.get(subId1).session;
        const subExts1 = subSession1.resourceLoader.getExtensions().extensions;
        assert.equal(subExts1.length, 1, "subagent session should load only the Subagent extension");
        assert.ok(subSession1.getActiveToolNames().includes("subagent"));
        assert.ok(!subExts1.some((ext: any) => ext.path.includes("pi-vertex-claude")), "Vertex must not be loaded per session");

        const foundLogs = logMessages.filter((msg) => msg.includes("EXTENSION_FOUND: label=Subagent"));
        assert.ok(foundLogs.length <= 1, `expected at most 1 EXTENSION_FOUND log across repeated creates, got ${foundLogs.length}`);
      } finally {
        logger.log = origLog;
      }
    } finally {
      await store.disposeAll();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
