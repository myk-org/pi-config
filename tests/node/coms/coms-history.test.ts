/**
 * #924 §5 — coms history: JSONL audit trail append/query.
 * Run with: npx tsx --test tests/node/coms/coms-history.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendHistoryRecord,
	queryHistoryRecords,
	truncatePreview,
	HISTORY_PREVIEW_MAX,
	HISTORY_MAX_FILE_BYTES,
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
	it("flattens whitespace", () => {
		assert.equal(truncatePreview("  short  "), "short");
	});

	it("truncates long text with an ellipsis", () => {
		const long = `line1\n\n\tline2 ${"x".repeat(200)}`;
		const out = truncatePreview(long);
		assert.equal(out.length, HISTORY_PREVIEW_MAX);
		assert.ok(out.endsWith("…"));
		assert.ok(!out.includes("\n"));
		assert.ok(!out.includes("\t"));
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

	it("filters by peer", () => {
		appendHistoryRecord(file, rec({ msg_id: "m1", peer: "alpha" }));
		appendHistoryRecord(file, rec({ msg_id: "m2", peer: "beta" }));
		assert.deepEqual(queryHistoryRecords(file, { peer: "alpha" }).map((r) => r.msg_id), ["m1"]);
	});

	it("filters by direction", () => {
		appendHistoryRecord(file, rec({ msg_id: "m1", direction: "out" }));
		appendHistoryRecord(file, rec({ msg_id: "m2", direction: "in" }));
		assert.deepEqual(queryHistoryRecords(file, { direction: "in" }).map((r) => r.msg_id), ["m2"]);
	});

	it("filters by msg_id", () => {
		appendHistoryRecord(file, rec({ msg_id: "m1" }));
		appendHistoryRecord(file, rec({ msg_id: "m2" }));
		assert.deepEqual(queryHistoryRecords(file, { msg_id: "m2" }).map((r) => r.msg_id), ["m2"]);
	});

	it("filters by since (inclusive lower bound)", () => {
		appendHistoryRecord(file, rec({ msg_id: "old", ts: "2026-01-01T00:00:00.000Z" }));
		appendHistoryRecord(file, rec({ msg_id: "new", ts: "2026-06-01T00:00:00.000Z" }));
		assert.deepEqual(queryHistoryRecords(file, { since: "2026-06-01T00:00:00.000Z" }).map((r) => r.msg_id), ["new"]);
	});

	it("filters by status substring, case-insensitive", () => {
		appendHistoryRecord(file, rec({ msg_id: "m1", status: "queued (priority)" }));
		appendHistoryRecord(file, rec({ msg_id: "m2", status: "replied" }));
		assert.deepEqual(queryHistoryRecords(file, { status: "PRIORITY" }).map((r) => r.msg_id), ["m1"]);
	});

	it("filters by owner session", () => {
		appendHistoryRecord(file, rec({ msg_id: "mine", owner: "sess-a" }));
		appendHistoryRecord(file, rec({ msg_id: "theirs", owner: "sess-b" }));
		assert.deepEqual(queryHistoryRecords(file, { owner: "sess-a" }).map((r) => r.msg_id), ["mine"]);
	});

	it("returns the most recent window, newest last", () => {
		for (let i = 1; i <= 10; i++) {
			appendHistoryRecord(file, rec({ msg_id: `m${i}` }));
		}
		const window = queryHistoryRecords(file, { limit: 3 });
		assert.deepEqual(window.map((r) => r.msg_id), ["m8", "m9", "m10"]);
	});

	it("skips malformed JSON lines without failing the query", () => {
		appendHistoryRecord(file, rec({ msg_id: "m1" }));
		appendFileSync(file, "{not json\n", "utf-8");
		assert.deepEqual(queryHistoryRecords(file).map((r) => r.msg_id), ["m1"]);
	});

	it("skips valid-JSON non-records (null, primitives, arrays)", () => {
		appendHistoryRecord(file, rec({ msg_id: "m1" }));
		appendHistoryRecord(file, rec({ msg_id: "m2" }));
		appendFileSync(file, "null\n123\n\"str\"\n[]\n{}\n", "utf-8");
		assert.deepEqual(queryHistoryRecords(file).map((r) => r.msg_id), ["m1", "m2"]);
	});
});

describe("history rotation", () => {
	it("trims an over-large file to the newest complete lines on append", () => {
		// Seed a file past the rotation threshold with numbered records.
		const big = "x".repeat(2000);
		let seedCount = 0;
		appendFileSync(file, `${JSON.stringify(rec({ msg_id: `seed-${seedCount}`, preview: big }))}\n`, "utf-8");
		while (statSync(file).size <= HISTORY_MAX_FILE_BYTES) {
			appendFileSync(file, `${JSON.stringify(rec({ msg_id: `seed-${seedCount}`, preview: big }))}\n`, "utf-8");
			seedCount++;
		}
		const sizeBefore = statSync(file).size;
		assert.ok(sizeBefore > HISTORY_MAX_FILE_BYTES);

		// The next append triggers rotation, then adds the new record.
		assert.equal(appendHistoryRecord(file, rec({ msg_id: "after-rotate" })), true);

		const records = queryHistoryRecords(file, { limit: HISTORY_MAX_FILE_BYTES });
		const ids = records.map((r) => r.msg_id);
		assert.ok(ids.includes("after-rotate"), "new record survives rotation");
		assert.ok(ids.includes(`seed-${seedCount - 1}`), "newest seeded record survives");
		assert.ok(!ids.includes("seed-0"), "oldest seeded record dropped");
		assert.ok(statSync(file).size < sizeBefore, "file shrank");
	});

	it("leaves small files untouched", () => {
		appendHistoryRecord(file, rec({ msg_id: "m1" }));
		const sizeBefore = statSync(file).size;
		assert.equal(appendHistoryRecord(file, rec({ msg_id: "m2" })), true);
		assert.ok(statSync(file).size > sizeBefore, "no rotation below threshold");
		assert.equal(queryHistoryRecords(file).length, 2);
	});
});
