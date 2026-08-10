/**
 * Sync agent time-limit helpers.
 * Kept separate from subagent-tool so unit tests can import without heavy deps.
 */

import { getSetting } from "./project-settings.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("sync-limit");

/**
 * Check if estimated seconds exceed the sync limit for a given cwd.
 * Exported for testing.
 */
export function checkSyncLimit(
  estimatedSeconds: number,
  cwd: string,
): { exceeded: boolean; limit: number } {
  const limit = getSetting(cwd, "sync_agent_max_seconds");
  const exceeded = estimatedSeconds >= limit;
  log.debug("checkSyncLimit", "estimatedSeconds", estimatedSeconds, "limit", limit, "exceeded", exceeded, "cwd", cwd);
  return { exceeded, limit };
}
