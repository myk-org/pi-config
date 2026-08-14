/**
 * Providers session_shutdown teardown — clears instances and the init guard
 * so the next factory invocation re-runs discovery + registerProvider (#752).
 *
 * Kept free of @earendil-works/pi-ai so unit tests can import it under tsx.
 */

import { stopCliSessionReaper } from "../cli-provider/session-reaper.js";
import { createLogger } from "../shared/logger.js";
import type { ProviderDriverRegistry } from "../shared/provider-registry.js";
import { resetProvidersInitialized } from "./initialized-guard.js";

const log = createLogger("providers");

export async function teardownProvidersOnSessionShutdown(
  registry: ProviderDriverRegistry,
  cliInstances: Map<string, unknown>,
  acpxInstances: Map<string, unknown>,
): Promise<void> {
  try {
    stopCliSessionReaper();
    await registry.teardownAll();
  } catch (err) {
    log.error(
      "session_shutdown teardown failed",
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  } finally {
    // Always clear maps + init guard so a teardown failure cannot leave
    // initialized stuck true (would skip registerProvider on /new|/resume|/fork).
    cliInstances.clear();
    acpxInstances.clear();
    resetProvidersInitialized();
    log.info(
      "session_shutdown: reset initialized so providers re-register on next session",
    );
  }
}
