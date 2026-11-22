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

export type WillRecoverPredicate = (messages: readonly any[] | undefined) => boolean;

interface MalformedRecoveryBridgeState {
  willRecover?: WillRecoverPredicate;
  pending: boolean;
  onRecoveryAborted: Set<() => void>;
}

function getBridgeState(): MalformedRecoveryBridgeState {
  const g = globalThis as Record<symbol, unknown>;
  let state = g[MALFORMED_RECOVERY_BRIDGE_SYMBOL] as MalformedRecoveryBridgeState | undefined;
  if (!state) {
    state = { pending: false, onRecoveryAborted: new Set() };
    g[MALFORMED_RECOVERY_BRIDGE_SYMBOL] = state;
  }
  return state;
}

/** Register the synchronous predicate reporting whether `agent_end` will retry `messages`. */
export function registerRecoveryCoordinator(willRecover: WillRecoverPredicate): () => void {
  const state = getBridgeState();
  state.willRecover = willRecover;
  log.debug("malformed_recovery_coordinator_registered");
  return () => {
    const current = (globalThis as Record<symbol, unknown>)[MALFORMED_RECOVERY_BRIDGE_SYMBOL] as
      | MalformedRecoveryBridgeState
      | undefined;
    if (current && current.willRecover === willRecover) {
      delete current.willRecover;
      log.debug("malformed_recovery_coordinator_unregistered");
    }
  };
}

/**
 * Report whether COMS should defer finalizing `currentInbound` on `agent_end`
 * because malformed-response recovery is about to (or just began to) schedule a follow-up.
 */
export function shouldDeferForMalformedRecovery(messages: readonly any[] | undefined): boolean {
  const state = (globalThis as Record<symbol, unknown>)[MALFORMED_RECOVERY_BRIDGE_SYMBOL] as
    | MalformedRecoveryBridgeState
    | undefined;
  if (!state) return false;
  if (typeof state.willRecover === "function") {
    if (messages === undefined) return state.pending;
    try {
      return Boolean(state.willRecover(messages));
    } catch (err) {
      log.debug("malformed_recovery_will_recover_error", { error: String(err) });
      return false;
    }
  }
  return state.pending;
}

/** Mark whether a malformed-response recovery follow-up is currently pending. */
export function markRecoveryPending(active: boolean): void {
  const state = getBridgeState();
  if (state.pending !== active) {
    state.pending = active;
    log.debug("malformed_recovery_pending_changed", { pending: active });
  }
}

/** Subscribe to abort/failure notifications so deferred COMS inbounds can finalize cleanly. */
export function onMalformedRecoveryAborted(cb: () => void): () => void {
  const state = getBridgeState();
  state.onRecoveryAborted.add(cb);
  log.debug("malformed_recovery_abort_listener_added", { listeners: state.onRecoveryAborted.size });
  return () => {
    state.onRecoveryAborted.delete(cb);
    log.debug("malformed_recovery_abort_listener_removed", { listeners: state.onRecoveryAborted.size });
  };
}

/** Notify all listeners that a pending recovery failed or was aborted. */
export function notifyMalformedRecoveryAborted(): void {
  const state = (globalThis as Record<symbol, unknown>)[MALFORMED_RECOVERY_BRIDGE_SYMBOL] as
    | MalformedRecoveryBridgeState
    | undefined;
  if (!state || state.onRecoveryAborted.size === 0) return;
  log.debug("malformed_recovery_aborted_notify", { listeners: state.onRecoveryAborted.size });
  for (const cb of [...state.onRecoveryAborted]) {
    try {
      cb();
    } catch (err) {
      log.debug("malformed_recovery_abort_listener_error", { error: String(err) });
    }
  }
}

/** Reset the global bridge slot between tests. */
export function resetMalformedRecoveryBridgeForTests(): void {
  delete (globalThis as Record<symbol, unknown>)[MALFORMED_RECOVERY_BRIDGE_SYMBOL];
}
