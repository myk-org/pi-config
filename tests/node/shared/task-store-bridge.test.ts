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
  TASK_STORE_SYMBOL,
  TASK_TELEMETRY_ACTIVE_SYMBOL,
  clearTaskStore,
  clearTaskTelemetryActive,
  publishedTaskStore,
  publishedTaskTelemetryActive,
  publishTaskStore,
  publishTaskTelemetryActive,
} from "../../../extensions/shared/task-store-bridge.ts";

const clear = (): void => {
  delete (globalThis as Record<symbol, unknown>)[TASK_STORE_SYMBOL];
  delete (globalThis as Record<symbol, unknown>)[TASK_TELEMETRY_ACTIVE_SYMBOL];
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

  it("ignores non-function values under the telemetry symbol", () => {
    (globalThis as Record<symbol, unknown>)[TASK_TELEMETRY_ACTIVE_SYMBOL] = { invalid: true };
    assert.equal(publishedTaskTelemetryActive(), null);
  });

  it("isolates stores and telemetry callbacks across concurrent sessions", () => {
    const storeA = { id: "a" };
    const storeB = { id: "b" };
    const unregA = publishTaskStore(() => storeA, "sess-a");
    publishTaskStore(() => storeB, "sess-b");

    assert.equal(publishedTaskStore("sess-a"), storeA);
    assert.equal(publishedTaskStore("sess-b"), storeB);
    assert.equal(publishedTaskStore(), null, "ambiguous un-keyed read returns null with multiple sessions");

    // A stale unregister handle must not clear a newer registration for the same session.
    const storeA2 = { id: "a2" };
    publishTaskStore(() => storeA2, "sess-a");
    unregA();
    assert.equal(publishedTaskStore("sess-a"), storeA2);

    clearTaskStore("sess-a");
    assert.equal(publishedTaskStore("sess-a"), null);
    assert.equal(publishedTaskStore("sess-b"), storeB);

    const seen: string[] = [];
    const unregTelA = publishTaskTelemetryActive((id) => seen.push(`a:${id}`), "sess-a");
    publishTaskTelemetryActive((id) => seen.push(`b:${id}`), "sess-b");
    publishedTaskTelemetryActive("sess-a")?.("1");
    publishedTaskTelemetryActive("sess-b")?.("2");
    assert.deepEqual(seen, ["a:1", "b:2"]);

    unregTelA();
    assert.equal(publishedTaskTelemetryActive("sess-a"), null);
    clearTaskTelemetryActive("sess-b");
    assert.equal(publishedTaskTelemetryActive("sess-b"), null);
  });
});
