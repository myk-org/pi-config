/**
 * Internal operations provider lookup.
 *
 * Resolves optional `internal_operations_provider` / `internal_operations_model`
 * settings for background operations like dreaming.
 */

import { createLogger } from "../shared/logger.js";
import { getSetting } from "./project-settings.js";

const log = createLogger("orchestrator");

export interface InternalOpsProvider {
  provider: string;
  model: string;
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
    const resolved = { provider: provider.trim(), model: model.trim() };
    log.debug("internal ops provider resolved", { provider: resolved.provider, model: resolved.model });
    return resolved;
  }
  log.debug("internal ops provider unset or incomplete");
  return null;
}
