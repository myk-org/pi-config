/**
 * Pure overlay dashboard helpers — no TUI deps (unit-testable).
 */

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
