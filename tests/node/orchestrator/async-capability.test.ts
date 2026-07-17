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
  isAcpxProvider,
  supportsAsyncLlm,
} from "../../../extensions/orchestrator/async-capability.js";
import {
  clearSettingsCache,
  setGlobalSettingsPath,
} from "../../../extensions/orchestrator/project-settings.js";

describe("isAcpxProvider / supportsAsyncLlm", () => {
  it("detects acpx providers", () => {
    assert.equal(isAcpxProvider("acpx-cursor"), true);
    assert.equal(isAcpxProvider("acpx-claude"), true);
    assert.equal(isAcpxProvider("anthropic"), false);
    assert.equal(isAcpxProvider("openai"), false);
    assert.equal(isAcpxProvider(undefined), false);
    assert.equal(isAcpxProvider(""), false);
  });

  it("supportsAsyncLlm is inverse of acpx", () => {
    assert.equal(supportsAsyncLlm("acpx-cursor"), false);
    assert.equal(supportsAsyncLlm("anthropic"), true);
    assert.equal(supportsAsyncLlm(null), true);
  });
});

describe("getAsyncLlmSidecar + decideAsyncLlmDispatch", () => {
  let tmp: string;
  let globalTmp: string;
  const prev = {
    PI_ASYNC_LLM_PROVIDER: process.env.PI_ASYNC_LLM_PROVIDER,
    PI_ASYNC_LLM_MODEL: process.env.PI_ASYNC_LLM_MODEL,
  };

  beforeEach(() => {
    clearSettingsCache();
    tmp = mkdtempSync(join(tmpdir(), "async-cap-"));
    globalTmp = mkdtempSync(join(tmpdir(), "async-cap-g-"));
    setGlobalSettingsPath(join(globalTmp, "pi-config-settings.json"));
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
    const d = decideAsyncLlmDispatch({
      parentProvider: "anthropic",
      cwd: tmp,
      mustAsync: false,
    });
    assert.equal(d.action, "keep-async");
  });

  it("acpx optional async coerces to sync", () => {
    const d = decideAsyncLlmDispatch({
      parentProvider: "acpx-cursor",
      cwd: tmp,
      mustAsync: false,
    });
    assert.equal(d.action, "coerce-sync");
  });

  it("acpx must-async skips without sidecar", () => {
    const d = decideAsyncLlmDispatch({
      parentProvider: "acpx-cursor",
      cwd: tmp,
      mustAsync: true,
    });
    assert.equal(d.action, "skip");
  });

  it("acpx must-async uses sidecar when set", () => {
    writeSettings({
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
