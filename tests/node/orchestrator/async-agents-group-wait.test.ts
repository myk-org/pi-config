/**
 * Tests for deliverGroupResults late-ingest wait behavior.
 * Verifies the group-level deadline wait for missing result files.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Simulate the wait-for-missing-files logic extracted from deliverGroupResults.
 * This tests the algorithm without requiring the full async agent infrastructure.
 */
async function waitForMissingFiles(
	resultDir: string,
	jobIds: string[],
	deadlineMs: number,
): Promise<Set<string>> {
	const found = new Set<string>();
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		let allFound = true;
		for (const id of jobIds) {
			if (found.has(id)) continue;
			if (existsSync(join(resultDir, `${id}.json`))) {
				found.add(id);
			} else {
				allFound = false;
			}
		}
		if (allFound) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	return found;
}

describe("group result file wait", () => {
	let tmp: string;

	it("finds files that already exist immediately", async () => {
		tmp = mkdtempSync(join(tmpdir(), "async-group-wait-"));
		writeFileSync(join(tmp, "job-1.json"), "{}");
		writeFileSync(join(tmp, "job-2.json"), "{}");
		const found = await waitForMissingFiles(tmp, ["job-1", "job-2"], 2000);
		assert.equal(found.size, 2);
		assert.ok(found.has("job-1"));
		assert.ok(found.has("job-2"));
		rmSync(tmp, { recursive: true, force: true });
	});

	it("waits for file that appears after a delay", async () => {
		tmp = mkdtempSync(join(tmpdir(), "async-group-wait-"));
		// Write one file after 300ms
		setTimeout(() => {
			writeFileSync(join(tmp, "delayed.json"), "{}");
		}, 300);
		const found = await waitForMissingFiles(tmp, ["delayed"], 2000);
		assert.equal(found.size, 1);
		assert.ok(found.has("delayed"));
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns partial results when deadline expires", async () => {
		tmp = mkdtempSync(join(tmpdir(), "async-group-wait-"));
		writeFileSync(join(tmp, "exists.json"), "{}");
		// "missing" never gets created
		const found = await waitForMissingFiles(tmp, ["exists", "missing"], 500);
		assert.equal(found.size, 1);
		assert.ok(found.has("exists"));
		assert.ok(!found.has("missing"));
		rmSync(tmp, { recursive: true, force: true });
	});

	it("uses single deadline for all files, not per-file", async () => {
		tmp = mkdtempSync(join(tmpdir(), "async-group-wait-"));
		const start = Date.now();
		// 3 missing files, 500ms deadline — should take ~500ms total, not 1500ms
		const found = await waitForMissingFiles(tmp, ["a", "b", "c"], 500);
		const elapsed = Date.now() - start;
		assert.equal(found.size, 0);
		assert.ok(elapsed < 1000, `Expected <1000ms but took ${elapsed}ms (serial wait bug)`);
		rmSync(tmp, { recursive: true, force: true });
	});
});
