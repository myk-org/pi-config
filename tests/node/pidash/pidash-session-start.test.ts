/**
 * Pidash session_start lastCtx / switchCtx — reconnect after /new|/resume|/reload.
 * Run with: npx tsx --test tests/node/pidash/pidash-session-start.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	lastCtxAfterSessionStart,
	resolveSessionStartCtx,
} from "../../../extensions/shared/live-ctx.js";

function staleCtx() {
	return {
		get mode() {
			throw new Error("This extension ctx is stale after session replacement or reload");
		},
		get cwd() {
			throw new Error("This extension ctx is stale after session replacement or reload");
		},
	};
}

describe("handleSessionStart lastCtx", () => {
	it("replaces lastCtx with a live session_start ctx", () => {
		const previous = { mode: "tui", cwd: "/old" };
		const incoming = { mode: "tui", cwd: "/new" };
		assert.equal(lastCtxAfterSessionStart(previous, incoming), incoming);
	});

	it("keeps previous lastCtx when incoming ctx is stale", () => {
		const previous = { mode: "tui", cwd: "/old" };
		assert.equal(lastCtxAfterSessionStart(previous, staleCtx()), previous);
	});

	it("does not invent lastCtx from a stale first session_start", () => {
		assert.equal(lastCtxAfterSessionStart(null, staleCtx()), null);
	});
});

describe("handleSessionStart switchCtx", () => {
	it("uses live incoming for execCtx and session_switch", () => {
		const previous = { mode: "tui", cwd: "/old" };
		const incoming = { mode: "tui", cwd: "/new" };
		const r = resolveSessionStartCtx(previous, incoming);
		assert.equal(r.execCtx, incoming);
		assert.equal(r.switchCtx, incoming);
		assert.equal(r.switchCtx?.cwd, "/new");
	});

	it("does not read stale incoming cwd; falls back to live lastCtx for session_switch", () => {
		const previous = { mode: "tui", cwd: "/old" };
		const r = resolveSessionStartCtx(previous, staleCtx());
		assert.equal(r.execCtx, null);
		assert.equal(r.switchCtx, previous);
		assert.equal(r.switchCtx?.cwd, "/old");
	});

	it("skips session_switch when incoming is stale and there is no live lastCtx", () => {
		const r = resolveSessionStartCtx(null, staleCtx());
		assert.equal(r.execCtx, null);
		assert.equal(r.switchCtx, null);
	});
});
