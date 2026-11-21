/**
 * Cross-module bridge for the pitasks store and telemetry activation.
 *
 * `pitasks` exports `taskStore` as `export let`, assigned when the extension
 * initializes, and keeps `currentWidget` module-local. Another extension's module
 * instance cannot read those bindings: `taskStore` snapshots `undefined` at import
 * time, which silently disabled task-id validation (issue #1016), and calling
 * `setTaskTelemetryActive` on a duplicate module instance hits a `null`
 * `currentWidget`. Both are therefore published on the global symbol registry from
 * the owning extension's registration path — never from module-load code — so
 * readers always reach the live owner across module instances.
 *
 * Same pattern as the pricing-provenance marker.
 */
import { createLogger } from "./logger.js";

const log = createLogger("task-store-bridge");

export const TASK_STORE_SYMBOL = Symbol.for("pi-config.taskStore");
export const TASK_TELEMETRY_ACTIVE_SYMBOL = Symbol.for("pi-config.taskTelemetryActive");

export type TaskTelemetryActiveCallback = (taskId: string, active?: boolean) => void;

interface TaskStoreBridge {
  readonly current: unknown;
}

/** Publish a getter over the live store binding. Called by the owning extension. */
export function publishTaskStore(getStore: () => unknown): void {
  (globalThis as Record<symbol, unknown>)[TASK_STORE_SYMBOL] = {
    get current(): unknown {
      return getStore();
    },
  } satisfies TaskStoreBridge;
  log.debug("task_store_bridge_published", { at: Date.now() });
}

/** The published store, or null when the owning extension has not registered. */
export function publishedTaskStore(): unknown {
  const bridge = (globalThis as Record<symbol, unknown>)[TASK_STORE_SYMBOL] as TaskStoreBridge | undefined;
  const store = bridge?.current ?? null;
  log.debug("task_store_bridge_read", { found: Boolean(store) });
  return store;
}

/** Publish the live widget telemetry-activation callback. Called by the owning extension. */
export function publishTaskTelemetryActive(setActive: TaskTelemetryActiveCallback): void {
  (globalThis as Record<symbol, unknown>)[TASK_TELEMETRY_ACTIVE_SYMBOL] = setActive;
  log.debug("task_telemetry_bridge_published", { at: Date.now() });
}

/** The published telemetry-activation callback, or null when the owning extension has not registered. */
export function publishedTaskTelemetryActive(): TaskTelemetryActiveCallback | null {
  const candidate = (globalThis as Record<symbol, unknown>)[TASK_TELEMETRY_ACTIVE_SYMBOL];
  const callback = typeof candidate === "function" ? (candidate as TaskTelemetryActiveCallback) : null;
  log.debug("task_telemetry_bridge_read", { found: Boolean(callback) });
  return callback;
}
