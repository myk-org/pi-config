import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	TASKS_EMPTY_MESSAGE,
	TASKS_HINT,
	TASKS_USAGE,
	applyTaskAction,
	formatTasksPlainText,
	nextTaskStatus,
	parseTasksCommand,
	planTaskCompose,
	taskComposePrompt,
	taskDetailRows,
	taskStatusGlyph,
	tasksOverlayDeps,
	tasksOverlayIntent,
	toTaskRowView,
} from "../../../extensions/pitasks/tasks-view.ts";
import type { Task, TaskStatus } from "../../../extensions/pitasks/types.ts";
import { openTasksOverlay } from "../../../extensions/pitasks/tasks-ui.ts";

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: "3",
		subject: "wire the overlay",
		description: "replace the nested menu",
		status: "completed",
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

describe("parseTasksCommand", () => {
	it("defaults to the list overlay", () => {
		assert.deepEqual(parseTasksCommand(""), { kind: "list" });
		assert.deepEqual(parseTasksCommand(undefined), { kind: "list" });
		assert.deepEqual(parseTasksCommand("   "), { kind: "list" });
	});

	it("routes create", () => {
		assert.deepEqual(parseTasksCommand("create"), { kind: "create" });
		assert.deepEqual(parseTasksCommand("  create  "), { kind: "create" });
	});

	it("routes clear completed", () => {
		assert.deepEqual(parseTasksCommand("clear completed"), { kind: "clear-completed" });
	});

	it("routes clear all", () => {
		assert.deepEqual(parseTasksCommand("clear all"), { kind: "clear-all" });
	});

	it("routes start by id", () => {
		assert.deepEqual(parseTasksCommand("start 3"), { kind: "start", id: "3" });
	});

	it("routes done by id, with or without a hash", () => {
		assert.deepEqual(parseTasksCommand("done 12"), { kind: "done", id: "12" });
		assert.deepEqual(parseTasksCommand("  done  #7  "), { kind: "done", id: "7" });
	});

	it("prints usage for start/done without a usable id", () => {
		assert.deepEqual(parseTasksCommand("start"), { kind: "usage" });
		assert.deepEqual(parseTasksCommand("done"), { kind: "usage" });
		assert.deepEqual(parseTasksCommand("done abc"), { kind: "usage" });
		assert.deepEqual(parseTasksCommand("done #"), { kind: "usage" });
		assert.deepEqual(parseTasksCommand("done 3 4"), { kind: "usage" });
	});

	it("prints usage for an unknown subcommand", () => {
		assert.deepEqual(parseTasksCommand("view"), { kind: "usage" });
		assert.deepEqual(parseTasksCommand("create extra"), { kind: "usage" });
	});

	it("prints usage for an incomplete clear", () => {
		assert.deepEqual(parseTasksCommand("clear"), { kind: "usage" });
		assert.deepEqual(parseTasksCommand("clear pending"), { kind: "usage" });
	});

	it("never acts on a clear with extra words", () => {
		assert.deepEqual(parseTasksCommand("clear completed now"), { kind: "usage" });
		assert.deepEqual(parseTasksCommand("clear all please"), { kind: "usage" });
		assert.deepEqual(parseTasksCommand("done 3 now"), { kind: "usage" });
		assert.deepEqual(parseTasksCommand("start 3 4"), { kind: "usage" });
	});

	it("documents the usage string", () => {
		assert.match(TASKS_USAGE, /^Usage: \/tasks/);
		assert.match(TASKS_USAGE, /start <id>/);
		assert.match(TASKS_USAGE, /done <id>/);
		assert.match(TASKS_USAGE, /clear completed/);
	});
});

describe("start / done subcommands", () => {
	const run = (action: "start" | "done", id: string, tasks: Task[]) => {
		const updates: Array<[string, TaskStatus]> = [];
		const outcome = applyTaskAction(action, id, {
			get: (taskId) => tasks.find((t) => t.id === taskId),
			update: (taskId, status) => { updates.push([taskId, status]); },
			onChanged: (taskId) => { updates.push([`changed:${taskId}`, "in_progress"]); },
		});
		return { outcome, updates };
	};

	it("moves a pending task to in_progress", () => {
		const started = run("start", "3", [task({ id: "3", status: "pending" })]);
		assert.equal(started.outcome, "applied");
		assert.deepEqual(started.updates[0], ["3", "in_progress"]);
	});

	it("moves a task to completed", () => {
		const done = run("done", "3", [task({ id: "3", status: "in_progress" })]);
		assert.equal(done.outcome, "applied");
		assert.deepEqual(done.updates[0], ["3", "completed"]);
	});

	it("reports an unknown id instead of throwing", () => {
		const result = run("done", "99", [task({ id: "3" })]);
		assert.equal(result.outcome, "missing");
		assert.deepEqual(result.updates, []);
	});

	it("is idempotent for done on a completed task", () => {
		const result = run("done", "3", [task({ id: "3", status: "completed" })]);
		assert.equal(result.outcome, "unchanged");
		assert.deepEqual(result.updates, []);
	});

	it("refuses to restart a completed task with start", () => {
		const result = run("start", "3", [task({ id: "3", status: "completed" })]);
		assert.equal(result.outcome, "refused");
		assert.deepEqual(result.updates, [], "a refused start must not write");
	});

	it("maps every status/action pair", () => {
		assert.deepEqual(nextTaskStatus("completed", "done"), { kind: "none" });
		assert.deepEqual(nextTaskStatus("completed", "start"), { kind: "refused" });
		assert.deepEqual(nextTaskStatus("in_progress", "start"), { kind: "none" });
		assert.deepEqual(nextTaskStatus("pending", "start"), { kind: "set", status: "in_progress" });
		assert.deepEqual(nextTaskStatus("pending", "done"), { kind: "set", status: "completed" });
	});
});

describe("toTaskRowView", () => {
	it("keeps the status icon", () => {
		assert.equal(toTaskRowView(task()).glyph, "✔");
	});

	it("keeps the id/status/subject row label", () => {
		const row = toTaskRowView(task());
		assert.equal(row.label, "#3 [completed] [llm] wire the overlay");
		assert.equal(row.blocked, false);
	});

	it("marks blocked tasks", () => {
		const row = toTaskRowView(task({ status: "pending", blockedBy: ["1", "2"] }));
		assert.equal(row.glyph, "◻");
		assert.equal(row.blocked, true);
	});

	it("uses the in_progress icon", () => {
		assert.equal(taskStatusGlyph("in_progress"), "◼");
		assert.equal(toTaskRowView(task({ status: "in_progress" })).glyph, "◼");
	});
});

describe("taskDetailRows", () => {
	it("renders all seven detail rows", () => {
		const rows = taskDetailRows(
			task({
				owner: "python-expert",
				blockedBy: ["1", "2"],
				description: "the body",
			}),
		);
		assert.deepEqual(
			rows.map(([label]) => label),
			["Subject", "Status", "Owner", "Blocked by", "Description", "Created", "Updated"],
		);
		assert.deepEqual(rows[0], ["Subject", "wire the overlay"]);
		assert.deepEqual(rows[1], ["Status", "completed"]);
		assert.deepEqual(rows[2], ["Owner", "python-expert"]);
		assert.deepEqual(rows[3], ["Blocked by", "#1, #2"]);
		assert.deepEqual(rows[4], ["Description", "the body"]);
		assert.equal(rows[5][1], new Date(1_700_000_000_000).toLocaleString());
		assert.equal(rows[6][1], new Date(1_700_000_100_000).toLocaleString());
	});

	it("uses dash placeholders for missing fields", () => {
		const rows = taskDetailRows(task({ description: "" }));
		assert.deepEqual(rows[2], ["Owner", "—"]);
		assert.deepEqual(rows[3], ["Blocked by", "—"]);
		assert.deepEqual(rows[4], ["Description", "—"]);
	});
});

describe("formatTasksPlainText", () => {
	it("uses the overlay empty message when there are no tasks", () => {
		assert.equal(formatTasksPlainText([]).split("\n")[0], TASKS_EMPTY_MESSAGE);
	});

	it("lists one line per task with blocked marker", () => {
		const text = formatTasksPlainText([
			task(),
			task({ id: "4", subject: "wait on 3", status: "pending", blockedBy: ["3"] }),
		]);
		assert.deepEqual(text.split("\n"), [
			"◻ #4 [pending] [llm] wait on 3 ⛔ blocked",
			"✔ #3 [completed] [llm] wire the overlay",
			TASKS_HINT,
		]);
	});

	it("always names the subcommands the text output replaces", () => {
		for (const hint of ["create", "start <id>", "done <id>", "clear completed", "clear all"]) {
			assert.match(TASKS_HINT, new RegExp(hint.replace(/[<>]/g, (c) => `\\${c}`)));
		}
		assert.equal(formatTasksPlainText([task()]).split("\n").at(-1), TASKS_HINT);
	});
});

describe("tasksOverlayDeps", () => {
	function deps(store: { list?: () => Task[]; get?: (id: string) => Task | undefined } = {}) {
		const created: string[] = [];
		const updated: Array<[string, string]> = [];
		const ui = tasksOverlayDeps({
			list: store.list ?? (() => []),
			get: store.get ?? (() => undefined),
			create: (subject) => { created.push(subject); return { id: String(created.length) }; },
			update: (id, fields) => { if ("subject" in fields) updated.push([id, fields.subject]); },
		});
		return { ui, created, updated };
	}

	it("maps n to add", () => {
		assert.equal(tasksOverlayIntent("n"), "add");
	});

	it("maps e to edit", () => {
		assert.equal(tasksOverlayIntent("e"), "edit");
	});

	it("ignores every other key", () => {
		for (const key of ["x", "j", "k", "m", "N", ""]) {
			assert.equal(tasksOverlayIntent(key), undefined);
		}
	});

	it("creates a task from the typed subject", () => {
		const { ui, created } = deps();
		const plan = planTaskCompose("  ship the overlay  ");
		assert.deepEqual(plan, { kind: "create", subject: "ship the overlay" });
		if (plan.kind === "create") ui.createTask(plan.subject);
		assert.deepEqual(created, ["ship the overlay"]);
	});

	it("renames through the store", () => {
		const { ui, updated } = deps({ get: () => task({ id: "3" }) });
		const plan = planTaskCompose("new subject", { id: "3", subject: "old subject" });
		assert.deepEqual(plan, { kind: "rename", id: "3", subject: "new subject" });
		if (plan.kind === "rename") ui.updateTaskSubject(plan.id, plan.subject);
		assert.deepEqual(updated, [["3", "new subject"]]);
	});

	it("refuses a cancelled line", () => {
		const { created, updated } = deps({ get: () => task({ id: "3" }) });
		assert.deepEqual(planTaskCompose(undefined), { kind: "skip", reason: "cancelled" });
		assert.deepEqual(created, []);
		assert.deepEqual(updated, []);
	});

	it("refuses a blank line instead of writing an empty subject", () => {
		const { created, updated } = deps({ get: () => task({ id: "3" }) });
		assert.deepEqual(planTaskCompose("   ", { id: "3", subject: "old" }), { kind: "skip", reason: "blank" });
		assert.deepEqual(created, []);
		assert.deepEqual(updated, []);
	});

	it("treats an unchanged subject as a no-op", () => {
		const { created, updated } = deps({ get: () => task({ id: "3", subject: "same" }) });
		assert.deepEqual(planTaskCompose(" same ", { id: "3", subject: "same" }), { kind: "skip", reason: "unchanged" });
		assert.deepEqual(created, []);
		assert.deepEqual(updated, []);
	});

	it("reports a vanished task instead of writing", () => {
		const { ui, updated } = deps();
		assert.equal(ui.updateTaskSubject("99", "anything"), false);
		assert.deepEqual(updated, []);
	});

	it("reads the live store on every call, never a snapshot", () => {
		let tasks = [task({ id: "1" })];
		const deps = tasksOverlayDeps({ list: () => tasks, get: () => undefined, create: () => ({ id: "1" }), update: () => undefined });
		assert.equal(deps.listTasks().length, 1);
		tasks = [task({ id: "1" }), task({ id: "2" })];
		assert.equal(deps.listTasks().length, 2);
	});

	it("deletes through the store", () => {
		const updates: Array<[string, string]> = [];
		const deleted: string[] = [];
		const deps = tasksOverlayDeps(
			{
				list: () => [task({ id: "3" })],
				get: (id) => (id === "3" ? task({ id: "3" }) : undefined),
				create: () => ({ id: "4" }),
				update: (id, fields) => { updates.push([id, "status" in fields ? fields.status : fields.subject]); },
			},
			(id) => { deleted.push(id); },
		);
		assert.equal(deps.deleteTask("3"), true);
		assert.deepEqual(updates, [["3", "deleted"]]);
	});

	it("reports the deletion to the caller", () => {
		const deleted: string[] = [];
		const deps = tasksOverlayDeps(
			{
				list: () => [task({ id: "3" })],
				get: () => task({ id: "3" }),
				create: () => ({ id: "4" }),
				update: () => undefined,
			},
			(id) => { deleted.push(id); },
		);
		deps.deleteTask("3");
		assert.deepEqual(deleted, ["3"]);
	});

	it("does not write for an unknown id", () => {
		let writes = 0;
		const deps = tasksOverlayDeps({ list: () => [], get: () => undefined, create: () => ({ id: "1" }), update: () => { writes++; } });
		assert.equal(deps.deleteTask("99"), false);
		assert.equal(writes, 0);
	});
});

describe("taskComposePrompt (#1089)", () => {
	it("starts a create with an empty line", () => {
		assert.deepEqual(taskComposePrompt(), { title: "New task subject", initialValue: "" });
	});

	it("starts an edit from the current subject, not a placeholder", () => {
		assert.deepEqual(taskComposePrompt({ id: "3", subject: "wire the overlay" }), {
			title: "Edit #3 subject",
			initialValue: "wire the overlay",
		});
	});

	it("feeds the prefill back into the unchanged decision", () => {
		const current = { id: "3", subject: "wire the overlay" };
		assert.deepEqual(planTaskCompose(taskComposePrompt(current).initialValue, current), {
			kind: "skip",
			reason: "unchanged",
		});
	});
});

describe("openTasksOverlay multi-select (#1087)", () => {
	/** A store whose `status: "deleted"` writes are recorded, so "which ids" is observable. */
	function deleteTracking(initial: Task[]) {
		const deleted: string[] = [];
		const tasks = [...initial];
		return {
			deleted,
			store: {
				list: () => tasks.filter((t) => !deleted.includes(t.id)),
				get: (id: string) => tasks.find((t) => t.id === id),
				create: () => ({ id: "99" }),
				update: (id: string, fields: { status?: string }) => {
					if (fields.status === "deleted") deleted.push(id);
				},
			},
		};
	}

	it("x deletes exactly the selected tasks and notifies once", async () => {
		// Space #1, j, Space #2, j to #3 (not selected), x, then close.
		const { ctx, notifications } = makeTasksCtx([[" ", "j", " ", "j", "x", "close"]]);
		const memory = deleteTracking([
			task({ id: "1", status: "pending" }),
			task({ id: "2", status: "pending" }),
			task({ id: "3", status: "pending" }),
		]);
		await openTasksOverlay(ctx, tasksOverlayDeps(memory.store));
		assert.deepEqual(memory.deleted, ["1", "2"], "the focused-but-unselected #3 is untouched");
		assert.deepEqual(notifications, [{ message: "deleted 2 tasks", level: "info" }]);
	});

	it("names a task whose delete did not go through", async () => {
		const { ctx, notifications } = makeTasksCtx([[" ", "j", " ", "x", "close"]]);
		const deps = {
			listTasks: () => [task({ id: "1" }), task({ id: "2" })],
			deleteTask: (id: string) => id !== "2",
			createTask: () => "99",
			updateTaskSubject: () => true,
		};
		await openTasksOverlay(ctx, deps);
		assert.deepEqual(notifications, [
			{ message: "deleted 1 of 2 tasks — failed: #2", level: "warning" },
		]);
	});

	it("keeps deleting after one delete throws", async () => {
		// A store write-lock timeout on #1 must not abandon #2 the user also selected.
		const { ctx, notifications } = makeTasksCtx([[" ", "j", " ", "x", "close"]]);
		const deleted: string[] = [];
		const deps = {
			listTasks: () => [task({ id: "1" }), task({ id: "2" })],
			deleteTask: (id: string) => {
				if (id === "1") throw new Error("store is locked");
				deleted.push(id);
				return true;
			},
			createTask: () => "99",
			updateTaskSubject: () => true,
		};
		await openTasksOverlay(ctx, deps);
		assert.deepEqual(deleted, ["2"], "the throw did not abort the remaining delete");
		assert.deepEqual(notifications, [
			{ message: "deleted 1 of 2 tasks — failed: #1", level: "warning" },
		]);
	});

	for (const key of ["n", "e"]) {
		it(`refuses ${key} while a selection exists, without opening a dialog`, async () => {
			const { ctx, notifications, openedCount } = makeTasksCtx([[" ", key, "close"]]);
			const memory = inMemoryStore([task({ id: "3", subject: "wire the overlay" })]);
			await openTasksOverlay(ctx, tasksOverlayDeps(memory.store));
			assert.equal(openedCount(), 1, "the list is not re-opened: no dialog ran");
			assert.deepEqual(memory.created, []);
			assert.equal(notifications.length, 1);
			assert.equal(notifications[0].level, "warning");
			assert.match(notifications[0].message, /clear the selection \(Space\)/);
		});
	}

	it("still acts on the focused row when nothing is selected", async () => {
		const { ctx, openedCount } = makeTasksCtx([["e"], ["\n"]]);
		const memory = inMemoryStore([task({ id: "3", subject: "wire the overlay" })]);
		await openTasksOverlay(ctx, tasksOverlayDeps(memory.store));
		assert.equal(openedCount(), 3, "the edit dialog opened, then the list re-opened");
	});
});

/**
 * An empty board has no row to press `n` on: `openTasksOverlay` must open the create dialog
 * itself. `ctx.ui.custom` is mocked so the real list overlay and the real input dialog receive
 * the keystrokes (#1089).
 */
function makeTasksCtx(opens: string[][]) {
	const notifications: Array<{ message: string; level: string }> = [];
	/** Rendered frame of every list that opened — the footer is asserted through what is drawn. */
	const frames: string[][] = [];
	let opened = 0;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const tui = { terminal: { rows: 20 }, requestRender: () => {} };
	const keybindings = { matches: (data: string, action: string) => action === "tui.select.cancel" && data === "close" };
	const ctx = {
		hasUI: true,
		ui: {
			notify: (message: string, level: string) => { notifications.push({ message, level }); },
			input: async () => undefined,
			custom: async (factory: any) => {
				const keys = opens[opened];
				opened += 1;
				if (!keys) return null; // a further open: close it
				return new Promise((resolve) => {
					const component = factory(tui, theme, keybindings, resolve);
					frames.push(component.render(100));
					for (const key of keys) component.handleInput(key);
				});
			},
		},
	};
	return { ctx: ctx as any, notifications, openedCount: () => opened, frames };
}

function inMemoryStore(initial: Task[] = []) {
	const tasks = [...initial];
	const created: string[] = [];
	return {
		tasks,
		created,
		store: {
			list: () => tasks,
			get: (id: string) => tasks.find((t) => t.id === id),
			create: (subject: string) => { created.push(subject); const next = task({ id: String(tasks.length + 1), subject, status: "pending" }); tasks.push(next); return { id: next.id }; },
			update: () => undefined,
		},
	};
}

describe("openTasksOverlay footer (#1089)", () => {
	it("names only keys that work, with or without a selection", async () => {
		// `x` deletes the selection when there is one and the focused row otherwise, and Esc
		// always closes — the footer must not promise one and hide the other.
		const { ctx, frames } = makeTasksCtx([["close"]]);
		await openTasksOverlay(ctx, tasksOverlayDeps(inMemoryStore([task({ id: "3" })]).store));
		const footer = frames[0].find((line) => line.includes("Space select")) ?? "";
		assert.equal(
			footer.trim(),
			"Space select · x delete · n add · e edit · d done · f mine/all · Enter view · Esc close",
		);
	});
});

describe("openTasksOverlay first task (#1089)", () => {
	it("creates the first task when the board is empty", async () => {
		const { ctx, openedCount } = makeTasksCtx([["first task", "\n"]]);
		const memory = inMemoryStore();
		await openTasksOverlay(ctx, tasksOverlayDeps(memory.store));
		assert.deepEqual(memory.created, ["first task"]);
		assert.equal(memory.tasks.length, 1, "the created task is visible to the next list");
		assert.equal(openedCount(), 2, "the list re-opens on the new task");
	});

	it("returns instead of reopening a cancelled first-task dialog", async () => {
		const { ctx, openedCount } = makeTasksCtx([["\x1b"]]);
		const memory = inMemoryStore();
		await openTasksOverlay(ctx, tasksOverlayDeps(memory.store));
		assert.deepEqual(memory.created, []);
		assert.equal(memory.tasks.length, 0);
		assert.equal(openedCount(), 1, "a cancel must not loop");
	});

	it("does not create from a blank first-task line", async () => {
		const { ctx } = makeTasksCtx([["\n"]]);
		const memory = inMemoryStore();
		await openTasksOverlay(ctx, tasksOverlayDeps(memory.store));
		assert.deepEqual(memory.created, []);
	});
});

describe("openTasksOverlay edit prefill (#1089)", () => {
	it("opens the edit dialog on the current subject", async () => {
		// 1st open: the list, `e` on the focused row. 2nd: the subject dialog, typed onto the
		// prefill. A placeholder-only dialog would submit " x", not "wire the overlay x".
		const { ctx } = makeTasksCtx([["e"], [" x", "\n"]]);
		const memory = inMemoryStore([task({ id: "3", subject: "wire the overlay" })]);
		const updates: Array<[string, string]> = [];
		await openTasksOverlay(ctx, tasksOverlayDeps({
			...memory.store,
			update: (id, fields) => { if ("subject" in fields) updates.push([id, fields.subject]); },
		}));
		assert.deepEqual(updates, [["3", "wire the overlay x"]]);
	});

	it("writes nothing when the prefilled subject is saved unchanged", async () => {
		const { ctx } = makeTasksCtx([["e"], ["\n"]]);
		const memory = inMemoryStore([task({ id: "3", subject: "wire the overlay" })]);
		let writes = 0;
		await openTasksOverlay(ctx, tasksOverlayDeps({
			...memory.store,
			update: () => { writes++; },
		}));
		assert.equal(writes, 0);
	});
});
