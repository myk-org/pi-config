import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	TASKS_EMPTY_MESSAGE,
	TASKS_USAGE,
	applyTaskAction,
	formatTasksPlainText,
	nextTaskStatus,
	parseTasksCommand,
	taskDetailRows,
	taskStatusGlyph,
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

	it("routes clear completed and clear all", () => {
		assert.deepEqual(parseTasksCommand("clear completed"), { kind: "clear-completed" });
		assert.deepEqual(parseTasksCommand("clear all"), { kind: "clear-all" });
	});

	it("routes start and done by id", () => {
		assert.deepEqual(parseTasksCommand("start 3"), { kind: "start", id: "3" });
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

	it("prints usage for unknown subcommands and incomplete clear", () => {
		assert.deepEqual(parseTasksCommand("view"), { kind: "usage" });
		assert.deepEqual(parseTasksCommand("clear"), { kind: "usage" });
		assert.deepEqual(parseTasksCommand("clear pending"), { kind: "usage" });
		assert.deepEqual(parseTasksCommand("create extra"), { kind: "usage" });
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

	it("moves a pending task to in_progress and a task to completed", () => {
		const started = run("start", "3", [task({ id: "3", status: "pending" })]);
		assert.equal(started.outcome, "applied");
		assert.deepEqual(started.updates[0], ["3", "in_progress"]);

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
		assert.equal(nextTaskStatus("completed", "done"), null);
		assert.equal(nextTaskStatus("in_progress", "start"), null);
		assert.equal(nextTaskStatus("pending", "start"), "in_progress");
		assert.equal(nextTaskStatus("pending", "done"), "completed");
	});
});

describe("toTaskRowView", () => {
	it("keeps the status icon and id/status/subject row label", () => {
		const row = toTaskRowView(task());
		assert.equal(row.glyph, "✔");
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
	it("renders subject, status, owner, blocked-by, description, created and updated", () => {
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

	it("uses placeholders for missing owner, blockers and description", () => {
		const rows = taskDetailRows(task({ description: "" }));
		assert.deepEqual(rows[2], ["Owner", "—"]);
		assert.deepEqual(rows[3], ["Blocked by", "—"]);
		assert.deepEqual(rows[4], ["Description", "—"]);
	});
});

describe("formatTasksPlainText", () => {
	it("uses the overlay empty message when there are no tasks", () => {
		assert.equal(formatTasksPlainText([]), TASKS_EMPTY_MESSAGE);
	});

	it("lists one line per task with blocked marker", () => {
		const text = formatTasksPlainText([
			task(),
			task({ id: "4", subject: "wait on 3", status: "pending", blockedBy: ["3"] }),
		]);
		assert.deepEqual(text.split("\n"), [
			"✔ #3 [completed] wire the overlay",
			"◻ #4 [pending] wait on 3 ⛔ blocked",
		]);
	});
});
