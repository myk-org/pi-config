/**
 * Tests for coms-shared formatting helpers (queue depth, response text).
 * Run with: npx tsx --test tests/node/shared/coms-shared.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatComsResponseText, formatQueueStr, renderQueuePart } from "../../../extensions/coms/coms-shared.js";

describe("formatComsResponseText", () => {
	it("formats error response without queue", () => {
		const result = formatComsResponseText("worker", null, "something failed", []);
		assert.equal(result, "[coms response from worker] Error: something failed");
	});

	it("formats error response with queued IDs", () => {
		const result = formatComsResponseText("worker", null, "something failed", ["msg-aaa", "msg-bbb"]);
		assert.equal(result, "[coms response from worker (2 more queued: msg-aaa, msg-bbb)] Error: something failed");
	});

	it("formats string response without queue", () => {
		const result = formatComsResponseText("peer-a", "task done", null, []);
		assert.equal(result, "[coms response from peer-a] task done");
	});

	it("formats string response with queued IDs", () => {
		const result = formatComsResponseText("peer-a", "task done", null, ["id-1", "id-2", "id-3"]);
		assert.equal(result, "[coms response from peer-a (3 more queued: id-1, id-2, id-3)] task done");
	});

	it("formats object response as JSON", () => {
		const result = formatComsResponseText("peer-b", { status: "ok" }, null, []);
		assert.equal(result, '[coms response from peer-b] {\n  "status": "ok"\n}');
	});

	it("formats object response with single queued ID", () => {
		const result = formatComsResponseText("peer-b", { status: "ok" }, null, ["msg-123"]);
		assert.equal(result, '[coms response from peer-b (1 more queued: msg-123)] {\n  "status": "ok"\n}');
	});

	it("truncates IDs when more than 5 are queued", () => {
		const ids = ["a", "b", "c", "d", "e", "f", "g"];
		const result = formatComsResponseText("peer-x", "done", null, ids);
		assert.equal(result, "[coms response from peer-x (7 more queued: a, b, c, d, e and 2 more)] done");
	});

	it("shows all IDs when exactly 5 are queued", () => {
		const ids = ["a", "b", "c", "d", "e"];
		const result = formatComsResponseText("peer-x", "done", null, ids);
		assert.equal(result, "[coms response from peer-x (5 more queued: a, b, c, d, e)] done");
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
