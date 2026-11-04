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
  publishedTaskStore,
  publishTaskStore,
} from "../../../extensions/shared/task-store-bridge.ts";

const clear = (): void => {
  delete (globalThis as Record<symbol, unknown>)[TASK_STORE_SYMBOL];
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
});
