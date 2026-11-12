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
	parseTasksCommand,
	planTaskCompletion,
	selectTaskRows,
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
	it("defaults to llm and keeps the default across a reload", () => {
		const path = storePath();
		const store = new TaskStore(path);
		const created = store.create("agent work", "", createdBy);
		assert.equal(created.assignee, "llm");
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

	it("persists completedBy and the owner's note, and reads them back", () => {
		const path = storePath();
		const store = new TaskStore(path);
		const created = store.create("owner step", "", createdBy, undefined, undefined, "user");
		store.update(created.id, { status: "completed", completedBy: "user", completionNote: "merged #1088" });
		store.close();
		const reopened = new TaskStore(path);
		const loaded = reopened.get(created.id);
		assert.equal(loaded?.completedBy, "user");
		assert.equal(loaded?.completionNote, "merged #1088");
		reopened.close();
	});

	it("reads a completed legacy record as completed by the agent", () => {
		const path = storePath();
		const legacy = task({ id: "9", status: "completed" }) as any;
		delete legacy.assignee;
		writeFileSync(path, JSON.stringify({ nextId: 10, tasks: [legacy] }), "utf-8");
		const store = new TaskStore(path);
		assert.equal(store.get("9")?.completedBy, undefined, "absent means the agent did it");
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

	it("renders the same tag in the /tasks row and the widget row", () => {
		const store = new TaskStore();
		const widget = new TaskWidget(store);
		try {
			const owner = store.create("run the Discord test", "", createdBy, undefined, undefined, "user");
			const agent = store.create("polish the drilldown", "", createdBy);
			// `/tasks` + drilldown row line.
			assert.equal(formatTaskRowLine(owner), `◻ #${owner.id} [pending] [you] run the Discord test`);
			assert.equal(formatTaskRowLine(agent), `◻ #${agent.id} [pending] [llm] polish the drilldown`);
			// The widget row carries the very same tag from the same definition.
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

	it("renders the widget in the same order", () => {
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
			assert.deepEqual(ids, [3, 1, 2, 5, 4], "owner's pending task above the agent's, in both surfaces");
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
	it("parses /tasks mine", () => {
		assert.deepEqual(parseTasksCommand("mine"), { kind: "list", mine: true });
		assert.deepEqual(parseTasksCommand("mine extra"), { kind: "usage" });
	});

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
	it("cancels on Esc and completes on an empty line", () => {
		assert.deepEqual(planTaskCompletion(undefined), { kind: "skip", reason: "cancelled" });
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

	it("writes who closed it and notifies the session once, with the note", () => {
		const writes: Array<[string, any]> = [];
		const notices: Array<{ id: string; subject: string; completionNote?: string }> = [];
		const ui = tasksOverlayDeps(
			{
				list: () => [task({ id: "5", assignee: "user" })],
				get: (id) => (id === "5" ? task({ id: "5", assignee: "user" }) : undefined),
				create: () => ({ id: "6" }),
				update: (id, fields) => { writes.push([id, fields]); },
			},
			undefined,
			(completed) => { notices.push(completed); },
		);
		assert.equal(ui.completeTask("5", { by: "user", note: "merged it" }), true);
		assert.deepEqual(writes, [["5", { status: "completed", completedBy: "user", completionNote: "merged it" }]]);
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
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const tui = { terminal: { rows: 20 }, requestRender: () => {} };
	const keybindings = { matches: (data: string, action: string) => action === "tui.select.cancel" && data === "close" };
	const ctx = {
		hasUI: true,
		ui: {
			notify: () => {},
			input: async () => undefined,
			custom: async (factory: any) => {
				const keys = opens[opened];
				opened += 1;
				if (!keys) return null;
				return new Promise((resolve) => {
					const component = factory(tui, theme, keybindings, resolve);
					screens.push(component.render(100).join("\n"));
					for (const key of keys) {
						component.handleInput(key);
						screens.push(component.render(100).join("\n"));
					}
				});
			},
		},
	};
	return { ctx: ctx as any, openedCount: () => opened, screens };
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
	it("asks the owner for an optional note and persists it", async () => {
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
		assert.deepEqual(writes, [["5", { status: "completed", completedBy: "llm" }]]);
	});

	it("shows only the owner's rows when the filter is on, and f toggles back", async () => {
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
		assert.match(screens[0], /#2 \[pending\] \[you\] owner row/);
		assert.match(screens[0], /d done · f mine\/all .* Esc close/, "the footer names the new keys");
		assert.doesNotMatch(screens[0], /agent row/, "mine hides the agent's rows");
		const afterToggle = screens.at(-1) ?? "";
		assert.match(afterToggle, /agent row/, "f toggles the filter back to all");
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

	it("writes the id and never the note", () => {
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
		assert.equal(body.includes(secret), false, "the note must never reach the log");
	});
});
