/**
 * The pitasks store bridge (issue #1016).
 *
 * The bug this guards: a reader snapshotted `taskStore` at import time and got
 * `undefined` forever, so task-id validation silently never ran. The bridge publishes a
 * getter over the live binding instead — and it must be published by the owning
 * extension, not by module-load code that a duplicate import would trigger.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BRIDGE_SESSION_KEY,
  SESSION_BRIDGE_SYMBOL,
  publishedTaskStore,
  publishedTaskTelemetryActive,
  publishTaskStore,
  publishTaskTelemetryActive,
  resetSessionBridge,
  resolveBridgeSessionKey,
} from "../../../extensions/shared/session-bridge.ts";

const clear = (): void => {
  resetSessionBridge({ all: true });
};

describe("task store bridge", () => {
  beforeEach(clear);

  it("returns null before the owning extension publishes", () => {
    assert.equal(publishedTaskStore(), null);
  });

  it("reads the live binding, so a store swap needs no republish", () => {
    let store: unknown = { id: "first" };
    publishTaskStore(() => store);
    assert.deepEqual(publishedTaskStore(), { id: "first" });

    store = { id: "second" };
    assert.deepEqual(publishedTaskStore(), { id: "second" }, "the getter must follow the binding");
  });

  it("reports null while the binding is still unassigned", () => {
    publishTaskStore(() => undefined);
    assert.equal(publishedTaskStore(), null, "an unpublished store is not an empty store");
  });

  it("returns null before telemetry activation is published", () => {
    assert.equal(publishedTaskTelemetryActive(), null);
  });

  it("returns the published telemetry activation callback", () => {
    const seen: Array<{ taskId: string; active: boolean }> = [];
    publishTaskTelemetryActive((taskId, active = true) => {
      seen.push({ taskId, active });
    });
    const bridged = publishedTaskTelemetryActive();
    assert.ok(bridged);
    bridged("42", false);
    assert.deepEqual(seen, [{ taskId: "42", active: false }]);
  });

  it("ignores non-function values under the telemetry slot", () => {
    (globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL] = { invalid: true };
    assert.equal(publishedTaskTelemetryActive(), null);

    (globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL] = new Map([
      [DEFAULT_BRIDGE_SESSION_KEY, { taskStore: { telemetryActive: { invalid: true } } }],
    ]);
    assert.equal(publishedTaskTelemetryActive(), null);
  });

  it("isolates published task stores between concurrent sessions", () => {
    const storeA = { id: "a" };
    const storeB = { id: "b" };
    publishTaskStore(() => storeA, "sess-a");
    publishTaskStore(() => storeB, "sess-b");

    assert.equal(publishedTaskStore("sess-a"), storeA);
    assert.equal(publishedTaskStore("sess-b"), storeB);
  });

  it("never substitutes a sole default or named entry for a mismatched session key", () => {
    publishTaskStore(() => ({ id: "default" }));
    assert.equal(publishedTaskStore("sess-explicit"), null);

    resetSessionBridge({ slot: "taskStore" });
    publishTaskStore(() => ({ id: "only" }), "sess-only");
    assert.equal(publishedTaskStore(), null);
    assert.equal(publishedTaskStore("sess-other"), null);

    publishTaskTelemetryActive(() => {});
    assert.equal(publishedTaskTelemetryActive("sess-explicit"), null);

    resetSessionBridge({ slot: "taskStore" });
    publishTaskTelemetryActive(() => {}, "sess-only");
    assert.equal(publishedTaskTelemetryActive(), null);
    assert.equal(publishedTaskTelemetryActive("sess-other"), null);
  });

  it("ignores a stale task-store unregister handle after republishing", () => {
    const storeA = { id: "a" };
    const storeA2 = { id: "a2" };
    const unregA = publishTaskStore(() => storeA, "sess-a");
    publishTaskStore(() => storeA2, "sess-a");
    unregA();
    assert.equal(publishedTaskStore("sess-a"), storeA2);
  });

  it("preserves sibling task stores when clearing one session", () => {
    const storeA = { id: "a" };
    const storeB = { id: "b" };
    publishTaskStore(() => storeA, "sess-a");
    publishTaskStore(() => storeB, "sess-b");
    resetSessionBridge({ sessionKey: "sess-a", slot: "taskStore" });
    assert.equal(publishedTaskStore("sess-a"), null);
    assert.equal(publishedTaskStore("sess-b"), storeB);
  });

  it("isolates telemetry activation callbacks between concurrent sessions", () => {
    const seen: string[] = [];
    const unregTelA = publishTaskTelemetryActive((id) => seen.push(`a:${id}`), "sess-a");
    publishTaskTelemetryActive((id) => seen.push(`b:${id}`), "sess-b");
    publishedTaskTelemetryActive("sess-a")?.("1");
    publishedTaskTelemetryActive("sess-b")?.("2");
    assert.deepEqual(seen, ["a:1", "b:2"]);

    unregTelA();
    assert.equal(publishedTaskTelemetryActive("sess-a"), null);
    resetSessionBridge({ sessionKey: "sess-b", slot: "taskStore" });
    assert.equal(publishedTaskTelemetryActive("sess-b"), null);
  });

  it("resolves trimmed session IDs from ExtensionContext via resolveBridgeSessionKey", () => {
    assert.equal(
      resolveBridgeSessionKey({ sessionManager: { getSessionId: () => "  sess-99  " } }),
      "sess-99",
    );
  });

  it("falls back to DEFAULT_BRIDGE_SESSION_KEY when ExtensionContext lacks a usable session ID", () => {
    assert.equal(resolveBridgeSessionKey(undefined), DEFAULT_BRIDGE_SESSION_KEY);
    assert.equal(resolveBridgeSessionKey({}), DEFAULT_BRIDGE_SESSION_KEY);
    assert.equal(resolveBridgeSessionKey({ sessionManager: { getSessionId: () => "   " } }), DEFAULT_BRIDGE_SESSION_KEY);
    assert.equal(resolveBridgeSessionKey({ sessionManager: { getSessionId: () => 42 } }), DEFAULT_BRIDGE_SESSION_KEY);
    assert.equal(
      resolveBridgeSessionKey({
        sessionManager: {
          getSessionId: () => {
            throw new Error("boom");
          },
        },
      }),
      DEFAULT_BRIDGE_SESSION_KEY,
    );
  });
});
