/**
 * Tests for pitasks exported API functions.
 * Run with: npx tsx --test tests/node/pitasks/*.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "../../../extensions/pitasks/task-store.js";
import { registerTaskTools } from "../../../extensions/pitasks/task-tools.js";
import {
	pendingReminderContent,
	staleReminderContent,
	shouldFireReminder,
} from "../../../extensions/pitasks/reminders.js";

describe("TaskCreate guidance", () => {
	it("describes agentType as non-executing optional metadata", () => {
		let taskCreate: any;
		const pi = { registerTool: (tool: any) => { if (tool.name === "TaskCreate") taskCreate = tool; } };
		registerTaskTools(pi as any, () => new TaskStore(), { update() {} } as any);

		const agentTypeDescription = taskCreate.parameters.properties.agentType.description;
		assert.doesNotMatch(taskCreate.description, /TaskExecute|general-purpose|Explore/);
		assert.doesNotMatch(agentTypeDescription, /TaskExecute|general-purpose|Explore/);
		assert.match(agentTypeDescription, /optional descriptive metadata/i);
		assert.match(agentTypeDescription, /does not dispatch or execute an agent/i);
	});
});

describe("pitasks exported API pattern", () => {
	it("TaskStore.create returns task with correct subject", () => {
		const store = new TaskStore();
		const task = store.create("Test task", "Description");
		assert.equal(task.subject, "Test task");
		assert.equal(task.description, "Description");
	});

	it("TaskStore.create defaults status to pending", () => {
		const store = new TaskStore();
		const task = store.create("Task", "desc");
		assert.equal(task.status, "pending");
	});

	it("TaskStore.create generates unique ids across calls", () => {
		const store = new TaskStore();
		const t1 = store.create("Task 1", "desc");
		const t2 = store.create("Task 2", "desc");
		assert.ok(t1.id);
		assert.ok(t2.id);
		assert.notEqual(t1.id, t2.id);
	});

	it("TaskStore.get returns created task", () => {
		const store = new TaskStore();
		const created = store.create("Find me", "desc");
		const found = store.get(created.id);
		assert.equal(found?.subject, "Find me");
	});

	it("TaskStore.list returns all tasks", () => {
		const store = new TaskStore();
		store.create("Task 1", "desc1");
		store.create("Task 2", "desc2");
		const list = store.list();
		assert.equal(list.length, 2);
	});

	it("TaskStore.update changes task fields", () => {
		const store = new TaskStore();
		const task = store.create("Original", "desc");
		const result = store.update(task.id, { status: "in_progress" });
		assert.equal(result.task?.status, "in_progress");
		assert.ok(result.changedFields.includes("status"));
	});

	it("TaskStore.delete removes task", () => {
		const store = new TaskStore();
		const task = store.create("Delete me", "desc");
		const deleted = store.delete(task.id);
		assert.equal(deleted, true);
		assert.equal(store.get(task.id), undefined);
	});

	it("TaskStore.create with createdBy stores origin", () => {
		const store = new TaskStore();
		const task = store.create("Peer task", "desc", { type: "coms", origin: "peer-a", session: "sess-1", project: "" });
		assert.equal(task.createdBy.session, "sess-1");
		assert.equal(task.createdBy.origin, "peer-a");
		assert.equal(task.createdBy.type, "coms");
	});

	it("TaskStore.update with metadata merges keys", () => {
		const store = new TaskStore();
		const task = store.create("Meta task", "desc", undefined, undefined, { key1: "a" });
		store.update(task.id, { metadata: { key2: "b" } });
		const updated = store.get(task.id);
		assert.equal(updated?.metadata.key1, "a");
		assert.equal(updated?.metadata.key2, "b");
	});

	it("TaskStore.delete returns false for nonexistent task", () => {
		const store = new TaskStore();
		assert.equal(store.delete("999"), false);
	});

	it("TaskStore.update returns empty for nonexistent task", () => {
		const store = new TaskStore();
		const result = store.update("999", { status: "completed" });
		assert.equal(result.task, undefined);
		assert.equal(result.changedFields.length, 0);
	});
});

/**
 * Tests for the task-focus reminder logic (Qodo #2, #5).
 *
 * These tests import the REAL exported pure functions from
 * extensions/pitasks/reminders.ts (also re-exported by index.ts and used by
 * the reminder timer) — pendingReminderContent, staleReminderContent,
 * shouldFireReminder — so production regressions are caught:
 *   (a) the agentBusy gate — reminders are SKIPPED while agentBusy is true; and
 *   (b) the reminder CONTENT — a GENERIC "You have N active task(s)..." string
 *       that contains the active COUNT but NO task ids or subjects (no leak).
 */
describe("task-focus reminder timer (Qodo #2)", () => {
	it("reminder is SKIPPED when agentBusy is true", () => {
		assert.equal(shouldFireReminder(true, 3), false);
	});

	it("reminder fires when agent is idle with active tasks", () => {
		assert.equal(shouldFireReminder(false, 3), true);
	});

	it("reminder does not fire when there are no matching tasks (even if idle)", () => {
		assert.equal(shouldFireReminder(false, 0), false);
	});

	it("pending reminder content includes the active COUNT", () => {
		assert.ok(pendingReminderContent(3).includes("3 active task(s)"));
	});

	it("pending reminder content is GENERIC — no task subject/id leaked", () => {
		// Build tasks with distinctive subjects/ids and verify none appear in the content.
		const store = new TaskStore();
		const by = { type: "local" as const, origin: "", session: "s", project: "" };
		const t1 = store.create("Secret subject ALPHA", "desc", by);
		const t2 = store.create("Confidential BETA", "desc", by);
		const active = store.list().filter(t => t.status === "pending" || t.status === "in_progress");
		const content = pendingReminderContent(active.length);

		// Sequential numeric ids ("1", "2") intentionally NOT asserted here — they
		// collide with the active COUNT that legitimately appears in the string.
		void t1; void t2;
		assert.ok(content.includes("2 active task(s)"));
		assert.equal(content.includes("Secret subject ALPHA"), false);
		assert.equal(content.includes("Confidential BETA"), false);
		assert.equal(content.includes("ALPHA"), false);
		assert.equal(content.includes("BETA"), false);
	});

	it("stale reminder content includes the COUNT", () => {
		const content = staleReminderContent(1);
		assert.ok(content.includes("1 task(s) stuck in progress"));
	});

	it("stale reminder content is GENERIC — no task subject leaked", () => {
		const content = staleReminderContent(1);
		assert.equal(content.includes("Stuck subject GAMMA"), false);
		assert.equal(content.includes("GAMMA"), false);
	});
});
