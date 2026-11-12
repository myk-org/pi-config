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
/** Text output (headless or browser) carries the actions the overlay cannot offer there. */
export const TASKS_HINT =
	"Subcommands: /tasks create · start <id> · done <id> · clear completed · clear all";

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
	if (sub === "clear" && parts.length === 2) {
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
	log.debug("tasks_plain_list", { count: tasks.length });
	const rows = tasks.length === 0 ? [TASKS_EMPTY_MESSAGE] : tasks.map(formatTaskRowLine);
	return [...rows, TASKS_HINT].join("\n");
}

/** List keys beyond the shared ones (j/k, Enter, x, Esc) — issue #1087. */
export function tasksOverlayIntent(key: string): "add" | "edit" | undefined {
	if (key === "n") return "add";
	if (key === "e") return "edit";
	return undefined;
}

/**
 * The one-line subject dialog's title and starting text. An edit starts from the CURRENT subject
 * (a placeholder would turn a rename into a full retype); a create starts empty.
 */
export function taskComposePrompt(
	current?: { id: string; subject: string },
): { title: string; initialValue: string } {
	if (!current) return { title: "New task subject", initialValue: "" };
	return { title: `Edit #${current.id} subject`, initialValue: current.subject };
}

/** What the overlay's one-line dialog asked for, turned into at most one store write. */
export type TaskComposeIntent =
	| { kind: "create"; subject: string }
	| { kind: "rename"; id: string; subject: string }
	/** Nothing is written: the dialog was cancelled, the line was blank, or nothing changed. */
	| { kind: "skip"; reason: "cancelled" | "blank" | "unchanged" };

/**
 * A blank line is refused rather than stored as an empty subject, and re-typing the current
 * subject is a no-op, so neither path writes.
 */
export function planTaskCompose(
	input: string | undefined,
	current?: { id: string; subject: string },
): TaskComposeIntent {
	if (input === undefined) return { kind: "skip", reason: "cancelled" };
	const subject = input.trim();
	if (!subject) return { kind: "skip", reason: "blank" };
	if (!current) return { kind: "create", subject };
	if (subject === current.subject) return { kind: "skip", reason: "unchanged" };
	return { kind: "rename", id: current.id, subject };
}

export type TaskAction = "start" | "done";
export type TaskActionOutcome = "applied" | "missing" | "unchanged" | "refused";

/** What `/tasks start|done <id>` would do to a task in this status. */
export type TaskTransition =
	| { kind: "set"; status: TaskStatus }
	/** Already in the target status — idempotent, no write. */
	| { kind: "none" }
	/** Completed work is not reopened by `start`; `done` on it stays idempotent. */
	| { kind: "refused" };

export function nextTaskStatus(current: string, action: TaskAction): TaskTransition {
	if (action === "start" && current === "completed") return { kind: "refused" };
	const target: TaskStatus = action === "start" ? "in_progress" : "completed";
	return current === target ? { kind: "none" } : { kind: "set", status: target };
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
	const transition = nextTaskStatus(task.status, action);
	if (transition.kind === "refused") {
		log.info("task_action_refused", { action, id, status: task.status });
		return "refused";
	}
	if (transition.kind === "none") {
		log.debug("task_action_unchanged", { action, id, status: task.status });
		return "unchanged";
	}
	deps.update(id, transition.status);
	deps.onChanged?.(id, transition.status);
	log.info("task_action_applied", { action, id, status: transition.status });
	return "applied";
}

/** The deps `openTasksOverlay` needs, bound to the live store (never a snapshot). */
export function tasksOverlayDeps(
	store: {
		list: () => Task[];
		get: (id: string) => Task | undefined;
		create: (subject: string, description: string, createdBy: Task["createdBy"]) => { id: string };
		update: (id: string, fields: { status: "deleted" } | { subject: string }) => unknown;
	},
	onDeleted?: (id: string) => void,
): TasksUiDeps {
	return {
		listTasks: () => store.list(),
		// The one-line dialog only carries a subject; the description stays empty like a fresh task.
		createTask: (subject) => {
			const task = store.create(subject, "", { type: "local", origin: "user", session: "", project: process.cwd() });
			log.info("task_created", { id: task.id });
			return task.id;
		},
		updateTaskSubject: (id, subject) => {
			if (!store.get(id)) {
				log.warn("task_edit_missing", { id });
				return false;
			}
			store.update(id, { subject });
			log.info("task_subject_updated", { id });
			return true;
		},
		deleteTask: (id) => {
			if (!store.get(id)) {
				log.warn("task_delete_missing", { id });
				return false;
			}
			store.update(id, { status: "deleted" });
			onDeleted?.(id);
			log.info("task_deleted", { id });
			return true;
		},
	};
}

/** What the overlay renders — pure data + callbacks, no TUI types. */
export interface TasksUiDeps {
	listTasks: () => Task[];
	/** Delete by task id. Returns true when the task was removed. */
	deleteTask: (id: string) => boolean;
	/** Create a task from one line of input; returns the new task id. */
	createTask: (subject: string) => string;
	/** Rename a task's subject. Returns false when the task is gone. */
	updateTaskSubject: (id: string, subject: string) => boolean;
}
