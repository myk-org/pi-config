/**
 * Shared per-session `globalThis[Symbol.for(...)]` Map registry helpers (#1337).
 *
 * Cross-extension bridges share a Node process across concurrent sessions in hosts
 * such as `pi-sidecar`. Every lookup is strictly exact-keyed (`normalizeBridgeSessionKey`),
 * never substituting another session's entry or the default slot for a mismatched key.
 */
import { createLogger } from "./logger.js";

const log = createLogger("session-bridge-map");

export const DEFAULT_BRIDGE_SESSION_KEY = "__default__";

/** Normalize an optional session ID to a non-empty bridge key (or DEFAULT_BRIDGE_SESSION_KEY). */
export function normalizeBridgeSessionKey(sessionKey?: string): string {
  if (typeof sessionKey === "string") {
    const trimmed = sessionKey.trim();
    if (trimmed) return trimmed;
  }
  return DEFAULT_BRIDGE_SESSION_KEY;
}

/** Resolve the per-session bridge key from an ExtensionContext (or DEFAULT_BRIDGE_SESSION_KEY). */
export function resolveBridgeSessionKey(ctx?: any): string {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    return normalizeBridgeSessionKey(typeof id === "string" ? id : undefined);
  } catch (err) {
    log.debug("bridge_session_key_resolve_failed", { error: String(err) });
    return DEFAULT_BRIDGE_SESSION_KEY;
  }
}

export function getExistingBridgeMap<T>(sym: symbol): Map<string, T> | undefined {
  const value = (globalThis as Record<symbol, unknown>)[sym];
  return value instanceof Map ? (value as Map<string, T>) : undefined;
}

export function getOrCreateBridgeMap<T>(sym: symbol): Map<string, T> {
  const g = globalThis as Record<symbol, unknown>;
  let map = g[sym];
  if (!(map instanceof Map)) {
    map = new Map<string, T>();
    g[sym] = map;
  }
  return map as Map<string, T>;
}

export function pruneBridgeMapIfEmpty<T>(sym: symbol, map: Map<string, T> | undefined): void {
  if (map && map.size === 0) {
    delete (globalThis as Record<symbol, unknown>)[sym];
  }
}

/** Strictly read the entry published under `sessionKey` (never falls back to another session). */
export function getBridgeSessionEntry<T>(sym: symbol, sessionKey?: string): T | undefined {
  const map = getExistingBridgeMap<T>(sym);
  if (!map) return undefined;
  return map.get(normalizeBridgeSessionKey(sessionKey));
}

/** Publish a value under `sessionKey` and return a compare-and-delete unregister callback. */
export function setBridgeSessionEntry<T>(
  sym: symbol,
  value: T,
  sessionKey?: string,
  onUnregister?: (key: string) => void,
): () => void {
  const key = normalizeBridgeSessionKey(sessionKey);
  const map = getOrCreateBridgeMap<T>(sym);
  map.set(key, value);
  return () => {
    const currentMap = getExistingBridgeMap<T>(sym);
    if (currentMap && currentMap.get(key) === value) {
      currentMap.delete(key);
      pruneBridgeMapIfEmpty(sym, currentMap);
      onUnregister?.(key);
    }
  };
}

/** Delete the entry for `sessionKey` and prune the map if empty. */
export function clearBridgeSessionEntry(sym: symbol, sessionKey?: string): void {
  const key = normalizeBridgeSessionKey(sessionKey);
  const map = getExistingBridgeMap<unknown>(sym);
  if (map) {
    map.delete(key);
    pruneBridgeMapIfEmpty(sym, map);
  }
}

/** Wipe the entire global bridge map between tests. */
export function resetBridgeMapForTests(sym: symbol): void {
  delete (globalThis as Record<symbol, unknown>)[sym];
}
