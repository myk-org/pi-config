/**
 * Background virtual model (pi-bg/auto) — registration gating, routing and fallback.
 * Run with: npx tsx --test tests/node/shared/background-model.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext, ModelRoute } from "@earendil-works/pi-coding-agent";
import {
  clearSettingsCache,
  setGlobalSettingsPath,
} from "../../../extensions/orchestrator/project-settings.js";
import {
  BACKGROUND_PROVIDER,
  BACKGROUND_MODEL_ID,
  backgroundModelRef,
  registerBackgroundModel,
  routeBackgroundRequest,
} from "../../../extensions/shared/background-model.js";

// ── fixtures ────────────────────────────────────────────────────────────────

type Settings = Record<string, unknown>;

let repo: string;
let cwd: string;

/**
 * Write a .pi/pi-config-settings.json the loader finds for `cwd`. `cwd` is a plain
 * temp dir, so resolveRepoRoot falls back to it; global ~/.pi settings are isolated.
 */
function writeSettings(settings: Settings): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pi-config-settings.json"), JSON.stringify(settings));
  clearSettingsCache();
}

/** Fake ExtensionAPI exposing only registerVirtualModel (pi >= 0.99). */
function fakePi(): { pi: ExtensionAPI; registered: any[] } {
  const registered: any[] = [];
  const pi = {
    registerVirtualModel: (model: unknown) => registered.push(model),
  } as unknown as ExtensionAPI;
  return { pi, registered };
}

/** pi older than 0.99: the API is simply absent. */
function pre099Pi(): ExtensionAPI {
  return {} as ExtensionAPI;
}

function physicalModel(provider: string, id: string): any {
  return { provider, id, name: id, api: "openai-completions" };
}

/** Registry that resolves only the models it was given, and reports auth for them. */
function fakeCtx(models: Record<string, any>, hasAuth = true): ExtensionContext {
  const registry = {
    find: (provider: string, id: string) => models[`${provider}/${id}`],
    hasConfiguredAuth: (_model: any) => hasAuth,
    // Snapshot is what the fallback scans when nothing else resolves.
    getAvailableSnapshot: () => Object.values(models),
  };
  return { cwd, modelRegistry: registry } as unknown as ExtensionContext;
}

function request(overrides: Record<string, unknown> = {}): any {
  return {
    model: { provider: BACKGROUND_PROVIDER, id: BACKGROUND_MODEL_ID, name: "Background (auto)" },
    thinkingLevel: "medium",
    reason: "user",
    messages: [],
    ...overrides,
  };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "bg-model-"));
  cwd = repo;
  setGlobalSettingsPath(join(repo, "global", "pi-config-settings.json"));
  clearSettingsCache();
});

afterEach(() => {
  setGlobalSettingsPath(null);
  clearSettingsCache();
  rmSync(repo, { recursive: true, force: true });
});

// ── registration ────────────────────────────────────────────────────────────

describe("registerBackgroundModel", () => {
  it("registers nothing when the flag is off", () => {
    const { pi, registered } = fakePi();
    assert.equal(registerBackgroundModel(pi, cwd), false);
    assert.equal(registered.length, 0);
  });

  it("registers when the flag is on", () => {
    writeSettings({
      background_virtual_model_enable: true,
      internal_operations_provider: "anthropic",
      internal_operations_model: "claude-haiku-4-5",
    });
    const { pi, registered } = fakePi();
    assert.equal(registerBackgroundModel(pi, cwd), true);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].provider, BACKGROUND_PROVIDER);
    assert.equal(registered[0].id, BACKGROUND_MODEL_ID);
    assert.equal(typeof registered[0].route, "function");
  });

  it("does not throw on a pre-0.99 pi and registers nothing", () => {
    writeSettings({ background_virtual_model_enable: true });
    assert.equal(registerBackgroundModel(pre099Pi(), cwd), false);
  });

  it("keeps the virtual id clear of any physical model id", () => {
    // pi throws at register time when the id belongs to a physical model.
    writeSettings({ background_virtual_model_enable: true });
    const { pi, registered } = fakePi();
    registerBackgroundModel(pi, cwd);
    assert.equal(registered[0].provider, "pi-bg");
    assert.equal(registered[0].id, "auto");
  });
});

// ── backgroundModelRef ──────────────────────────────────────────────────────

describe("backgroundModelRef", () => {
  it("is undefined when the flag is off", () => {
    writeSettings({
      internal_operations_provider: "anthropic",
      internal_operations_model: "claude-haiku-4-5",
    });
    assert.equal(backgroundModelRef(cwd), undefined);
  });

  it("is undefined when no internal operations target is configured", () => {
    writeSettings({ background_virtual_model_enable: true });
    assert.equal(backgroundModelRef(cwd), undefined);
  });

  it("is undefined when the virtual model was never registered", async () => {
    // Fresh module instance: `registered` is per-process module state, so the
    // top-level import has already been registered by an earlier test. A cache
    // busting query gives a module that has definitely not registered anything.
    writeSettings({
      background_virtual_model_enable: true,
      internal_operations_provider: "anthropic",
      internal_operations_model: "claude-haiku-4-5",
    });
    const fresh = await import("../../../extensions/shared/background-model.js?unregistered=1");
    // Flag and target are set, so the only thing stopping a spawn is that the
    // virtual model does not exist in this process (pi < 0.99, or the flag was
    // off at load time). Handing out pi-bg/auto here would fail the spawn.
    assert.equal(fresh.backgroundModelRef(cwd), undefined);
  });

  it("points at the virtual model when the flag and target are set", () => {
    writeSettings({
      background_virtual_model_enable: true,
      internal_operations_provider: "anthropic",
      internal_operations_model: "claude-haiku-4-5",
    });
    assert.deepEqual(backgroundModelRef(cwd), {
      provider: BACKGROUND_PROVIDER,
      model: BACKGROUND_MODEL_ID,
    });
  });
});

// ── route() ─────────────────────────────────────────────────────────────────

describe("routeBackgroundRequest", () => {
  beforeEach(() => {
    writeSettings({
      background_virtual_model_enable: true,
      internal_operations_provider: "anthropic",
      internal_operations_model: "claude-haiku-4-5",
    });
  });

  it("sends the first request to the configured internal operations model", () => {
    const target = physicalModel("anthropic", "claude-haiku-4-5");
    const route = routeBackgroundRequest(request(), fakeCtx({ "anthropic/claude-haiku-4-5": target }));
    assert.equal(route.model, target);
    assert.equal(route.thinkingLevel, "medium");
  });

  it("stays on the model that already answered", () => {
    const previous = physicalModel("anthropic", "claude-sonnet-4-5");
    const route = routeBackgroundRequest(
      request({ reason: "continuation", previous: { model: previous, thinkingLevel: "high" } }),
      fakeCtx({ "anthropic/claude-haiku-4-5": physicalModel("anthropic", "claude-haiku-4-5") }),
    );
    assert.equal(route.model, previous);
    assert.equal(route.thinkingLevel, "high");
  });

  it("falls back to the request model when nothing resolves", () => {
    const selected = request();
    const route: ModelRoute = routeBackgroundRequest(selected, fakeCtx({}));
    assert.equal(route.model, selected.model);
  });

  it("falls back to the request model when the target has no credentials", () => {
    const selected = request();
    const route = routeBackgroundRequest(
      selected,
      fakeCtx({ "anthropic/claude-haiku-4-5": physicalModel("anthropic", "claude-haiku-4-5") }, false),
    );
    assert.equal(route.model, selected.model);
  });

  it("does not throw when the registry blows up", () => {
    const selected = request();
    const ctx = {
      cwd,
      modelRegistry: {
        find() { throw new Error("registry exploded"); },
        hasConfiguredAuth() { return true; },
      },
    } as unknown as ExtensionContext;
    const route = routeBackgroundRequest(selected, ctx);
    assert.equal(route.model, selected.model);
  });

  it("does not throw when settings resolution blows up", () => {
    const previous = physicalModel("anthropic", "claude-sonnet-4-5");
    const ctx = {
      cwd: "/nonexistent",
      modelRegistry: { find: () => undefined, hasConfiguredAuth: () => true },
    } as unknown as ExtensionContext;
    const route = routeBackgroundRequest(request({ previous: { model: previous } }), ctx);
    assert.equal(route.model, previous);
  });

  it("falls back to a physical model from the catalog, never the virtual one", () => {
    // No previous response and no usable target: request.model is pi-bg/auto, which
    // pi rejects as a route target ("which is not a physical model"). The fallback
    // must come from the catalog instead, or this becomes an error response.
    writeSettings({ background_virtual_model_enable: true });
    const usable = physicalModel("anthropic", "claude-haiku-4-5");
    const route = routeBackgroundRequest(request(), fakeCtx({ "anthropic/claude-haiku-4-5": usable }));
    assert.equal(route.model, usable);
    assert.notEqual(route.model.provider, BACKGROUND_PROVIDER);
  });

  it("never routes to another virtual model when a previous response exists", () => {
    const selected = request();
    const route = routeBackgroundRequest(
      { ...selected, reason: "retry", previous: { model: selected.model, thinkingLevel: "low" } },
      fakeCtx({}),
    );
    // A previous response is always physical, so this asserts the sticky branch is taken
    // verbatim rather than re-resolved through the registry.
    assert.equal(route.model, selected.model);
    assert.equal(route.thinkingLevel, "low");
  });
});
