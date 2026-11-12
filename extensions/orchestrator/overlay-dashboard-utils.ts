/**
 * Pure overlay dashboard helpers — no TUI deps (unit-testable).
 */
import { createLogger } from "../shared/logger.js";

const log = createLogger("overlay-dashboard");

export type OverlayId = string | number;

export interface OverlaySelection<TId extends OverlayId = OverlayId> {
  id?: TId;
  index: number;
}

export function reconcileSelection<TId extends OverlayId>(
  selection: OverlaySelection<TId>,
  items: ReadonlyArray<{ id: TId }>,
): void {
  const stableIndex =
    selection.id !== undefined && selection.id !== null
      ? items.findIndex((item) => item.id === selection.id)
      : -1;
  selection.index =
    stableIndex >= 0
      ? stableIndex
      : Math.min(Math.max(0, selection.index), Math.max(0, items.length - 1));
  selection.id = items[selection.index]?.id;
}

/** What Enter does on a list row, decided from what the caller wired up. Data, so the seam is
 *  testable without a TUI: `onSelect` (navigate a level deeper) wins over `createDetail`. */
export type EnterAction = "navigate" | "detail" | "none";

export function enterAction(spec: {
  onSelect?: unknown;
  createDetail?: unknown;
}): EnterAction {
  const action: EnterAction =
    typeof spec.onSelect === "function"
      ? "navigate"
      : typeof spec.createDetail === "function"
        ? "detail"
        : "none";
  // The decision, never the item: Enter routing is what goes invisible when a level "does nothing".
  log.debug("enter_action", { action, createDetail: typeof spec.createDetail === "function" });
  return action;
}

/** The starting index for a list that is re-opened on a known row. An id that is gone (a peer
 *  left, a section emptied) falls back to the first row instead of throwing. */
export function selectionIndexFor<TId extends OverlayId>(
  items: ReadonlyArray<{ id: TId }>,
  id: TId | undefined | null,
): number {
  if (id === undefined || id === null) return 0;
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) {
    // Falling back to the first row is otherwise indistinguishable from "it was already there".
    log.debug("selection_unknown", { id: String(id).slice(0, 40), rows: items.length });
    return 0;
  }
  return index;
}
