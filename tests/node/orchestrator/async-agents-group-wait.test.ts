/**
 * Tests for waitForResultFiles — the shared helper used by deliverGroupResults
 * to wait for missing async result files before group delivery.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { waitForResultFiles } from "../../../extensions/orchestrator/async-wait.js";

describe("waitForResultFiles", () => {
	let tmp: string;

	it("finds files that already exist immediately", async () => {
		tmp = mkdtempSync(join(tmpdir(), "async-group-wait-"));
		writeFileSync(join(tmp, "job-1.json"), "{}");
		writeFileSync(join(tmp, "job-2.json"), "{}");
		const found = await waitForResultFiles(tmp, ["job-1", "job-2"], 2000);
		assert.equal(found.size, 2);
		assert.ok(found.has("job-1"));
		assert.ok(found.has("job-2"));
		rmSync(tmp, { recursive: true, force: true });
	});

	it("waits for file that appears after a delay", async () => {
		tmp = mkdtempSync(join(tmpdir(), "async-group-wait-"));
		setTimeout(() => {
			writeFileSync(join(tmp, "delayed.json"), "{}");
		}, 300);
		const found = await waitForResultFiles(tmp, ["delayed"], 2000);
		assert.equal(found.size, 1);
		assert.ok(found.has("delayed"));
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns partial results when deadline expires", async () => {
		tmp = mkdtempSync(join(tmpdir(), "async-group-wait-"));
		writeFileSync(join(tmp, "exists.json"), "{}");
		const found = await waitForResultFiles(tmp, ["exists", "missing"], 500);
		assert.equal(found.size, 1);
		assert.ok(found.has("exists"));
		assert.ok(!found.has("missing"));
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns empty set when no files appear before deadline", async () => {
		tmp = mkdtempSync(join(tmpdir(), "async-group-wait-"));
		const found = await waitForResultFiles(tmp, ["a", "b", "c"], 500);
		assert.equal(found.size, 0);
		rmSync(tmp, { recursive: true, force: true });
	});

	it("scans at least once even with deadlineMs=0", async () => {
		tmp = mkdtempSync(join(tmpdir(), "async-group-wait-"));
		writeFileSync(join(tmp, "already.json"), "{}");
		const found = await waitForResultFiles(tmp, ["already"], 0);
		assert.equal(found.size, 1);
		assert.ok(found.has("already"));
		rmSync(tmp, { recursive: true, force: true });
	});
});
