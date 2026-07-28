import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeManagedSnapshot, buildInitialSnapshot } from "../../../extensions/shared/managed-refresh.js";

describe("managed-refresh", () => {
  it("buildInitialSnapshot available", () => { const s = buildInitialSnapshot(true, [{ id: "m1", name: "M1" }], "1.0"); assert.equal(s.available, true); assert.equal(s.version, "1.0"); assert.equal(s.models.length, 1); });
  it("buildInitialSnapshot unavailable", () => { const s = buildInitialSnapshot(false, [], undefined, "not installed"); assert.equal(s.available, false); assert.equal(s.message, "not installed"); });
  it("returns initial snapshot immediately", () => {
    const m = makeManagedSnapshot({ initialSnapshot: () => buildInitialSnapshot(true, [{ id: "m1", name: "M1" }]), checkProvider: async () => buildInitialSnapshot(true, []), getSettings: () => ({}), haveSettingsChanged: () => false, refreshIntervalMs: 600_000 });
    assert.equal(m.getSnapshot().models.length, 1); m.dispose();
  });
  it("refresh updates snapshot", async () => {
    let c = 0;
    const m = makeManagedSnapshot({ initialSnapshot: () => buildInitialSnapshot(true, []), checkProvider: async () => { c++; return buildInitialSnapshot(true, [{ id: `m${c}`, name: `M${c}` }]); }, getSettings: () => ({ v: c }), haveSettingsChanged: () => true, refreshIntervalMs: 600_000 });
    await new Promise((r) => setTimeout(r, 150));
    const s = await m.refresh(); assert.ok(s.models.length > 0); m.dispose();
  });
  it("dispose stops cleanly", () => {
    makeManagedSnapshot({ initialSnapshot: () => buildInitialSnapshot(true, []), checkProvider: async () => buildInitialSnapshot(true, []), getSettings: () => ({}), haveSettingsChanged: () => false, refreshIntervalMs: 100 }).dispose();
  });
});
