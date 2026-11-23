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
export const DEFAULT_TASK_BRIDGE_SESSION_KEY = "__default__";

export type TaskTelemetryActiveCallback = (taskId: string, active?: boolean) => void;

interface TaskStoreBridge {
  readonly current: unknown;
}

function normalizeSessionKey(sessionKey?: string): string {
  if (typeof sessionKey === "string") {
    const trimmed = sessionKey.trim();
    if (trimmed) return trimmed;
  }
  return DEFAULT_TASK_BRIDGE_SESSION_KEY;
}

/** Resolve the per-session task bridge key from an ExtensionContext (or DEFAULT_TASK_BRIDGE_SESSION_KEY). */
export function resolveTaskBridgeSessionKey(ctx?: any): string {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    return normalizeSessionKey(typeof id === "string" ? id : undefined);
  } catch {
    return DEFAULT_TASK_BRIDGE_SESSION_KEY;
  }
}

function getExistingBridgeMap<T>(sym: symbol): Map<string, T> | undefined {
  const value = (globalThis as Record<symbol, unknown>)[sym];
  return value instanceof Map ? (value as Map<string, T>) : undefined;
}

function getOrCreateBridgeMap<T>(sym: symbol): Map<string, T> {
  const g = globalThis as Record<symbol, unknown>;
  let map = g[sym];
  if (!(map instanceof Map)) {
    map = new Map<string, T>();
    g[sym] = map;
  }
  return map as Map<string, T>;
}

function pruneMapIfEmpty<T>(sym: symbol, map: Map<string, T> | undefined): void {
  if (map && map.size === 0) {
    delete (globalThis as Record<symbol, unknown>)[sym];
  }
}

function lookupSessionEntry<T>(
  map: Map<string, T> | undefined,
  sessionKey: string | undefined,
  label: string,
): T | undefined {
  if (!map) return undefined;
  const key = normalizeSessionKey(sessionKey);
  const direct = map.get(key);
  if (direct !== undefined) return direct;
  if (key !== DEFAULT_TASK_BRIDGE_SESSION_KEY) {
    // Compat fallback for single-session/test publishers that did not specify a session key.
    if (map.size === 1 && map.has(DEFAULT_TASK_BRIDGE_SESSION_KEY)) {
      return map.get(DEFAULT_TASK_BRIDGE_SESSION_KEY);
    }
    return undefined;
  }
  if (map.size === 1) return map.values().next().value;
  if (map.size > 1) {
    log.debug(`${label}_ambiguous_default_lookup`, { sessions: map.size });
  }
  return undefined;
}

/** Publish a getter over the live store binding for a session. Returns an idempotent unregister callback. */
export function publishTaskStore(getStore: () => unknown, sessionKey?: string): () => void {
  const key = normalizeSessionKey(sessionKey);
  const bridge: TaskStoreBridge = {
    get current(): unknown {
      return getStore();
    },
  };
  const map = getOrCreateBridgeMap<TaskStoreBridge>(TASK_STORE_SYMBOL);
  map.set(key, bridge);
  log.debug("task_store_bridge_published", { sessionKey: key, at: Date.now() });
  return () => {
    const currentMap = getExistingBridgeMap<TaskStoreBridge>(TASK_STORE_SYMBOL);
    if (currentMap && currentMap.get(key) === bridge) {
      currentMap.delete(key);
      pruneMapIfEmpty(TASK_STORE_SYMBOL, currentMap);
      log.debug("task_store_bridge_unregistered", { sessionKey: key, at: Date.now() });
    }
  };
}

/** Clear the published store for a session. */
export function clearTaskStore(sessionKey?: string): void {
  const key = normalizeSessionKey(sessionKey);
  const map = getExistingBridgeMap<TaskStoreBridge>(TASK_STORE_SYMBOL);
  if (map) {
    map.delete(key);
    pruneMapIfEmpty(TASK_STORE_SYMBOL, map);
  }
  log.debug("task_store_bridge_cleared", { sessionKey: key, at: Date.now() });
}

/** The published store for a session, or null when absent (or ambiguous across concurrent sessions). */
export function publishedTaskStore(sessionKey?: string): unknown {
  const map = getExistingBridgeMap<TaskStoreBridge>(TASK_STORE_SYMBOL);
  const bridge = lookupSessionEntry(map, sessionKey, "task_store_bridge");
  const store = bridge?.current ?? null;
  log.debug("task_store_bridge_read", { sessionKey: normalizeSessionKey(sessionKey), found: Boolean(store) });
  return store;
}

/** Publish the live widget telemetry-activation callback for a session. Returns an idempotent unregister callback. */
export function publishTaskTelemetryActive(setActive: TaskTelemetryActiveCallback, sessionKey?: string): () => void {
  const key = normalizeSessionKey(sessionKey);
  const map = getOrCreateBridgeMap<TaskTelemetryActiveCallback>(TASK_TELEMETRY_ACTIVE_SYMBOL);
  map.set(key, setActive);
  log.debug("task_telemetry_bridge_published", { sessionKey: key, at: Date.now() });
  return () => {
    const currentMap = getExistingBridgeMap<TaskTelemetryActiveCallback>(TASK_TELEMETRY_ACTIVE_SYMBOL);
    if (currentMap && currentMap.get(key) === setActive) {
      currentMap.delete(key);
      pruneMapIfEmpty(TASK_TELEMETRY_ACTIVE_SYMBOL, currentMap);
      log.debug("task_telemetry_bridge_unregistered", { sessionKey: key, at: Date.now() });
    }
  };
}

/** Clear the published telemetry-activation callback for a session. */
export function clearTaskTelemetryActive(sessionKey?: string): void {
  const key = normalizeSessionKey(sessionKey);
  const map = getExistingBridgeMap<TaskTelemetryActiveCallback>(TASK_TELEMETRY_ACTIVE_SYMBOL);
  if (map) {
    map.delete(key);
    pruneMapIfEmpty(TASK_TELEMETRY_ACTIVE_SYMBOL, map);
  }
  log.debug("task_telemetry_bridge_cleared", { sessionKey: key, at: Date.now() });
}

/** The published telemetry-activation callback for a session, or null when absent. */
export function publishedTaskTelemetryActive(sessionKey?: string): TaskTelemetryActiveCallback | null {
  const map = getExistingBridgeMap<TaskTelemetryActiveCallback>(TASK_TELEMETRY_ACTIVE_SYMBOL);
  const candidate = lookupSessionEntry(map, sessionKey, "task_telemetry_bridge");
  const callback = typeof candidate === "function" ? candidate : null;
  log.debug("task_telemetry_bridge_read", { sessionKey: normalizeSessionKey(sessionKey), found: Boolean(callback) });
  return callback;
}

/** Reset both task-store bridge maps between tests. */
export function resetTaskStoreBridgeForTests(): void {
  delete (globalThis as Record<symbol, unknown>)[TASK_STORE_SYMBOL];
  delete (globalThis as Record<symbol, unknown>)[TASK_TELEMETRY_ACTIVE_SYMBOL];
}
