import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  INTERNAL_AGENT_DIR,
  SessionStore,
  createSessionSettingsManager,
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

  it("registers custom providers from the configured dir's models.json", async () => {
    log.debug("testing custom models.json provider registration via configured agent dir");
    const dir = mkdtempSync(join(tmpdir(), "sidecar-agent-dir-902-"));
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
    } finally {
      await store.disposeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to /tmp/pi-sidecar-agent when constructed with no options", async () => {
    log.debug("testing SessionStore default agent dir is unchanged");
    const store = withAgentDirEnv(undefined, () => new SessionStore());
    try {
      assert.equal((store as any).agentDir, INTERNAL_AGENT_DIR);
    } finally {
      await store.disposeAll();
    }
  });

  it("honors PI_SIDECAR_AGENT_DIR at construction", async () => {
    log.debug("testing SessionStore picks up PI_SIDECAR_AGENT_DIR env");
    const store = withAgentDirEnv("/configured/by/env", () => new SessionStore());
    try {
      assert.equal((store as any).agentDir, "/configured/by/env");
    } finally {
      await store.disposeAll();
    }
  });
});

describe("createSessionSettingsManager settings.json seeding", () => {
  it("seeds settings from <agentDir>/settings.json", () => {
    log.debug("testing settings.json seeding into the in-memory settings store");
    const dir = mkdtempSync(join(tmpdir(), "sidecar-settings-902-"));
    try {
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "foo" }));
      const manager = createSessionSettingsManager(dir);
      assert.equal(manager.getDefaultProvider(), "foo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses empty settings when settings.json is missing", () => {
    log.debug("testing missing settings.json falls back to empty settings");
    const dir = mkdtempSync(join(tmpdir(), "sidecar-settings-902-"));
    try {
      const manager = createSessionSettingsManager(dir);
      assert.equal(manager.getDefaultProvider(), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses empty settings when settings.json is unparseable", () => {
    log.debug("testing unparseable settings.json falls back to empty settings without throwing");
    const dir = mkdtempSync(join(tmpdir(), "sidecar-settings-902-"));
    try {
      writeFileSync(join(dir, "settings.json"), "{ not json");
      const manager = createSessionSettingsManager(dir);
      assert.equal(manager.getDefaultProvider(), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps compaction disabled even when settings.json enables it", () => {
    log.debug("testing compaction stays disabled regardless of seeded settings");
    const dir = mkdtempSync(join(tmpdir(), "sidecar-settings-902-"));
    try {
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ compaction: { enabled: true } }));
      const manager = createSessionSettingsManager(dir);
      assert.equal(manager.getSettings().compaction?.enabled, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
