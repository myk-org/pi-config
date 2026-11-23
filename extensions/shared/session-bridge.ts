/**
 * Unified per-session cross-extension bridge (`extensions/shared/session-bridge.ts`, #1364).
 *
 * Extensions load independently and share one Node process across concurrent sessions in hosts
 * such as `pi-sidecar`. All mutable per-session cross-extension state lives inside a single
 * `globalThis[SESSION_BRIDGE_SYMBOL]` `Map<sessionKey, SessionBridgeSlot>` with four typed slots:
 *   - `taskStore`: live pitasks store getter & widget telemetry-activation callback (#1016)
 *   - `workload`: orchestrator async-agent & cron getters for coms/pitasks (#1083)
 *   - `malformedRecovery`: orchestrator <-> coms malformed-response retry coordination (#1333)
 *   - `comsActive`: per-session P2P coms active flag for rules assembly
 *
 * Every lookup is strictly exact-keyed (`normalizeBridgeSessionKey`), never substituting another
 * session's entry or the default slot for a mismatched key. Empty session slots are pruned
 * automatically, and the outer `globalThis` Map is deleted once empty.
 */
import { createLogger } from "./logger.js";

const log = createLogger("session-bridge");

export const SESSION_BRIDGE_SYMBOL = Symbol.for("pi-config.sessionBridge");
export const DEFAULT_BRIDGE_SESSION_KEY = "__default__";

export type TaskTelemetryActiveCallback = (taskId: string, active?: boolean) => void;
export type WillRecoverPredicate = (messages: readonly any[] | undefined) => boolean;

/** One async agent, as the orchestrator tracks it. */
export interface WorkloadAgent {
  id: string;
  agent: string;
  name?: string;
  task: string;
  status: string;
  startedAt: number;
  /** Linked pitasks task ID when spawned with `taskId` (#1104). */
  taskId?: string;
}

/** One scheduled cron (session or project scope). */
export interface WorkloadCron {
  id: string;
  scope: string;
  description: string;
  task: string;
  intervalMs?: number;
  atHour?: number;
  atMinute?: number;
  createdAt: number;
  lastRun?: number;
  nextRun?: number;
  /** Project crons: false on a non-leader replica. Absent on session crons. */
  leader?: boolean;
  /** Paused by the user: kept in the store, not active work (#1087). */
  paused?: boolean;
}

export interface WorkloadSources {
  agents: () => WorkloadAgent[];
  crons: () => WorkloadCron[];
}

interface TaskStoreBinding {
  readonly current: unknown;
}

export interface TaskStoreBridgeSlot {
  store?: TaskStoreBinding;
  telemetryActive?: TaskTelemetryActiveCallback;
}

export interface MalformedRecoveryBridgeSlot {
  willRecover?: WillRecoverPredicate;
  pending: boolean;
  onRecoveryAborted: Set<() => void>;
}

export interface SessionBridgeSlot {
  taskStore?: TaskStoreBridgeSlot;
  workload?: WorkloadSources;
  malformedRecovery?: MalformedRecoveryBridgeSlot;
  comsActive?: boolean;
}

export type SessionBridgeSlotName = keyof SessionBridgeSlot;

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

function getExistingBridgeMap(): Map<string, SessionBridgeSlot> | undefined {
  const value = (globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL];
  return value instanceof Map ? (value as Map<string, SessionBridgeSlot>) : undefined;
}

function getOrCreateBridgeMap(): Map<string, SessionBridgeSlot> {
  const g = globalThis as Record<symbol, unknown>;
  let map = g[SESSION_BRIDGE_SYMBOL];
  if (!(map instanceof Map)) {
    map = new Map<string, SessionBridgeSlot>();
    g[SESSION_BRIDGE_SYMBOL] = map;
  }
  return map as Map<string, SessionBridgeSlot>;
}

function getSessionSlot(key: string): SessionBridgeSlot | undefined {
  const slot = getExistingBridgeMap()?.get(key);
  return slot !== null && typeof slot === "object" ? slot : undefined;
}

function getOrCreateSessionSlot(key: string): SessionBridgeSlot {
  const map = getOrCreateBridgeMap();
  const existing = map.get(key);
  if (existing !== null && typeof existing === "object") {
    return existing;
  }
  const slot: SessionBridgeSlot = {};
  map.set(key, slot);
  return slot;
}

function getOrCreateTaskStoreSlot(key: string): TaskStoreBridgeSlot {
  const slot = getOrCreateSessionSlot(key);
  if (!slot.taskStore || typeof slot.taskStore !== "object") {
    slot.taskStore = {};
  }
  return slot.taskStore;
}

function getOrCreateMalformedRecoverySlot(key: string): MalformedRecoveryBridgeSlot {
  const slot = getOrCreateSessionSlot(key);
  if (
    !slot.malformedRecovery ||
    typeof slot.malformedRecovery !== "object" ||
    !(slot.malformedRecovery.onRecoveryAborted instanceof Set)
  ) {
    slot.malformedRecovery = { pending: false, onRecoveryAborted: new Set() };
  }
  return slot.malformedRecovery;
}

function pruneSessionSlot(map: Map<string, SessionBridgeSlot> | undefined, key: string): void {
  if (!map) return;
  const slot = map.get(key);
  if (slot !== null && typeof slot === "object") {
    if (slot.taskStore && !slot.taskStore.store && !slot.taskStore.telemetryActive) {
      delete slot.taskStore;
    }
    if (
      slot.malformedRecovery &&
      !slot.malformedRecovery.willRecover &&
      !slot.malformedRecovery.pending &&
      (!(slot.malformedRecovery.onRecoveryAborted instanceof Set) ||
        slot.malformedRecovery.onRecoveryAborted.size === 0)
    ) {
      delete slot.malformedRecovery;
    }
    if (!slot.comsActive) {
      delete slot.comsActive;
    }
    if (slot.workload === undefined) {
      delete slot.workload;
    }
    if (Object.keys(slot).length === 0) {
      map.delete(key);
    }
  }
  if (map.size === 0) {
    delete (globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL];
  }
}

// ── taskStore slot ──────────────────────────────────────────────────────────

/** Publish a getter over the live task store binding for a session. Returns an idempotent unregister callback. */
export function publishTaskStore(getStore: () => unknown, sessionKey?: string): () => void {
  const key = normalizeBridgeSessionKey(sessionKey);
  const binding: TaskStoreBinding = {
    get current(): unknown {
      return getStore();
    },
  };
  getOrCreateTaskStoreSlot(key).store = binding;
  log.debug("task_store_bridge_published", { sessionKey: key, at: Date.now() });
  return () => {
    const map = getExistingBridgeMap();
    const taskSlot = map?.get(key)?.taskStore;
    if (taskSlot && taskSlot.store === binding) {
      delete taskSlot.store;
      pruneSessionSlot(map, key);
      log.debug("task_store_bridge_unregistered", { sessionKey: key, at: Date.now() });
    }
  };
}

/** The published task store for a session, or null when absent for that exact session key. */
export function publishedTaskStore(sessionKey?: string): unknown {
  const key = normalizeBridgeSessionKey(sessionKey);
  const binding = getSessionSlot(key)?.taskStore?.store;
  const store = binding && typeof binding === "object" ? (binding.current ?? null) : null;
  log.debug("task_store_bridge_read", { sessionKey: key, found: Boolean(store) });
  return store;
}

/** Publish the live widget telemetry-activation callback for a session. Returns an idempotent unregister callback. */
export function publishTaskTelemetryActive(setActive: TaskTelemetryActiveCallback, sessionKey?: string): () => void {
  const key = normalizeBridgeSessionKey(sessionKey);
  getOrCreateTaskStoreSlot(key).telemetryActive = setActive;
  log.debug("task_telemetry_bridge_published", { sessionKey: key, at: Date.now() });
  return () => {
    const map = getExistingBridgeMap();
    const taskSlot = map?.get(key)?.taskStore;
    if (taskSlot && taskSlot.telemetryActive === setActive) {
      delete taskSlot.telemetryActive;
      pruneSessionSlot(map, key);
      log.debug("task_telemetry_bridge_unregistered", { sessionKey: key, at: Date.now() });
    }
  };
}

/** The published telemetry-activation callback for a session, or null when absent for that exact session key. */
export function publishedTaskTelemetryActive(sessionKey?: string): TaskTelemetryActiveCallback | null {
  const key = normalizeBridgeSessionKey(sessionKey);
  const candidate = getSessionSlot(key)?.taskStore?.telemetryActive;
  const callback = typeof candidate === "function" ? candidate : null;
  log.debug("task_telemetry_bridge_read", { sessionKey: key, found: Boolean(callback) });
  return callback;
}

// ── workload slot ───────────────────────────────────────────────────────────

function isValidWorkloadSources(candidate: unknown): candidate is WorkloadSources {
  const sources = candidate as WorkloadSources | undefined;
  return Boolean(sources && typeof sources.agents === "function" && typeof sources.crons === "function");
}

/** Publish the orchestrator's workload getters for a session. Returns an idempotent unregister callback. */
export function publishWorkloadSources(sources: WorkloadSources, sessionKey?: string): () => void {
  const key = normalizeBridgeSessionKey(sessionKey);
  getOrCreateSessionSlot(key).workload = sources;
  log.debug("workload_sources_published", { sessionKey: key, at: Date.now() });
  return () => {
    const map = getExistingBridgeMap();
    const slot = map?.get(key);
    if (slot && slot.workload === sources) {
      delete slot.workload;
      pruneSessionSlot(map, key);
      log.debug("workload_sources_unregistered", { sessionKey: key, at: Date.now() });
    }
  };
}

/** The workload sources for a session, or null when absent for that exact session key. */
export function publishedWorkloadSources(sessionKey?: string): WorkloadSources | null {
  const key = normalizeBridgeSessionKey(sessionKey);
  const candidate = getSessionSlot(key)?.workload;
  return isValidWorkloadSources(candidate) ? candidate : null;
}

// ── malformedRecovery slot ──────────────────────────────────────────────────

/** Register the synchronous predicate reporting whether `agent_end` will retry `messages`. */
export function registerRecoveryCoordinator(
  willRecover: WillRecoverPredicate,
  sessionKey?: string,
): () => void {
  const key = normalizeBridgeSessionKey(sessionKey);
  const recovery = getOrCreateMalformedRecoverySlot(key);
  recovery.willRecover = willRecover;
  log.debug("malformed_recovery_coordinator_registered", { sessionKey: key });
  return () => {
    const map = getExistingBridgeMap();
    const current = map?.get(key)?.malformedRecovery;
    if (current && current.willRecover === willRecover) {
      delete current.willRecover;
      pruneSessionSlot(map, key);
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
  const key = normalizeBridgeSessionKey(sessionKey);
  const recovery = getSessionSlot(key)?.malformedRecovery;
  if (!recovery || typeof recovery !== "object") return false;
  if (typeof recovery.willRecover === "function") {
    if (messages === undefined) return Boolean(recovery.pending);
    try {
      return Boolean(recovery.willRecover(messages));
    } catch (err) {
      log.debug("malformed_recovery_will_recover_error", { sessionKey: key, error: String(err) });
      return false;
    }
  }
  return Boolean(recovery.pending);
}

/** Mark whether a malformed-response recovery follow-up is currently pending. */
export function markRecoveryPending(active: boolean, sessionKey?: string): void {
  const key = normalizeBridgeSessionKey(sessionKey);
  if (!active) {
    const map = getExistingBridgeMap();
    const recovery = map?.get(key)?.malformedRecovery;
    if (!recovery) return;
    if (recovery.pending) {
      recovery.pending = false;
      log.debug("malformed_recovery_pending_changed", { sessionKey: key, pending: false });
    }
    pruneSessionSlot(map, key);
    return;
  }
  const recovery = getOrCreateMalformedRecoverySlot(key);
  if (!recovery.pending) {
    recovery.pending = true;
    log.debug("malformed_recovery_pending_changed", { sessionKey: key, pending: true });
  }
}

/** Subscribe to abort/failure notifications so deferred COMS inbounds can finalize cleanly. */
export function onMalformedRecoveryAborted(cb: () => void, sessionKey?: string): () => void {
  const key = normalizeBridgeSessionKey(sessionKey);
  const recovery = getOrCreateMalformedRecoverySlot(key);
  recovery.onRecoveryAborted.add(cb);
  log.debug("malformed_recovery_abort_listener_added", {
    sessionKey: key,
    listeners: recovery.onRecoveryAborted.size,
  });
  return () => {
    const map = getExistingBridgeMap();
    const current = map?.get(key)?.malformedRecovery;
    if (!current || !(current.onRecoveryAborted instanceof Set) || !current.onRecoveryAborted.delete(cb)) {
      return;
    }
    log.debug("malformed_recovery_abort_listener_removed", {
      sessionKey: key,
      listeners: current.onRecoveryAborted.size,
    });
    pruneSessionSlot(map, key);
  };
}

/** Notify listeners for a session that a pending recovery failed or was aborted. */
export function notifyMalformedRecoveryAborted(sessionKey?: string): void {
  const key = normalizeBridgeSessionKey(sessionKey);
  const recovery = getSessionSlot(key)?.malformedRecovery;
  if (!recovery || !(recovery.onRecoveryAborted instanceof Set) || recovery.onRecoveryAborted.size === 0) {
    return;
  }
  log.debug("malformed_recovery_aborted_notify", {
    sessionKey: key,
    listeners: recovery.onRecoveryAborted.size,
  });
  for (const cb of [...recovery.onRecoveryAborted]) {
    try {
      cb();
    } catch (err) {
      log.debug("malformed_recovery_abort_listener_error", { sessionKey: key, error: String(err) });
    }
  }
}

// ── comsActive slot ─────────────────────────────────────────────────────────

/** Set whether P2P coms is active for a specific session. */
export function setComsActive(active: boolean, sessionKey?: string): void {
  const key = normalizeBridgeSessionKey(sessionKey);
  const current = getSessionSlot(key)?.comsActive === true;
  if (current === active) {
    log.debug("coms_active_noop", { sessionKey: key, active });
    return;
  }
  if (active) {
    getOrCreateSessionSlot(key).comsActive = true;
  } else {
    const map = getExistingBridgeMap();
    const slot = map?.get(key);
    if (slot) {
      delete slot.comsActive;
      pruneSessionSlot(map, key);
    }
  }
  log.info("coms_active_changed", { sessionKey: key, active });
}

/** Report whether P2P coms is active for a specific session (never falls back across sessions). */
export function isComsActive(sessionKey?: string): boolean {
  const key = normalizeBridgeSessionKey(sessionKey);
  return getSessionSlot(key)?.comsActive === true;
}

// ── Unified teardown & test reset ───────────────────────────────────────────

/**
 * Single teardown and test-reset interface for the session bridge:
 * - `resetSessionBridge()` (no args): wipes the entire process-local bridge map (test reset).
 * - `resetSessionBridge(sessionKey)`: tears down all slots for that session and prunes the outer map if empty.
 * - `resetSessionBridge(sessionKey, { slot })`: clears one typed slot for that session and prunes if empty.
 */
export function resetSessionBridge(
  sessionKey?: string,
  options?: { slot?: SessionBridgeSlotName },
): void {
  if (sessionKey === undefined && !options?.slot) {
    delete (globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL];
    log.debug("session_bridge_reset_all");
    return;
  }
  const key = normalizeBridgeSessionKey(sessionKey);
  const map = getExistingBridgeMap();
  if (!map) return;
  if (options?.slot) {
    const entry = map.get(key);
    if (!entry || typeof entry !== "object") return;
    delete entry[options.slot];
    pruneSessionSlot(map, key);
    log.debug("session_bridge_slot_cleared", { sessionKey: key, slot: options.slot });
    return;
  }
  if (!map.delete(key)) return;
  if (map.size === 0) {
    delete (globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL];
  }
  log.debug("session_bridge_cleared", { sessionKey: key });
}
