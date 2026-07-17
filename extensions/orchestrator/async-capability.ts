/**
 * Async LLM capability — whether the parent session can host detached LLM async agents.
 *
 * acpx providers are registered by `extensions/acpx-provider` as `acpx-${agent}` for each
 * entry in `acpx_agents` settings. Child pi processes skip acpx registration
 * (PI_SUBAGENT_CHILD=1), so async children cannot use those parent models.
 *
 * Capability gate: any provider id starting with `acpx-` → supportsAsyncLlm false.
 * Registration list (`isAcpxProvider`) still comes from `acpx_agents` settings.
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

/** True when provider id uses the acpx-* namespace (registered or not). */
export function isAcpxProviderId(
  provider: string | null | undefined,
): boolean {
  return typeof provider === "string" && provider.startsWith("acpx-");
}

/**
 * Whether detached LLM async agents can inherit the parent model/provider.
 * Native / cli-* : true. Any `acpx-*` provider id: false (children skip acpx load).
 * `cwd` kept for API stability / settings lookups elsewhere.
 */
export function supportsAsyncLlm(
  provider: string | null | undefined,
  _cwd: string,
): boolean {
  return !isAcpxProviderId(provider);
}

/**
 * Sidecar model for must-async LLM work (dream, fireAndForget) when parent is acpx.
 * Both provider and model must be set. Returns null if incomplete or sidecar is acpx-*.
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
    const p = provider.trim();
    if (isAcpxProviderId(p)) return null;
    return { provider: p, model: model.trim() };
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
 *
 * Pass `parentSupportsAsyncLlm` when the caller already computed capability from the
 * parent session cwd — do not re-derive it from a different (task) cwd.
 * `cwd` is used only for sidecar settings lookup.
 */
export function decideAsyncLlmDispatch(opts: {
  parentProvider?: string | null;
  cwd: string;
  /** fireAndForget / dream / cron — must stay detached when possible */
  mustAsync?: boolean;
  /** Explicit parent capability; when set, skips supportsAsyncLlm(parent, cwd). */
  parentSupportsAsyncLlm?: boolean;
}): AsyncDispatchDecision {
  const asyncOk =
    opts.parentSupportsAsyncLlm !== undefined
      ? opts.parentSupportsAsyncLlm
      : supportsAsyncLlm(opts.parentProvider, opts.cwd);
  if (asyncOk) {
    return { action: "keep-async" };
  }
  const sidecar = getAsyncLlmSidecar(opts.cwd);
  if (opts.mustAsync) {
    if (!sidecar) {
      return {
        action: "skip",
        note:
          "Skipped must-async LLM work: parent is acpx and " +
          "async_llm_provider/async_llm_model are not set (or sidecar is acpx-*).",
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
