import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

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
import { registerTaskTools } from "../../../extensions/pitasks/task-tools.js";
import { TaskWidget } from "../../../extensions/pitasks/task-widget.js";
import { setLogLevelPin } from "../../../extensions/shared/file-logger.js";
import {
	publishedTaskStore,
	publishedTaskTelemetryActive,
	resetSessionBridge,
} from "../../../extensions/shared/session-bridge.js";
import { makeTempDir } from "../helpers/temp-dirs.js";


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

	it("does not register after disposal", () => {
		const store = new TaskStore();
		const widget = new TaskWidget(store);
		let registrations = 0;
		try {
			widget.setUICtx({ setWidget(_name: string, value: any) { if (value) registrations++; } });
			store.create("Task", "body", createdBy);
			widget.update();
			widget.dispose();
			widget.update();
			assert.equal(registrations, 1);
		} finally { widget.dispose(); }
	});
});

describe("TaskWidget telemetry lifecycle", () => {
	it("does not attribute a turn to restored in-progress tasks", () => {
		const dir = makeTempDir("pitasks-");
		const path = join(dir, "tasks.json");
		const originalNow = Date.now;
		let store: TaskStore | undefined;
		let reloaded: TaskStore | undefined;
		let widget: TaskWidget | undefined;
		try {
			Date.now = () => 1_000;
			store = new TaskStore(path);
			const first = store.create("First", "body", createdBy);
			const second = store.create("Second", "body", createdBy);
			store.updateTasks([{ id: first.id, fields: { status: "in_progress" } }, { id: second.id, fields: { status: "in_progress" } }]);
			store.close();
			reloaded = new TaskStore(path);
			widget = new TaskWidget(reloaded);
			widget.addTokenUsage(7, 11);
			assert.deepEqual(reloaded.get(first.id)?.telemetry, { startedAt: reloaded.get(first.id)?.telemetry?.startedAt, inputTokens: 0, outputTokens: 0 });
			assert.deepEqual(reloaded.get(second.id)?.telemetry, { startedAt: reloaded.get(second.id)?.telemetry?.startedAt, inputTokens: 0, outputTokens: 0 });
		} finally {
			Date.now = originalNow;
			widget?.dispose();
			reloaded?.close();
			store?.close();
			rmSync(dir, { recursive: true, force: true });
		}
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
	it("release file watchers", () => {
		const dir = makeTempDir("pitasks-session-store-");
		try {
			const script = `import { createTaskForSession, createTasksForSession, deleteTaskForSession, getTaskForSession, listTasksForSession, updateTaskForSession, updateTasksForSession } from './extensions/pitasks/index.js'; const dir = process.argv[1]; const by = { type: 'local', origin: 'system', session: '', project: '' }; const task = createTaskForSession('session', 'Task', 'body', by, undefined, dir); createTasksForSession('session', [{ subject: 'Task two', description: 'body', createdBy: by }], dir); getTaskForSession('session', task.id, dir); listTasksForSession('session', dir); updateTaskForSession('session', task.id, { status: 'in_progress' }, dir); updateTasksForSession('session', [{ id: task.id, fields: { status: 'completed' } }], dir); deleteTaskForSession('session', task.id, dir);`;
			// 20 s, not 5: this spawns a tsx child, and under the pre-commit hook the node suite
      // runs beside typecheck and the sidecar suite — tsx startup crossed 5 s and spawnSync
      // killed the child with SIGTERM, which is what `signal === null` reports. A real
      // watcher leak never exits, so a longer budget does not weaken the assertion.
      const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script, dir], { cwd: process.cwd(), timeout: 20_000 });
			assert.equal(result.signal, null, result.stderr.toString());
			assert.equal(result.status, 0, result.stderr.toString());
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});

describe("pitasks telemetry bridge", () => {
	it("forwards activation to the current widget", async () => {
		const child = process.env.PI_SUBAGENT_CHILD;
		const handlers = new Map<string, Function>();
		delete process.env.PI_SUBAGENT_CHILD;
		try {
			const api = { on(name: string, handler: Function) { handlers.set(name, handler); }, registerTool() {}, registerCommand() {}, events: { on() { return () => {}; }, emit() {} } };
			pitasks(api as any);
			await handlers.get("session_start")!({ reason: "new" }, { ui: { setWidget() {} }, sessionManager: { getSessionId: () => "widget-test" } });
			const task = taskStore.create("Bridge", "body", createdBy);
			taskStore.update(task.id, { status: "in_progress" });
			setTaskTelemetryActive(task.id);
			assert.ok(taskStore.get(task.id)?.telemetry);
		} finally {
			handlers.get("session_shutdown")?.();
			if (child === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = child;
		}
	});

	it("refreshes the resumed widget after an external file update", async () => {
		const child = process.env.PI_SUBAGENT_CHILD;
		const dir = makeTempDir("pitasks-resume-watch-");
		const taskPath = join(dir, "tasks.json");
		const piTasks = process.env.PI_TASKS;
		const handlers = new Map<string, Function>();
		let renders = 0;
		delete process.env.PI_SUBAGENT_CHILD;
		process.env.PI_TASKS = taskPath;
		try {
			const api = { on(name: string, handler: Function) { handlers.set(name, handler); }, registerTool() {}, registerCommand() {}, events: { on() { return () => {}; }, emit() {} } };
			pitasks(api as any);
			const context = { ui: { setWidget(_name: string, value: any) { if (value) value({ terminal: { columns: 200 }, requestRender() { renders++; } }, theme); } }, sessionManager: { getSessionId: () => "widget-test" } };
			await handlers.get("session_start")!({ reason: "startup" }, context);
			taskStore.create("Resume", "body", createdBy);
			await handlers.get("tool_execution_start")!({}, context);
			handlers.get("session_shutdown")!();
			await handlers.get("session_start")!({ reason: "resume" }, context);
			const baseline = renders;
			const external = new TaskStore(taskPath);
			external.create("External", "body", createdBy);
			external.close();
			const deadline = performance.now() + 100;
			while (renders <= baseline && performance.now() < deadline) {
				await new Promise(resolve => setTimeout(resolve, 5));
			}
			assert.ok(renders > baseline, `external update should request a resumed widget render within 100ms: expected > ${baseline}, observed ${renders}`);
		} finally {
			handlers.get("session_shutdown")?.();
			if (piTasks === undefined) delete process.env.PI_TASKS;
			else process.env.PI_TASKS = piTasks;
			if (child === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = child;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("attributes a resumed turn only to the task active before shutdown", async () => {
		const child = process.env.PI_SUBAGENT_CHILD;
		const dir = makeTempDir("pitasks-resume-telemetry-");
		const taskPath = join(dir, "tasks.json");
		const piTasks = process.env.PI_TASKS;
		const handlers = new Map<string, Function>();
		delete process.env.PI_SUBAGENT_CHILD;
		process.env.PI_TASKS = taskPath;
		try {
			const api = { on(name: string, handler: Function) { handlers.set(name, handler); }, registerTool() {}, registerCommand() {}, events: { on() { return () => {}; }, emit() {} } };
			pitasks(api as any);
			const context = { ui: { setWidget() {} }, sessionManager: { getSessionId: () => "widget-test" } };
			await handlers.get("session_start")!({ reason: "startup" }, context);
			const active = taskStore.create("Active", "body", createdBy);
			const other = taskStore.create("Other", "body", createdBy);
			taskStore.updateTasks([{ id: active.id, fields: { status: "in_progress" } }, { id: other.id, fields: { status: "in_progress" } }]);
			setTaskTelemetryActive(active.id);
			handlers.get("session_shutdown")!();
			await handlers.get("session_start")!({ reason: "resume" }, context);
			await handlers.get("turn_end")!({ message: { role: "assistant", usage: { input: 7, output: 11 } } });
			assert.deepEqual(taskStore.get(active.id)?.telemetry?.inputTokens, 7);
			assert.deepEqual(taskStore.get(other.id)?.telemetry?.inputTokens, 0);
		} finally {
			handlers.get("session_shutdown")?.();
			if (piTasks === undefined) delete process.env.PI_TASKS;
			else process.env.PI_TASKS = piTasks;
			if (child === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = child;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves only explicitly active telemetry across extension reload", async () => {
		const child = process.env.PI_SUBAGENT_CHILD;
		const dir = makeTempDir("pitasks-reload-telemetry-");
		const taskPath = join(dir, "tasks.json");
		const piTasks = process.env.PI_TASKS;
		const first = new Map<string, Function>();
		const second = new Map<string, Function>();
		delete process.env.PI_SUBAGENT_CHILD;
		process.env.PI_TASKS = taskPath;
		try {
			const makeApi = (handlers: Map<string, Function>) => ({ on(name: string, handler: Function) { handlers.set(name, handler); }, registerTool() {}, registerCommand() {}, events: { on() { return () => {}; }, emit() {} } });
			const context = { ui: { setWidget() {} }, sessionManager: { getSessionId: () => "widget-test" } };
			pitasks(makeApi(first) as any);
			await first.get("session_start")!({ reason: "startup" }, context);
			const active = taskStore.create("Active", "body", createdBy);
			const other = taskStore.create("Other", "body", createdBy);
			taskStore.updateTasks([{ id: active.id, fields: { status: "in_progress" } }, { id: other.id, fields: { status: "in_progress" } }]);
			setTaskTelemetryActive(active.id);
			pitasks(makeApi(second) as any);
			await second.get("session_start")!({ reason: "reload" }, context);
			await second.get("turn_end")!({ message: { role: "assistant", usage: { input: 7, output: 11 } } });
			assert.equal(taskStore.get(active.id)?.telemetry?.inputTokens, 7);
			assert.equal(taskStore.get(other.id)?.telemetry?.inputTokens, 0);
		} finally {
			second.get("session_shutdown")?.();
			if (piTasks === undefined) delete process.env.PI_TASKS;
			else process.env.PI_TASKS = piTasks;
			if (child === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = child;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reactivates its widget after shutdown and resume", async () => {
		const child = process.env.PI_SUBAGENT_CHILD;
		const dir = makeTempDir("pitasks-resume-");
		const taskPath = join(dir, "tasks.json");
		const piTasks = process.env.PI_TASKS;
		const handlers = new Map<string, Function>();
		let registrations = 0;
		delete process.env.PI_SUBAGENT_CHILD;
		process.env.PI_TASKS = taskPath;
		try {
			const api = { on(name: string, handler: Function) { handlers.set(name, handler); }, registerTool() {}, registerCommand() {}, events: { on() { return () => {}; }, emit() {} } };
			pitasks(api as any);
			const context = { ui: { setWidget(_name: string, value: any) { if (value) registrations++; } }, sessionManager: { getSessionId: () => "widget-test" } };
			await handlers.get("session_start")!({ reason: "startup" }, context);
			taskStore.create("Resume", "body", createdBy);
			await handlers.get("tool_execution_start")!({}, context);
			handlers.get("session_shutdown")!();
			await handlers.get("session_start")!({ reason: "resume" }, context);
			assert.equal(registrations, 2);
		} finally {
			handlers.get("session_shutdown")?.();
			if (piTasks === undefined) delete process.env.PI_TASKS;
			else process.env.PI_TASKS = piTasks;
			if (child === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = child;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("forwards deactivation to the current widget", async () => {
		const child = process.env.PI_SUBAGENT_CHILD;
		const handlers = new Map<string, Function>();
		delete process.env.PI_SUBAGENT_CHILD;
		try {
			const api = { on(name: string, handler: Function) { handlers.set(name, handler); }, registerTool() {}, registerCommand() {}, events: { on() { return () => {}; }, emit() {} } };
			pitasks(api as any);
			await handlers.get("session_start")!({ reason: "new" }, { ui: { setWidget() {} }, sessionManager: { getSessionId: () => "widget-test" } });
			const task = taskStore.create("Bridge", "body", createdBy);
			taskStore.update(task.id, { status: "in_progress", telemetry: { startedAt: Date.now(), inputTokens: 0, outputTokens: 0 } });
			setTaskTelemetryActive(task.id, false);
			assert.ok(taskStore.get(task.id)?.telemetry?.endedAt);
		} finally {
			handlers.get("session_shutdown")?.();
			resetSessionBridge({ all: true });
			if (child === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = child;
		}
	});

	it("forwards activation from an uninitialized pitasks module instance over the global bridge", async () => {
		const child = process.env.PI_SUBAGENT_CHILD;
		const dir = makeTempDir("pitasks-cross-instance-");
		const taskPath = join(dir, "tasks.json");
		const piTasks = process.env.PI_TASKS;
		const handlers = new Map<string, Function>();
		delete process.env.PI_SUBAGENT_CHILD;
		process.env.PI_TASKS = taskPath;
		try {
			const api = { on(name: string, handler: Function) { handlers.set(name, handler); }, registerTool() {}, registerCommand() {}, events: { on() { return () => {}; }, emit() {} } };
			pitasks(api as any);
			await handlers.get("session_start")!({ reason: "startup" }, { ui: { setWidget() {} }, sessionManager: { getSessionId: () => "widget-test" } });
			const task = taskStore.create("Delegated", "body", createdBy);
			taskStore.update(task.id, { status: "in_progress" });
			// The query string busts the module cache to get a second instance; tsc cannot resolve
			// a specifier that carries one, so keep it in a variable and re-assert the module type.
			const isolatedPath = "../../../extensions/pitasks/index.js?isolated-bridge-instance=1";
			const isolatedInstance: typeof import("../../../extensions/pitasks/index.js") = await import(isolatedPath);
			assert.equal(isolatedInstance.taskStore, undefined);
			isolatedInstance.setTaskTelemetryActive(task.id, true, "widget-test");
			await handlers.get("turn_end")!({ message: { role: "assistant", usage: { input: 13, output: 29 } } });
			assert.equal(taskStore.get(task.id)?.telemetry?.inputTokens, 13);
			assert.equal(taskStore.get(task.id)?.telemetry?.outputTokens, 29);
		} finally {
			handlers.get("session_shutdown")?.();
			resetSessionBridge({ all: true });
			if (piTasks === undefined) delete process.env.PI_TASKS;
			else process.env.PI_TASKS = piTasks;
			if (child === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = child;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rekeys task bridges on before_agent_start when a watched session switches", async () => {
		const child = process.env.PI_SUBAGENT_CHILD;
		const piTasks = process.env.PI_TASKS;
		const handlers = new Map<string, Function>();
		delete process.env.PI_SUBAGENT_CHILD;
		process.env.PI_TASKS = "off";
		try {
			const api = { on(name: string, handler: Function) { handlers.set(name, handler); }, registerTool() {}, registerCommand() {}, events: { on() { return () => {}; }, emit() {} } };
			pitasks(api as any);
			await handlers.get("session_start")!({ reason: "startup" }, { ui: { setWidget() {} }, sessionManager: { getSessionId: () => "sess-old" } });
			assert.ok(publishedTaskStore("sess-old"));
			assert.ok(publishedTaskTelemetryActive("sess-old"));

			await handlers.get("before_agent_start")!({}, { ui: { setWidget() {} }, sessionManager: { getSessionId: () => "sess-switched" } });
			assert.equal(publishedTaskStore("sess-old"), null);
			assert.equal(publishedTaskTelemetryActive("sess-old"), null);
			assert.ok(publishedTaskStore("sess-switched"));
			assert.ok(publishedTaskTelemetryActive("sess-switched"));
		} finally {
			handlers.get("session_shutdown")?.();
			resetSessionBridge({ all: true });
			if (piTasks === undefined) delete process.env.PI_TASKS;
			else process.env.PI_TASKS = piTasks;
			if (child === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = child;
		}
	});

	it("never routes session-keyed telemetry into another session's currentWidget", async () => {
		const child = process.env.PI_SUBAGENT_CHILD;
		const piTasks = process.env.PI_TASKS;
		const handlersB = new Map<string, Function>();
		delete process.env.PI_SUBAGENT_CHILD;
		process.env.PI_TASKS = "off";
		try {
			const apiB = { on(name: string, handler: Function) { handlersB.set(name, handler); }, registerTool() {}, registerCommand() {}, events: { on() { return () => {}; }, emit() {} } };
			pitasks(apiB as any);
			await handlersB.get("session_start")!({ reason: "startup" }, { ui: { setWidget() {} }, sessionManager: { getSessionId: () => "sess-b" } });
			const taskB = taskStore.create("Session B task", "body", createdBy);
			taskStore.update(taskB.id, { status: "in_progress" });

			// Session A has no published telemetry callback; calling with "sess-a" must NOT activate Session B's widget.
			setTaskTelemetryActive(taskB.id, true, "sess-a");
			await handlersB.get("turn_end")!({ message: { role: "assistant", usage: { input: 17, output: 23 } } });
			assert.equal(taskStore.get(taskB.id)?.telemetry?.inputTokens ?? 0, 0);
			assert.equal(taskStore.get(taskB.id)?.telemetry?.outputTokens ?? 0, 0);
		} finally {
			handlersB.get("session_shutdown")?.();
			resetSessionBridge({ all: true });
			if (piTasks === undefined) delete process.env.PI_TASKS;
			else process.env.PI_TASKS = piTasks;
			if (child === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = child;
		}
	});
});

describe("TaskWidget single-snapshot ticks (#1162)", () => {
	it("renders active tasks with blocker annotations across update ticks", () => {
		const store = new TaskStore();
		const widget = new TaskWidget(store);
		try {
			const t1 = store.create("Blocker", "b", createdBy);
			const t2 = store.create("Active", "a", createdBy);
			const t3 = store.create("Blocked", "c", createdBy);
			store.update(t2.id, { status: "in_progress" });
			store.update(t3.id, { addBlockedBy: [t1.id] });
			widget.setActiveTask(t2.id);

			let renderFn: (() => string[]) | undefined;
			let rendersRequested = 0;
			widget.setUICtx({
				setWidget(_name: string, value: any) {
					if (value) renderFn = value({ terminal: { columns: 120 }, requestRender() { rendersRequested++; } }, theme).render;
				},
			});
			widget.update();
			assert.ok(renderFn);

			widget.update();
			assert.equal(rendersRequested, 1);
			const lines = renderFn();
			assert.ok(lines.some(l => l.includes("Active")));
			assert.ok(lines.some(l => l.includes("blocked by #1")));
		} finally {
			widget.dispose();
		}
	});
});

describe("WT-13 pitasks optimizations", () => {
	it("TaskWidget.update() calls store.list() only once per update when debug logging is off", () => {
		const store = new TaskStore();
		store.create("Task one", "body", createdBy);
		let listCalls = 0;
		const origList = store.list.bind(store);
		store.list = () => {
			listCalls++;
			return origList();
		};
		setLogLevelPin("pitasks", "info");
		const widget = new TaskWidget(store);
		try {
			assert.equal(listCalls, 0, "constructor should not call store.list() when debug is off");
			widget.setUICtx({ setWidget() {} });
			widget.update();
			assert.equal(listCalls, 1, "first update() should call store.list() once");
			widget.update();
			assert.equal(listCalls, 2, "second update() should call store.list() once");
		} finally {
			widget.dispose();
			setLogLevelPin("pitasks", null);
		}
	});

	it("TaskList orders tasks via selectTaskRows and formats open blockers cleanly", async () => {
		const store = new TaskStore();
		const widget = new TaskWidget(store);
		const tools = new Map<string, any>();
		const fakePi = { registerTool: (tool: any) => { tools.set(tool.name, tool); } };
		try {
			registerTaskTools(fakePi as any, () => store, widget);
			const taskListTool = tools.get("TaskList");
			assert.ok(taskListTool, "TaskList should be registered");

			const t1 = store.create("Done blocker", "b1", createdBy);
			store.update(t1.id, { status: "completed" });
			const t2 = store.create("Open blocker", "b2", createdBy);
			const t3 = store.create("Blocked llm task", "b3", createdBy);
			store.update(t3.id, { addBlockedBy: [t1.id, t2.id] });
			const t4 = store.create("User pending task", "b4", createdBy, undefined, undefined, "user");
			store.update(t4.id, { owner: "alice" });
			const t5 = store.create("Active llm task", "b5", createdBy);
			store.update(t5.id, { status: "in_progress" });

			const result = await taskListTool.execute("call-1", {});
			const lines = (result.content[0].text as string).split("\n");
			assert.deepEqual(
				lines.map((l) => l.split(" ")[0]),
				[`#${t4.id}`, `#${t2.id}`, `#${t3.id}`, `#${t5.id}`, `#${t1.id}`],
			);
			assert.equal(lines[0], `#${t4.id} [pending] [you] User pending task (alice)`);
			assert.equal(lines[2], `#${t3.id} [pending] [llm] Blocked llm task [blocked by #${t2.id}]`);
		} finally {
			widget.dispose();
		}
	});
});
