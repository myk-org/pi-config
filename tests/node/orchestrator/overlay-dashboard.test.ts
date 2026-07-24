import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  reconcileSelection,
  type OverlaySelection,
} from "../../../extensions/orchestrator/overlay-dashboard-utils.ts";

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
});
