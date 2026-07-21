/**
 * CLI agent "configured" gate: binary on PATH + AgentState present.
 * Kept separate from index.ts so unit tests can exercise it without loading pi-ai.
 */

import { isCliBinaryAvailable } from "./discover.js";
import { isCliAgentName } from "./providers.js";

/** Bound to the extension's AgentState map (or a test stand-in). */
let agentStates: { has(agent: string): boolean } = new Map();

/** Bind the live agents Map from the extension entrypoint. */
export function bindCliAgentStates(map: { has(agent: string): boolean }): void {
  agentStates = map;
}

/**
 * True when the CLI binary is on PATH and this agent still has AgentState
 * (cleared on session_shutdown). Used by /login resolve/check, filterModels,
 * and fetchModels — matches ACPX `agents.has` gating so models hide after shutdown.
 */
export function isCliAgentConfigured(agent: string): boolean {
  if (!isCliAgentName(agent)) return false;
  return isCliBinaryAvailable(agent) && agentStates.has(agent);
}

/** @internal — unit tests */
export function bindCliAgentStatesForTests(agents: Iterable<string>): void {
  agentStates = new Set(agents);
}
