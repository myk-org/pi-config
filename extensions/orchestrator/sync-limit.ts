/**
 * Sync agent time-limit helpers.
 * Kept separate from subagent-tool so unit tests can import without heavy deps.
 */

import { getSetting } from "./project-settings.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("subagent");

/**
 * Check if estimated seconds exceed the sync limit for a given cwd.
 * Exported for testing.
 */
export function checkSyncLimit(
  estimatedSeconds: number,
  cwd: string,
): { exceeded: boolean; limit: number } {
  const raw = getSetting(cwd, "sync_agent_max_seconds");
  const limit = typeof raw === "number" && raw > 0 ? raw : 60; // fallback to default
  log.debug("checkSyncLimit", "estimated", estimatedSeconds, "limit", limit, "exceeded", estimatedSeconds >= limit);
  return { exceeded: estimatedSeconds >= limit, limit };
}
