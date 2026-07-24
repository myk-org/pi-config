import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  reconcileSelection,
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
  it("documents TUI dependency — no direct unit call", () => {
    // Signature constraint: TItem must have id: TId extends OverlayId
    type Ok = OverlaySelection<"a" | "b">;
    const sel: Ok = { index: 0, id: "a" };
    assert.equal(sel.index, 0);

    // OverlayId accepts string | number only (compile-time contract)
    const stringId: OverlayId = "job-1";
    const numberId: OverlayId = 42;
    assert.equal(typeof stringId, "string");
    assert.equal(typeof numberId, "number");
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
