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
import { visibleWidth } from "@earendil-works/pi-tui";
import { TaskStore } from "../../../extensions/pitasks/task-store.js";
import { registerTaskTools } from "../../../extensions/pitasks/task-tools.js";
import {
	TaskWidget,
	formatBoundAgentsBadge,
	type BoundAsyncAgent,
} from "../../../extensions/pitasks/task-widget.js";
import { setLogLevelPin } from "../../../extensions/shared/file-logger.js";
import {
	publishWorkloadSources,
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

describe("formatBoundAgentsBadge (#1386)", () => {
	it("returns empty string for zero agents", () => {
		assert.equal(formatBoundAgentsBadge([]), "");
		assert.equal(formatBoundAgentsBadge(undefined), "");
	});

	it("formats a single unnamed agent as [⏳ <agent>]", () => {
		assert.equal(formatBoundAgentsBadge([{ agent: "python-expert" }]), "[⏳ python-expert]");
	});

	it("omits duplicate name when name matches agent type", () => {
		assert.equal(
			formatBoundAgentsBadge([{ agent: "ts-expert", name: "ts-expert" }]),
			"[⏳ ts-expert]",
		);
	});

	it("formats a single named agent as [⏳ <agent> · <name>]", () => {
		assert.equal(
			formatBoundAgentsBadge([{ agent: "python-expert", name: "Fix pytest" }]),
			"[⏳ python-expert · Fix pytest]",
		);
	});

	it("sanitizes control characters and truncates long display names", () => {
		const badge = formatBoundAgentsBadge([
			{ agent: "worker", name: "\x1b[31mReview\n\tvery long agent display name exceeding limit\x1b[0m" },
		]);
		assert.doesNotMatch(badge, /[\x00-\x1f\x7f]/);
		assert.equal(badge, "[⏳ worker · Review very long agent…]");
	});

	it("formats multiple same-type agents as [⏳ <agent> ×<N>]", () => {
		assert.equal(
			formatBoundAgentsBadge([
				{ agent: "code-reviewer-quality", name: "Round 1" },
				{ agent: "code-reviewer-quality", name: "Round 2" },
				{ agent: "code-reviewer-quality", name: "Round 3" },
			]),
			"[⏳ code-reviewer-quality ×3]",
		);
	});

	it("formats mixed multi-type agents as [⏳ <N> agents: <a1>, <a2>]", () => {
		assert.equal(
			formatBoundAgentsBadge([
				{ agent: "python-expert" },
				{ agent: "ts-expert" },
			]),
			"[⏳ 2 agents: python-expert, ts-expert]",
		);
		assert.equal(
			formatBoundAgentsBadge([
				{ agent: "python-expert" },
				{ agent: "ts-expert" },
				{ agent: "test-runner" },
			]),
			"[⏳ 3 agents: python-expert, ts-expert, +1]",
		);
	});
});

describe("TaskWidget bound live async agent badge (#1386)", () => {
	function renderWithWidth(widget: TaskWidget, columns: number): () => string[] {
		let render: (() => string[]) | undefined;
		widget.setUICtx({
			setWidget(_name: string, value: any) {
				if (value) render = value({ terminal: { columns }, requestRender() {} }, theme).render;
			},
		});
		widget.update();
		assert.ok(render);
		return render;
	}

	it("renders a single bound running agent on an in_progress task and supersedes metadata.agentId", () => {
		const store = new TaskStore();
		const task = store.create("Build badge", "body", createdBy, undefined, { agentId: "abcde12345" });
		store.update(task.id, { status: "in_progress" });
		const agents: BoundAsyncAgent[] = [
			{ id: "job-1", agent: "ts-expert", status: "running", taskId: task.id },
		];
		const widget = new TaskWidget(store, {}, () => agents);
		try {
			const line = renderWithWidth(widget, 200)().find(l => l.includes(`#${task.id}`));
			assert.ok(line);
			assert.match(line, /\[⏳ ts-expert\]/);
			assert.doesNotMatch(line, /\(agent abcde\)/);
		} finally {
			widget.dispose();
		}
	});

	it("keeps task.metadata.agentId fallback when no live bound agent exists", () => {
		const store = new TaskStore();
		const task = store.create("Fallback task", "body", createdBy, undefined, { agentId: "abcde12345" });
		store.update(task.id, { status: "in_progress" });
		const widget = new TaskWidget(store, {}, () => []);
		try {
			const line = renderWithWidth(widget, 200)().find(l => l.includes(`#${task.id}`));
			assert.ok(line);
			assert.match(line, /\(agent abcde\)/);
			assert.doesNotMatch(line, /\[⏳/);
		} finally {
			widget.dispose();
		}
	});

	it("renders a named queued agent badge on a pending task row", () => {
		const store = new TaskStore();
		const task = store.create("Pending work", "body", createdBy);
		const widget = new TaskWidget(store, {}, () => [
			{ id: "job-2", agent: "python-expert", name: "Run pytest", status: "queued", taskId: task.id },
		]);
		try {
			const line = renderWithWidth(widget, 200)().find(l => l.includes(`#${task.id}`));
			assert.ok(line);
			assert.match(line, /\[⏳ python-expert · Run pytest\]/);
		} finally {
			widget.dispose();
		}
	});

	it("renders same-type multi-agent badge on a task row", () => {
		const store = new TaskStore();
		const task = store.create("Parallel checks", "body", createdBy);
		store.update(task.id, { status: "in_progress" });
		const widget = new TaskWidget(store, {}, () => [
			{ id: "job-1", agent: "test-runner", status: "running", taskId: task.id },
			{ id: "job-2", agent: "test-runner", status: "running", taskId: task.id },
		]);
		try {
			const line = renderWithWidth(widget, 200)().find(l => l.includes(`#${task.id}`));
			assert.ok(line);
			assert.match(line, /\[⏳ test-runner ×2\]/);
		} finally {
			widget.dispose();
		}
	});

	it("renders mixed multi-agent badge on a task row", () => {
		const store = new TaskStore();
		const task = store.create("Review PR", "body", createdBy);
		store.update(task.id, { status: "in_progress" });
		const widget = new TaskWidget(store, {}, () => [
			{ id: "job-1", agent: "code-reviewer-quality", status: "running", taskId: task.id },
			{ id: "job-2", agent: "code-reviewer-security", status: "running", taskId: task.id },
		]);
		try {
			const line = renderWithWidth(widget, 200)().find(l => l.includes(`#${task.id}`));
			assert.ok(line);
			assert.match(line, /\[⏳ 2 agents: code-reviewer-quality, code-reviewer-security\]/);
		} finally {
			widget.dispose();
		}
	});

	it("hides the bound agent badge on completed tasks", () => {
		const store = new TaskStore();
		const task = store.create("Done work", "body", createdBy);
		store.update(task.id, { status: "completed" });
		const widget = new TaskWidget(store, {}, () => [
			{ id: "job-1", agent: "ts-expert", name: "Still draining", status: "running", taskId: task.id },
		]);
		try {
			const line = renderWithWidth(widget, 200)().find(l => l.includes(`#${task.id}`));
			assert.ok(line);
			assert.doesNotMatch(line, /\[⏳/);
		} finally {
			widget.dispose();
		}
	});

	it("clears the badge and stops the timer once a bound agent finishes", () => {
		const store = new TaskStore();
		const task = store.create("Queued work", "body", createdBy);
		const agents: BoundAsyncAgent[] = [
			{ id: "job-1", agent: "ts-expert", status: "running", taskId: task.id },
		];
		const widget = new TaskWidget(store, {}, () => agents);
		try {
			const render = renderWithWidth(widget, 200);
			assert.equal(widget.hasActiveTimer(), true, "timer should stay active while visible pending task has live bound agent");
			assert.match(render().join("\n"), /\[⏳ ts-expert\]/);

			agents[0] = { ...agents[0], status: "complete" };
			widget.update();
			assert.equal(widget.hasActiveTimer(), false, "timer should stop once bound agent finishes");
			assert.doesNotMatch(render().join("\n"), /\[⏳/);
		} finally {
			widget.dispose();
		}
	});

	it("truncates task lines with badges to terminal column width", () => {
		const store = new TaskStore();
		const task = store.create("Implement bound live async agent badge in widget", "body", createdBy);
		store.update(task.id, { status: "in_progress" });
		const widget = new TaskWidget(store, {}, () => [
			{ id: "job-1", agent: "ts-expert", name: "Detailed implementation", status: "running", taskId: task.id },
		]);
		try {
			const width = 45;
			const lines = renderWithWidth(widget, width)();
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= width, `expected visible width <= ${width}, got ${visibleWidth(line)}: ${line}`);
			}
		} finally {
			widget.dispose();
		}
	});

	it("ignores unlinked async agents with taskId '-1' or missing taskId", () => {
		const store = new TaskStore();
		const task = store.create("Unbound task", "body", createdBy);
		store.update(task.id, { status: "in_progress" });
		const widget = new TaskWidget(store, {}, () => [
			{ id: "job-1", agent: "worker", status: "running", taskId: "-1" },
			{ id: "job-2", agent: "scout", status: "running" },
		]);
		try {
			const line = renderWithWidth(widget, 200)().find(l => l.includes(`#${task.id}`));
			assert.ok(line);
			assert.doesNotMatch(line, /\[⏳/);
		} finally {
			widget.dispose();
		}
	});

	it("refreshes the tasks widget via publishedWorkloadSources on pidash:async-status and cleans up on shutdown", async () => {
		const child = process.env.PI_SUBAGENT_CHILD;
		const piTasks = process.env.PI_TASKS;
		const handlers = new Map<string, Function>();
		const eventListeners = new Map<string, Set<Function>>();
		let renderFn: (() => string[]) | undefined;
		let renders = 0;
		delete process.env.PI_SUBAGENT_CHILD;
		process.env.PI_TASKS = "off";
		let agents: any[] = [];
		const unregisterWorkload = publishWorkloadSources(
			{ agents: () => agents, crons: () => [] },
			"badge-live-session",
		);
		try {
			const api = {
				on(name: string, handler: Function) { handlers.set(name, handler); },
				registerTool() {},
				registerCommand() {},
				events: {
					on(name: string, handler: Function) {
						let set = eventListeners.get(name);
						if (!set) { set = new Set(); eventListeners.set(name, set); }
						set.add(handler);
						return () => { set!.delete(handler); };
					},
					emit(name: string, payload?: unknown) {
						for (const fn of eventListeners.get(name) ?? []) fn(payload);
					},
				},
			};
			pitasks(api as any);
			const context = {
				ui: {
					setWidget(_name: string, value: any) {
						if (value) {
							renderFn = value({ terminal: { columns: 200 }, requestRender() { renders++; } }, theme).render;
						}
					},
				},
				sessionManager: { getSessionId: () => "badge-live-session" },
			};
			await handlers.get("session_start")!({ reason: "startup" }, context);
			const task = taskStore.create("Live bridged task", "body", createdBy);
			assert.ok(renderFn);
			assert.doesNotMatch(renderFn().join("\n"), /\[⏳/);

			const beforeEmit = renders;
			agents = [{ id: "j1", agent: "ts-expert", name: "Wire badge", task: "t", status: "running", startedAt: Date.now(), taskId: task.id }];
			api.events.emit("pidash:async-status", { count: 1 });
			assert.ok(renders > beforeEmit, "pidash:async-status should trigger widget re-render");
			assert.match(renderFn().join("\n"), /\[⏳ ts-expert · Wire badge\]/);

			agents = [{ id: "j1", agent: "ts-expert", name: "Wire badge", task: "t", status: "complete", startedAt: Date.now(), taskId: task.id }];
			api.events.emit("pidash:async-status", { count: 0 });
			assert.doesNotMatch(renderFn().join("\n"), /\[⏳/);

			handlers.get("session_shutdown")!();
			assert.equal(eventListeners.get("pidash:async-status")?.size ?? 0, 0, "shutdown should unsubscribe pidash:async-status listener");
		} finally {
			unregisterWorkload();
			handlers.get("session_shutdown")?.();
			resetSessionBridge({ all: true });
			if (piTasks === undefined) delete process.env.PI_TASKS;
			else process.env.PI_TASKS = piTasks;
			if (child === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = child;
		}
	});
});
