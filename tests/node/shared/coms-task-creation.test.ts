/**
 * Tests for coms task lookup helpers (#731).
 * Run with: npx tsx --test tests/node/shared/coms-task-creation.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComsInboundTasks, getComsOriginTask, getComsOriginTasks, readTaskSummary } from "../../../extensions/coms/coms-shared.js";

describe("ESM-safe lazy pitasks loading", () => {
	it("reads a task summary without CommonJS require", async () => {
		const result = await readTaskSummary(process.cwd(), "missing-session");
		assert.equal(result, null);
	});

	it("creates one task with COMS origin metadata", async () => {
		const project = mkdtempSync(join(tmpdir(), "coms-task-creation-"));
		try {
			const count = await createComsInboundTasks(
				[{ subject: "Review result", description: "Inspect the finding" }],
				{ sender_session: "sender-session", sender_name: "reviewer", sender_endpoint: "peer.sock" },
				"target-session",
				project,
			);
			const store = JSON.parse(readFileSync(join(project, ".pi/tasks/tasks-target-session.json"), "utf8"));

			assert.equal(count, 1);
			assert.equal(store.tasks.length, 1);
			assert.deepEqual(store.tasks[0].createdBy, {
				type: "coms",
				origin: "reviewer",
				session: "sender-session",
				project: "",
			});
			assert.equal(store.tasks[0].metadata.sender_endpoint, "peer.sock");
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	});
});

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
	it("returns empty array when no tasks have coms createdBy", async () => {
		const result = await getComsOriginTasks();
		assert.ok(Array.isArray(result));
	});
});
