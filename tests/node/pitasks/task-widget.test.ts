import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pitasks, {
	createTaskForSession,
	createTasksForSession,
	deleteTaskForSession,
	getTaskForSession,
	listTasksForSession,
	setTaskTelemetryActive,
	taskStore,
	updateTaskForSession,
	updateTasksForSession,
} from "../../../extensions/pitasks/index.js";
import { TaskStore } from "../../../extensions/pitasks/task-store.js";
import { TaskWidget } from "../../../extensions/pitasks/task-widget.js";

const createdBy = { type: "local" as const, origin: "system", session: "", project: "" };
const theme = { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text };

function renderer(widget: TaskWidget): () => string[] {
	let render: (() => string[]) | undefined;
	widget.setUICtx({
		setWidget(_name: string, value: any) { if (value) render = value({ terminal: { columns: 200 } }, theme).render; },
	});
	widget.update();
	assert.ok(render);
	return render;
}

function withNow(fn: (setNow: (now: number) => void) => void): void {
	const originalNow = Date.now;
	let now = 0;
	Date.now = () => now;
	try { fn(value => { now = value; }); } finally { Date.now = originalNow; }
}

describe("TaskWidget rendering", () => {
	it("renders completed telemetry", () => withNow(setNow => {
		const store = new TaskStore();
		const widget = new TaskWidget(store);
		try {
			const task = store.create("Completed task", "body", createdBy);
			setNow(1_000); store.update(task.id, { status: "in_progress" }); widget.setActiveTask(task.id); widget.addTokenUsage(1_234, 567);
			setNow(61_000); store.update(task.id, { status: "completed" }); widget.setActiveTask(task.id, false);
			assert.match(renderer(widget)().join("\n"), /\(1m · ↑ 1\.2k ↓ 567\)/);
		} finally { widget.dispose(); }
	}));

	it("freezes completed elapsed time", () => withNow(setNow => {
		const store = new TaskStore();
		const widget = new TaskWidget(store);
		try {
			const task = store.create("Completed task", "body", createdBy);
			setNow(1_000); store.update(task.id, { status: "in_progress" });
			setNow(61_000); store.update(task.id, { status: "completed" });
			const render = renderer(widget);
			const completed = render().join("\n"); setNow(999_999);
			assert.equal(render().join("\n"), completed);
		} finally { widget.dispose(); }
	}));

	it("omits completed task details", () => {
		const store = new TaskStore();
		const widget = new TaskWidget(store);
		try {
			const task = store.create("Completed task", "SECRET TASK BODY", createdBy);
			store.update(task.id, { status: "in_progress", activeForm: "leaking active form" });
			store.update(task.id, { status: "completed" });
			assert.doesNotMatch(renderer(widget)().join("\n"), /SECRET TASK BODY|leaking active form/);
		} finally { widget.dispose(); }
	});
});

describe("TaskWidget telemetry lifecycle", () => {
	it("does not attribute a turn to restored in-progress tasks", () => {
		const dir = mkdtempSync(join(tmpdir(), "pitasks-"));
		const path = join(dir, "tasks.json");
		try {
			const originalNow = Date.now;
			Date.now = () => 1_000;
			const store = new TaskStore(path);
			const first = store.create("First", "body", createdBy);
			const second = store.create("Second", "body", createdBy);
			store.updateTasks([{ id: first.id, fields: { status: "in_progress" } }, { id: second.id, fields: { status: "in_progress" } }]);
			store.close();
			const reloaded = new TaskStore(path);
			const widget = new TaskWidget(reloaded);
			widget.addTokenUsage(7, 11);
			assert.deepEqual(reloaded.get(first.id)?.telemetry, { startedAt: reloaded.get(first.id)?.telemetry?.startedAt, inputTokens: 0, outputTokens: 0 });
			assert.deepEqual(reloaded.get(second.id)?.telemetry, { startedAt: reloaded.get(second.id)?.telemetry?.startedAt, inputTokens: 0, outputTokens: 0 });
			widget.dispose(); reloaded.close();
			Date.now = originalNow;
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("attributes usage to a task explicitly activated after reload", () => {
		const store = new TaskStore();
		const task = store.create("Running task", "body", createdBy);
		store.update(task.id, { status: "in_progress", telemetry: { startedAt: 1_000, inputTokens: 5, outputTokens: 3 } });
		const widget = new TaskWidget(store);
		try {
			widget.setActiveTask(task.id); widget.addTokenUsage(7, 11);
			assert.deepEqual(store.get(task.id)?.telemetry, { startedAt: 1_000, inputTokens: 12, outputTokens: 14 });
		} finally { widget.dispose(); }
	});

	it("clears old telemetry when its store changes", () => {
		const oldStore = new TaskStore();
		const oldTask = oldStore.create("Old", "body", createdBy);
		oldStore.update(oldTask.id, { status: "in_progress" });
		const replacement = new TaskStore();
		const newTask = replacement.create("New", "body", createdBy);
		replacement.update(newTask.id, { status: "in_progress" });
		const widget = new TaskWidget(oldStore);
		try {
			widget.setActiveTask(oldTask.id); widget.setStore(replacement); widget.setActiveTask(newTask.id); widget.addTokenUsage(7, 11);
			assert.deepEqual(oldStore.get(oldTask.id)?.telemetry?.inputTokens, 0);
			assert.deepEqual(replacement.get(newTask.id)?.telemetry?.inputTokens, 7);
		} finally { widget.dispose(); }
	});

	it("starts fresh telemetry when a completed task restarts", () => withNow(setNow => {
		const store = new TaskStore(); const widget = new TaskWidget(store); const task = store.create("Restarted", "body", createdBy);
		try {
			setNow(1_000); store.update(task.id, { status: "in_progress" }); widget.setActiveTask(task.id); widget.addTokenUsage(10, 20);
			setNow(2_000); store.update(task.id, { status: "completed" }); widget.setActiveTask(task.id, false);
			setNow(3_000); store.update(task.id, { status: "in_progress" }); widget.setActiveTask(task.id); widget.addTokenUsage(1, 2);
			assert.deepEqual(store.get(task.id)?.telemetry, { startedAt: 3_000, inputTokens: 1, outputTokens: 2 });
		} finally { widget.dispose(); }
	}));
});

describe("session-targeted task helpers", () => {
	it("close their temporary stores", () => {
		const dir = mkdtempSync(join(tmpdir(), "pitasks-session-store-"));
		const originalClose = TaskStore.prototype.close;
		let closeCount = 0;
		TaskStore.prototype.close = function () { closeCount++; return originalClose.call(this); };
		try {
			const task = createTaskForSession("session", "Task", "body", createdBy, undefined, dir);
			createTasksForSession("session", [{ subject: "Task two", description: "body", createdBy }], dir);
			getTaskForSession("session", task.id, dir);
			listTasksForSession("session", dir);
			updateTaskForSession("session", task.id, { status: "in_progress" }, dir);
			updateTasksForSession("session", [{ id: task.id, fields: { status: "completed" } }], dir);
			deleteTaskForSession("session", task.id, dir);
			assert.equal(closeCount, 7);
		} finally {
			TaskStore.prototype.close = originalClose;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("pitasks telemetry bridge", () => {
	it("forwards activation and deactivation to the current widget", () => {
		const child = process.env.PI_SUBAGENT_CHILD;
		delete process.env.PI_SUBAGENT_CHILD;
		try {
			const handlers = new Map<string, Function>();
			const api = { on(name: string, handler: Function) { handlers.set(name, handler); }, registerTool() {}, registerCommand() {}, events: { on() { return () => {}; }, emit() {} } };
			pitasks(api as any);
			const ui = { setWidget() {} };
			return Promise.resolve(handlers.get("session_start")!({ reason: "new" }, { ui, sessionManager: { getSessionId: () => "widget-test" } })).then(() => {
				const task = taskStore.create("Bridge", "body", createdBy);
				taskStore.update(task.id, { status: "in_progress" });
				setTaskTelemetryActive(task.id); setTaskTelemetryActive(task.id, false);
				assert.ok(taskStore.get(task.id)?.telemetry?.endedAt);
				handlers.get("session_shutdown")!();
			});
		} finally {
			if (child === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = child;
		}
	});
});
