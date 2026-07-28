import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ProviderDriverRegistry } from "../../../extensions/shared/provider-registry.js";
import type { ProviderDriver, ProviderInstance } from "../../../extensions/shared/provider-driver.js";

function createMockDriver(kind: string, opts?: { probeAvailable?: boolean; createThrows?: boolean }): ProviderDriver<{ value: string }> {
  return {
    driverKind: kind,
    metadata: { displayName: `Mock ${kind}` },
    configSchema: { parse: (raw: unknown) => ({ value: raw && typeof raw === "object" ? String((raw as any).value || "default") : "default" }) },
    defaultConfig: () => ({ value: "default" }),
    probe: async () => opts?.probeAvailable === false ? { available: false, reason: "mock unavailable" } : { available: true, version: "1.0.0" },
    create: async (input) => {
      if (opts?.createThrows) throw new Error("mock create failure");
      return {
        instanceId: input.instanceId, driverKind: kind, displayName: input.displayName, enabled: input.enabled,
        snapshot: { getSnapshot: () => ({ available: true, models: [{ id: "m1", name: "M1" }], checkedAt: new Date().toISOString() }), refresh: async () => ({ available: true, models: [{ id: "m1", name: "M1" }], checkedAt: new Date().toISOString() }), dispose: () => {} },
        adapter: { startSession: async () => ({ sessionId: "s", model: "default" }), sendTurn: async () => ({ text: "ok", stopReason: "stop" }), stopSession: async () => {}, stopAll: async () => {}, hasSession: () => false },
        dispose: async () => {},
      } satisfies ProviderInstance;
    },
  };
}

describe("ProviderDriverRegistry", () => {
  let registry: ProviderDriverRegistry;
  beforeEach(() => { registry = new ProviderDriverRegistry(); });
  it("registered driver is retrievable by kind", () => { const d = createMockDriver("test"); registry.registerDriver(d); assert.equal(registry.getDriver("test"), d); });
  it("lists driver kinds", () => { registry.registerDriver(createMockDriver("a")); registry.registerDriver(createMockDriver("b")); assert.deepEqual(registry.listDriverKinds().sort(), ["a", "b"]); });
  it("creates a live instance", async () => { registry.registerDriver(createMockDriver("test")); const i = await registry.createInstance("t1", { driver: "test", enabled: true }, "/tmp"); assert.equal(i.instanceId, "t1"); });
  it("throws for unknown driver", async () => { await assert.rejects(() => registry.createInstance("x", { driver: "nope" }, "/tmp"), /not registered/); });
  it("unavailable for failed probe", async () => { registry.registerDriver(createMockDriver("bad", { probeAvailable: false })); await registry.reconcile({ "bad-1": { driver: "bad" } }, "/tmp"); assert.equal(registry.listUnavailable().length, 1); });
  it("unavailable for failed create", async () => { registry.registerDriver(createMockDriver("fail", { createThrows: true })); await registry.reconcile({ f1: { driver: "fail" } }, "/tmp"); assert.equal(registry.listUnavailable().length, 1); });
  it("reconcile adds instances", async () => { registry.registerDriver(createMockDriver("test")); await registry.reconcile({ a: { driver: "test" }, b: { driver: "test" } }, "/tmp"); assert.equal(registry.listInstances().length, 2); });
  it("reconcile removes instances", async () => { registry.registerDriver(createMockDriver("test")); await registry.reconcile({ a: { driver: "test" } }, "/tmp"); await registry.reconcile({}, "/tmp"); assert.equal(registry.listInstances().length, 0); });
  it("notifies on change", async () => { registry.registerDriver(createMockDriver("test")); let n = false; registry.onChange(() => { n = true; }); await registry.reconcile({ inst: { driver: "test" } }, "/tmp"); assert.ok(n); });
  it("tears down all", async () => { registry.registerDriver(createMockDriver("test")); await registry.reconcile({ a: { driver: "test" }, b: { driver: "test" } }, "/tmp"); await registry.teardownAll(); assert.equal(registry.listInstances().length, 0); });
  it("returns live snapshot", async () => { registry.registerDriver(createMockDriver("test")); await registry.reconcile({ inst: { driver: "test" } }, "/tmp"); assert.equal((registry.getSnapshot("inst") as any).available, true); });
  it("returns unavailable snapshot", async () => { registry.registerDriver(createMockDriver("bad", { probeAvailable: false })); await registry.reconcile({ inst: { driver: "bad" } }, "/tmp"); assert.equal((registry.getSnapshot("inst") as any).available, false); });
  it("returns undefined for unknown id", () => { assert.equal(registry.getSnapshot("nope"), undefined); });
});
