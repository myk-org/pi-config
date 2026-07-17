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
  getAsyncLlmSidecar,
  getRegisteredAcpxProviders,
  isAcpxProvider,
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
    PI_ASYNC_LLM_PROVIDER: process.env.PI_ASYNC_LLM_PROVIDER,
    PI_ASYNC_LLM_MODEL: process.env.PI_ASYNC_LLM_MODEL,
  };

  beforeEach(() => {
    clearSettingsCache();
    tmp = mkdtempSync(join(tmpdir(), "async-cap-"));
    globalTmp = mkdtempSync(join(tmpdir(), "async-cap-g-"));
    setGlobalSettingsPath(join(globalTmp, "pi-config-settings.json"));
    delete process.env.ACPX_AGENTS;
    delete process.env.PI_ASYNC_LLM_PROVIDER;
    delete process.env.PI_ASYNC_LLM_MODEL;
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

  it("supportsAsyncLlm is false only for registered acpx providers", () => {
    writeSettings({ acpx_agents: ["cursor"] });
    assert.equal(supportsAsyncLlm("acpx-cursor", tmp), false);
    assert.equal(supportsAsyncLlm("acpx-claude", tmp), true);
    assert.equal(supportsAsyncLlm("anthropic", tmp), true);
    assert.equal(supportsAsyncLlm(null, tmp), true);
  });

  it("with empty acpx_agents, acpx-* strings are not treated as acpx", () => {
    writeSettings({ acpx_agents: [] });
    assert.equal(isAcpxProvider("acpx-cursor", tmp), false);
    assert.equal(supportsAsyncLlm("acpx-cursor", tmp), true);
  });

  it("returns null sidecar when unset", () => {
    assert.equal(getAsyncLlmSidecar(tmp), null);
  });

  it("loads sidecar from project settings", () => {
    writeSettings({
      async_llm_provider: "anthropic",
      async_llm_model: "claude-sonnet-4-20250514",
    });
    assert.deepEqual(getAsyncLlmSidecar(tmp), {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    });
  });

  it("requires both provider and model", () => {
    writeSettings({ async_llm_provider: "anthropic" });
    assert.equal(getAsyncLlmSidecar(tmp), null);
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

  it("registered acpx optional async coerces to sync", () => {
    writeSettings({ acpx_agents: ["cursor"] });
    const d = decideAsyncLlmDispatch({
      parentProvider: "acpx-cursor",
      cwd: tmp,
      mustAsync: false,
    });
    assert.equal(d.action, "coerce-sync");
  });

  it("unregistered acpx-* string does not coerce", () => {
    writeSettings({ acpx_agents: ["cursor"] });
    const d = decideAsyncLlmDispatch({
      parentProvider: "acpx-gemini",
      cwd: tmp,
      mustAsync: false,
    });
    assert.equal(d.action, "keep-async");
  });

  it("acpx must-async skips without sidecar", () => {
    writeSettings({ acpx_agents: ["cursor"] });
    const d = decideAsyncLlmDispatch({
      parentProvider: "acpx-cursor",
      cwd: tmp,
      mustAsync: true,
    });
    assert.equal(d.action, "skip");
  });

  it("acpx must-async uses sidecar when set", () => {
    writeSettings({
      acpx_agents: ["cursor"],
      async_llm_provider: "openai",
      async_llm_model: "gpt-5.4",
    });
    const d = decideAsyncLlmDispatch({
      parentProvider: "acpx-cursor",
      cwd: tmp,
      mustAsync: true,
    });
    assert.equal(d.action, "sidecar-async");
    if (d.action === "sidecar-async") {
      assert.equal(d.sidecar.provider, "openai");
      assert.equal(d.sidecar.model, "gpt-5.4");
    }
  });

  it("reads sidecar from env when file unset", () => {
    process.env.PI_ASYNC_LLM_PROVIDER = "openai";
    process.env.PI_ASYNC_LLM_MODEL = "gpt-4.1";
    clearSettingsCache();
    assert.deepEqual(getAsyncLlmSidecar(tmp), {
      provider: "openai",
      model: "gpt-4.1",
    });
  });
});
