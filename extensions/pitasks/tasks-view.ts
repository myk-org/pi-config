/**
 * tasks-view.ts — Pure /tasks view + command routing helpers (no TUI deps).
 *
 * Kept separate from tasks-ui.ts so the row/detail mapping and the subcommand
 * parser can be unit-tested without pi-tui or an ExtensionCommandContext.
 */
import type { Task, TaskStatus } from "./types.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("pitasks");

export const TASKS_USAGE =
	"Usage: /tasks [create | start <id> | done <id> | clear completed | clear all]";
export const TASKS_EMPTY_MESSAGE = "No tasks.";

export type TasksCommand =
	| { kind: "list" }
	| { kind: "create" }
	| { kind: "start"; id: string }
	| { kind: "done"; id: string }
	| { kind: "clear-completed" }
	| { kind: "clear-all" }
	| { kind: "usage" };

/** `/tasks <args>` — the command never opens a nested menu. */
export function parseTasksCommand(args: string | undefined): TasksCommand {
	const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
	const [sub, target] = parts;
	if (!sub) return { kind: "list" };
	if (sub === "create") {
		if (parts.length > 1) return { kind: "usage" };
		return { kind: "create" };
	}
	if (sub === "start" || sub === "done") {
		const id = (target ?? "").replace(/^#/, "");
		if (parts.length !== 2 || !/^\d+$/.test(id)) return { kind: "usage" };
		return { kind: sub, id };
	}
	if (sub === "clear") {
		if (target === "completed") return { kind: "clear-completed" };
		if (target === "all") return { kind: "clear-all" };
	}
	log.debug("tasks_command_unrecognised", { args: (args ?? "").slice(0, 80) });
	return { kind: "usage" };
}

export interface TaskRowView {
	/** Status icon kept from the old menu flow. */
	glyph: string;
	/** `#3 [completed] subject` — same text as before, now one overlay row. */
	label: string;
	blocked: boolean;
}

export function taskStatusGlyph(status: string): string {
	return status === "completed" ? "✔" : status === "in_progress" ? "◼" : "◻";
}

/** The only fields a row needs — a coms peer's task report has no store record. */
export interface TaskRowSource {
	id: string;
	status: string;
	subject: string;
	blockedBy?: readonly string[];
}

export function toTaskRowView(task: TaskRowSource): TaskRowView {
	const blocked = (task.blockedBy?.length ?? 0) > 0;
	return {
		glyph: taskStatusGlyph(task.status),
		label: `#${task.id} [${task.status}] ${task.subject}`,
		blocked,
	};
}

/** The ONE task-row line: `/tasks` plain text and the coms drilldown both use it. */
export function formatTaskRowLine(task: TaskRowSource): string {
	const row = toTaskRowView(task);
	return `${row.glyph} ${row.label}${row.blocked ? " ⛔ blocked" : ""}`;
}

/** Uncolored (label, value) rows rendered by the task detail pane. */
export function taskDetailRows(task: Task): Array<[string, string]> {
	const rows: Array<[string, string]> = [
		["Subject", task.subject],
		["Status", task.status],
		["Owner", task.owner || "—"],
		["Blocked by", task.blockedBy.length > 0 ? task.blockedBy.map((id) => `#${id}`).join(", ") : "—"],
		["Description", task.description || "—"],
		["Created", new Date(task.createdAt).toLocaleString()],
		["Updated", new Date(task.updatedAt).toLocaleString()],
	];
	log.debug("task_detail_rows", { taskId: task.id, rows: rows.length, blocked: task.blockedBy.length });
	return rows;
}

/** Headless (no UI) listing — the same rows the overlay would show. */export function formatTasksPlainText(tasks: readonly Task[]): string {
	if (tasks.length === 0) return TASKS_EMPTY_MESSAGE;
	log.debug("tasks_plain_list", { count: tasks.length });
	return tasks.map(formatTaskRowLine).join("\n");
}

export type TaskAction = "start" | "done";
export type TaskActionOutcome = "applied" | "missing" | "unchanged";

/** The status `start`/`done` sets, or null when the task already has it (idempotent). */
export function nextTaskStatus(current: string, action: TaskAction): TaskStatus | null {
	const target: TaskStatus = action === "start" ? "in_progress" : "completed";
	return current === target ? null : target;
}

export interface TaskActionDeps {
	get: (id: string) => Task | undefined;
	update: (id: string, status: TaskStatus) => void;
	/** Called only when something actually changed. */
	onChanged?: (id: string, status: TaskStatus) => void;
}

/** Apply `/tasks start|done <id>`. An unknown id is a result, never a throw. */
export function applyTaskAction(
	action: TaskAction,
	id: string,
	deps: TaskActionDeps,
): TaskActionOutcome {
	const task = deps.get(id);
	if (!task) {
		log.warn("task_action_missing", { action, id });
		return "missing";
	}
	const status = nextTaskStatus(task.status, action);
	if (!status) {
		log.debug("task_action_unchanged", { action, id, status: task.status });
		return "unchanged";
	}
	deps.update(id, status);
	deps.onChanged?.(id, status);
	log.info("task_action_applied", { action, id, status });
	return "applied";
}
