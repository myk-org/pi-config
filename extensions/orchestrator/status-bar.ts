/**
 * Status bar slot registry — single source of truth for layout and ordering.
 *
 * All status bar updates go through setSlot/clearSlot. No module should
 * call ctx.ui.setStatus directly — use this module instead.
 *
 * Adding a new slot: add to SLOTS, import setSlot in the consumer.
 * Reordering: change the sort-key prefix here — nothing else changes.
 */

/** Slot sort-keys — alphabetical order determines left-to-right position in the bar. */
const SLOTS = {
  time:   "1-time",
  async:  "2-async",
  crons:  "3-crons",
  dream:  "3b-dream",
  git:    "4-git",
  review: "5-review",
} as const;

export type StatusBarSlot = keyof typeof SLOTS;

/** Set a status bar slot value. Pass undefined to clear. */
export function setSlot(slot: StatusBarSlot, text: string | undefined, ctx: any): void {
  ctx?.ui?.setStatus(SLOTS[slot], text);
}

/** Clear a status bar slot. */
export function clearSlot(slot: StatusBarSlot, ctx: any): void {
  ctx?.ui?.setStatus(SLOTS[slot], undefined);
}
