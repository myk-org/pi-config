import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  INTERNAL_AGENT_DIR,
  SessionStore,
  createSessionSettingsManager,
  readSettingsSeed,
  resolveInternalAgentDir,
} from "../../src/sessions.js";
import { createLogger } from "../../src/logger.js";

const log = createLogger("agent-dir-config-test");

/** Run fn with PI_SIDECAR_AGENT_DIR temporarily set to value (undefined = unset); restores after. */
function withAgentDirEnv<T>(value: string | undefined, fn: () => T): T {
  const original = process.env.PI_SIDECAR_AGENT_DIR;
  if (value === undefined) delete process.env.PI_SIDECAR_AGENT_DIR;
  else process.env.PI_SIDECAR_AGENT_DIR = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.PI_SIDECAR_AGENT_DIR;
    else process.env.PI_SIDECAR_AGENT_DIR = original;
  }
}

/** Write a models.json defining one offline fake provider (unroutable loopback baseUrl). */
function writeModelsJson(dir: string, providerId: string, modelId: string): void {
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        [providerId]: {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "test-key-902", // pragma: allowlist secret — synthetic test credential
          models: [{ id: modelId, name: `${providerId} model` }],
        },
      },
    }),
  );
}

/**
 * Write a minimal extension under `<dir>/extensions/<extName>/index.ts` that registers
 * one provider via the extension API. Loading (or not loading) this extension is the
 * externally observable signal for both resource loading (which agent dir was used) and
 * settings seeding (the `extensions` pattern in the settings snapshot can disable it).
 */
function writeProviderExtension(dir: string, extName: string, providerId: string, modelId: string): void {
  const extDir = join(dir, "extensions", extName);
  mkdirSync(extDir, { recursive: true });
  writeFileSync(
    join(extDir, "index.ts"),
    `export default function (pi: { registerProvider: (id: string, config: unknown) => void }) {
  pi.registerProvider(${JSON.stringify(providerId)}, {
    baseUrl: "http://127.0.0.1:9/v1",
    api: "openai-completions",
    apiKey: "test-key-902", // pragma: allowlist secret — synthetic test credential
    models: [{ id: ${JSON.stringify(modelId)}, name: "Ext Model" }],
  });
}
`,
  );
}

/**
 * Temporarily place a models.json in the default internal agent dir (/tmp/pi-sidecar-agent),
 * restoring any pre-existing file afterwards. Used to verify default-dir resolution
 * behaviorally via provider discovery without depending on prior machine state.
 */
async function withDefaultAgentDirFixture(providerId: string, fn: () => Promise<void>): Promise<void> {
  const modelsPath = join(INTERNAL_AGENT_DIR, "models.json");
  const dirExisted = existsSync(INTERNAL_AGENT_DIR);
  const hadModels = existsSync(modelsPath);
  const backup = hadModels ? readFileSync(modelsPath, "utf-8") : undefined;
  try {
    mkdirSync(INTERNAL_AGENT_DIR, { recursive: true });
    writeModelsJson(INTERNAL_AGENT_DIR, providerId, `${providerId}-model`);
    await fn();
  } finally {
    if (backup !== undefined) writeFileSync(modelsPath, backup);
    else rmSync(modelsPath, { force: true });
    if (!dirExisted) rmSync(INTERNAL_AGENT_DIR, { recursive: true, force: true });
  }
}

describe("resolveInternalAgentDir", () => {
  it("explicit option wins over env var", () => {
    log.debug("testing explicit option precedence over PI_SIDECAR_AGENT_DIR");
    withAgentDirEnv("/from-env", () => {
      assert.equal(resolveInternalAgentDir("/explicit/dir"), "/explicit/dir");
    });
  });

  it("env var wins over default", () => {
    log.debug("testing PI_SIDECAR_AGENT_DIR precedence over default");
    withAgentDirEnv("/from-env", () => {
      assert.equal(resolveInternalAgentDir(), "/from-env");
    });
  });

  it("empty or whitespace env var is ignored", () => {
    log.debug("testing empty/whitespace PI_SIDECAR_AGENT_DIR falls back to default");
    for (const value of ["", "   ", "\t"]) {
      withAgentDirEnv(value, () => {
        assert.equal(resolveInternalAgentDir(), INTERNAL_AGENT_DIR);
      });
    }
  });

  it("resolves the default when nothing is set", () => {
    log.debug("testing default resolution with no option and no env");
    withAgentDirEnv(undefined, () => {
      assert.equal(resolveInternalAgentDir(), "/tmp/pi-sidecar-agent");
    });
  });
});

describe("SessionStore configured agent dir", { concurrency: false }, () => {
  let offline: string | undefined;

  before(() => {
    offline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = "1";
  });
  after(() => {
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
  });

  it("registers custom providers from the configured dir's models.json and creates sessions for them", async () => {
    log.debug("testing custom models.json provider registration and session creation via configured agent dir");
    const dir = mkdtempSync(join(tmpdir(), "sidecar-agent-dir-902-"));
    const sessionCwd = mkdtempSync(join(tmpdir(), "sidecar-create-cwd-902-"));
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          "enmaas-test-902": {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            apiKey: "test-key-902", // pragma: allowlist secret — synthetic test credential
            models: [{ id: "enmaas-model-x", name: "EnMaaS Model X" }],
          },
        },
      }),
    );
    const store = new SessionStore({ agentDir: dir });
    try {
      const providers = await store.getProviders();
      assert.ok(
        providers.some((p) => p.provider === "enmaas-test-902"),
        `custom provider should be listed, got: ${providers.map((p) => p.provider).join(",")}`,
      );
      const models = await store.getModels();
      assert.ok(
        models.some((m) => m.provider === "enmaas-test-902" && m.id === "enmaas-model-x"),
        `custom provider model should be listed, got: ${models.filter((m) => m.provider === "enmaas-test-902").map((m) => m.id).join(",")}`,
      );
      // Session creation against the configured provider — creation only, no prompts.
      const sessionId = await store.create({
        provider: "enmaas-test-902",
        model: "enmaas-model-x",
        systemPrompt: "test",
        cwd: sessionCwd,
      });
      assert.ok(sessionId, "store.create() should return a session id for the custom provider");
      // The provider is key-capable (models.json apiKey auth, not ambient) — creation with a
      // per-session api_key must also succeed.
      const keySessionId = await store.create({
        provider: "enmaas-test-902",
        model: "enmaas-model-x",
        systemPrompt: "test",
        cwd: sessionCwd,
        apiKey: "test-key-902", // pragma: allowlist secret — synthetic test credential
      });
      assert.ok(keySessionId, "store.create() with api_key should return a session id");
    } finally {
      await store.disposeAll();
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessionCwd, { recursive: true, force: true });
    }
  });

  it("discovers providers from the default dir when constructed with no options", async () => {
    log.debug("testing default agent dir resolution via provider discovery");
    await withDefaultAgentDirFixture("default-dir-prov-902", async () => {
      const store = withAgentDirEnv(undefined, () => new SessionStore());
      try {
        const providers = await store.getProviders();
        assert.ok(
          providers.some((p) => p.provider === "default-dir-prov-902"),
          `provider from the default agent dir should be listed, got: ${providers.map((p) => p.provider).join(",")}`,
        );
      } finally {
        await store.disposeAll();
      }
    });
  });

  it("does not pick up the default dir's models.json when a configured dir overrides it", async () => {
    log.debug("testing configured agent dir takes precedence over the default dir");
    await withDefaultAgentDirFixture("default-dir-prov-902", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sidecar-agent-dir-override-"));
      writeModelsJson(dir, "configured-dir-prov-902", "configured-model");
      const store = new SessionStore({ agentDir: dir });
      try {
        const providers = await store.getProviders();
        assert.ok(
          providers.some((p) => p.provider === "configured-dir-prov-902"),
          "provider from the configured agent dir should be listed",
        );
        assert.ok(
          !providers.some((p) => p.provider === "default-dir-prov-902"),
          "provider from the default agent dir must not be listed when a configured dir overrides it",
        );
      } finally {
        await store.disposeAll();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("honors PI_SIDECAR_AGENT_DIR at construction", async () => {
    log.debug("testing SessionStore picks up PI_SIDECAR_AGENT_DIR env via provider discovery");
    const dir = mkdtempSync(join(tmpdir(), "sidecar-agent-dir-env-"));
    writeModelsJson(dir, "env-dir-prov-902", "env-dir-model");
    const store = withAgentDirEnv(dir, () => new SessionStore());
    try {
      const providers = await store.getProviders();
      assert.ok(
        providers.some((p) => p.provider === "env-dir-prov-902"),
        `provider from the env-configured agent dir should be listed, got: ${providers.map((p) => p.provider).join(",")}`,
      );
      const models = await store.getModels();
      assert.ok(
        models.some((m) => m.provider === "env-dir-prov-902" && m.id === "env-dir-model"),
        "model from the env-configured agent dir should be listed",
      );
    } finally {
      await store.disposeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readSettingsSeed", () => {
  it("reads settings.json from the agent dir", () => {
    log.debug("testing readSettingsSeed parses settings.json from the agent dir");
    const dir = mkdtempSync(join(tmpdir(), "sidecar-settings-902-"));
    try {
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "foo" }));
      assert.deepEqual(readSettingsSeed(dir), { defaultProvider: "foo" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns {} when settings.json is missing", () => {
    log.debug("testing readSettingsSeed falls back to {} for a missing settings.json");
    const dir = mkdtempSync(join(tmpdir(), "sidecar-settings-902-"));
    try {
      assert.deepEqual(readSettingsSeed(dir), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns {} when settings.json is unparseable", () => {
    log.debug("testing readSettingsSeed falls back to {} for an unparseable settings.json");
    const dir = mkdtempSync(join(tmpdir(), "sidecar-settings-902-"));
    try {
      writeFileSync(join(dir, "settings.json"), "{ not json");
      assert.deepEqual(readSettingsSeed(dir), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns {} when settings.json is not a JSON object", () => {
    log.debug("testing readSettingsSeed falls back to {} for a non-object settings.json");
    const dir = mkdtempSync(join(tmpdir(), "sidecar-settings-902-"));
    try {
      writeFileSync(join(dir, "settings.json"), JSON.stringify(["not", "an", "object"]));
      assert.deepEqual(readSettingsSeed(dir), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns {} when no agent dir is given", () => {
    log.debug("testing readSettingsSeed falls back to {} without an agent dir");
    assert.deepEqual(readSettingsSeed(undefined), {});
  });
});

describe("createSessionSettingsManager settings seeding", () => {
  it("seeds settings from the startup snapshot seed object", () => {
    log.debug("testing the settings manager applies the seed object");
    const manager = createSessionSettingsManager({ defaultProvider: "foo" });
    assert.equal(manager.getDefaultProvider(), "foo");
  });

  it("uses empty settings for an empty seed", () => {
    log.debug("testing the settings manager defaults without a seed");
    const manager = createSessionSettingsManager();
    assert.equal(manager.getDefaultProvider(), undefined);
  });

  it("keeps compaction disabled even when the seed enables it", () => {
    log.debug("testing compaction stays disabled regardless of the seed");
    const manager = createSessionSettingsManager({ compaction: { enabled: true } });
    assert.equal(manager.getSettings().compaction?.enabled, false);
  });
});

describe("SessionStore settings come from a startup snapshot of the deployment dir", { concurrency: false }, () => {
  let offline: string | undefined;

  before(() => {
    offline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = "1";
  });
  after(() => {
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
  });

  /**
   * Extension directory name shared by the deployment and request dirs, so one
   * settings pattern (`-extensions/<EXT>/index.ts`, resolved against the session
   * loader's agent dir) deterministically disables it while the permissive
   * `{"extensions": []}` in the request dir's own settings.json would enable it.
   */
  const EXT_NAME = "settings-snapshot-ext";

  it("per-request agent_dir drives resource loading, not session settings", async () => {
    log.debug("testing that a per-request agent_dir loads its resources but not its settings");
    const deployDir = mkdtempSync(join(tmpdir(), "sidecar-snapshot-deploy-"));
    const requestDir = mkdtempSync(join(tmpdir(), "sidecar-snapshot-request-"));
    const cwd = mkdtempSync(join(tmpdir(), "sidecar-snapshot-cwd-"));
    try {
      writeModelsJson(deployDir, "snapshot-deploy-prov", "snapshot-deploy-model");
      // Deployment snapshot disables the extension; the request dir's own settings.json
      // would allow it. If session settings came from the request dir, the extension
      // would load and its provider would register on the shared runtime.
      writeFileSync(join(deployDir, "settings.json"), JSON.stringify({ extensions: [`-extensions/${EXT_NAME}/index.ts`] }));
      writeProviderExtension(requestDir, EXT_NAME, "snapshot-req-ext-prov", "snapshot-req-ext-model");
      writeFileSync(join(requestDir, "settings.json"), JSON.stringify({ extensions: [] }));

      const store = new SessionStore({ agentDir: deployDir });
      try {
        const sessionId = await store.create({
          provider: "snapshot-deploy-prov",
          model: "snapshot-deploy-model",
          systemPrompt: "test",
          cwd,
          agentDir: requestDir,
        });
        assert.ok(sessionId, "store.create() with a per-request agent_dir should succeed");
        const providers = await store.getProviders();
        assert.ok(
          !providers.some((p) => p.provider === "snapshot-req-ext-prov"),
          "session settings must come from the deployment snapshot, not the per-request agent_dir",
        );
      } finally {
        await store.disposeAll();
      }
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
      rmSync(requestDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("per-request agent_dir resources still load when the deployment snapshot allows them", async () => {
    log.debug("testing that resource loading genuinely uses the per-request agent_dir");
    const deployDir = mkdtempSync(join(tmpdir(), "sidecar-snapshot-deploy2-"));
    const requestDir = mkdtempSync(join(tmpdir(), "sidecar-snapshot-request2-"));
    const cwd = mkdtempSync(join(tmpdir(), "sidecar-snapshot-cwd2-"));
    try {
      // No deployment settings.json — the snapshot seed is {} and disables nothing.
      writeModelsJson(deployDir, "snapshot-deploy2-prov", "snapshot-deploy2-model");
      writeProviderExtension(requestDir, EXT_NAME, "snapshot-req2-ext-prov", "snapshot-req2-ext-model");

      const store = new SessionStore({ agentDir: deployDir });
      try {
        const sessionId = await store.create({
          provider: "snapshot-deploy2-prov",
          model: "snapshot-deploy2-model",
          systemPrompt: "test",
          cwd,
          agentDir: requestDir,
        });
        assert.ok(sessionId, "store.create() with a per-request agent_dir should succeed");
        const providers = await store.getProviders();
        assert.ok(
          providers.some((p) => p.provider === "snapshot-req2-ext-prov"),
          "the request dir's extension must load — per-request agent_dir drives resource loading",
        );
      } finally {
        await store.disposeAll();
      }
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
      rmSync(requestDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("editing the deployment settings.json after construction does not change subsequent sessions", async () => {
    log.debug("testing that the deployment settings snapshot is never re-read");
    const deployDir = mkdtempSync(join(tmpdir(), "sidecar-snapshot-deploy3-"));
    const cwd = mkdtempSync(join(tmpdir(), "sidecar-snapshot-cwd3-"));
    try {
      writeModelsJson(deployDir, "snapshot-deploy3-prov", "snapshot-deploy3-model");
      writeProviderExtension(deployDir, EXT_NAME, "snapshot-dep3-ext-prov", "snapshot-dep3-ext-model");
      writeFileSync(join(deployDir, "settings.json"), JSON.stringify({ extensions: [`-extensions/${EXT_NAME}/index.ts`] }));

      const store = new SessionStore({ agentDir: deployDir });
      try {
        // Force internal runtime creation with the disabling snapshot.
        const before = await store.getProviders();
        assert.ok(
          !before.some((p) => p.provider === "snapshot-dep3-ext-prov"),
          "the deployment extension must be disabled by the construction-time snapshot",
        );
        // Flip the on-disk settings.json to permissive. If the seed were re-read per
        // session, the next create() would load the extension and register its
        // provider on the shared runtime.
        writeFileSync(join(deployDir, "settings.json"), JSON.stringify({ extensions: [] }));
        const sessionId = await store.create({
          provider: "snapshot-deploy3-prov",
          model: "snapshot-deploy3-model",
          systemPrompt: "test",
          cwd,
        });
        assert.ok(sessionId, "store.create() after a settings.json edit should succeed");
        const after = await store.getProviders();
        assert.ok(
          !after.some((p) => p.provider === "snapshot-dep3-ext-prov"),
          "the settings snapshot must not be re-read after SessionStore construction",
        );
      } finally {
        await store.disposeAll();
      }
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
