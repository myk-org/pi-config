import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLiveExtensionCtx } from "../../../extensions/shared/live-ctx.js";

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
