/**
 * #924 §5 — coms history: JSONL audit trail append/query.
 * Run with: npx tsx --test tests/node/coms/coms-history.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendHistoryRecord,
	queryHistoryRecords,
	truncatePreview,
	HISTORY_PREVIEW_MAX,
	type HistoryRecord,
} from "../../../extensions/coms/coms-history.js";

let dir: string;
let file: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "coms-history-"));
	file = join(dir, "history.jsonl");
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function rec(overrides: Partial<HistoryRecord> & { msg_id: string }): HistoryRecord {
	return {
		ts: new Date().toISOString(),
		direction: "out",
		peer: "peer-a",
		preview: "hello",
		status: "sent",
		...overrides,
	};
}

describe("truncatePreview", () => {
	it("flattens whitespace and truncates with an ellipsis", () => {
		const long = `line1\n\n\tline2 ${"x".repeat(200)}`;
		const out = truncatePreview(long);
		assert.equal(out.length, HISTORY_PREVIEW_MAX);
		assert.ok(out.endsWith("…"));
		assert.ok(!out.includes("\n"));
		assert.ok(!out.includes("\t"));
	});
	it("keeps short text untouched", () => {
		assert.equal(truncatePreview("  short  "), "short");
	});
});

describe("appendHistoryRecord", () => {
	it("appends records as JSONL lines and reports success", () => {
		assert.equal(appendHistoryRecord(file, rec({ msg_id: "m1" })), true);
		assert.equal(appendHistoryRecord(file, rec({ msg_id: "m2", direction: "in", peer: "peer-b" })), true);
		const records = queryHistoryRecords(file);
		assert.equal(records.length, 2);
		assert.equal(records[0].msg_id, "m1");
		assert.equal(records[1].direction, "in");
	});
	it("creates the parent directory on demand", () => {
		const nested = join(dir, "a", "b", "history.jsonl");
		assert.equal(appendHistoryRecord(nested, rec({ msg_id: "m1" })), true);
		assert.equal(queryHistoryRecords(nested).length, 1);
	});
	it("fail-soft: an unwritable path returns false, never throws", () => {
		const blocked = join(dir, "file-not-dir");
		writeFileSync(blocked, "not a directory");
		assert.equal(appendHistoryRecord(join(blocked, "history.jsonl"), rec({ msg_id: "m1" })), false);
	});
});

describe("queryHistoryRecords", () => {
	it("missing file is an empty result, not an error", () => {
		assert.deepEqual(queryHistoryRecords(join(dir, "nope.jsonl")), []);
	});
	it("filters by peer, direction, and msg_id", () => {
		appendHistoryRecord(file, rec({ msg_id: "m1", peer: "alpha", direction: "out" }));
		appendHistoryRecord(file, rec({ msg_id: "m2", peer: "beta", direction: "in" }));
		appendHistoryRecord(file, rec({ msg_id: "m3", peer: "alpha", direction: "response_out" }));
		assert.deepEqual(queryHistoryRecords(file, { peer: "alpha" }).map((r) => r.msg_id), ["m1", "m3"]);
		assert.deepEqual(queryHistoryRecords(file, { direction: "in" }).map((r) => r.msg_id), ["m2"]);
		assert.deepEqual(queryHistoryRecords(file, { msg_id: "m3" }).map((r) => r.msg_id), ["m3"]);
		assert.deepEqual(queryHistoryRecords(file, { peer: "nobody" }), []);
	});
	it("returns the most recent window, newest last", () => {
		for (let i = 1; i <= 10; i++) {
			appendHistoryRecord(file, rec({ msg_id: `m${i}`, preview: `p${i}` }));
		}
		const window = queryHistoryRecords(file, { limit: 3 });
		assert.deepEqual(window.map((r) => r.msg_id), ["m8", "m9", "m10"]);
	});
	it("skips malformed lines without failing the query", () => {
		appendHistoryRecord(file, rec({ msg_id: "m1" }));
		appendHistoryRecord(file, rec({ msg_id: "m2" }));
		appendFileSync(file, "{not json\n", "utf-8");
		assert.deepEqual(queryHistoryRecords(file).map((r) => r.msg_id), ["m1", "m2"]);
	});
});
