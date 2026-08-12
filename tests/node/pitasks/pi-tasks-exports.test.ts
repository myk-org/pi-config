/**
 * Tests for pitasks exported API functions.
 * Run with: npx tsx --test tests/node/pitasks/*.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "../../../extensions/pitasks/task-store.js";

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
		const task = store.create("Meta task", "desc", undefined, { key1: "a" });
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
