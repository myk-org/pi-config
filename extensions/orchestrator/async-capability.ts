/**
 * Async LLM capability — whether the parent session can host detached LLM async agents.
 *
 * acpx providers are registered by `extensions/acpx-provider` as `acpx-${agent}` for each
 * entry in `acpx_agents` settings. Child pi processes skip acpx registration
 * (PI_SUBAGENT_CHILD=1), so async children cannot use those parent models.
 *
 * See: https://github.com/myk-org/pi-config/issues/647
 */

import { getSetting } from "./project-settings.js";

export interface AsyncLlmSidecar {
  provider: string;
  model: string;
}

/**
 * Provider ids we register for configured acpx agents (`acpx-cursor`, …).
 * Source of truth: `acpx_agents` in project/global settings (same list acpx-provider uses).
 */
export function getRegisteredAcpxProviders(cwd: string): string[] {
  return getSetting(cwd, "acpx_agents").map((agent) => `acpx-${agent}`);
}

/** True when provider is one we registered via acpx-provider for this project. */
export function isAcpxProvider(
  provider: string | null | undefined,
  cwd: string,
): boolean {
  if (typeof provider !== "string" || !provider) return false;
  return getRegisteredAcpxProviders(cwd).includes(provider);
}

/**
 * Whether detached LLM async agents can inherit the parent model/provider.
 * Native pi providers: true. Registered acpx parents: false.
 */
export function supportsAsyncLlm(
  provider: string | null | undefined,
  cwd: string,
): boolean {
  return !isAcpxProvider(provider, cwd);
}

/**
 * Sidecar model for must-async LLM work (dream, fireAndForget) when parent is acpx.
 * Both provider and model must be set. Returns null if incomplete.
 */
export function getAsyncLlmSidecar(cwd: string): AsyncLlmSidecar | null {
  const provider = getSetting(cwd, "async_llm_provider");
  const model = getSetting(cwd, "async_llm_model");
  if (
    typeof provider === "string" &&
    provider.trim() &&
    typeof model === "string" &&
    model.trim()
  ) {
    return { provider: provider.trim(), model: model.trim() };
  }
  return null;
}

export type AsyncDispatchDecision =
  | { action: "keep-async" }
  | { action: "coerce-sync"; note: string }
  | { action: "sidecar-async"; sidecar: AsyncLlmSidecar; note: string }
  | { action: "skip"; note: string };

/**
 * Decide how to handle an async LLM request given parent provider + settings.
 * Pure decision helper for subagent/dream/cron (code-enforced paths).
 */
export function decideAsyncLlmDispatch(opts: {
  parentProvider?: string | null;
  cwd: string;
  /** fireAndForget / dream / cron — must stay detached when possible */
  mustAsync?: boolean;
}): AsyncDispatchDecision {
  if (supportsAsyncLlm(opts.parentProvider, opts.cwd)) {
    return { action: "keep-async" };
  }
  const sidecar = getAsyncLlmSidecar(opts.cwd);
  if (opts.mustAsync) {
    if (!sidecar) {
      return {
        action: "skip",
        note:
          "Skipped must-async LLM work: parent is acpx and " +
          "async_llm_provider/async_llm_model are not set.",
      };
    }
    return {
      action: "sidecar-async",
      sidecar,
      note: `Using async_llm sidecar ${sidecar.provider}/${sidecar.model} (parent is acpx).`,
    };
  }
  return {
    action: "coerce-sync",
    note: "Coerced async→sync: parent provider does not support async LLM (acpx).",
  };
}
