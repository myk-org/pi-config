/**
 * Unified per-session cross-extension bridge (`extensions/shared/session-bridge.ts`, #1364).
 *
 * Extensions load independently and share one Node process across concurrent sessions in hosts
 * such as `pi-sidecar`. All mutable per-session cross-extension state lives inside a single
 * `globalThis[SESSION_BRIDGE_SYMBOL]` `Map<sessionKey, SessionBridgeSlot>` with five typed slots:
 *   - `taskStore`: live pitasks store getter & widget telemetry-activation callback (#1016)
 *   - `workload`: orchestrator async-agent & cron getters for coms/pitasks (#1083)
 *   - `malformedRecovery`: orchestrator <-> coms malformed-response retry coordination (#1333)
 *   - `comsActive`: per-session P2P coms active flag for rules assembly
 *   - `streamLoopAborted`: orchestrator <-> coms stream repetition loop abort flag (#1374)
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
  readonly getStore: () => unknown;
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
  comsPeerName?: string;
  streamLoopAborted?: boolean;
  humanRelayedPrompts?: string[];
}

export type SessionBridgeSlotName = keyof SessionBridgeSlot;

export type ResetSessionBridgeOptions =
  | { readonly all: true }
  | { readonly sessionKey?: string; readonly slot?: SessionBridgeSlotName };

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

function isBridgeValueEmpty(value: unknown, visiting = new Set<object>()): boolean {
  if (value === undefined || value === null || value === false) return true;
  if (typeof value !== "object") return false;
  if (value instanceof Set || value instanceof Map) return value.size === 0;
  if (Array.isArray(value)) return value.length === 0;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  if (visiting.has(value)) return false;
  visiting.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc) continue;
      if (typeof desc.get === "function") return false;
      if (!isBridgeValueEmpty(desc.value, visiting)) return false;
    }
    return true;
  } finally {
    visiting.delete(value);
  }
}

function pruneSessionSlot(map: Map<string, SessionBridgeSlot> | undefined, key: string): void {
  if (!map) return;
  const slot = map.get(key);
  if (slot !== null && typeof slot === "object") {
    const record = slot as Record<string, unknown>;
    for (const [slotName, value] of Object.entries(record)) {
      if (isBridgeValueEmpty(value)) {
        delete record[slotName];
      }
    }
    if (Object.keys(record).length === 0) {
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
  const binding: TaskStoreBinding = { getStore };
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
  const store = binding && typeof binding.getStore === "function" ? (binding.getStore() ?? null) : null;
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

/** Set whether P2P coms is active for a specific session (and its optional active peer name). */
export function setComsActive(active: boolean, sessionKey?: string, peerName?: string): void {
  const key = normalizeBridgeSessionKey(sessionKey);
  const normalizedPeerName = active && typeof peerName === "string" ? peerName.trim() || undefined : undefined;
  const existing = getSessionSlot(key);
  const current = existing?.comsActive === true;
  const currentPeerName = existing?.comsPeerName;
  if (current === active && currentPeerName === normalizedPeerName) {
    log.debug("coms_active_noop", { sessionKey: key, active });
    return;
  }
  if (active) {
    const slot = getOrCreateSessionSlot(key);
    slot.comsActive = true;
    if (normalizedPeerName) {
      slot.comsPeerName = normalizedPeerName;
    } else {
      delete slot.comsPeerName;
    }
  } else {
    const map = getExistingBridgeMap();
    const slot = map?.get(key);
    if (slot) {
      delete slot.comsActive;
      delete slot.comsPeerName;
      pruneSessionSlot(map, key);
    }
  }
  log.info("coms_active_changed", {
    sessionKey: key,
    active,
    ...(normalizedPeerName ? { peerName: normalizedPeerName } : {}),
  });
}

/** Report whether P2P coms is active for a specific session (never falls back across sessions). */
export function isComsActive(sessionKey?: string): boolean {
  const key = normalizeBridgeSessionKey(sessionKey);
  return getSessionSlot(key)?.comsActive === true;
}

/** Report the active P2P coms peer name for a specific session (never falls back across sessions). */
export function getComsPeerName(sessionKey?: string): string | null {
  const key = normalizeBridgeSessionKey(sessionKey);
  const slot = getSessionSlot(key);
  if (slot?.comsActive !== true) return null;
  const name = slot.comsPeerName;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

// ── streamLoopAborted slot ──────────────────────────────────────────────────

/** Record that the active assistant turn in `sessionKey` was aborted by stream-loop-guard (#1374). */
export function markStreamLoopAborted(sessionKey?: string): void {
  const key = normalizeBridgeSessionKey(sessionKey);
  getOrCreateSessionSlot(key).streamLoopAborted = true;
  log.debug("stream_loop_abort_marked", { sessionKey: key });
}

/** Report whether `sessionKey` currently has an unconsumed stream-loop abort mark. */
export function hasStreamLoopAborted(sessionKey?: string): boolean {
  const key = normalizeBridgeSessionKey(sessionKey);
  return getSessionSlot(key)?.streamLoopAborted === true;
}

/** Consume and clear the stream-loop abort mark for `sessionKey`, returning true if it was set. */
export function consumeStreamLoopAborted(sessionKey?: string): boolean {
  const key = normalizeBridgeSessionKey(sessionKey);
  const map = getExistingBridgeMap();
  const slot = map?.get(key);
  if (!slot || slot.streamLoopAborted !== true) return false;
  delete slot.streamLoopAborted;
  pruneSessionSlot(map, key);
  log.debug("stream_loop_abort_consumed", { sessionKey: key });
  return true;
}

/** Clear any stream-loop abort mark for `sessionKey` and prune empty session slots. */
export function clearStreamLoopAborted(sessionKey?: string): void {
  const key = normalizeBridgeSessionKey(sessionKey);
  const map = getExistingBridgeMap();
  const slot = map?.get(key);
  if (!slot || slot.streamLoopAborted === undefined) return;
  delete slot.streamLoopAborted;
  pruneSessionSlot(map, key);
}

// ── humanRelayedPrompts slot ────────────────────────────────────────────────

const MAX_HUMAN_RELAYED_PROMPTS = 32;

/**
 * Mark an extension-relayed human prompt (e.g. pidash browser chat or pidiff review publish)
 * before calling `pi.sendUserMessage` so downstream hooks distinguish it from synthetic automation.
 */
export function markHumanRelayedPrompt(text: string, sessionKey?: string): void {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized) return;
  const key = normalizeBridgeSessionKey(sessionKey);
  const slot = getOrCreateSessionSlot(key);
  if (!Array.isArray(slot.humanRelayedPrompts)) {
    slot.humanRelayedPrompts = [];
  }
  slot.humanRelayedPrompts.push(normalized);
  if (slot.humanRelayedPrompts.length > MAX_HUMAN_RELAYED_PROMPTS) {
    slot.humanRelayedPrompts.splice(0, slot.humanRelayedPrompts.length - MAX_HUMAN_RELAYED_PROMPTS);
  }
  log.debug("human_relayed_prompt_marked", {
    sessionKey: key,
    queued: slot.humanRelayedPrompts.length,
  });
}

/**
 * Consume a matching human-relayed prompt mark for `sessionKey`.
 * Returns `true` when `text` matches a queued mark (exact match after trimming).
 */
export function consumeHumanRelayedPrompt(text: string, sessionKey?: string): boolean {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized) return false;
  const key = normalizeBridgeSessionKey(sessionKey);
  const map = getExistingBridgeMap();
  const slot = map?.get(key);
  const queue = slot?.humanRelayedPrompts;
  if (!Array.isArray(queue) || queue.length === 0) return false;
  const idx = queue.indexOf(normalized);
  if (idx < 0) return false;
  queue.splice(idx, 1);
  if (queue.length === 0) {
    delete slot!.humanRelayedPrompts;
    pruneSessionSlot(map, key);
  }
  log.debug("human_relayed_prompt_consumed", { sessionKey: key, remaining: queue.length });
  return true;
}

// ── Unified teardown & test reset ───────────────────────────────────────────

/**
 * Single teardown and test-reset interface for the session bridge:
 * - `resetSessionBridge({ all: true })`: wipes the entire process-local bridge map (test reset).
 * - `resetSessionBridge({ sessionKey })`: tears down all slots for that session (missing/blank
 *   `sessionKey` normalizes to `DEFAULT_BRIDGE_SESSION_KEY`, never wiping sibling sessions) and
 *   prunes the outer map if empty.
 * - `resetSessionBridge({ sessionKey, slot })`: clears one typed slot for that session and prunes
 *   empty session entries and the outer map automatically.
 */
export function resetSessionBridge(options: ResetSessionBridgeOptions): void {
  if ("all" in options && options.all === true) {
    delete (globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL];
    log.debug("session_bridge_reset_all");
    return;
  }
  const key = normalizeBridgeSessionKey("sessionKey" in options ? options.sessionKey : undefined);
  const map = getExistingBridgeMap();
  if (!map) return;
  const slotName = "slot" in options ? options.slot : undefined;
  if (slotName) {
    const entry = map.get(key);
    if (!entry || typeof entry !== "object") return;
    delete entry[slotName];
    if (slotName === "comsActive") {
      delete entry.comsPeerName;
    }
    pruneSessionSlot(map, key);
    log.debug("session_bridge_slot_cleared", { sessionKey: key, slot: slotName });
    return;
  }
  if (!map.delete(key)) return;
  if (map.size === 0) {
    delete (globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL];
  }
  log.debug("session_bridge_cleared", { sessionKey: key });
}
