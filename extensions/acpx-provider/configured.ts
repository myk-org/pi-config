/**
 * ACPX agent "configured" gate: AgentState/runtime present.
 * Kept separate from index.ts so unit tests can exercise it without loading pi-ai.
 */

/** Bound to the extension's AgentState map (or a test stand-in). */
let agentStates: { has(agent: string): boolean } = new Map();

/** Bind the live agents Map from the extension entrypoint. */
export function bindAcpxAgentStates(map: {
  has(agent: string): boolean;
}): void {
  agentStates = map;
}

/**
 * True when this acpx agent has an initialized AgentState/runtime.
 * Used by /login resolve/check and filterModels.
 */
export function isAcpxAgentConfigured(agent: string): boolean {
  return agentStates.has(agent);
}

/** @internal — unit tests */
export function bindAcpxAgentStatesForTests(agents: Iterable<string>): void {
  agentStates = new Set(agents);
}
