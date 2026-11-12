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
	taskDetailRows,
	taskStatusGlyph,
	tasksOverlayDeps,
	toTaskRowView,
} from "../../../extensions/pitasks/tasks-view.ts";
import type { Task, TaskStatus } from "../../../extensions/pitasks/types.ts";

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
		assert.equal(row.label, "#3 [completed] wire the overlay");
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
			"✔ #3 [completed] wire the overlay",
			"◻ #4 [pending] wait on 3 ⛔ blocked",
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
	it("reads the live store on every call, never a snapshot", () => {
		let tasks = [task({ id: "1" })];
		const deps = tasksOverlayDeps({ list: () => tasks, get: () => undefined, update: () => undefined });
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
				update: (id, fields) => { updates.push([id, fields.status]); },
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
				update: () => undefined,
			},
			(id) => { deleted.push(id); },
		);
		deps.deleteTask("3");
		assert.deepEqual(deleted, ["3"]);
	});

	it("does not write for an unknown id", () => {
		let writes = 0;
		const deps = tasksOverlayDeps({ list: () => [], get: () => undefined, update: () => { writes++; } });
		assert.equal(deps.deleteTask("99"), false);
		assert.equal(writes, 0);
	});
});
