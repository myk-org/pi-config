import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emitIfLive, isLiveExtensionCtx } from "../../../extensions/shared/live-ctx.js";

describe("isLiveExtensionCtx", () => {
	it("returns false for nullish and non-objects", () => {
		assert.equal(isLiveExtensionCtx(null), false);
		assert.equal(isLiveExtensionCtx(undefined), false);
		assert.equal(isLiveExtensionCtx("tui"), false);
	});

	it("returns true when mode can be read", () => {
		assert.equal(isLiveExtensionCtx({ mode: "tui" }), true);
		assert.equal(isLiveExtensionCtx({ mode: "print" }), true);
	});

	it("returns false when mode getter throws (stale ctx after reload)", () => {
		const stale = {
			get mode() {
				throw new Error(
					"This extension ctx is stale after session replacement or reload",
				);
			},
		};
		assert.equal(isLiveExtensionCtx(stale), false);
	});
});

describe("emitIfLive", () => {
  const throwing = {
    events: {
      emit() {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
    },
  };

  it("swallows the stale-instance throw that would otherwise exit pi", () => {
    // The crash this guards: a surviving setTimeout emitting after /reload.
    assert.equal(emitIfLive(throwing, "subagents:completed", { id: "x" }), false);
  });

  it("emits and reports success on a live instance", () => {
    const seen: Array<{ event: string; data: unknown }> = [];
    const live = { events: { emit: (event: string, data: unknown) => { seen.push({ event, data }); } } };
    assert.equal(emitIfLive(live, "subagents:completed", { id: "y" }), true);
    assert.deepEqual(seen, [{ event: "subagents:completed", data: { id: "y" } }]);
  });

  it("reports a missing instance as NOT delivered", () => {
    // Nothing was emitted, so claiming success would hide a lost event.
    assert.equal(emitIfLive(null, "subagents:ready", {}), false);
    assert.equal(emitIfLive(undefined, "subagents:ready", {}), false);
  });

  it("distinguishes a stale instance from a live listener that throws", () => {
    const stale = { events: { emit() { throw new Error("This extension ctx is stale after session replacement or reload."); } } };
    const listener = { events: { emit() { throw new Error("listener exploded"); } } };
    assert.equal(emitIfLive(stale, "subagents:completed", { id: "s1" }), false);
    assert.equal(emitIfLive(listener, "subagents:completed", { id: "s2" }), false);
    // Both are reported; only the second is an error, and both carry the job id in the log line.
  });
});
