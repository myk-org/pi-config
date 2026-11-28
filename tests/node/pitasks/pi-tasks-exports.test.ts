/**
 * Tests for pitasks exported API functions.
 * Run with: npx tsx --test tests/node/pitasks/*.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pitasks from "../../../extensions/pitasks/index.js";
import { TaskStore } from "../../../extensions/pitasks/task-store.js";
import type { Task } from "../../../extensions/pitasks/types.js";
import { registerTaskTools } from "../../../extensions/pitasks/task-tools.js";
import {
	pendingReminderContent,
	staleReminderContent,
	shouldFireReminder,
} from "../../../extensions/pitasks/reminders.js";
import { makeTempDir } from "../helpers/temp-dirs.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { useSupportedPiVersion } from "../helpers/pi-version-env.js";

useSupportedPiVersion();

const localCreatedBy: Task["createdBy"] = { type: "local", origin: "system", session: "", project: "" };

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

	it("keeps condensed tool descriptions concise while preserving behavioral rules (#1159)", () => {
		const tools = new Map<string, any>();
		const pi = { registerTool: (tool: any) => { tools.set(tool.name, tool); } };
		registerTaskTools(pi as any, () => new TaskStore(), { update() {} } as any);

		const totalChars = ["TaskCreate", "TaskList", "TaskGet", "TaskUpdate"]
			.reduce((sum, name) => sum + (tools.get(name)?.description?.length ?? 0), 0);
		assert.ok(totalChars <= 2100, `expected condensed descriptions <= 2100 chars, got ${totalChars}`);

		assert.match(tools.get("TaskCreate").description, /assignee.*user/is);
		assert.match(tools.get("TaskCreate").description, /never assign `user` to work an agent could do itself/i);
		assert.match(tools.get("TaskCreate").description, /\/tasks/);
		assert.match(tools.get("TaskList").description, /lowest ID/i);
		assert.match(tools.get("TaskGet").description, /completedBy.*completionNote/s);
		assert.match(tools.get("TaskGet").description, /blockedBy/i);
		assert.match(tools.get("TaskUpdate").description, /refuses starting or completing.*user/is);
		assert.match(tools.get("TaskUpdate").description, /deleted/);
		assert.match(tools.get("TaskUpdate").description, /addBlocks.*addBlockedBy/s);
		assert.match(tools.get("TaskUpdate").description, /remaining open tasks/i);
		assert.doesNotMatch(tools.get("TaskUpdate").description, /check `TaskList` after resolving/i);
		assert.match(tools.get("TaskBulkUpdate").description, /remaining open-task summary/i);
		const guidelines: string[] = tools.get("TaskCreate").promptGuidelines ?? [];
		assert.ok(guidelines.some(g => /open-task summary/i.test(g) && /only when/i.test(g)));
		assert.ok(!guidelines.some(g => /Use TaskList to check for available work after completing a task/i.test(g)));
	});
});

describe("TaskUpdate/TaskBulkUpdate open-task summary (#1340)", () => {
	function makeTools(store: TaskStore) {
		const tools = new Map<string, any>();
		const pi = { registerTool: (tool: any) => { tools.set(tool.name, tool); } };
		registerTaskTools(pi as any, () => store, { update() {}, setActiveTask() {} } as any);
		return tools;
	}

	it("TaskUpdate appends a 1-line summary of remaining open tasks ordered in_progress then pending", async () => {
		const store = new TaskStore();
		const [t1, t2, t3, t4] = store.createTasks([
			{ subject: "Done step", description: "d", createdBy: localCreatedBy },
			{ subject: "Pending step", description: "d", createdBy: localCreatedBy },
			{ subject: "Active step", description: "d", createdBy: localCreatedBy },
			{ subject: "Owner merge", description: "d", createdBy: localCreatedBy, assignee: "user" },
		]);
		store.update(t3.id, { status: "in_progress" });
		store.update(t2.id, { addBlockedBy: [t3.id] });
		const tools = makeTools(store);

		const res = await tools.get("TaskUpdate").execute("call", { taskId: t1.id, status: "completed" });
		const lines = res.content[0].text.split("\n");
		assert.equal(lines.length, 2);
		assert.equal(lines[0], `Updated task #${t1.id} status`);
		assert.equal(
			lines[1],
			`Open (3): #${t3.id} [in_progress] Active step; #${t2.id} [pending, blocked by #${t3.id}] Pending step; #${t4.id} [pending, you] Owner merge`,
		);
	});

	it("TaskUpdate appends 'All tasks completed' when no open tasks remain", async () => {
		const store = new TaskStore();
		const t1 = store.create("Only step", "d", localCreatedBy);
		const tools = makeTools(store);

		const res = await tools.get("TaskUpdate").execute("call", { taskId: t1.id, status: "completed" });
		assert.equal(res.content[0].text, `Updated task #${t1.id} status\nAll tasks completed`);
	});

	it("TaskUpdate appends 'No open tasks' when the last task is deleted", async () => {
		const store = new TaskStore();
		const t1 = store.create("Drop me", "d", localCreatedBy);
		const tools = makeTools(store);

		const res = await tools.get("TaskUpdate").execute("call", { taskId: t1.id, status: "deleted" });
		assert.equal(res.content[0].text, `Updated task #${t1.id} deleted\nNo open tasks`);
	});

	it("TaskUpdate normalizes multiline subjects to one truncated line", async () => {
		const store = new TaskStore();
		const [t1, t2] = store.createTasks([
			{
				subject: "Line one\nline two with a very long subject exceeding forty-eight characters easily",
				description: "d",
				createdBy: localCreatedBy,
			},
			{ subject: "Finish", description: "d", createdBy: localCreatedBy },
		]);
		const tools = makeTools(store);

		const res = await tools.get("TaskUpdate").execute("call", { taskId: t2.id, status: "completed" });
		const lines = res.content[0].text.split("\n");
		assert.equal(lines.length, 2);
		assert.equal(
			lines[1],
			`Open (1): #${t1.id} [pending] Line one line two with a very long subject exce…`,
		);
	});

	it("TaskUpdate caps the open-task summary at 8 items with an overflow count", async () => {
		const store = new TaskStore();
		const created = store.createTasks(
			Array.from({ length: 10 }, (_, idx) => ({
				subject: `Task ${idx + 1}`,
				description: "d",
				createdBy: localCreatedBy,
			})),
		);
		const tools = makeTools(store);

		const res = await tools.get("TaskUpdate").execute("call", { taskId: created[9].id, status: "completed" });
		const lines = res.content[0].text.split("\n");
		assert.equal(lines.length, 2);
		assert.match(lines[1], /^Open \(9\): #1 \[pending\] Task 1; .+; #8 \[pending\] Task 8 \(\+1 more\)$/);
	});

	it("TaskUpdate tolerates malformed open tasks with non-string subjects loaded from disk", async () => {
		const dir = makeTempDir("task-summary-malformed-");
		const file = join(dir, "tasks.json");
		writeFileSync(
			file,
			JSON.stringify({
				nextId: 3,
				tasks: [
					{ id: "1", subject: "Normal", description: "d", status: "pending" },
					{ id: "2", subject: 42, description: "d", status: "pending" },
				],
			}),
		);
		const store = new TaskStore(file, { watch: false });
		try {
			const tools = makeTools(store);
			const res = await tools.get("TaskUpdate").execute("call", { taskId: "1", status: "completed" });
			assert.equal(res.content[0].text, "Updated task #1 status\nOpen (1): #2 [pending]");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("TaskBulkUpdate tolerates malformed open tasks with missing subjects loaded from disk", async () => {
		const dir = makeTempDir("task-bulk-summary-malformed-");
		const file = join(dir, "tasks.json");
		writeFileSync(
			file,
			JSON.stringify({
				nextId: 3,
				tasks: [
					{ id: "1", subject: "Normal", description: "d", status: "pending" },
					{ id: "2", description: "d", status: "pending" },
				],
			}),
		);
		const store = new TaskStore(file, { watch: false });
		try {
			const tools = makeTools(store);
			const res = await tools.get("TaskBulkUpdate").execute("call", {
				updates: [{ taskId: "1", status: "completed" }],
			});
			const lines = res.content[0].text.split("\n");
			assert.equal(lines[lines.length - 1], "Open (1): #2 [pending]");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("TaskBulkUpdate appends open-task summary for remaining work", async () => {
		const store = new TaskStore();
		const [t1, t2, t3] = store.createTasks([
			{ subject: "First", description: "d", createdBy: localCreatedBy },
			{ subject: "Second", description: "d", createdBy: localCreatedBy },
			{ subject: "Third", description: "d", createdBy: localCreatedBy },
		]);
		const tools = makeTools(store);

		const partial = await tools.get("TaskBulkUpdate").execute("call", {
			updates: [
				{ taskId: t1.id, status: "completed" },
				{ taskId: t2.id, status: "in_progress" },
			],
		});
		const partialLines = partial.content[0].text.split("\n");
		assert.equal(
			partialLines[partialLines.length - 1],
			`Open (2): #${t2.id} [in_progress] Second; #${t3.id} [pending] Third`,
		);
	});

	it("TaskBulkUpdate appends 'All tasks completed' when batch closes all open tasks", async () => {
		const store = new TaskStore();
		const [t1, t2] = store.createTasks([
			{ subject: "First", description: "d", createdBy: localCreatedBy },
			{ subject: "Second", description: "d", createdBy: localCreatedBy },
		]);
		const tools = makeTools(store);

		const done = await tools.get("TaskBulkUpdate").execute("call", {
			updates: [
				{ taskId: t1.id, status: "completed" },
				{ taskId: t2.id, status: "completed" },
			],
		});
		const doneLines = done.content[0].text.split("\n");
		assert.equal(doneLines[doneLines.length - 1], "All tasks completed");
	});

	it("pitasks registers TaskUpdate/TaskBulkUpdate in parent sessions", () => {
		const parentTools = new Map<string, any>();
		withSubagentChildEnv(undefined, () => {
			pitasks({
				on() {},
				registerTool(tool: any) { parentTools.set(tool.name, tool); },
				registerCommand() {},
				events: { on() { return () => {}; }, emit() {} },
			} as any);
			return undefined;
		});
		assert.ok(parentTools.get("TaskUpdate"));
		assert.ok(parentTools.get("TaskBulkUpdate"));
	});

	it("pitasks skips TaskUpdate/TaskBulkUpdate registration when PI_SUBAGENT_CHILD=1", () => {
		const childTools = new Map<string, any>();
		withSubagentChildEnv("1", () => {
			pitasks({
				on() {},
				registerTool(tool: any) { childTools.set(tool.name, tool); },
				registerCommand() {},
				events: { on() { return () => {}; }, emit() {} },
			} as any);
			return undefined;
		});
		assert.equal(childTools.get("TaskUpdate"), undefined);
		assert.equal(childTools.get("TaskBulkUpdate"), undefined);
	});
});

describe("pitasks exported API pattern", () => {
	it("TaskStore.create returns task with correct subject", () => {
		const store = new TaskStore();
		const task = store.create("Test task", "Description", localCreatedBy);
		assert.equal(task.subject, "Test task");
		assert.equal(task.description, "Description");
	});

	it("TaskStore.create defaults status to pending", () => {
		const store = new TaskStore();
		const task = store.create("Task", "desc", localCreatedBy);
		assert.equal(task.status, "pending");
	});

	it("TaskStore.create generates unique ids across calls", () => {
		const store = new TaskStore();
		const t1 = store.create("Task 1", "desc", localCreatedBy);
		const t2 = store.create("Task 2", "desc", localCreatedBy);
		assert.ok(t1.id);
		assert.ok(t2.id);
		assert.notEqual(t1.id, t2.id);
	});

	it("TaskStore.get returns created task", () => {
		const store = new TaskStore();
		const created = store.create("Find me", "desc", localCreatedBy);
		const found = store.get(created.id);
		assert.equal(found?.subject, "Find me");
	});

	it("TaskStore.list returns all tasks", () => {
		const store = new TaskStore();
		store.create("Task 1", "desc1", localCreatedBy);
		store.create("Task 2", "desc2", localCreatedBy);
		const list = store.list();
		assert.equal(list.length, 2);
	});

	it("TaskStore.update starts telemetry for in-progress tasks", () => {
		const store = new TaskStore();
		const task = store.create("Original", "desc", localCreatedBy);
		const originalNow = Date.now;
		try {
			Date.now = () => 1_000;
			const result = store.update(task.id, { status: "in_progress" });
			assert.equal(result.task?.status, "in_progress");
			assert.deepEqual(result.task?.telemetry, { startedAt: 1_000, inputTokens: 0, outputTokens: 0 });
			assert.ok(result.changedFields.includes("status"));
		} finally {
			Date.now = originalNow;
		}
	});

	it("TaskStore.updateTasks starts telemetry for auto-managed transitions", () => {
		const store = new TaskStore();
		const pending = store.create("Pending", "desc", localCreatedBy);
		const completed = store.create("Completed", "desc", localCreatedBy);
		const originalNow = Date.now;
		try {
			Date.now = () => 1_000;
			store.update(completed.id, { status: "in_progress" });
			Date.now = () => 2_000;
			store.update(completed.id, { status: "completed" });
			Date.now = () => 3_000;
			store.updateTasks([
				{ id: pending.id, fields: { status: "in_progress" } },
				{ id: completed.id, fields: { status: "in_progress" } },
			]);
			assert.deepEqual(store.get(pending.id)?.telemetry, { startedAt: 3_000, inputTokens: 0, outputTokens: 0 });
			assert.deepEqual(store.get(completed.id)?.telemetry, { startedAt: 3_000, inputTokens: 0, outputTokens: 0 });
		} finally {
			Date.now = originalNow;
		}
	});

	it("TaskStore.delete removes task", () => {
		const store = new TaskStore();
		const task = store.create("Delete me", "desc", localCreatedBy);
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
		const task = store.create("Meta task", "desc", localCreatedBy, undefined, { key1: "a" });
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

	it("TaskStore.updateTasks updates blockedBy with bidirectional blocks links (#1173)", () => {
		const store = new TaskStore();
		const [t1, t2, t3] = store.createTasks([
			{ subject: "A", description: "a", createdBy: localCreatedBy },
			{ subject: "B", description: "b", createdBy: localCreatedBy },
			{ subject: "C", description: "c", createdBy: localCreatedBy },
		]);
		store.update(t3.id, { addBlockedBy: [t1.id] });
		assert.deepEqual(store.get(t1.id)?.blocks, [t3.id]);

		const res = store.updateTasks([{ id: t3.id, fields: { blockedBy: [t2.id] } }]);
		assert.equal(res[0].success, true);
		assert.ok(res[0].changedFields?.includes("blockedBy"));
		assert.deepEqual(store.get(t3.id)?.blockedBy, [t2.id]);
		assert.deepEqual(store.get(t1.id)?.blocks, []);
		assert.deepEqual(store.get(t2.id)?.blocks, [t3.id]);
	});

	it("TaskStore.updateTasks prunes references when deleting a task (#1173)", () => {
		const store = new TaskStore();
		const [t1, t2] = store.createTasks([
			{ subject: "A", description: "a", createdBy: localCreatedBy },
			{ subject: "B", description: "b", createdBy: localCreatedBy },
		]);
		store.update(t2.id, { addBlockedBy: [t1.id] });

		const res = store.updateTasks([
			{ id: t1.id, fields: { status: "deleted" } },
			{ id: "missing", fields: { subject: "nope" } },
		]);
		assert.deepEqual(res[0], { id: t1.id, success: true, changedFields: ["deleted"] });
		assert.deepEqual(res[1], { id: "missing", success: false });
		assert.deepEqual(store.get(t2.id)?.blockedBy, []);
	});

	it("TaskStore.deleteTasks prunes dangling references (#1173)", () => {
		const store = new TaskStore();
		const [t1, t2, t3, t4] = store.createTasks([
			{ subject: "1", description: "d", createdBy: localCreatedBy },
			{ subject: "2", description: "d", createdBy: localCreatedBy },
			{ subject: "3", description: "d", createdBy: localCreatedBy },
			{ subject: "4", description: "d", createdBy: localCreatedBy },
		]);
		store.update(t3.id, { addBlockedBy: [t1.id, t2.id] });
		store.update(t4.id, { addBlockedBy: [t1.id, t3.id] });
		assert.equal(store.deleteTasks([t1.id, t2.id, "missing"]), 2);
		assert.deepEqual(store.get(t3.id)?.blockedBy, []);
		assert.deepEqual(store.get(t4.id)?.blockedBy, [t3.id]);
	});

	it("TaskStore.clearCompleted prunes pre-existing missing links (#1173)", () => {
		const store = new TaskStore();
		const [t1, t2] = store.createTasks([
			{ subject: "Done", description: "d", createdBy: localCreatedBy },
			{ subject: "Keep", description: "d", createdBy: localCreatedBy },
		]);
		store.update(t2.id, { blockedBy: [t1.id, "missing-id"] });
		store.update(t1.id, { status: "completed" });
		assert.equal(store.clearCompleted(), 1);
		assert.deepEqual(store.get(t2.id)?.blockedBy, []);
	});

	it("TaskStore.withLock rolls back in-memory state when an update throws (#1162)", () => {
		const dir = makeTempDir("task-store-rollback-");
		const file = join(dir, "tasks.json");
		const store = new TaskStore(file, { watch: false });
		try {
			const created = store.create("Persisted", "body", localCreatedBy);
			assert.throws(() => {
				store.update(created.id, { status: "in_progress", metadata: null as any });
			}, TypeError);

			assert.equal(store.get(created.id)?.status, "pending");
			const afterFollowUpWrite = store.create("Second", "body", localCreatedBy);
			assert.equal(afterFollowUpWrite.id, "2");
			assert.equal(store.get(created.id)?.status, "pending");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
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
