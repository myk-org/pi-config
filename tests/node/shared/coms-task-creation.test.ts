/**
 * Tests for coms task lookup helpers (#731).
 * Run with: npx tsx --test tests/node/shared/coms-task-creation.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getComsOriginTask, getComsOriginTasks } from "../../../extensions/coms/coms-shared.js";

describe("getComsOriginTask", () => {
	it("returns null for empty taskId", async () => {
		const result = await getComsOriginTask("");
		assert.equal(result, null);
	});

	it("returns null for taskId -1", async () => {
		const result = await getComsOriginTask("-1");
		assert.equal(result, null);
	});

	it("returns null for nonexistent task", async () => {
		const result = await getComsOriginTask("99999");
		assert.equal(result, null);
	});
});

describe("getComsOriginTasks", () => {
	it("returns empty array when no tasks have coms_origin", async () => {
		const result = await getComsOriginTasks();
		assert.ok(Array.isArray(result));
	});
});
