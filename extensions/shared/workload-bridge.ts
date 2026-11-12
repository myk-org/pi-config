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
 * Same marker pattern as the pricing-provenance, session-cwd and task-store bridges.
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
}

export interface WorkloadSources {
  agents: () => WorkloadAgent[];
  crons: () => WorkloadCron[];
}

export const WORKLOAD_SOURCES_SYMBOL = Symbol.for("pi-config.workloadSources");

/** Publish the owner's getters. Called once from the orchestrator registration path. */
export function publishWorkloadSources(sources: WorkloadSources): void {
  (globalThis as Record<symbol, unknown>)[WORKLOAD_SOURCES_SYMBOL] = sources;
  log.debug("workload_sources_published", { at: Date.now() });
}

/** The sources, or null when this process has no orchestrator extension (older build). */
export function publishedWorkloadSources(): WorkloadSources | null {
  const sources = (globalThis as Record<symbol, unknown>)[WORKLOAD_SOURCES_SYMBOL] as WorkloadSources | undefined;
  if (!sources || typeof sources.agents !== "function" || typeof sources.crons !== "function") return null;
  return sources;
}

/** Drop the published getters on shutdown: a torn-down runtime must not answer a describe. */
export function clearWorkloadSources(): void {
  delete (globalThis as Record<symbol, unknown>)[WORKLOAD_SOURCES_SYMBOL];
  log.debug("workload_sources_cleared", { at: Date.now() });
}
