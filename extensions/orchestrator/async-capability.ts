/**
 * Async LLM capability & internal operations provider lookup.
 *
 * All registered providers support detached LLM async children.
 * `getInternalOpsProvider` resolves optional `internal_operations_provider` /
 * `internal_operations_model` settings for background operations like dreaming.
 */

import { getSetting } from "./project-settings.js";

export interface InternalOpsProvider {
  provider: string;
  model: string;
}

/**
 * Whether detached LLM async agents can inherit the parent model/provider.
 */
export function supportsAsyncLlm(
  _provider: string | null | undefined,
  _cwd: string,
): boolean {
  return true;
}

/**
 * Optional provider/model for internal operations (e.g. dreaming).
 * Both provider and model must be set; returns null if incomplete.
 */
export function getInternalOpsProvider(cwd: string): InternalOpsProvider | null {
  const provider = getSetting(cwd, "internal_operations_provider");
  const model = getSetting(cwd, "internal_operations_model");
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
  | { action: "sidecar-async"; sidecar: InternalOpsProvider; note: string }
  | { action: "skip"; note: string };

/**
 * Decide how to handle an async LLM request given parent capability + settings.
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
  const sidecar = getInternalOpsProvider(opts.cwd);
  if (opts.mustAsync) {
    if (!sidecar) {
      return {
        action: "skip",
        note:
          "Skipped must-async LLM work: parent does not support async LLM and " +
          "internal_operations_provider/internal_operations_model are not set.",
      };
    }
    return {
      action: "sidecar-async",
      sidecar,
      note: `Using internal ops provider ${sidecar.provider}/${sidecar.model}.`,
    };
  }
  return {
    action: "coerce-sync",
    note: "Coerced async→sync: parent provider does not support async LLM.",
  };
}
