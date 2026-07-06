/**
 * Tests for coms-shared formatting helpers (queue depth, response text).
 * Run with: npx tsx --test tests/node/shared/coms-shared.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatComsResponseText, formatQueueStr, renderQueuePart } from "../../../extensions/coms/coms-shared.js";

describe("formatComsResponseText", () => {
	it("formats error response without queue", () => {
		const result = formatComsResponseText("worker", null, "something failed", 0);
		assert.equal(result, "[coms response from worker] Error: something failed");
	});

	it("formats error response with queue depth", () => {
		const result = formatComsResponseText("worker", null, "something failed", 2);
		assert.equal(result, "[coms response from worker (2 more queued)] Error: something failed");
	});

	it("formats string response without queue", () => {
		const result = formatComsResponseText("peer-a", "task done", null, 0);
		assert.equal(result, "[coms response from peer-a] task done");
	});

	it("formats string response with queue depth", () => {
		const result = formatComsResponseText("peer-a", "task done", null, 3);
		assert.equal(result, "[coms response from peer-a (3 more queued)] task done");
	});

	it("formats object response as JSON", () => {
		const result = formatComsResponseText("peer-b", { status: "ok" }, null, 0);
		assert.equal(result, '[coms response from peer-b] {\n  "status": "ok"\n}');
	});

	it("formats object response with queue depth", () => {
		const result = formatComsResponseText("peer-b", { status: "ok" }, null, 1);
		assert.equal(result, '[coms response from peer-b (1 more queued)] {\n  "status": "ok"\n}');
	});
});

describe("formatQueueStr", () => {
	it("returns empty string for 0", () => {
		assert.equal(formatQueueStr(0), "");
	});

	it("returns empty string for undefined", () => {
		assert.equal(formatQueueStr(undefined), "");
	});

	it("returns empty string for null", () => {
		assert.equal(formatQueueStr(null), "");
	});

	it("returns 📨N for positive depth", () => {
		assert.equal(formatQueueStr(3), " 📨3");
	});

	it("returns 📨1 for depth 1", () => {
		assert.equal(formatQueueStr(1), " 📨1");
	});
});

describe("renderQueuePart", () => {
	const mockTheme = { fg: (_color: string, text: string) => text };

	it("returns empty string for 0", () => {
		assert.equal(renderQueuePart(0, mockTheme), "");
	});

	it("returns formatted part for positive depth", () => {
		const result = renderQueuePart(2, mockTheme);
		assert.equal(result, " 📨2");
	});
});
