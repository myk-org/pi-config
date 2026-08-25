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

/**
 * Pidash session_start: keep a live incoming ctx as lastCtx so reconnect
 * after /new|/resume still has a context. Stale incoming does not wipe previous.
 */
export function lastCtxAfterSessionStart<T>(previous: T | null, incoming: unknown): T | null {
  if (isLiveExtensionCtx(incoming)) {
    log.debug("session_start lastCtx: using live incoming ctx");
    return incoming as T;
  }
  log.debug("session_start lastCtx: incoming stale, keeping previous");
  return previous;
}

/** Safe ctxs for pidash session_start: never read properties on a stale incoming. */
export function resolveSessionStartCtx<T>(
  previous: T | null,
  incoming: unknown,
): { lastCtx: T | null; execCtx: T | null; switchCtx: T | null } {
  const lastCtx = lastCtxAfterSessionStart(previous, incoming);
  if (isLiveExtensionCtx(incoming)) {
    const live = incoming as T;
    log.debug("session_start: incoming ctx is live");
    return { lastCtx, execCtx: live, switchCtx: live };
  }
  const fallback = isLiveExtensionCtx(lastCtx) ? lastCtx : null;
  if (fallback) {
    log.debug("session_start: incoming stale, falling back to previous lastCtx");
  } else {
    log.debug("session_start: incoming stale and no live lastCtx");
  }
  return { lastCtx, execCtx: fallback, switchCtx: fallback };
}

/** First captured ctx that is still live; skips null and stale getters. */
export function firstLiveExtensionCtx<T>(...candidates: Array<T | null | undefined>): T | null {
  for (const c of candidates) {
    if (c == null) continue;
    if (isLiveExtensionCtx(c)) {
      log.debug("firstLiveExtensionCtx: selected live candidate");
      return c;
    }
  }
  log.debug("firstLiveExtensionCtx: no live candidate");
  return null;
}
