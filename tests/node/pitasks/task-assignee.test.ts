/**
 * #1090 — a task belongs to the agent (default) or to the owner.
 *
 * Covers the record (default + round-trip + legacy files), the ONE tag definition consumed by
 * `/tasks` and the widget, the sort order, the reminder exclusion, the `mine` filter, the owner's
 * completion (note dialog, Esc, empty line) and the single message the session receives.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { TaskStore } from "../../../extensions/pitasks/task-store.js";
import { TaskWidget } from "../../../extensions/pitasks/task-widget.js";
import {
	COMPLETION_NOTE_MAX,
	formatTaskRowLine,
	planTaskCompletion,
	selectTaskRows,
	sortTaskRows,
	taskAssigneeTag,
	taskCompletionNotice,
	tasksOverlayDeps,
} from "../../../extensions/pitasks/tasks-view.js";
import {
	decidePendingReminder,
	selectActiveTasks,
	selectStaleTasks,
} from "../../../extensions/pitasks/reminders.js";
import { openTasksOverlay } from "../../../extensions/pitasks/tasks-ui.js";
import { clearLogLevelCache, getPiLogPath, setGlobalSessionId } from "../../../extensions/shared/file-logger.js";
import type { Task } from "../../../extensions/pitasks/types.js";
import { makeTempDir } from "../helpers/temp-dirs.js";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { fakeCommandCtx, fakeCustom, type FakeCustomFactory, type FakeOverlayComponent } from "../helpers/fake-extension-ctx.js";

const createdBy = { type: "local" as const, origin: "system", session: "", project: "" };
const theme = { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text };

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: "3",
		subject: "wire the overlay",
		description: "",
		status: "pending",
		assignee: "llm",
		metadata: {},
		blocks: [],
		blockedBy: [],
		createdBy: { type: "local", origin: "user", session: "", project: "" },
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_100_000,
		statusHistory: {
			pending_at: new Date(1_700_000_000_000).toISOString(),
			in_progress_at: null,
			completed_at: null,
			deleted_at: null,
		},
		...overrides,
	};
}

const storePath = (): string => join(makeTempDir("pitasks-assignee-"), "tasks.json");

describe("assignee on the task record (#1090)", () => {
	it("defaults to llm on creation", () => {
		const store = new TaskStore();
		const created = store.create("agent work", "", createdBy);
		assert.equal(created.assignee, "llm");
	});

	it("preserves the default assignee across a reload", () => {
		const path = storePath();
		const store = new TaskStore(path);
		const created = store.create("agent work", "", createdBy);
		store.close();
		const reopened = new TaskStore(path);
		assert.equal(reopened.get(created.id)?.assignee, "llm");
		reopened.close();
	});

	it("round-trips a task assigned to the owner", () => {
		const path = storePath();
		const store = new TaskStore(path);
		const created = store.create("owner step", "", createdBy, undefined, undefined, "user");
		assert.equal(created.assignee, "user");
		store.close();
		const reopened = new TaskStore(path);
		assert.equal(reopened.get(created.id)?.assignee, "user");
		reopened.close();
	});

	it("reassigns through update, both ways", () => {
		const store = new TaskStore();
		const created = store.create("step", "", createdBy);
		store.update(created.id, { assignee: "user" });
		assert.equal(store.get(created.id)?.assignee, "user");
		store.update(created.id, { assignee: "llm" });
		assert.equal(store.get(created.id)?.assignee, "llm");
	});

	it("loads a legacy file without the field as llm, losing nothing", () => {
		const path = storePath();
		// A record written before #1090: no assignee, no completion fields.
		const legacy = task({ id: "1", subject: "old task", description: "old body" }) as any;
		delete legacy.assignee;
		writeFileSync(path, JSON.stringify({ nextId: 2, tasks: [legacy] }), "utf-8");
		const store = new TaskStore(path);
		const loaded = store.get("1");
		assert.equal(loaded?.assignee, "llm");
		assert.equal(loaded?.subject, "old task");
		assert.equal(loaded?.description, "old body");
		assert.equal(loaded?.completedBy, undefined);
		assert.equal(loaded?.completionNote, undefined);
		store.close();
	});

	it("persists completedBy across a reload", () => {
		const path = storePath();
		const store = new TaskStore(path);
		const created = store.create("owner step", "", createdBy, undefined, undefined, "user");
		store.update(created.id, { status: "completed", completedBy: "user", completionNote: "merged #1088" });
		store.close();
		const reopened = new TaskStore(path);
		assert.equal(reopened.get(created.id)?.completedBy, "user");
		reopened.close();
	});

	it("persists the owner's completion note across a reload", () => {
		const path = storePath();
		const store = new TaskStore(path);
		const created = store.create("owner step", "", createdBy, undefined, undefined, "user");
		store.update(created.id, { status: "completed", completedBy: "user", completionNote: "merged #1088" });
		store.close();
		const reopened = new TaskStore(path);
		assert.equal(reopened.get(created.id)?.completionNote, "merged #1088");
		reopened.close();
	});

	it("reads a completed legacy record as completed by the agent", () => {
		const path = storePath();
		const legacy = task({ id: "9", status: "completed" }) as any;
		delete legacy.assignee;
		writeFileSync(path, JSON.stringify({ nextId: 10, tasks: [legacy] }), "utf-8");
		const store = new TaskStore(path);
		assert.equal(store.get("9")?.completedBy, "llm");
		store.close();
	});
});

describe("the [you] / [llm] tag has one definition (#1090)", () => {
	function renderer(widget: TaskWidget): () => string[] {
		let render: (() => string[]) | undefined;
		widget.setUICtx({
			setWidget(_name: string, value: any) { if (value) render = value({ terminal: { columns: 200 } }, theme).render; },
		});
		widget.update();
		assert.ok(render);
		return render;
	}

	it("names the tags", () => {
		assert.equal(taskAssigneeTag({ assignee: "user" }), "[you]");
		assert.equal(taskAssigneeTag({ assignee: "llm" }), "[llm]");
		assert.equal(taskAssigneeTag({}), "[llm]", "a record without the field is the agent's");
	});

	it("renders the assignee tag in the /tasks row", () => {
		const owner = task({ id: "1", subject: "run the Discord test", assignee: "user" });
		const agent = task({ id: "2", subject: "polish the drilldown", assignee: "llm" });
		assert.equal(formatTaskRowLine(owner), "◻ #1 [pending] [you] run the Discord test");
		assert.equal(formatTaskRowLine(agent), "◻ #2 [pending] [llm] polish the drilldown");
	});

	it("renders the assignee tag in the widget row", () => {
		const store = new TaskStore();
		const widget = new TaskWidget(store);
		try {
			const owner = store.create("run the Discord test", "", createdBy, undefined, undefined, "user");
			const agent = store.create("polish the drilldown", "", createdBy);
			const lines = renderer(widget)().join("\n");
			assert.match(lines, new RegExp(`#${owner.id} \\[you\\] run the Discord test`));
			assert.match(lines, new RegExp(`#${agent.id} \\[llm\\] polish the drilldown`));
		} finally {
			widget.dispose();
		}
	});

	it("adds `· N yours` to the widget header only when the owner has open work", () => {
		const store = new TaskStore();
		const widget = new TaskWidget(store);
		try {
			store.create("agent work", "", createdBy);
			const render = renderer(widget);
			assert.doesNotMatch(render()[0], /yours/);
			store.create("owner step", "", createdBy, undefined, undefined, "user");
			store.create("owner step 2", "", createdBy, undefined, undefined, "user");
			assert.match(render()[0], /· 2 yours/);
		} finally {
			widget.dispose();
		}
	});
});

describe("the owner's tasks sort first within a status group (#1090)", () => {
	const rows = (): Task[] => [
		task({ id: "1", status: "pending" }),
		task({ id: "2", status: "pending" }),
		task({ id: "3", status: "pending", assignee: "user" }),
		task({ id: "4", status: "completed", assignee: "user" }),
		task({ id: "5", status: "in_progress" }),
	];

	it("orders selectTaskRows by status group, then owner first, then id", () => {
		assert.deepEqual(selectTaskRows(rows()).map((t) => t.id), ["3", "1", "2", "5", "4"]);
	});

	it("orders widget rows with in-progress before pending while keeping owner tasks first per group", () => {
		const store = new TaskStore();
		const widget = new TaskWidget(store);
		try {
			for (const row of rows()) {
				const created = store.create(row.subject, "", createdBy, undefined, undefined, row.assignee);
				store.update(created.id, { status: row.status });
			}
			let render: (() => string[]) | undefined;
			widget.setUICtx({ setWidget(_n: string, value: any) { if (value) render = value({ terminal: { columns: 200 } }, theme).render; } });
			widget.update();
			const lines = (render?.() ?? []).filter((line) => line.includes("#"));
			const ids = lines.map((line) => Number(/#(\d+)/.exec(line)?.[1]));
			assert.deepEqual(ids, [5, 3, 1, 2, 4]);
		} finally {
			widget.dispose();
		}
	});

	it("keeps an active in-progress task visible ahead of ten pending tasks", () => {
		const store = new TaskStore();
		const widget = new TaskWidget(store);
		try {
			for (let i = 1; i <= 11; i++) store.create(`pending ${i}`, "", createdBy);
			const active = store.create("running work", "", createdBy);
			store.update(active.id, { status: "in_progress" });
			let render: (() => string[]) | undefined;
			widget.setUICtx({ setWidget(_n: string, value: any) { if (value) render = value({ terminal: { columns: 200 } }, theme).render; } });
			widget.update();
			const lines = (render?.() ?? []).join("\n");
			assert.match(lines, /#12 \[llm\] running work/);
		} finally {
			widget.dispose();
		}
	});
});

describe("the owner's tasks never nag (#1090)", () => {
	const old = new Date(0).toISOString();

	it("does not count a user task as active work, so no pending reminder fires", () => {
		const tasks = [{ status: "pending", assignee: "user", createdAt: 0, statusHistory: { pending_at: old } }];
		assert.deepEqual(selectActiveTasks(tasks).active, []);
		const decision = decidePendingReminder({ tasks, agentBusy: false, lastReminderAt: 0, now: 10_000_000, threshold: 1_000 });
		assert.equal(decision.fire, false);
	});

	it("does not count a user task as the agent's stuck task", () => {
		const stale = [{ status: "in_progress", assignee: "user", statusHistory: { in_progress_at: old } }];
		assert.deepEqual(selectStaleTasks(stale, 10_000_000, 1_000), []);
		// The agent's own task still is stale: the exclusion is the assignee, not the clock.
		const agentTask = [{ status: "in_progress", assignee: "llm", statusHistory: { in_progress_at: old } }];
		assert.equal(selectStaleTasks(agentTask, 10_000_000, 1_000).length, 1);
	});
});

describe("the mine filter (#1090)", () => {
	it("keeps only the owner's rows", () => {
		const tasks = [
			task({ id: "1" }),
			task({ id: "2", assignee: "user" }),
			task({ id: "3", assignee: "user", status: "completed" }),
		];
		assert.deepEqual(selectTaskRows(tasks, { mine: true }).map((t) => t.id), ["2", "3"]);
		assert.deepEqual(selectTaskRows(tasks).map((t) => t.id), ["2", "1", "3"], "the owner's pending row sorts above the agent's");
	});
});

describe("completing the owner's task (#1090)", () => {
	it("cancels on Esc", () => {
		assert.deepEqual(planTaskCompletion(undefined), { kind: "skip", reason: "cancelled" });
	});

	it("completes without a note on a blank input", () => {
		assert.deepEqual(planTaskCompletion(""), { kind: "complete" });
		assert.deepEqual(planTaskCompletion("   "), { kind: "complete" });
	});

	it("keeps a typed note, trimmed", () => {
		assert.deepEqual(planTaskCompletion("  merged #1088  "), { kind: "complete", note: "merged #1088" });
	});

	it("bounds the note like other owner-supplied text", () => {
		const plan = planTaskCompletion("x".repeat(COMPLETION_NOTE_MAX + 50));
		assert.equal(plan.kind, "complete");
		assert.equal(plan.kind === "complete" ? plan.note?.length : undefined, COMPLETION_NOTE_MAX);
	});

	it("records the user actor with the completion note", () => {
		const writes: Array<[string, any]> = [];
		const ui = tasksOverlayDeps({
			list: () => [task({ id: "5", assignee: "user" })],
			get: (id) => (id === "5" ? task({ id: "5", assignee: "user" }) : undefined),
			create: () => ({ id: "6" }),
			update: (id, fields) => { writes.push([id, fields]); },
		});
		assert.equal(ui.completeTask("5", { by: "user", note: "merged it" }), true);
		assert.deepEqual(writes, [["5", { status: "completed", completedBy: "user", completionNote: "merged it" }]]);
	});

	it("emits one completion notice carrying the note", () => {
		const notices: Array<{ id: string; subject: string; completionNote?: string }> = [];
		const ui = tasksOverlayDeps(
			{
				list: () => [task({ id: "5", assignee: "user" })],
				get: (id) => (id === "5" ? task({ id: "5", assignee: "user" }) : undefined),
				create: () => ({ id: "6" }),
				update: () => undefined,
			},
			undefined,
			(completed) => { notices.push(completed); },
		);
		assert.equal(ui.completeTask("5", { by: "user", note: "merged it" }), true);
		assert.deepEqual(notices, [{ id: "5", subject: "wire the overlay", completionNote: "merged it" }]);
		const notice = taskCompletionNotice(notices[0]);
		assert.equal(notice.content, 'Task #5 "wire the overlay" marked done by you\nmerged it');
		assert.deepEqual(notice.details, { taskId: "5", note: "merged it" });
	});

	it("notifies once with no note when the owner completes without one", () => {
		const writes: Array<[string, any]> = [];
		const notices: Array<{ id: string; subject: string; completionNote?: string }> = [];
		const ui = tasksOverlayDeps(
			{
				list: () => [task({ id: "5", assignee: "user" })],
				get: () => task({ id: "5", assignee: "user" }),
				create: () => ({ id: "6" }),
				update: (id, fields) => { writes.push([id, fields]); },
			},
			undefined,
			(completed) => { notices.push(completed); },
		);
		ui.completeTask("5", { by: "user" });
		assert.deepEqual(writes, [["5", { status: "completed", completedBy: "user" }]]);
		assert.equal(notices.length, 1);
		const notice = taskCompletionNotice(notices[0]);
		assert.equal(notice.content, 'Task #5 "wire the overlay" marked done by you');
		assert.deepEqual(notice.details, { taskId: "5" });
	});

	it("does not notify for the agent's own task", () => {
		const notices: unknown[] = [];
		const ui = tasksOverlayDeps(
			{
				list: () => [task({ id: "5" })],
				get: () => task({ id: "5" }),
				create: () => ({ id: "6" }),
				update: () => undefined,
			},
			undefined,
			(completed) => { notices.push(completed); },
		);
		assert.equal(ui.completeTask("5", { by: "llm" }), true);
		assert.deepEqual(notices, []);
	});

	it("does not write an already-completed task", () => {
		let writes = 0;
		const ui = tasksOverlayDeps(
			{
				list: () => [task({ id: "5", status: "completed", assignee: "user" })],
				get: () => task({ id: "5", status: "completed", assignee: "user" }),
				create: () => ({ id: "6" }),
				update: () => { writes++; },
			},
		);
		assert.equal(ui.completeTask("5", { by: "user" }), false);
		assert.equal(writes, 0);
	});
});

/** The real list overlay + the real input dialog receive the mocked keystrokes; each render is
 *  captured so the rows a surface actually shows are assertable. */
function makeTasksCtx(opens: string[][]) {
	let opened = 0;
	const screens: string[] = [];
	const screen = (component: FakeOverlayComponent): void => { screens.push(component.render?.(100).join("\n") ?? ""); };
	const custom = (<T,>(factory: FakeCustomFactory<T>) => {
		const keys = opens[opened];
		opened += 1;
		if (!keys) return Promise.resolve(null as never);
		// A frame per key: the surfaces are asserted through what they draw.
		return fakeCustom(factory, keys, { onOpen: screen, onKey: (_key, _delivered, component) => screen(component) });
	}) satisfies ExtensionUIContext["custom"];
	const ctx = fakeCommandCtx({ notify: () => {}, input: async () => undefined, custom });
	return { ctx, openedCount: () => opened, screens };
}

function completionDeps(assignee: "llm" | "user", onUserCompleted?: (task: any) => void) {
	const writes: Array<[string, any]> = [];
	const tasks = [task({ id: "5", subject: "run the Discord test", assignee })];
	const deps = tasksOverlayDeps(
		{
			list: () => tasks,
			get: (id) => tasks.find((t) => t.id === id),
			create: () => ({ id: "6" }),
			update: (id, fields) => { writes.push([id, fields]); },
		},
		undefined,
		onUserCompleted,
	);
	return { deps, writes, tasks };
}

describe("d in /tasks closes the focused task (#1090)", () => {
	it("keeps an empty mine view navigable", async () => {
		const { ctx, screens } = makeTasksCtx([["f", "close"]]);
		const { deps } = completionDeps("llm");
		await openTasksOverlay(ctx, deps, { mine: true });
		assert.match(screens[0], /No tasks assigned to you/);
		assert.match(screens.at(-1) ?? "", /run the Discord test/);
	});

	it("allows n from an empty mine view", async () => {
		const { ctx } = makeTasksCtx([["n"], ["new owner step", "\n"], ["you", "\n"]]);
		const store = new TaskStore();
		store.create("agent step", "", createdBy);
		await openTasksOverlay(ctx, tasksOverlayDeps(store), { mine: true });
		assert.equal(store.list().find(t => t.subject === "new owner step")?.assignee, "user");
	});

	it("creates a user-assigned task after the assignee prompt", async () => {
		const { ctx } = makeTasksCtx([["n"], ["new step", "\n"], ["you", "\n"]]);
		const store = new TaskStore();
		store.create("existing", "", createdBy);
		await openTasksOverlay(ctx, tasksOverlayDeps(store));
		assert.equal(store.list().find(t => t.subject === "new step")?.assignee, "user");
	});

	it("cancels assignee selection without creating a task", async () => {
		const { ctx } = makeTasksCtx([["n"], ["new step", "\n"], ["\x1b"]]);
		const store = new TaskStore();
		store.create("existing", "", createdBy);
		await openTasksOverlay(ctx, tasksOverlayDeps(store));
		assert.equal(store.list().length, 1);
	});
	it("persists the optional note from the completion dialog", async () => {
		const { ctx, openedCount } = makeTasksCtx([["d"], ["merged #1088", "\n"]]);
		const { deps, writes } = completionDeps("user");
		await openTasksOverlay(ctx, deps);
		assert.equal(openedCount(), 3, "the note dialog opened once, then the list re-opened");
		assert.deepEqual(writes, [["5", { status: "completed", completedBy: "user", completionNote: "merged #1088" }]]);
	});

	it("completes without a note on an empty line", async () => {
		const { ctx } = makeTasksCtx([["d"], ["\n"]]);
		const { deps, writes } = completionDeps("user");
		await openTasksOverlay(ctx, deps);
		assert.deepEqual(writes, [["5", { status: "completed", completedBy: "user" }]]);
	});

	it("writes nothing when the owner presses Esc", async () => {
		const { ctx, openedCount } = makeTasksCtx([["d"], ["\x1b"]]);
		const { deps, writes } = completionDeps("user");
		await openTasksOverlay(ctx, deps);
		assert.equal(openedCount(), 3);
		assert.deepEqual(writes, []);
	});

	it("closes the agent's task without a dialog", async () => {
		const { ctx, openedCount } = makeTasksCtx([["d", "close"]]);
		const { deps, writes } = completionDeps("llm");
		await openTasksOverlay(ctx, deps);
		assert.equal(openedCount(), 1, "no note dialog for the agent's own task");
		assert.deepEqual(writes, [["5", { status: "completed", completedBy: "user" }]]);
	});

	it("shows only the owner's rows when the mine filter is on", async () => {
		const { ctx, screens } = makeTasksCtx([["close"]]);
		const tasks = [task({ id: "1", subject: "agent row" }), task({ id: "2", assignee: "user", subject: "owner row" })];
		const deps = {
			listTasks: () => tasks,
			deleteTask: () => true,
			createTask: () => "9",
			updateTaskSubject: () => true,
			completeTask: () => true,
		};
		await openTasksOverlay(ctx, deps, { mine: true });
		assert.match(screens[0], /#2 \[pending\] \[you\] owner row/);
		assert.match(screens[0], /d done · u undo · f mine\/all .* Esc close/, "the footer names the new keys");
		assert.doesNotMatch(screens[0], /agent row/, "mine hides the agent's rows");
	});

	it("restores agent rows when f toggles off the mine filter", async () => {
		const { ctx, screens } = makeTasksCtx([["f", "close"]]);
		const tasks = [task({ id: "1", subject: "agent row" }), task({ id: "2", assignee: "user", subject: "owner row" })];
		const deps = {
			listTasks: () => tasks,
			deleteTask: () => true,
			createTask: () => "9",
			updateTaskSubject: () => true,
			completeTask: () => true,
		};
		await openTasksOverlay(ctx, deps, { mine: true });
		const afterToggle = screens.at(-1) ?? "";
		assert.match(afterToggle, /agent row/, "f toggles the filter back to all");
	});

	it("prunes invisible selections when f switches to mine so x deletes the focused row", async () => {
		const deleted: string[] = [];
		let tasks = [
			task({ id: "1", subject: "agent row", assignee: "llm" }),
			task({ id: "2", subject: "owner row", assignee: "user" }),
		];
		const deps = {
			listTasks: () => tasks,
			deleteTask: (id: string) => {
				deleted.push(id);
				tasks = tasks.filter((t) => t.id !== id);
				return true;
			},
			createTask: () => "9",
			updateTaskSubject: () => true,
			completeTask: () => true,
		};
		// Row 0 is #2 ([you]), row 1 is #1 ([llm]); move to #1, Space-select it, press f (mine), then press x.
		const { ctx } = makeTasksCtx([["j", " ", "f", "x", "close"]]);
		await openTasksOverlay(ctx, deps);
		assert.deepEqual(deleted, ["2"]);
	});

	it("shows the unfiltered empty message when all tasks disappear in the all view", async () => {
		let tasks = [task({ id: "1", subject: "last row", assignee: "llm" })];
		const deps = {
			listTasks: () => tasks,
			deleteTask: (id: string) => {
				tasks = tasks.filter((t) => t.id !== id);
				return true;
			},
			createTask: () => "9",
			updateTaskSubject: () => true,
			completeTask: () => true,
		};
		// Enter detail pane, press x to delete the only task, Esc back to the empty unfiltered list, then close.
		const { ctx, screens } = makeTasksCtx([["\r"], ["x", "\x1b"], ["close"]]);
		await openTasksOverlay(ctx, deps);
		const emptyUnfiltered = screens.at(-2) ?? "";
		assert.match(emptyUnfiltered, /No tasks\. Press n to add\./);
		assert.doesNotMatch(emptyUnfiltered, /assigned to you/);
	});
});

/**
 * The completion event names the task in the log; the owner's note never reaches the sink,
 * because it is their free text and the log is not the place for it.
 */
describe("the completion log carries the id only (#1090)", () => {
	const saved: { home?: string; level?: string } = {};
	const secret = "SECRET-OWNER-NOTE-1090"; // pragma: allowlist secret
	let tmpHome: string;

	before(() => {
		saved.home = process.env.HOME;
		saved.level = process.env.PI_LOG_PITASKS;
		tmpHome = makeTempDir("pitasks-assignee-logs-");
		process.env.HOME = tmpHome;
		process.env.USERPROFILE = tmpHome;
		process.env.PI_LOG_PITASKS = "info";
		setGlobalSessionId("task-assignee-test");
		clearLogLevelCache();
	});

	after(() => {
		if (saved.home === undefined) delete process.env.HOME;
		else process.env.HOME = saved.home;
		if (saved.level === undefined) delete process.env.PI_LOG_PITASKS;
		else process.env.PI_LOG_PITASKS = saved.level;
		clearLogLevelCache();
	});

	it("logs the completed task id", () => {
		const { deps } = completionDeps("user");
		deps.completeTask("5", { by: "user", note: secret });
		const path = getPiLogPath("pitasks");
		assert.ok(path, "the pitasks log path must resolve");
		assert.ok(existsSync(path), "the completion must be logged");
		const body = readFileSync(path, "utf-8");
		const line = body.split("\n").find((candidate) => candidate.includes("task_completed"));
		assert.ok(line, "task_completed must be logged");
		const payload = JSON.parse(line.slice(line.indexOf("task_completed") + "task_completed ".length));
		assert.deepEqual(payload, { id: "5" });
	});

	it("omits the completion note from the log", () => {
		const { deps } = completionDeps("user");
		deps.completeTask("5", { by: "user", note: secret });
		const path = getPiLogPath("pitasks");
		assert.ok(path, "the pitasks log path must resolve");
		const body = readFileSync(path, "utf-8");
		assert.equal(body.includes(secret), false, "the note must never reach the log");
	});
});

describe("debug logging for stale reminders and pure view helpers (#1090)", () => {
	const saved: { home?: string; pitasks?: string; reminders?: string } = {};

	before(() => {
		saved.home = process.env.HOME;
		saved.pitasks = process.env.PI_LOG_PITASKS;
		saved.reminders = process.env.PI_LOG_PITASKS_REMINDERS;
		const tmpHome = makeTempDir("pitasks-debug-logs-");
		process.env.HOME = tmpHome;
		process.env.USERPROFILE = tmpHome;
		process.env.PI_LOG_PITASKS = "debug";
		process.env.PI_LOG_PITASKS_REMINDERS = "debug";
		setGlobalSessionId("task-assignee-debug-test");
		clearLogLevelCache();
	});

	after(() => {
		if (saved.home === undefined) delete process.env.HOME;
		else process.env.HOME = saved.home;
		if (saved.pitasks === undefined) delete process.env.PI_LOG_PITASKS;
		else process.env.PI_LOG_PITASKS = saved.pitasks;
		if (saved.reminders === undefined) delete process.env.PI_LOG_PITASKS_REMINDERS;
		else process.env.PI_LOG_PITASKS_REMINDERS = saved.reminders;
		clearLogLevelCache();
	});

	it("logs selectStaleTasks counts at debug level", () => {
		selectStaleTasks([{ status: "in_progress", assignee: "user", statusHistory: { in_progress_at: new Date(0).toISOString() } }], 10_000, 1_000);
		const path = getPiLogPath("pitasks-reminders");
		assert.ok(path && existsSync(path));
		assert.match(readFileSync(path, "utf-8"), /selectStaleTasks/);
	});

	it("logs pure view helper calls at debug level", () => {
		taskAssigneeTag({ assignee: "user" });
		sortTaskRows([task({ id: "1" })]);
		selectTaskRows([task({ id: "1" })], { mine: true });
		planTaskCompletion(undefined);
		const path = getPiLogPath("pitasks");
		assert.ok(path && existsSync(path));
		const body = readFileSync(path, "utf-8");
		assert.match(body, /task_assignee_tag/);
		assert.match(body, /tasks_rows_sorted/);
		assert.match(body, /tasks_rows_selected/);
		assert.match(body, /task_completion_planned/);
	});
});
