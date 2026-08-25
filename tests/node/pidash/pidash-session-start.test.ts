/**
 * Pidash session_start lastCtx assignment — reconnect after /new|/resume.
 * Run with: npx tsx --test tests/node/pidash/pidash-session-start.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lastCtxAfterSessionStart } from "../../../extensions/shared/live-ctx.js";

describe("handleSessionStart lastCtx", () => {
	it("replaces lastCtx with a live session_start ctx", () => {
		const previous = { mode: "tui", cwd: "/old" };
		const incoming = { mode: "tui", cwd: "/new" };
		assert.equal(lastCtxAfterSessionStart(previous, incoming), incoming);
	});

	it("keeps previous lastCtx when incoming ctx is stale", () => {
		const previous = { mode: "tui", cwd: "/old" };
		const stale = {
			get mode() {
				throw new Error("This extension ctx is stale after session replacement or reload");
			},
			cwd: "/stale",
		};
		assert.equal(lastCtxAfterSessionStart(previous, stale), previous);
	});

	it("does not invent lastCtx from a stale first session_start", () => {
		const stale = {
			get mode() {
				throw new Error("This extension ctx is stale after session replacement or reload");
			},
		};
		assert.equal(lastCtxAfterSessionStart(null, stale), null);
	});
});
