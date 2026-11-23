/**
 * Cross-extension bridge for the peer's OWN workload sources (#1083).
 *
 * A peer reports what it is doing; nothing scans another process's files. The orchestrator
 * extension owns async agents and crons (crons — especially SESSION crons — exist only in that
 * process's memory, which is exactly why a filesystem scan cannot answer). It publishes its
 * getters here, and the coms extension reads them over the global symbol registry so a second
 * extension instance still sees the live bindings. Tasks are read through
 * `publishedTaskStore()` (`task-store-bridge.ts`), the same pattern.
 *
 * Same marker pattern as the pricing-provenance and task-store bridges.
 */
import { createLogger } from "./logger.js";

const log = createLogger("workload-bridge");

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

export const WORKLOAD_SOURCES_SYMBOL = Symbol.for("pi-config.workloadSources");
export const DEFAULT_WORKLOAD_SESSION_KEY = "__default__";

function normalizeSessionKey(sessionKey?: string): string {
  if (typeof sessionKey === "string") {
    const trimmed = sessionKey.trim();
    if (trimmed) return trimmed;
  }
  return DEFAULT_WORKLOAD_SESSION_KEY;
}

/** Resolve the per-session workload bridge key from an ExtensionContext (or DEFAULT_WORKLOAD_SESSION_KEY). */
export function resolveWorkloadSessionKey(ctx?: any): string {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    return normalizeSessionKey(typeof id === "string" ? id : undefined);
  } catch {
    return DEFAULT_WORKLOAD_SESSION_KEY;
  }
}

function getExistingSourcesMap(): Map<string, WorkloadSources> | undefined {
  const value = (globalThis as Record<symbol, unknown>)[WORKLOAD_SOURCES_SYMBOL];
  return value instanceof Map ? (value as Map<string, WorkloadSources>) : undefined;
}

function getOrCreateSourcesMap(): Map<string, WorkloadSources> {
  const g = globalThis as Record<symbol, unknown>;
  let map = g[WORKLOAD_SOURCES_SYMBOL];
  if (!(map instanceof Map)) {
    map = new Map<string, WorkloadSources>();
    g[WORKLOAD_SOURCES_SYMBOL] = map;
  }
  return map as Map<string, WorkloadSources>;
}

function pruneMapIfEmpty(map: Map<string, WorkloadSources> | undefined): void {
  if (map && map.size === 0) {
    delete (globalThis as Record<symbol, unknown>)[WORKLOAD_SOURCES_SYMBOL];
  }
}

function isValidWorkloadSources(candidate: unknown): candidate is WorkloadSources {
  const sources = candidate as WorkloadSources | undefined;
  return Boolean(sources && typeof sources.agents === "function" && typeof sources.crons === "function");
}

/** Publish the owner's getters for a session. Returns an idempotent unregister callback. */
export function publishWorkloadSources(sources: WorkloadSources, sessionKey?: string): () => void {
  const key = normalizeSessionKey(sessionKey);
  const map = getOrCreateSourcesMap();
  map.set(key, sources);
  log.debug("workload_sources_published", { sessionKey: key, at: Date.now() });
  return () => {
    const currentMap = getExistingSourcesMap();
    if (currentMap && currentMap.get(key) === sources) {
      currentMap.delete(key);
      pruneMapIfEmpty(currentMap);
      log.debug("workload_sources_unregistered", { sessionKey: key, at: Date.now() });
    }
  };
}

/** The sources for a session, or null when absent (or ambiguous across concurrent sessions). */
export function publishedWorkloadSources(sessionKey?: string): WorkloadSources | null {
  const map = getExistingSourcesMap();
  if (!map) return null;
  const key = normalizeSessionKey(sessionKey);
  let candidate = map.get(key);
  if (candidate === undefined) {
    if (key !== DEFAULT_WORKLOAD_SESSION_KEY) {
      // Compat fallback for single-session/test publishers that did not specify a session key.
      if (map.size === 1 && map.has(DEFAULT_WORKLOAD_SESSION_KEY)) {
        candidate = map.get(DEFAULT_WORKLOAD_SESSION_KEY);
      }
    } else if (map.size === 1) {
      candidate = map.values().next().value;
    } else if (map.size > 1) {
      log.debug("workload_sources_ambiguous_default_lookup", { sessions: map.size });
    }
  }
  return isValidWorkloadSources(candidate) ? candidate : null;
}

/** Drop the published getters for a session on shutdown: a torn-down runtime must not answer a describe. */
export function clearWorkloadSources(sessionKey?: string): void {
  const key = normalizeSessionKey(sessionKey);
  const map = getExistingSourcesMap();
  if (map) {
    map.delete(key);
    pruneMapIfEmpty(map);
  }
  log.debug("workload_sources_cleared", { sessionKey: key, at: Date.now() });
}

/** Reset the entire workload bridge map between tests. */
export function resetWorkloadBridgeForTests(): void {
  delete (globalThis as Record<symbol, unknown>)[WORKLOAD_SOURCES_SYMBOL];
}
