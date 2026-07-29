import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SessionStore } from "../../src/sessions.js";

/**
 * Unit tests for SessionStore lifecycle (refresh / catalog / status / concurrency).
 *
 * Fully mocked — never creates a real AgentSessionRuntime, never loads
 * extensions, never touches provider APIs or credentials. Mirrors the
 * snapshot-agent-source.test.ts pattern: pre-install duck-typed
 * `internalRuntime` / `modelRuntime` / `modelRegistry` so
 * `ensureInternalRuntime()` short-circuits.
 */

type DiscoveredModel = { id: string; name: string; provider: string };

function fakeSession(): { dispose: () => void } {
  return { dispose: () => {} };
}

function installMockRuntime(
  store: any,
  options: {
    available?: DiscoveredModel[];
    providerModels?: Record<string, DiscoveredModel[]>;
  } = {},
): { refreshCalls: number; available: DiscoveredModel[] } {
  const available = options.available ?? [
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
  ];
  const providerModels = options.providerModels ?? {
    google: available.filter((m) => m.provider === "google"),
  };
  const state = { refreshCalls: 0, available };

  store.internalRuntime = {
    dispose: async () => {},
    services: {},
    diagnostics: [],
  };
  store.modelRuntime = {
    getProvider: (id: string) => {
      const models = providerModels[id];
      return models ? { getModels: () => models } : undefined;
    },
    getModel: (provider: string, modelId: string) => {
      const models = providerModels[provider] ?? [];
      return models.find((m) => m.id === modelId);
    },
    refresh: async () => {
      state.refreshCalls += 1;
      return { errors: new Map() };
    },
    checkAuth: async () => null,
    getProviderAuthStatus: (provider: string) =>
      provider === "google"
        ? { configured: true, source: "environment", label: "MOCK_KEY" }
        : undefined,
  };
  store.modelRegistry = {
    getAvailable: () => state.available,
    find: (provider: string, modelId: string) =>
      state.available.find((m) => m.provider === provider && m.id === modelId),
  };
  return state;
}

describe("SessionStore (mocked runtime)", () => {
  it("is not ready before any discovery has run", () => {
    const store = new SessionStore();
    assert.equal(store.ready, false);
    assert.equal(store.discoveryError, null);
    assert.equal(store.count(), 0);
  });

  it("refreshModels() marks ready and returns the mocked available catalog", async () => {
    const store = new SessionStore() as any;
    const state = installMockRuntime(store);
    delete process.env.ACPX_AGENTS;
    delete process.env.CLI_AGENTS;

    const models = await store.refreshModels();
    assert.equal(store.ready, true);
    assert.equal(store.discoveryError, null);
    assert.equal(models.length, state.available.length);
    assert.ok(models.every((m: DiscoveredModel) => m.provider === "google"));
    assert.ok(!models.some((m: DiscoveredModel) => m.provider.startsWith("acpx-")));
    assert.ok(!models.some((m: DiscoveredModel) => m.provider.startsWith("cli-")));
    // Pre-installed internalRuntime → refresh path (not first-discovery create).
    assert.equal(state.refreshCalls, 1);
  });

  it("refreshModels() returns an empty available catalog without treating it as failure", async () => {
    const store = new SessionStore() as any;
    installMockRuntime(store, { available: [], providerModels: { google: [{ id: "gemini-2.5-flash", name: "Flash", provider: "google" }] } });
    delete process.env.ACPX_AGENTS;
    delete process.env.CLI_AGENTS;

    const models = await store.refreshModels();
    assert.equal(models.length, 0);
    assert.equal(store.ready, true);
    assert.equal(store.discoveryError, null);

    const google = await store.getProviderStatus("google");
    assert.equal(google.registered, true);
    assert.equal(google.modelCount, 1);
  });

  it("refreshModels() can be called again and hits ModelRuntime.refresh each time after init", async () => {
    const store = new SessionStore() as any;
    const state = installMockRuntime(store);
    delete process.env.ACPX_AGENTS;
    delete process.env.CLI_AGENTS;

    const first = await store.refreshModels();
    const second = await store.refreshModels();
    assert.equal(second.length, first.length);
    assert.equal(state.refreshCalls, 2);
    assert.equal(store.discoveryError, null);
  });

  it("getModels() matches the most recent refreshModels() snapshot", async () => {
    const store = new SessionStore() as any;
    installMockRuntime(store);
    delete process.env.ACPX_AGENTS;
    delete process.env.CLI_AGENTS;

    const refreshed = await store.refreshModels();
    const listed = await store.getModels();
    assert.deepEqual(
      listed.map((m: DiscoveredModel) => m.id).sort(),
      refreshed.map((m: DiscoveredModel) => m.id).sort(),
    );
  });

  it("getModels() triggers discovery when store is not yet ready", async () => {
    const store = new SessionStore() as any;
    installMockRuntime(store);
    delete process.env.ACPX_AGENTS;
    delete process.env.CLI_AGENTS;

    assert.equal(store.ready, false);
    const listed = await store.getModels();
    assert.equal(store.ready, true);
    assert.ok(listed.length >= 1);
  });

  it("concurrent getModels() before ready share one refreshModels pass", async () => {
    const store = new SessionStore() as any;
    const state = installMockRuntime(store);
    delete process.env.ACPX_AGENTS;
    delete process.env.CLI_AGENTS;

    const [a, b] = await Promise.all([store.getModels(), store.getModels()]);
    assert.deepEqual(
      a.map((m: DiscoveredModel) => m.id).sort(),
      b.map((m: DiscoveredModel) => m.id).sort(),
    );
    // Mock installs internalRuntime up front, so discovery hits ModelRuntime.refresh
    // once; concurrent callers must join the same in-flight promise.
    assert.equal(state.refreshCalls, 1);
  });

  it("getProviderStatus() reports a registered builtin provider with a positive model count", async () => {
    const store = new SessionStore() as any;
    installMockRuntime(store);
    await store.refreshModels();
    const status = await store.getProviderStatus("google");
    assert.equal(status.provider, "google");
    assert.equal(status.registered, true);
    assert.ok(status.modelCount > 0);
    assert.ok(status.authStatus && typeof status.authStatus.configured === "boolean");
  });

  it("getProviderStatus() reports registered=false and modelCount=0 for an unknown provider", async () => {
    const store = new SessionStore() as any;
    installMockRuntime(store);
    const status = await store.getProviderStatus("totally-unknown-provider-xyz");
    assert.equal(status.registered, false);
    assert.equal(status.modelCount, 0);
  });

  it("getProviderStatus() reports zero models for acpx-*/cli-* providers when no agents are configured", async () => {
    const store = new SessionStore() as any;
    installMockRuntime(store);
    delete process.env.ACPX_AGENTS;
    delete process.env.CLI_AGENTS;
    await store.refreshModels();
    const acpxStatus = await store.getProviderStatus("acpx-cursor");
    const cliStatus = await store.getProviderStatus("cli-cursor");
    assert.equal(acpxStatus.modelCount, 0);
    assert.equal(cliStatus.modelCount, 0);
  });

  it("create() rejects an acpx-* model when ACPX_AGENTS is not configured", async () => {
    const store = new SessionStore() as any;
    installMockRuntime(store);
    delete process.env.ACPX_AGENTS;
    delete process.env.CLI_AGENTS;
    await store.refreshModels();
    await assert.rejects(
      () => store.create({ provider: "acpx-cursor", model: "cursor:default[]", systemPrompt: "test", cwd: "/tmp" }),
      /not found for provider 'acpx-cursor'/,
    );
  });

  it("create() rejects an unknown builtin model", async () => {
    const store = new SessionStore() as any;
    installMockRuntime(store);
    await store.refreshModels();
    await assert.rejects(
      () => store.create({ provider: "google", model: "not-a-real-model-xyz", systemPrompt: "test", cwd: "/tmp" }),
      /not found for provider 'google'/,
    );
  });

  describe("concurrent sessions interleaved with refresh", () => {
    it("keeps the model catalog stable while mocked sessions are created/deleted concurrently with refreshModels()", async () => {
      const store = new SessionStore() as any;
      const state = installMockRuntime(store);
      delete process.env.ACPX_AGENTS;
      delete process.env.CLI_AGENTS;

      const baseline = await store.refreshModels();
      const baselineIds = baseline.map((m: DiscoveredModel) => `${m.provider}/${m.id}`).sort();

      // Inject fake session entries — never call create() (that would hit the real SDK).
      const sessionIds = Array.from({ length: 5 }, (_, i) => `mock-session-${i}`);
      for (const id of sessionIds) {
        store.sessions.set(id, { session: fakeSession(), lastActivity: Date.now(), inFlight: false });
      }
      assert.equal(store.count(), 5);

      const concurrentRefreshes = Array.from({ length: 3 }, () => store.refreshModels());
      const refreshResults = await Promise.all(concurrentRefreshes);

      for (const refreshed of refreshResults) {
        assert.deepEqual(
          refreshed.map((m: DiscoveredModel) => `${m.provider}/${m.id}`).sort(),
          baselineIds,
          "every concurrent refreshModels() call must return the same stable catalog",
        );
      }
      assert.ok(state.refreshCalls >= 2); // 1 baseline + ≥1 coalesced concurrent batch (inFlight join)

      const [idsToDelete, idsToKeep] = [sessionIds.slice(0, 3), sessionIds.slice(3)];
      const [deleteResults, finalRefresh] = await Promise.all([
        Promise.all(idsToDelete.map((id) => store.delete(id))),
        store.refreshModels(),
      ]);

      assert.deepEqual(deleteResults, [true, true, true]);
      assert.equal(store.count(), idsToKeep.length);
      assert.deepEqual(
        finalRefresh.map((m: DiscoveredModel) => `${m.provider}/${m.id}`).sort(),
        baselineIds,
      );

      const finalCatalog = await store.getModels();
      assert.deepEqual(
        finalCatalog.map((m: DiscoveredModel) => `${m.provider}/${m.id}`).sort(),
        baselineIds,
      );

      for (const id of idsToKeep) {
        assert.equal(store.delete(id), true);
      }
      assert.equal(store.count(), 0);
    });
  });

  it("getProviderStatus() returns controlled 503 when discovery left no runtime", async () => {
    const store = new SessionStore() as any;
    // Simulate failed init: ready but no modelRuntime/modelRegistry.
    store._ready = true;
    store.modelRuntime = undefined;
    store.modelRegistry = undefined;
    await assert.rejects(
      () => store.getProviderStatus("google"),
      (err: any) => err?.statusCode === 503 && /runtime unavailable/.test(String(err?.message)),
    );
  });

  it("create() rejects HEADLESS_EXCLUDED_PROVIDERS (e.g. github-copilot)", async () => {
    const store = new SessionStore() as any;
    installMockRuntime(store);
    await assert.rejects(
      () =>
        store.create({
          provider: "github-copilot",
          model: "gpt-4.1",
          systemPrompt: "test",
          cwd: "/tmp",
        }),
      /requires interactive browser OAuth/,
    );
  });

  it("disposeAll() awaits in-flight runtimeInit and disposes a runtime assigned mid-shutdown", async () => {
    const store = new SessionStore() as any;
    let runtimeDisposed = false;
    const fakeRuntime = {
      dispose: async () => {
        runtimeDisposed = true;
      },
    };

    let resolveInit!: () => void;
    store.runtimeInit = new Promise<void>((resolve) => {
      resolveInit = () => {
        store.internalRuntime = fakeRuntime;
        resolve();
      };
    });

    const disposePromise = store.disposeAll();
    assert.equal(store.disposed, true);
    assert.equal(store.internalRuntime, undefined, "runtime must not exist yet mid-init");

    resolveInit();
    await disposePromise;

    assert.equal(runtimeDisposed, true, "runtime assigned during awaited init must be disposed");
    assert.equal(store.internalRuntime, undefined);
    assert.equal(store.runtimeInit, undefined);
  });
});
