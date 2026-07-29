import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SessionStore } from "../../src/sessions.js";

/**
 * Unit tests for SessionStore's private `snapshotAgentSource()` — the shared
 * helper behind `snapshotExtensionModels()` that decides, per agent, whether
 * to read models off the shared ModelRuntime's live provider catalog (the
 * "modelRuntime" branch) or fall back to a jiti-loaded discovery call (the
 * "fallback" branch, used when the provider isn't registered yet or is
 * registered but empty). Fallback results are filtered to models that
 * `ModelRuntime.getModel()` can resolve — and dropped entirely when the
 * provider itself is unregistered — so GET /models never advertises models
 * that POST /sessions cannot create.
 *
 * `modelRuntime` and `snapshotAgentSource` are private; this file reaches
 * past that via `as any` with a duck-typed `{ getProvider }` stand-in —
 * never spins up the real SDK/extensions. Same pattern as session-store.test.ts.
 */
describe("SessionStore.snapshotAgentSource", () => {
  it("prefers the live ModelRuntime provider catalog when it has models (modelRuntime branch)", async () => {
    const store = new SessionStore() as any;
    const runtimeModels = [{ id: "cursor:default[]", name: "Default", provider: "acpx-cursor" }];
    store.modelRuntime = {
      getProvider: (id: string) => (id === "acpx-cursor" ? { getModels: () => runtimeModels } : undefined),
    };

    let fallbackCalled = false;
    const fallback = async () => {
      fallbackCalled = true;
      return [{ id: "cursor:should-not-be-used[]", name: "Unused", provider: "acpx-cursor" }];
    };

    const result = await store.snapshotAgentSource(["cursor"], "acpx", fallback);

    assert.equal(fallbackCalled, false, "fallback must not run when the ModelRuntime provider already has models");
    assert.deepEqual(result, runtimeModels);
  });

  it("skips fallback discovery when the provider isn't registered on ModelRuntime", async () => {
    const store = new SessionStore() as any;
    store.modelRuntime = {
      getProvider: () => undefined,
      getModel: () => undefined,
    };

    let fallbackCalled = false;
    const fallback = async () => {
      fallbackCalled = true;
      return [{ id: "cursor:composer-2.5", name: "Composer", provider: "cli-cursor" }];
    };

    const result = await store.snapshotAgentSource(["cursor"], "cli", fallback);

    assert.equal(fallbackCalled, false, "unregistered providers must not run expensive fallback discovery");
    assert.deepEqual(result, []);
  });

  it("keeps only fallback models that ModelRuntime.getModel can resolve when the provider catalog is empty", async () => {
    const store = new SessionStore() as any;
    const resolvable = { id: "cursor:default[]", name: "Default", provider: "acpx-cursor" };
    const unresolvable = { id: "cursor:ghost[]", name: "Ghost", provider: "acpx-cursor" };
    store.modelRuntime = {
      getProvider: (id: string) => (id === "acpx-cursor" ? { getModels: () => [] } : undefined),
      getModel: (_provider: string, modelId: string) => (modelId === resolvable.id ? resolvable : undefined),
    };

    let fallbackCalled = false;
    const fallback = async () => {
      fallbackCalled = true;
      return [resolvable, unresolvable];
    };

    const result = await store.snapshotAgentSource(["cursor"], "acpx", fallback);

    assert.equal(fallbackCalled, true, "an empty (but registered) provider catalog must still trigger the fallback");
    assert.deepEqual(result, [resolvable]);
  });

  it("returns an empty array without touching modelRuntime/fallback when no agents are configured", async () => {
    const store = new SessionStore() as any;
    store.modelRuntime = {
      getProvider: () => {
        throw new Error("must not be called when there are no agents");
      },
    };
    const fallback = async () => {
      throw new Error("must not be called when there are no agents");
    };

    const result = await store.snapshotAgentSource([], "acpx", fallback);
    assert.deepEqual(result, []);
  });

  it("isolates per-agent failures: one agent's rejection does not affect another agent's result", async () => {
    const goodModels = [{ id: "cursor:default[]", name: "Default", provider: "acpx-cursor" }];
    const store = new SessionStore() as any;
    store.modelRuntime = {
      getProvider: (id: string) => (id.startsWith("acpx-") ? { getModels: () => [] } : undefined),
      getModel: (_provider: string, modelId: string) =>
        modelId === goodModels[0].id ? goodModels[0] : undefined,
    };

    const fallback = async (agent: string) => {
      if (agent === "broken") throw new Error("discovery exploded");
      return goodModels;
    };

    const result = await store.snapshotAgentSource(["broken", "cursor"], "acpx", fallback);
    assert.deepEqual(result, goodModels);
  });
});
