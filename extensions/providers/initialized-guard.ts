/**
 * Session-scoped init guard for the unified providers extension.
 *
 * Shims (cli-provider / acpx-provider) and providers/ may call the same
 * default factory multiple times in one process — early-return while set.
 * session_shutdown must clear this so /new|/resume|/fork re-registers (#752).
 */

import { createLogger } from "../shared/logger.js";

const log = createLogger("providers");

let initialized = false;

export function isProvidersInitialized(): boolean {
  return initialized;
}

export function markProvidersInitialized(): void {
  initialized = true;
  log.debug("initialized-guard", "markProvidersInitialized → true");
}

export function resetProvidersInitialized(): void {
  initialized = false;
  log.debug("initialized-guard", "resetProvidersInitialized → false");
}
