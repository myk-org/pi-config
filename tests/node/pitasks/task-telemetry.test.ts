/**
 * #1026 — per-turn token telemetry attribution by tool-call task references.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";

import pitasks, {
	setTaskTelemetryActive,
	taskStore,
} from "../../../extensions/pitasks/index.js";
import { TaskStore } from "../../../extensions/pitasks/task-store.js";
import { TaskWidget } from "../../../extensions/pitasks/task-widget.js";
import { makeTempDir } from "../helpers/temp-dirs.js";
import { useSupportedPiVersion } from "../helpers/pi-version-env.js";

useSupportedPiVersion();

const createdBy = { type: "local" as const, origin: "system", session: "", project: "" };

function sumTokens(store: TaskStore): { input: number; output: number } {
	let input = 0;
	let output = 0;
	for (const t of store.list()) {
		input += t.telemetry?.inputTokens ?? 0;
		output += t.telemetry?.outputTokens ?? 0;
	}
	return { input, output };
}

function bootTelemetryHarness() {
	const dir = makeTempDir("pitasks-telemetry-");
	const taskPath = join(dir, "tasks.json");
	const prevChild = process.env.PI_SUBAGENT_CHILD;
	const prevPiTasks = process.env.PI_TASKS;
	delete process.env.PI_SUBAGENT_CHILD;
	process.env.PI_TASKS = taskPath;

	const handlers = new Map<string, Function>();
	const tools = new Map<string, any>();
	const api = {
		on(name: string, handler: Function) {
			handlers.set(name, handler);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		events: { on() { return () => {}; }, emit() {} },
	};
	pitasks(api as any);
	const ctx = {
		ui: { setWidget() {} },
		sessionManager: { getSessionId: () => "telemetry-test" },
	};

	const startInProgress = (subject: string) => {
		const task = taskStore.create(subject, "body", createdBy);
		taskStore.update(task.id, { status: "in_progress" });
		setTaskTelemetryActive(task.id, true);
		return task;
	};

	return {
		ctx,
		startInProgress,
		async sessionStart(reason = "startup") {
			await handlers.get("session_start")!({ reason }, ctx);
		},
		async turnStart() {
			await handlers.get("turn_start")!({}, ctx);
		},
		async toolStart(toolName: string, args: Record<string, unknown>) {
			await handlers.get("tool_execution_start")!({
				type: "tool_execution_start",
				toolCallId: `call-${toolName}`,
				toolName,
				args,
			}, ctx);
		},
		async runTool(toolName: string, args: Record<string, unknown>) {
			const toolCallId = `call-${toolName}`;
			await handlers.get("tool_execution_start")!({
				type: "tool_execution_start",
				toolCallId,
				toolName,
				args,
			}, ctx);
			return tools.get(toolName)!.execute(toolCallId, args);
		},
		async turnEnd(input: number, output: number) {
			await handlers.get("turn_end")!({
				message: { role: "assistant", usage: { input, output } },
			});
		},
		async agentSettled() {
			await handlers.get("agent_settled")!();
		},
		cleanup() {
			handlers.get("session_shutdown")?.();
			if (prevPiTasks === undefined) delete process.env.PI_TASKS;
			else process.env.PI_TASKS = prevPiTasks;
			if (prevChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = prevChild;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("#1026 per-turn task token attribution", () => {
	it("credits the whole turn when tool execution names one in-progress task", async () => {
		const h = bootTelemetryHarness();
		try {
			await h.sessionStart();
			const t1 = h.startInProgress("Task 1");
			const t2 = h.startInProgress("Task 2");
			const t3 = h.startInProgress("Task 3");

			await h.turnStart();
			await h.toolStart("TaskUpdate", { taskId: t2.id, activeForm: "Working" });
			await h.turnEnd(90, 30);

			assert.equal(taskStore.get(t1.id)?.telemetry?.inputTokens, 0);
			assert.equal(taskStore.get(t1.id)?.telemetry?.outputTokens, 0);
			assert.equal(taskStore.get(t2.id)?.telemetry?.inputTokens, 90);
			assert.equal(taskStore.get(t2.id)?.telemetry?.outputTokens, 30);
			assert.equal(taskStore.get(t3.id)?.telemetry?.inputTokens, 0);
			assert.equal(taskStore.get(t3.id)?.telemetry?.outputTokens, 0);
			assert.deepEqual(sumTokens(taskStore), { input: 90, output: 30 });
		} finally {
			h.cleanup();
		}
	});

	it("splits usage across two named in-progress tasks while leaving the third untouched", async () => {
		const h = bootTelemetryHarness();
		try {
			await h.sessionStart();
			const t1 = h.startInProgress("Task 1");
			const t2 = h.startInProgress("Task 2");
			const t3 = h.startInProgress("Task 3");

			await h.turnStart();
			await h.toolStart("TaskGet", { taskId: t1.id });
			await h.toolStart("subagent", { agent: "worker", task: "run", taskId: t3.id });
			await h.turnEnd(101, 51);

			assert.equal(taskStore.get(t1.id)?.telemetry?.inputTokens, 51);
			assert.equal(taskStore.get(t1.id)?.telemetry?.outputTokens, 26);
			assert.equal(taskStore.get(t2.id)?.telemetry?.inputTokens, 0);
			assert.equal(taskStore.get(t2.id)?.telemetry?.outputTokens, 0);
			assert.equal(taskStore.get(t3.id)?.telemetry?.inputTokens, 50);
			assert.equal(taskStore.get(t3.id)?.telemetry?.outputTokens, 25);
			assert.deepEqual(sumTokens(taskStore), { input: 101, output: 51 });
		} finally {
			h.cleanup();
		}
	});

	it("ignores a referenced task that is not in progress", async () => {
		const h = bootTelemetryHarness();
		try {
			await h.sessionStart();
			const pendingTask = taskStore.create("Pending", "body", createdBy);
			const completedTask = h.startInProgress("Completed");
			taskStore.update(completedTask.id, { status: "completed" });
			setTaskTelemetryActive(completedTask.id, false);
			const activeA = h.startInProgress("Active A");
			const activeB = h.startInProgress("Active B");

			await h.turnStart();
			await h.toolStart("TaskGet", { taskId: pendingTask.id });
			await h.toolStart("TaskGet", { taskId: completedTask.id });
			await h.turnEnd(80, 20);

			assert.equal(taskStore.get(pendingTask.id)?.telemetry, undefined);
			assert.equal(taskStore.get(completedTask.id)?.telemetry?.inputTokens, 0);
			assert.equal(taskStore.get(activeA.id)?.telemetry?.inputTokens, 0);
			assert.equal(taskStore.get(activeB.id)?.telemetry?.inputTokens, 0);
			assert.deepEqual(sumTokens(taskStore), { input: 0, output: 0 });
		} finally {
			h.cleanup();
		}
	});

	it("ignores read-only taskId -1 references", async () => {
		const h = bootTelemetryHarness();
		try {
			await h.sessionStart();
			const t1 = h.startInProgress("Task 1");
			const t2 = h.startInProgress("Task 2");

			await h.turnStart();
			await h.toolStart("subagent", { agent: "explorer", task: "inspect", taskId: "-1" });
			await h.turnEnd(60, 15);

			assert.equal(taskStore.get(t1.id)?.telemetry?.inputTokens, 0);
			assert.equal(taskStore.get(t2.id)?.telemetry?.inputTokens, 0);
			assert.deepEqual(sumTokens(taskStore), { input: 0, output: 0 });
		} finally {
			h.cleanup();
		}
	});

	it("credits the sole in-progress task when a turn has no task references", async () => {
		const h = bootTelemetryHarness();
		try {
			await h.sessionStart();
			const sole = h.startInProgress("Sole task");

			await h.turnStart();
			await h.toolStart("read", { path: "README.md" });
			await h.turnEnd(42, 17);

			assert.equal(taskStore.get(sole.id)?.telemetry?.inputTokens, 42);
			assert.equal(taskStore.get(sole.id)?.telemetry?.outputTokens, 17);
			assert.deepEqual(sumTokens(taskStore), { input: 42, output: 17 });
		} finally {
			h.cleanup();
		}
	});

	it("credits nobody when multiple tasks are in progress without task references", async () => {
		const h = bootTelemetryHarness();
		try {
			await h.sessionStart();
			const t1 = h.startInProgress("Task 1");
			const t2 = h.startInProgress("Task 2");
			const t3 = h.startInProgress("Task 3");

			await h.turnStart();
			await h.toolStart("bash", { command: "ls" });
			await h.turnEnd(900, 300);

			assert.equal(taskStore.get(t1.id)?.telemetry?.inputTokens, 0);
			assert.equal(taskStore.get(t2.id)?.telemetry?.inputTokens, 0);
			assert.equal(taskStore.get(t3.id)?.telemetry?.inputTokens, 0);
			assert.deepEqual(sumTokens(taskStore), { input: 0, output: 0 });
		} finally {
			h.cleanup();
		}
	});

	it("assigns integer division remainder to the first referenced task", () => {
		const store = new TaskStore();
		const widget = new TaskWidget(store);
		try {
			const t1 = store.create("First", "body", createdBy);
			const t2 = store.create("Second", "body", createdBy);
			const t3 = store.create("Third", "body", createdBy);
			for (const t of [t1, t2, t3]) {
				store.update(t.id, { status: "in_progress" });
				widget.setActiveTask(t.id, true);
			}

			widget.addTokenUsage(10, 10, [t1.id, t2.id, t3.id]);

			assert.equal(store.get(t1.id)?.telemetry?.inputTokens, 4);
			assert.equal(store.get(t1.id)?.telemetry?.outputTokens, 4);
			assert.equal(store.get(t2.id)?.telemetry?.inputTokens, 3);
			assert.equal(store.get(t2.id)?.telemetry?.outputTokens, 3);
			assert.equal(store.get(t3.id)?.telemetry?.inputTokens, 3);
			assert.equal(store.get(t3.id)?.telemetry?.outputTokens, 3);
			assert.deepEqual(sumTokens(store), { input: 10, output: 10 });
		} finally {
			widget.dispose();
		}
	});

	it("clears task references between turns so later turns do not inherit earlier refs", async () => {
		const h = bootTelemetryHarness();
		try {
			await h.sessionStart();
			const t1 = h.startInProgress("Task 1");
			const t2 = h.startInProgress("Task 2");

			await h.turnStart();
			await h.toolStart("TaskUpdate", { taskId: t1.id, activeForm: "Step 1" });
			await h.turnEnd(20, 8);

			await h.turnStart();
			await h.toolStart("read", { path: "package.json" });
			await h.turnEnd(50, 12);

			assert.equal(taskStore.get(t1.id)?.telemetry?.inputTokens, 20);
			assert.equal(taskStore.get(t1.id)?.telemetry?.outputTokens, 8);
			assert.equal(taskStore.get(t2.id)?.telemetry?.inputTokens, 0);
			assert.equal(taskStore.get(t2.id)?.telemetry?.outputTokens, 0);
			assert.deepEqual(sumTokens(taskStore), { input: 20, output: 8 });
		} finally {
			h.cleanup();
		}
	});

	it("clears task references on agent_settled after an interrupted turn", async () => {
		const h = bootTelemetryHarness();
		try {
			await h.sessionStart();
			const t1 = h.startInProgress("Task 1");
			const t2 = h.startInProgress("Task 2");

			await h.turnStart();
			await h.toolStart("TaskGet", { taskId: t1.id });
			await h.agentSettled();

			await h.turnEnd(40, 10);

			assert.equal(taskStore.get(t1.id)?.telemetry?.inputTokens, 0);
			assert.equal(taskStore.get(t2.id)?.telemetry?.inputTokens, 0);
			assert.deepEqual(sumTokens(taskStore), { input: 0, output: 0 });
		} finally {
			h.cleanup();
		}
	});

	it("keeps accumulating on the same task across a deactivate-reactivate cycle", () => {
		const store = new TaskStore();
		const widget = new TaskWidget(store);
		try {
			const task = store.create("Accumulating", "body", createdBy);
			store.update(task.id, { status: "in_progress" });

			widget.setActiveTask(task.id, true);
			widget.addTokenUsage(12, 5);
			widget.setActiveTask(task.id, false);
			widget.addTokenUsage(99, 99);
			widget.setActiveTask(task.id, true);
			widget.addTokenUsage(8, 15);

			assert.equal(store.get(task.id)?.telemetry?.inputTokens, 20);
			assert.equal(store.get(task.id)?.telemetry?.outputTokens, 20);
			assert.equal(store.get(task.id)?.telemetry?.endedAt, undefined);
			assert.deepEqual(sumTokens(store), { input: 20, output: 20 });
		} finally {
			widget.dispose();
		}
	});

	it("performs a no-op when zero tasks are active", () => {
		const store = new TaskStore();
		const widget = new TaskWidget(store);
		try {
			const pendingTask = store.create("Pending", "body", createdBy);
			widget.addTokenUsage(100, 50, [pendingTask.id]);

			assert.equal(store.get(pendingTask.id)?.telemetry, undefined);
			assert.deepEqual(sumTokens(store), { input: 0, output: 0 });
		} finally {
			widget.dispose();
		}
	});

	it("gives integer remainder to the first referenced task regardless of activation order", async () => {
		const h = bootTelemetryHarness();
		try {
			await h.sessionStart();
			const t1 = h.startInProgress("Task 1");
			const t2 = h.startInProgress("Task 2");
			const t3 = h.startInProgress("Task 3");

			await h.turnStart();
			await h.toolStart("TaskGet", { taskId: t3.id });
			await h.toolStart("TaskGet", { taskId: t1.id });
			await h.toolStart("TaskGet", { taskId: t2.id });
			await h.turnEnd(10, 10);

			assert.equal(taskStore.get(t3.id)?.telemetry?.inputTokens, 4);
			assert.equal(taskStore.get(t3.id)?.telemetry?.outputTokens, 4);
			assert.equal(taskStore.get(t1.id)?.telemetry?.inputTokens, 3);
			assert.equal(taskStore.get(t1.id)?.telemetry?.outputTokens, 3);
			assert.equal(taskStore.get(t2.id)?.telemetry?.inputTokens, 3);
			assert.equal(taskStore.get(t2.id)?.telemetry?.outputTokens, 3);
			assert.deepEqual(sumTokens(taskStore), { input: 10, output: 10 });
		} finally {
			h.cleanup();
		}
	});

	it("credits tasks referenced via TaskBulkUpdate updates array", async () => {
		const h = bootTelemetryHarness();
		try {
			await h.sessionStart();
			const t1 = h.startInProgress("Task 1");
			const t2 = h.startInProgress("Task 2");
			const t3 = h.startInProgress("Task 3");

			await h.turnStart();
			await h.runTool("TaskBulkUpdate", {
				updates: [
					{ taskId: t3.id, subject: "Updated 3" },
					{ taskId: t1.id, subject: "Updated 1" },
				],
			});
			await h.turnEnd(101, 51);

			assert.equal(taskStore.get(t3.id)?.telemetry?.inputTokens, 51);
			assert.equal(taskStore.get(t3.id)?.telemetry?.outputTokens, 26);
			assert.equal(taskStore.get(t1.id)?.telemetry?.inputTokens, 50);
			assert.equal(taskStore.get(t1.id)?.telemetry?.outputTokens, 25);
			assert.equal(taskStore.get(t2.id)?.telemetry?.inputTokens, 0);
			assert.equal(taskStore.get(t2.id)?.telemetry?.outputTokens, 0);
			assert.deepEqual(sumTokens(taskStore), { input: 101, output: 51 });
		} finally {
			h.cleanup();
		}
	});

	it("credits tasks referenced via TaskBulkDelete taskIds array", async () => {
		const h = bootTelemetryHarness();
		try {
			await h.sessionStart();
			const t1 = h.startInProgress("Task 1");
			const t2 = h.startInProgress("Task 2");

			await h.turnStart();
			await h.toolStart("TaskBulkDelete", { taskIds: [t2.id] });
			await h.turnEnd(40, 10);

			assert.equal(taskStore.get(t1.id)?.telemetry?.inputTokens, 0);
			assert.equal(taskStore.get(t2.id)?.telemetry?.inputTokens, 40);
			assert.equal(taskStore.get(t2.id)?.telemetry?.outputTokens, 10);
			assert.deepEqual(sumTokens(taskStore), { input: 40, output: 10 });
		} finally {
			h.cleanup();
		}
	});

	it("credits tasks referenced via parallel subagent tasks array", async () => {
		const h = bootTelemetryHarness();
		try {
			await h.sessionStart();
			const t1 = h.startInProgress("Task 1");
			const t2 = h.startInProgress("Task 2");
			const t3 = h.startInProgress("Task 3");

			await h.turnStart();
			await h.toolStart("subagent", {
				async: true,
				tasks: [
					{ agent: "explorer", task: "inspect", cwd: "/tmp", taskId: "-1" },
					{ agent: "worker", task: "fix 3", cwd: "/tmp", taskId: t3.id },
					{ agent: "worker", task: "fix 1", cwd: "/tmp", taskId: t1.id },
				],
			});
			await h.turnEnd(21, 9);

			assert.equal(taskStore.get(t3.id)?.telemetry?.inputTokens, 11);
			assert.equal(taskStore.get(t3.id)?.telemetry?.outputTokens, 5);
			assert.equal(taskStore.get(t1.id)?.telemetry?.inputTokens, 10);
			assert.equal(taskStore.get(t1.id)?.telemetry?.outputTokens, 4);
			assert.equal(taskStore.get(t2.id)?.telemetry?.inputTokens, 0);
			assert.deepEqual(sumTokens(taskStore), { input: 21, output: 9 });
		} finally {
			h.cleanup();
		}
	});

	it("credits tasks referenced via chain subagent steps array", async () => {
		const h = bootTelemetryHarness();
		try {
			await h.sessionStart();
			const t1 = h.startInProgress("Task 1");
			const t2 = h.startInProgress("Task 2");
			const t3 = h.startInProgress("Task 3");

			await h.turnStart();
			await h.toolStart("subagent", {
				async: true,
				chain: [
					{ agent: "worker", task: "step 1", cwd: "/tmp", taskId: t2.id },
					{ agent: "worker", task: "step 2", cwd: "/tmp", taskId: t1.id },
				],
			});
			await h.turnEnd(15, 7);

			assert.equal(taskStore.get(t2.id)?.telemetry?.inputTokens, 8);
			assert.equal(taskStore.get(t2.id)?.telemetry?.outputTokens, 4);
			assert.equal(taskStore.get(t1.id)?.telemetry?.inputTokens, 7);
			assert.equal(taskStore.get(t1.id)?.telemetry?.outputTokens, 3);
			assert.equal(taskStore.get(t3.id)?.telemetry?.inputTokens, 0);
			assert.deepEqual(sumTokens(taskStore), { input: 15, output: 7 });
		} finally {
			h.cleanup();
		}
	});

	it("does not attribute peer snake_case task_id calls to local tasks or suppress sole-task fallback", async () => {
		const h = bootTelemetryHarness();
		try {
			await h.sessionStart();
			const t1 = h.startInProgress("Task 1");
			const t2 = h.startInProgress("Task 2");

			await h.turnStart();
			await h.toolStart("coms_task_update", { target: "peer-worker", task_id: t2.id, status: "completed" });
			await h.toolStart("coms_task_get", { target: "peer-worker", task_id: t1.id });
			await h.toolStart("coms_task_delete", { target: "peer-worker", task_id: t2.id });
			await h.turnEnd(33, 11);

			assert.equal(taskStore.get(t1.id)?.telemetry?.inputTokens, 0);
			assert.equal(taskStore.get(t1.id)?.telemetry?.outputTokens, 0);
			assert.equal(taskStore.get(t2.id)?.telemetry?.inputTokens, 0);
			assert.equal(taskStore.get(t2.id)?.telemetry?.outputTokens, 0);
			assert.deepEqual(sumTokens(taskStore), { input: 0, output: 0 });

			taskStore.update(t2.id, { status: "completed" });
			setTaskTelemetryActive(t2.id, false);

			await h.turnStart();
			await h.toolStart("coms_task_get", { target: "peer-worker", task_id: "999" });
			await h.turnEnd(20, 5);

			assert.equal(taskStore.get(t1.id)?.telemetry?.inputTokens, 20);
			assert.equal(taskStore.get(t1.id)?.telemetry?.outputTokens, 5);
			assert.equal(taskStore.get(t2.id)?.telemetry?.inputTokens, 0);
			assert.deepEqual(sumTokens(taskStore), { input: 20, output: 5 });
		} finally {
			h.cleanup();
		}
	});

	it("credits a task completed mid-turn while preserving its endedAt timestamp", async () => {
		const h = bootTelemetryHarness();
		try {
			await h.sessionStart();
			const t5 = h.startInProgress("Task 5");
			const t6 = h.startInProgress("Task 6");

			await h.turnStart();
			await h.runTool("TaskUpdate", { taskId: t6.id, status: "completed" });
			await h.turnEnd(90, 30);

			assert.equal(taskStore.get(t6.id)?.status, "completed");
			assert.equal(typeof taskStore.get(t6.id)?.telemetry?.endedAt, "number");
			assert.equal(taskStore.get(t6.id)?.telemetry?.inputTokens, 90);
			assert.equal(taskStore.get(t6.id)?.telemetry?.outputTokens, 30);
			assert.equal(taskStore.get(t5.id)?.telemetry?.inputTokens, 0);
			assert.equal(taskStore.get(t5.id)?.telemetry?.outputTokens, 0);
			assert.deepEqual(sumTokens(taskStore), { input: 90, output: 30 });
		} finally {
			h.cleanup();
		}
	});

	it("does not bill a sole active task when tool calls reference only a pending task", async () => {
		const h = bootTelemetryHarness();
		try {
			await h.sessionStart();
			const sole = h.startInProgress("Sole active");
			const pending = taskStore.create("Pending", "body", createdBy);

			await h.turnStart();
			await h.toolStart("TaskGet", { taskId: pending.id });
			await h.turnEnd(75, 25);

			assert.equal(taskStore.get(pending.id)?.telemetry, undefined);
			assert.equal(taskStore.get(sole.id)?.telemetry?.inputTokens, 0);
			assert.equal(taskStore.get(sole.id)?.telemetry?.outputTokens, 0);
			assert.deepEqual(sumTokens(taskStore), { input: 0, output: 0 });
		} finally {
			h.cleanup();
		}
	});

	it("does not credit a task completed in an earlier turn when read later", async () => {
		const h = bootTelemetryHarness();
		try {
			await h.sessionStart();
			const t5 = h.startInProgress("Task 5");
			const t6 = h.startInProgress("Task 6");

			await h.turnStart();
			await h.runTool("TaskUpdate", { taskId: t6.id, status: "completed" });
			await h.turnEnd(40, 10);

			await h.turnStart();
			await h.runTool("TaskGet", { taskId: t6.id });
			await h.turnEnd(60, 20);

			assert.equal(taskStore.get(t6.id)?.telemetry?.inputTokens, 40);
			assert.equal(taskStore.get(t6.id)?.telemetry?.outputTokens, 10);
			assert.equal(taskStore.get(t5.id)?.telemetry?.inputTokens, 0);
			assert.equal(taskStore.get(t5.id)?.telemetry?.outputTokens, 0);
			assert.deepEqual(sumTokens(taskStore), { input: 40, output: 10 });
		} finally {
			h.cleanup();
		}
	});
});
