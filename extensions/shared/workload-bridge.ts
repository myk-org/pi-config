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
import {
  DEFAULT_BRIDGE_SESSION_KEY,
  clearBridgeSessionEntry,
  getBridgeSessionEntry,
  normalizeBridgeSessionKey,
  resetBridgeMapForTests,
  resolveBridgeSessionKey,
  setBridgeSessionEntry,
} from "./session-bridge-map.js";

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
export const DEFAULT_WORKLOAD_SESSION_KEY = DEFAULT_BRIDGE_SESSION_KEY;

/** Resolve the per-session workload bridge key from an ExtensionContext (or DEFAULT_WORKLOAD_SESSION_KEY). */
export function resolveWorkloadSessionKey(ctx?: any): string {
  return resolveBridgeSessionKey(ctx);
}

function isValidWorkloadSources(candidate: unknown): candidate is WorkloadSources {
  const sources = candidate as WorkloadSources | undefined;
  return Boolean(sources && typeof sources.agents === "function" && typeof sources.crons === "function");
}

/** Publish the owner's getters for a session. Returns an idempotent unregister callback. */
export function publishWorkloadSources(sources: WorkloadSources, sessionKey?: string): () => void {
  const key = normalizeBridgeSessionKey(sessionKey);
  log.debug("workload_sources_published", { sessionKey: key, at: Date.now() });
  return setBridgeSessionEntry(WORKLOAD_SOURCES_SYMBOL, sources, key, (removedKey) => {
    log.debug("workload_sources_unregistered", { sessionKey: removedKey, at: Date.now() });
  });
}

/** The sources for a session, or null when absent for that exact session key. */
export function publishedWorkloadSources(sessionKey?: string): WorkloadSources | null {
  const candidate = getBridgeSessionEntry<WorkloadSources>(WORKLOAD_SOURCES_SYMBOL, sessionKey);
  return isValidWorkloadSources(candidate) ? candidate : null;
}

/** Drop the published getters for a session on shutdown: a torn-down runtime must not answer a describe. */
export function clearWorkloadSources(sessionKey?: string): void {
  const key = normalizeBridgeSessionKey(sessionKey);
  clearBridgeSessionEntry(WORKLOAD_SOURCES_SYMBOL, key);
  log.debug("workload_sources_cleared", { sessionKey: key, at: Date.now() });
}

/** Reset the entire workload bridge map between tests. */
export function resetWorkloadBridgeForTests(): void {
  resetBridgeMapForTests(WORKLOAD_SOURCES_SYMBOL);
}
