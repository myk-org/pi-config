/**
 * Cross-extension bridge coordinating malformed-response recovery with COMS (#1333).
 *
 * The orchestrator extension owns malformed-response auto-retry, while the COMS
 * extension finalizes active inbound peer requests on `agent_end`. Extensions load
 * independently and handler order is not guaranteed (e.g., `coms` loads before
 * `orchestrator`), so both sides coordinate through a process-local global symbol.
 */
import { createLogger } from "./logger.js";

const log = createLogger("malformed-recovery-bridge");

export const MALFORMED_RECOVERY_BRIDGE_SYMBOL = Symbol.for("pi-config.malformedRecoveryBridge");
export const DEFAULT_SESSION_KEY = "__default__";

export type WillRecoverPredicate = (messages: readonly any[] | undefined) => boolean;

interface SessionRecoverySlot {
  willRecover?: WillRecoverPredicate;
  pending: boolean;
  onRecoveryAborted: Set<() => void>;
}

function normalizeSessionKey(sessionKey?: string): string {
  if (typeof sessionKey === "string") {
    const trimmed = sessionKey.trim();
    if (trimmed) return trimmed;
  }
  return DEFAULT_SESSION_KEY;
}

/** Resolve the per-session bridge key from an ExtensionContext (or DEFAULT_SESSION_KEY). */
export function resolveRecoverySessionKey(ctx?: any): string {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    return normalizeSessionKey(typeof id === "string" ? id : undefined);
  } catch {
    return DEFAULT_SESSION_KEY;
  }
}

function getExistingBridgeMap(): Map<string, SessionRecoverySlot> | undefined {
  const value = (globalThis as Record<symbol, unknown>)[MALFORMED_RECOVERY_BRIDGE_SYMBOL];
  return value instanceof Map ? (value as Map<string, SessionRecoverySlot>) : undefined;
}

function getOrCreateBridgeMap(): Map<string, SessionRecoverySlot> {
  const g = globalThis as Record<symbol, unknown>;
  let map = g[MALFORMED_RECOVERY_BRIDGE_SYMBOL];
  if (!(map instanceof Map)) {
    map = new Map<string, SessionRecoverySlot>();
    g[MALFORMED_RECOVERY_BRIDGE_SYMBOL] = map;
  }
  return map as Map<string, SessionRecoverySlot>;
}

function getOrCreateSlot(key: string): SessionRecoverySlot {
  const map = getOrCreateBridgeMap();
  let slot = map.get(key);
  if (!slot) {
    slot = { pending: false, onRecoveryAborted: new Set() };
    map.set(key, slot);
  }
  return slot;
}

function pruneSlotIfEmpty(map: Map<string, SessionRecoverySlot> | undefined, key: string): void {
  if (!map) return;
  const slot = map.get(key);
  if (slot && !slot.willRecover && !slot.pending && slot.onRecoveryAborted.size === 0) {
    map.delete(key);
  }
}

/** Register the synchronous predicate reporting whether `agent_end` will retry `messages`. */
export function registerRecoveryCoordinator(
  willRecover: WillRecoverPredicate,
  sessionKey?: string,
): () => void {
  const key = normalizeSessionKey(sessionKey);
  const slot = getOrCreateSlot(key);
  slot.willRecover = willRecover;
  log.debug("malformed_recovery_coordinator_registered", { sessionKey: key });
  return () => {
    const map = getExistingBridgeMap();
    const current = map?.get(key);
    if (current && current.willRecover === willRecover) {
      delete current.willRecover;
      pruneSlotIfEmpty(map, key);
      log.debug("malformed_recovery_coordinator_unregistered", { sessionKey: key });
    }
  };
}

/**
 * Report whether COMS should defer finalizing `currentInbound` on `agent_end`
 * because malformed-response recovery is about to (or just began to) schedule a follow-up.
 */
export function shouldDeferForMalformedRecovery(
  messages: readonly any[] | undefined,
  sessionKey?: string,
): boolean {
  const key = normalizeSessionKey(sessionKey);
  const slot = getExistingBridgeMap()?.get(key);
  if (!slot) return false;
  if (typeof slot.willRecover === "function") {
    if (messages === undefined) return slot.pending;
    try {
      return Boolean(slot.willRecover(messages));
    } catch (err) {
      log.debug("malformed_recovery_will_recover_error", { sessionKey: key, error: String(err) });
      return false;
    }
  }
  return slot.pending;
}

/** Mark whether a malformed-response recovery follow-up is currently pending. */
export function markRecoveryPending(active: boolean, sessionKey?: string): void {
  const key = normalizeSessionKey(sessionKey);
  if (!active) {
    const map = getExistingBridgeMap();
    const slot = map?.get(key);
    if (!slot) return;
    if (slot.pending) {
      slot.pending = false;
      log.debug("malformed_recovery_pending_changed", { sessionKey: key, pending: false });
    }
    pruneSlotIfEmpty(map, key);
    return;
  }
  const slot = getOrCreateSlot(key);
  if (!slot.pending) {
    slot.pending = true;
    log.debug("malformed_recovery_pending_changed", { sessionKey: key, pending: true });
  }
}

/** Subscribe to abort/failure notifications so deferred COMS inbounds can finalize cleanly. */
export function onMalformedRecoveryAborted(cb: () => void, sessionKey?: string): () => void {
  const key = normalizeSessionKey(sessionKey);
  const slot = getOrCreateSlot(key);
  slot.onRecoveryAborted.add(cb);
  log.debug("malformed_recovery_abort_listener_added", {
    sessionKey: key,
    listeners: slot.onRecoveryAborted.size,
  });
  return () => {
    const map = getExistingBridgeMap();
    const current = map?.get(key);
    if (!current || !current.onRecoveryAborted.delete(cb)) return;
    log.debug("malformed_recovery_abort_listener_removed", {
      sessionKey: key,
      listeners: current.onRecoveryAborted.size,
    });
    pruneSlotIfEmpty(map, key);
  };
}

/** Notify listeners for a session that a pending recovery failed or was aborted. */
export function notifyMalformedRecoveryAborted(sessionKey?: string): void {
  const key = normalizeSessionKey(sessionKey);
  const slot = getExistingBridgeMap()?.get(key);
  if (!slot || slot.onRecoveryAborted.size === 0) return;
  log.debug("malformed_recovery_aborted_notify", {
    sessionKey: key,
    listeners: slot.onRecoveryAborted.size,
  });
  for (const cb of [...slot.onRecoveryAborted]) {
    try {
      cb();
    } catch (err) {
      log.debug("malformed_recovery_abort_listener_error", { sessionKey: key, error: String(err) });
    }
  }
}

/** Reset the global bridge slot between tests. */
export function resetMalformedRecoveryBridgeForTests(): void {
  delete (globalThis as Record<symbol, unknown>)[MALFORMED_RECOVERY_BRIDGE_SYMBOL];
}
