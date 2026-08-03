/**
 * Tests for async LLM capability (acpx vs native).
 * Run with: npx tsx --test tests/node/orchestrator/async-capability.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  decideAsyncLlmDispatch,
  getInternalOpsProvider,
  getRegisteredAcpxProviders,
  isAcpxProvider,
  isAcpxProviderId,
  supportsAsyncLlm,
} from "../../../extensions/orchestrator/async-capability.js";
import {
  clearSettingsCache,
  setGlobalSettingsPath,
} from "../../../extensions/orchestrator/project-settings.js";

describe("registered acpx providers / supportsAsyncLlm", () => {
  let tmp: string;
  let globalTmp: string;
  const prev = {
    ACPX_AGENTS: process.env.ACPX_AGENTS,
    PI_INTERNAL_OPERATIONS_PROVIDER: process.env.PI_INTERNAL_OPERATIONS_PROVIDER,
    PI_INTERNAL_OPERATIONS_MODEL: process.env.PI_INTERNAL_OPERATIONS_MODEL,
  };

  beforeEach(() => {
    clearSettingsCache();
    tmp = mkdtempSync(join(tmpdir(), "async-cap-"));
    globalTmp = mkdtempSync(join(tmpdir(), "async-cap-g-"));
    setGlobalSettingsPath(join(globalTmp, "pi-config-settings.json"));
    delete process.env.ACPX_AGENTS;
    delete process.env.PI_INTERNAL_OPERATIONS_PROVIDER;
    delete process.env.PI_INTERNAL_OPERATIONS_MODEL;
  });

  afterEach(() => {
    setGlobalSettingsPath(null);
    clearSettingsCache();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(globalTmp, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string>)[k] = v;
    }
  });

  function writeSettings(data: Record<string, unknown>): void {
    mkdirSync(join(tmp, ".pi"), { recursive: true });
    writeFileSync(join(tmp, ".pi", "pi-config-settings.json"), JSON.stringify(data));
    clearSettingsCache();
  }

  it("maps acpx_agents settings to registered provider ids", () => {
    writeSettings({ acpx_agents: ["cursor", "claude"] });
    assert.deepEqual(getRegisteredAcpxProviders(tmp), [
      "acpx-cursor",
      "acpx-claude",
    ]);
  });

  it("isAcpxProvider only matches registered agents", () => {
    writeSettings({ acpx_agents: ["cursor"] });
    assert.equal(isAcpxProvider("acpx-cursor", tmp), true);
    assert.equal(isAcpxProvider("acpx-claude", tmp), false);
    assert.equal(isAcpxProvider("anthropic", tmp), false);
    assert.equal(isAcpxProvider(undefined, tmp), false);
  });

  it("isAcpxProviderId matches any acpx-* string", () => {
    assert.equal(isAcpxProviderId("acpx-cursor"), true);
    assert.equal(isAcpxProviderId("acpx-unknown"), true);
    assert.equal(isAcpxProviderId("cli-cursor"), false);
    assert.equal(isAcpxProviderId(null), false);
  });

  it("supportsAsyncLlm is false for any acpx-* provider id", () => {
    writeSettings({ acpx_agents: ["cursor"] });
    assert.equal(supportsAsyncLlm("acpx-cursor", tmp), false);
    assert.equal(supportsAsyncLlm("acpx-claude", tmp), false);
    assert.equal(supportsAsyncLlm("anthropic", tmp), true);
    assert.equal(supportsAsyncLlm("cli-cursor", tmp), true);
    assert.equal(supportsAsyncLlm(null, tmp), true);
  });

  it("with empty acpx_agents, acpx-* still disables async LLM", () => {
    writeSettings({ acpx_agents: [] });
    assert.equal(isAcpxProvider("acpx-cursor", tmp), false);
    assert.equal(supportsAsyncLlm("acpx-cursor", tmp), false);
  });

  it("returns null sidecar when unset", () => {
    assert.equal(getInternalOpsProvider(tmp), null);
  });

  it("loads sidecar from project settings", () => {
    writeSettings({
      internal_operations_provider: "anthropic",
      internal_operations_model: "claude-sonnet-4-20250514",
    });
    assert.deepEqual(getInternalOpsProvider(tmp), {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    });
  });

  it("rejects acpx-* sidecar providers", () => {
    writeSettings({
      internal_operations_provider: "acpx-cursor",
      internal_operations_model: "composer-2",
    });
    assert.equal(getInternalOpsProvider(tmp), null);
  });

  it("requires both provider and model", () => {
    writeSettings({ internal_operations_provider: "anthropic" });
    assert.equal(getInternalOpsProvider(tmp), null);
  });

  it("native parent keeps async", () => {
    writeSettings({ acpx_agents: ["cursor"] });
    const d = decideAsyncLlmDispatch({
      parentProvider: "anthropic",
      cwd: tmp,
      mustAsync: false,
    });
    assert.equal(d.action, "keep-async");
  });

  it("acpx optional async coerces to sync", () => {
    writeSettings({ acpx_agents: ["cursor"] });
    const d = decideAsyncLlmDispatch({
      parentProvider: "acpx-cursor",
      cwd: tmp,
      mustAsync: false,
    });
    assert.equal(d.action, "coerce-sync");
  });

  it("unregistered acpx-* string still coerces", () => {
    writeSettings({ acpx_agents: ["cursor"] });
    const d = decideAsyncLlmDispatch({
      parentProvider: "acpx-gemini",
      cwd: tmp,
      mustAsync: false,
    });
    assert.equal(d.action, "coerce-sync");
  });

  it("parentSupportsAsyncLlm false forces coerce even if cwd would differ", () => {
    writeSettings({ acpx_agents: [] });
    // Empty acpx_agents + wrong cwd must not reopen keep-async when parent already gated
    const d = decideAsyncLlmDispatch({
      parentProvider: "acpx-cursor",
      cwd: tmp,
      mustAsync: false,
      parentSupportsAsyncLlm: false,
    });
    assert.equal(d.action, "coerce-sync");
  });

  it("parentSupportsAsyncLlm true keeps async without re-checking cwd", () => {
    writeSettings({ acpx_agents: ["cursor"] });
    const d = decideAsyncLlmDispatch({
      parentProvider: "acpx-cursor",
      cwd: tmp,
      mustAsync: false,
      parentSupportsAsyncLlm: true,
    });
    assert.equal(d.action, "keep-async");
  });

  it("acpx must-async skips without sidecar", () => {
    writeSettings({ acpx_agents: ["cursor"] });
    const d = decideAsyncLlmDispatch({
      parentProvider: "acpx-cursor",
      cwd: tmp,
      mustAsync: true,
      parentSupportsAsyncLlm: false,
    });
    assert.equal(d.action, "skip");
  });

  it("acpx must-async uses sidecar when set", () => {
    writeSettings({
      acpx_agents: ["cursor"],
      internal_operations_provider: "openai",
      internal_operations_model: "gpt-5.4",
    });
    const d = decideAsyncLlmDispatch({
      parentProvider: "acpx-cursor",
      cwd: tmp,
      mustAsync: true,
      parentSupportsAsyncLlm: false,
    });
    assert.equal(d.action, "sidecar-async");
    if (d.action === "sidecar-async") {
      assert.equal(d.sidecar.provider, "openai");
      assert.equal(d.sidecar.model, "gpt-5.4");
    }
  });

  it("must-async skips when sidecar is acpx-*", () => {
    writeSettings({
      acpx_agents: ["cursor"],
      internal_operations_provider: "acpx-cursor",
      internal_operations_model: "composer-2",
    });
    const d = decideAsyncLlmDispatch({
      parentProvider: "acpx-cursor",
      cwd: tmp,
      mustAsync: true,
      parentSupportsAsyncLlm: false,
    });
    assert.equal(d.action, "skip");
  });

  it("reads sidecar from env when file unset", () => {
    process.env.PI_INTERNAL_OPERATIONS_PROVIDER = "openai";
    process.env.PI_INTERNAL_OPERATIONS_MODEL = "gpt-4.1";
    clearSettingsCache();
    assert.deepEqual(getInternalOpsProvider(tmp), {
      provider: "openai",
      model: "gpt-4.1",
    });
  });
});
