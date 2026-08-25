/**
 * Probe whether a captured extension ctx is still usable.
 *
 * After session replacement or /reload, pi marks the old ctx inactive.
 * Property getters such as `mode` call assertActive() and throw
 * uncaughtException if a surviving setInterval/setTimeout reads them.
 */

import { createLogger } from "./logger.js";

const log = createLogger("live-ctx");

export function isLiveExtensionCtx(ctx: unknown): boolean {
  if (ctx == null || typeof ctx !== "object") return false;
  try {
    void (ctx as { mode?: unknown }).mode;
    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log.debug(`captured ctx is stale: ${msg}`);
    return false;
  }
}
