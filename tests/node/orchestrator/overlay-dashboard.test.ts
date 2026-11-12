import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  enterAction,
  reconcileSelection,
  selectionIndexFor,
  type OverlayId,
  type OverlaySelection,
} from "../../../extensions/orchestrator/overlay-dashboard-utils.ts";

/**
 * openListDetailOverlay / OverlayListDashboard / OverlayScrollDetail require
 * ExtensionCommandContext + pi-tui (TUI, Theme, KeybindingsManager). Those
 * packages are not available in this test harness, so the overlay loop itself
 * is not unit-tested here.
 *
 * Testable pure logic lives in overlay-dashboard-utils.ts (reconcileSelection).
 *
 * Manual coverage (pi session):
 * - Empty list → early return + emptyMessage notify (/async-status, /cron list)
 * - List → Enter → detail → Esc → back to list
 * - Esc / Ctrl-C on list closes without detail
 * - j/k + arrows move selection; x runs onX when provided
 */
describe("openListDetailOverlay (manual / integration)", () => {
  it("OverlaySelection type accepts id constrained by OverlayId", () => {
    // Signature constraint: TItem must have id: TId extends OverlayId
    type Ok = OverlaySelection<"a" | "b">;
    const sel: Ok = { index: 0, id: "a" };
    assert.equal(sel.index, 0);
    assert.equal(sel.id, "a");
  });

  it("OverlayId accepts string | number only", () => {
    const stringId: OverlayId = "job-1";
    const numberId: OverlayId = 42;
    assert.equal(typeof stringId, "string");
    assert.equal(typeof numberId, "number");
  });

  it("documents TUI dependency — no direct unit call", () => {
    // Overlay loop (openListDetailOverlay) needs ExtensionCommandContext + pi-tui.
    // Not unit-tested here; see file-level comment for manual coverage.
    assert.ok(true);
  });
});

describe("reconcileSelection", () => {
  it("keeps selection by stable id", () => {
    const sel: OverlaySelection<string> = { id: "b", index: 0 };
    reconcileSelection(sel, [{ id: "a" }, { id: "b" }, { id: "c" }]);
    assert.equal(sel.index, 1);
    assert.equal(sel.id, "b");
  });

  it("clamps when id missing", () => {
    const sel: OverlaySelection<number> = { id: 99, index: 5 };
    reconcileSelection(sel, [{ id: 1 }, { id: 2 }]);
    assert.equal(sel.index, 1);
    assert.equal(sel.id, 2);
  });

  it("uses index when id unset", () => {
    const sel: OverlaySelection<string> = { index: 2 };
    reconcileSelection(sel, [{ id: "a" }, { id: "b" }, { id: "c" }]);
    assert.equal(sel.index, 2);
    assert.equal(sel.id, "c");
  });

  it("clamps negative index to 0", () => {
    const sel: OverlaySelection<string> = { index: -3 };
    reconcileSelection(sel, [{ id: "a" }, { id: "b" }]);
    assert.equal(sel.index, 0);
    assert.equal(sel.id, "a");
  });

  it("empty list clears id and keeps index at 0", () => {
    const sel: OverlaySelection<string> = { id: "gone", index: 4 };
    reconcileSelection(sel, []);
    assert.equal(sel.index, 0);
    assert.equal(sel.id, undefined);
  });

  it("single item always selects that item", () => {
    const sel: OverlaySelection<string> = { id: "missing", index: 9 };
    reconcileSelection(sel, [{ id: "only" }]);
    assert.equal(sel.index, 0);
    assert.equal(sel.id, "only");
  });

  it("treats null id like missing (clamp by index)", () => {
    const sel = { id: null as unknown as string, index: 1 } as OverlaySelection<string>;
    reconcileSelection(sel, [{ id: "a" }, { id: "b" }, { id: "c" }]);
    assert.equal(sel.index, 1);
    assert.equal(sel.id, "b");
  });

  it("numeric ids stay stable across reorder", () => {
    const sel: OverlaySelection<number> = { id: 30, index: 0 };
    reconcileSelection(sel, [{ id: 10 }, { id: 30 }, { id: 20 }]);
    assert.equal(sel.index, 1);
    assert.equal(sel.id, 30);
  });
});

describe("enterAction (#1084 finding 3): the Enter seam", () => {
  it("navigates when the caller handles Enter, opens a detail when one is wired", () => {
    assert.equal(enterAction({ onSelect: () => {} }), "navigate");
    assert.equal(enterAction({ createDetail: () => ({}) }), "detail");
    assert.equal(enterAction({}), "none");
  });

  it("lets onSelect win over createDetail", () => {
    assert.equal(enterAction({ onSelect: () => {}, createDetail: () => ({}) }), "navigate");
  });

  it("ignores non-function values", () => {
    assert.equal(enterAction({ onSelect: true, createDetail: null }), "none");
  });
});

describe("selectionIndexFor (#1084 finding 4): re-open on the same row", () => {
  const items = [{ id: "section:peer" }, { id: "section:tasks" }, { id: "section:crons" }];

  it("finds the row a caller came from", () => {
    assert.equal(selectionIndexFor(items, "section:tasks"), 1);
    assert.equal(selectionIndexFor(items, "section:peer"), 0);
  });

  it("falls back to the first row when the id is gone or absent", () => {
    assert.equal(selectionIndexFor(items, "section:gone"), 0);
    assert.equal(selectionIndexFor(items, undefined), 0);
    assert.equal(selectionIndexFor(items, null), 0);
    assert.equal(selectionIndexFor([], "anything"), 0);
  });
});
