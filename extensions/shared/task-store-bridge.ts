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
import {
  DEFAULT_BRIDGE_SESSION_KEY,
  clearBridgeSessionEntry,
  getBridgeSessionEntry,
  normalizeBridgeSessionKey,
  resetBridgeMapForTests,
  resolveBridgeSessionKey,
  setBridgeSessionEntry,
} from "./session-bridge-map.js";

const log = createLogger("task-store-bridge");

export const TASK_STORE_SYMBOL = Symbol.for("pi-config.taskStore");
export const TASK_TELEMETRY_ACTIVE_SYMBOL = Symbol.for("pi-config.taskTelemetryActive");
export const DEFAULT_TASK_BRIDGE_SESSION_KEY = DEFAULT_BRIDGE_SESSION_KEY;

export type TaskTelemetryActiveCallback = (taskId: string, active?: boolean) => void;

interface TaskStoreBridge {
  readonly current: unknown;
}

/** Resolve the per-session task bridge key from an ExtensionContext (or DEFAULT_TASK_BRIDGE_SESSION_KEY). */
export function resolveTaskBridgeSessionKey(ctx?: any): string {
  return resolveBridgeSessionKey(ctx);
}

/** Publish a getter over the live store binding for a session. Returns an idempotent unregister callback. */
export function publishTaskStore(getStore: () => unknown, sessionKey?: string): () => void {
  const key = normalizeBridgeSessionKey(sessionKey);
  const bridge: TaskStoreBridge = {
    get current(): unknown {
      return getStore();
    },
  };
  log.debug("task_store_bridge_published", { sessionKey: key, at: Date.now() });
  return setBridgeSessionEntry(TASK_STORE_SYMBOL, bridge, key, (removedKey) => {
    log.debug("task_store_bridge_unregistered", { sessionKey: removedKey, at: Date.now() });
  });
}

/** Clear the published store for a session. */
export function clearTaskStore(sessionKey?: string): void {
  const key = normalizeBridgeSessionKey(sessionKey);
  clearBridgeSessionEntry(TASK_STORE_SYMBOL, key);
  log.debug("task_store_bridge_cleared", { sessionKey: key, at: Date.now() });
}

/** The published store for a session, or null when absent for that exact session key. */
export function publishedTaskStore(sessionKey?: string): unknown {
  const key = normalizeBridgeSessionKey(sessionKey);
  const bridge = getBridgeSessionEntry<TaskStoreBridge>(TASK_STORE_SYMBOL, key);
  const store = bridge?.current ?? null;
  log.debug("task_store_bridge_read", { sessionKey: key, found: Boolean(store) });
  return store;
}

/** Publish the live widget telemetry-activation callback for a session. Returns an idempotent unregister callback. */
export function publishTaskTelemetryActive(setActive: TaskTelemetryActiveCallback, sessionKey?: string): () => void {
  const key = normalizeBridgeSessionKey(sessionKey);
  log.debug("task_telemetry_bridge_published", { sessionKey: key, at: Date.now() });
  return setBridgeSessionEntry(TASK_TELEMETRY_ACTIVE_SYMBOL, setActive, key, (removedKey) => {
    log.debug("task_telemetry_bridge_unregistered", { sessionKey: removedKey, at: Date.now() });
  });
}

/** Clear the published telemetry-activation callback for a session. */
export function clearTaskTelemetryActive(sessionKey?: string): void {
  const key = normalizeBridgeSessionKey(sessionKey);
  clearBridgeSessionEntry(TASK_TELEMETRY_ACTIVE_SYMBOL, key);
  log.debug("task_telemetry_bridge_cleared", { sessionKey: key, at: Date.now() });
}

/** The published telemetry-activation callback for a session, or null when absent for that exact session key. */
export function publishedTaskTelemetryActive(sessionKey?: string): TaskTelemetryActiveCallback | null {
  const key = normalizeBridgeSessionKey(sessionKey);
  const candidate = getBridgeSessionEntry<TaskTelemetryActiveCallback>(TASK_TELEMETRY_ACTIVE_SYMBOL, key);
  const callback = typeof candidate === "function" ? candidate : null;
  log.debug("task_telemetry_bridge_read", { sessionKey: key, found: Boolean(callback) });
  return callback;
}

/** Reset both task-store bridge maps between tests. */
export function resetTaskStoreBridgeForTests(): void {
  resetBridgeMapForTests(TASK_STORE_SYMBOL);
  resetBridgeMapForTests(TASK_TELEMETRY_ACTIVE_SYMBOL);
}
