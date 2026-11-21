/**
 * Tests for internal ops provider resolution.
 * Run with: npx tsx --test tests/node/orchestrator/async-capability.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { getInternalOpsProvider } from "../../../extensions/orchestrator/async-capability.js";
import {
  clearSettingsCache,
  setGlobalSettingsPath,
} from "../../../extensions/orchestrator/project-settings.js";
import { makeTempDir } from "../helpers/temp-dirs.js";


describe("internal ops provider", () => {
  let tmp: string;
  let globalTmp: string;
  const prev = {
    PI_INTERNAL_OPERATIONS_PROVIDER: process.env.PI_INTERNAL_OPERATIONS_PROVIDER,
    PI_INTERNAL_OPERATIONS_MODEL: process.env.PI_INTERNAL_OPERATIONS_MODEL,
  };

  beforeEach(() => {
    clearSettingsCache();
    tmp = makeTempDir("async-cap-");
    globalTmp = makeTempDir("async-cap-g-");
    setGlobalSettingsPath(join(globalTmp, "pi-config-settings.json"));
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

  it("returns null when unset", () => {
    assert.equal(getInternalOpsProvider(tmp), null);
  });

  it("loads internal ops provider from project settings", () => {
    writeSettings({
      internal_operations_provider: "anthropic",
      internal_operations_model: "claude-sonnet-4-20250514",
    });
    assert.deepEqual(getInternalOpsProvider(tmp), {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    });
  });

  it("requires both provider and model", () => {
    writeSettings({ internal_operations_provider: "anthropic" });
    assert.equal(getInternalOpsProvider(tmp), null);
  });

  it("reads internal ops provider from env when file unset", () => {
    process.env.PI_INTERNAL_OPERATIONS_PROVIDER = "openai";
    process.env.PI_INTERNAL_OPERATIONS_MODEL = "gpt-4.1";
    clearSettingsCache();
    assert.deepEqual(getInternalOpsProvider(tmp), {
      provider: "openai",
      model: "gpt-4.1",
    });
  });
});
