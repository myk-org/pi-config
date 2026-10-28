/**
 * Status bar slot registry — single source of truth for layout and ordering.
 *
 * All status bar updates go through setSlot/clearSlot. No module should
 * call ctx.ui.setStatus directly — use this module instead.
 *
 * Adding a new slot: add to SLOTS, import setSlot in the consumer.
 * Reordering: change the sort-key prefix here — nothing else changes.
 *
 * Stale-ctx safety (reload crash postmortem, PR #950): ctx.ui getters call
 * assertActive() and THROW after a runtime reload/replacement — an async
 * continuation (e.g. a trail build resolving across a reload) or a
 * session_shutdown handler touching a captured ctx must never crash the
 * process over a footer update. Guarded with isLiveExtensionCtx + try/catch.
 */

import { isLiveExtensionCtx } from "../shared/live-ctx.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("status-bar");

/** Slot sort-keys — alphabetical order determines left-to-right position in the bar. */
const SLOTS = {
  time:   "1-time",
  async:  "2-async",
  crons:  "3-crons",
  dream:  "3b-dream",
  git:    "4-git",
  trail:  "4b-trail",
  review: "5-review",
} as const;

export type StatusBarSlot = keyof typeof SLOTS;

function safeSetStatus(key: string, text: string | undefined, ctx: any): void {
  if (!isLiveExtensionCtx(ctx)) {
    log.debug("status_update_skipped_stale_ctx", { key });
    return;
  }
  try {
    ctx.ui.setStatus(key, text);
  } catch (e: unknown) {
    log.warn("status_update_failed", { key, error: String(e) });
  }
}

/** Set a status bar slot value. Pass undefined to clear. */
export function setSlot(slot: StatusBarSlot, text: string | undefined, ctx: any): void {
  safeSetStatus(SLOTS[slot], text, ctx);
}

/** Clear a status bar slot. */
export function clearSlot(slot: StatusBarSlot, ctx: any): void {
  safeSetStatus(SLOTS[slot], undefined, ctx);
}
