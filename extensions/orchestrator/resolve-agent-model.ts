/**
 * Resolve effective model/provider for an agent.
 * Each field resolved independently through priority chain:
 * explicit > agent_overrides[name] > agent frontmatter > agent_provider/agent_model setting > parent
 * null in overrides = skip settings, use parent directly.
 */

import { getSetting } from "./project-settings.js";

export function resolveAgentModelProvider(
  agentName: string,
  agent: { model?: string; provider?: string },
  parentModelId: string | undefined,
  parentProvider: string | undefined,
  cwd: string,
  explicit?: { model?: string; provider?: string },
): { model: string | undefined; provider: string | undefined } {
  const overrides = getSetting(cwd, "agent_overrides");
  const override = overrides[agentName];

  // Resolve each field independently through the priority chain:
  // explicit > agent_overrides[name] > agent frontmatter > agent_provider/agent_model setting > parent
  // null in overrides = skip settings, use parent directly.
  function resolveModel(): string | undefined {
    if (explicit?.model) return explicit.model;
    if (override) {
      if (override.model === null) return parentModelId;
      if (override.model) return override.model;
    }
    return agent.model || getSetting(cwd, "agent_model") || parentModelId || undefined;
  }

  function resolveProvider(): string | undefined {
    if (explicit?.provider) return explicit.provider;
    if (override) {
      if (override.provider === null) return parentProvider;
      if (override.provider) return override.provider;
    }
    return agent.provider || getSetting(cwd, "agent_provider") || parentProvider || undefined;
  }

  return { model: resolveModel(), provider: resolveProvider() };
}
