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
});
