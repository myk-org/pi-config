/**
 * Resolve effective model/provider for an agent.
 * Priority: agent_overrides[name] > agent frontmatter > agent_provider/agent_model setting > parent
 * null in overrides = skip settings, use parent directly.
 */

import { getSetting } from "./project-settings.js";

export function resolveAgentModelProvider(
  agentName: string,
  agent: { model?: string; provider?: string },
  parentModelId: string | undefined,
  parentProvider: string | undefined,
  cwd: string
): { model: string | undefined; provider: string | undefined } {
  const overrides = getSetting(cwd, "agent_overrides");
  const override = overrides[agentName];

  if (override) {
    // null = explicitly use parent (skip agent frontmatter AND global settings)
    // Model and provider resolve independently on purpose: a partial override
    // (e.g. only model) still lets provider fall through frontmatter → settings → parent.
    const model = override.model === null ? parentModelId : (override.model || agent.model || getSetting(cwd, "agent_model") || parentModelId);
    const provider = override.provider === null ? parentProvider : (override.provider || agent.provider || getSetting(cwd, "agent_provider") || parentProvider);
    return { model: model || undefined, provider: provider || undefined };
  }

  // No override: agent frontmatter > global setting > parent
  const model = agent.model || getSetting(cwd, "agent_model") || parentModelId;
  const provider = agent.provider || getSetting(cwd, "agent_provider") || parentProvider;
  return { model: model || undefined, provider: provider || undefined };
}
