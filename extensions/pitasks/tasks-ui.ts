/**
 * tasks-ui.ts — /tasks fullscreen list → detail overlay.
 *
 * Same shared component as /cron list and /async-status (openListDetailOverlay +
 * OverlayScrollDetail), so j/k, Enter, x and Esc mean the same thing everywhere.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Input, Text } from "@earendil-works/pi-tui";
import {
	bulkRemove,
	bulkResultMessage,
	matchesOverlayKey,
	openListDetailOverlay,
	OverlayScrollDetail,
	type OverlayNotice,
} from "../orchestrator/overlay-dashboard.js";
import type { Task } from "./types.js";
import {
	TASKS_EMPTY_MESSAGE,
	bulkTaskCompletionPrompt,
	planTaskCompose,
	planTaskCompletion,
	selectTaskRows,
	taskCompletionPrompt,
	taskComposePrompt,
	taskDetailRows,
	tasksOverlayIntent,
	toTaskRowView,
	type TasksUiDeps,
} from "./tasks-view.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("pitasks");

function glyphColor(status: string): "success" | "warning" | "muted" {
	if (status === "completed") return "success";
	if (status === "in_progress") return "warning";
	return "muted";
}

function detailHeader(task: Task, theme: Theme, taskById: Map<string, Task>): string {
	const row = toTaskRowView(task, (id) => taskById.get(id));
	return (
		`${theme.fg(glyphColor(task.status), row.glyph)} ` +
		theme.fg("accent", theme.bold(row.label)) +
		theme.fg("muted", ` · ${task.owner || "unassigned"}`) +
		(row.blocked ? theme.fg("warning", " · ⛔ blocked") : "")
	);
}

/** The subject/note dialogs share one input dialog: Enter accepts, Esc cancels. */
async function promptLine(
	ctx: ExtensionCommandContext,
	prompt: { title: string; placeholder: string; initialValue?: string },
): Promise<string | undefined> {
	if (typeof ctx.ui.custom !== "function") return ctx.ui.input(prompt.title, prompt.initialValue ?? "");
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const input = new Input({ placeholder: prompt.placeholder });
		// Bracketed paste puts the cursor AFTER the prefilled subject; setValue alone would leave it
		// at 0, so the next keystroke would land in front of the name being edited.
		if (prompt.initialValue) input.handleInput(`\x1b[200~${prompt.initialValue}\x1b[201~`);
		input.onSubmit = (value: string) => done(value);
		input.onEscape = () => done(undefined);
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", prompt.title), 1, 0));
		container.addChild(input);
		container.addChild(new Text(theme.fg("dim", "enter save · esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		let focused = false;
		return {
			set focused(value: boolean) { focused = value; input.focused = value; },
			get focused(): boolean { return focused; },
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => { input.handleInput(data); tui.requestRender(); },
		};
	});
}

const TASKS_LIST_HINTS = "Space select · x delete · n add · e edit · d done · f mine/all · Enter view · Esc close";
const TASKS_SELECTED_HINTS = "Space toggle · d done · x delete · Enter view · Esc clear";

/** Complete a multi-selected batch of tasks (shared by immediate LLM-only and post-note user flows). */
function applyBulkTaskCompletion(
	deps: TasksUiDeps,
	selected: readonly Task[],
	note?: string,
): { notice: OverlayNotice; clearSelection: boolean } {
	const open = selected.filter((t) => t.status !== "completed");
	const skipped = selected.length - open.length;
	if (open.length === 0) {
		log.debug("tasks_overlay_bulk_complete_unchanged", { selected: selected.length });
		return {
			notice: {
				message:
					selected.length === 1
						? `Task #${selected[0].id} is already completed.`
						: `All ${selected.length} selected tasks are already completed.`,
				level: "info",
			},
			clearSelection: false,
		};
	}
	const batchNotice = typeof deps.notifyUserCompleted === "function";
	const { failed, errors } = bulkRemove(open, (t) =>
		deps.completeTask(t.id, {
			by: "user",
			...(t.assignee === "user" && note ? { note } : {}),
			...(batchNotice ? { silent: true } : {}),
		}),
	);
	const failedIds = new Set(failed.map((t) => t.id));
	const completedUserTasks = open
		.filter((t) => t.assignee === "user" && !failedIds.has(t.id))
		.map((t) => ({ id: t.id, subject: t.subject }));
	let noticeFailed = false;
	if (batchNotice && completedUserTasks.length > 0) {
		try {
			noticeFailed = !deps.notifyUserCompleted!(completedUserTasks, note);
		} catch (err) {
			noticeFailed = true;
			log.error("tasks_overlay_bulk_notice_threw", {
				count: completedUserTasks.length,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	const names = failed.map((t) => `#${t.id}`);
	log.info("tasks_overlay_bulk_complete", {
		selected: selected.length,
		open: open.length,
		skipped,
		failed: names.length,
		noticeFailed,
		errors,
	});
	const base = bulkResultMessage("completed", "task", open.length, names);
	const withSkipped = skipped > 0 ? `${base} (${skipped} already completed)` : base;
	const message = noticeFailed
		? `${withSkipped} — owner notice failed to submit; read via TaskGet`
		: withSkipped;
	return {
		notice: { message, level: names.length === 0 && !noticeFailed ? "info" : "warning" },
		clearSelection: true,
	};
}

/** Open the task list overlay; loops list → detail until the list is closed. `mine` starts the
 *  overlay on the owner's rows only; `f` toggles the same filter in place (#1090). */
export async function openTasksOverlay(
	ctx: ExtensionCommandContext,
	deps: TasksUiDeps,
	opts: { mine?: boolean } = {},
): Promise<void> {
	let initialTasks: Task[] | null = deps.listTasks();
	if (log.isDebugEnabled()) log.debug("tasks_overlay_open", { tasks: initialTasks.length, mine: !!opts.mine });
	let mineOnly = opts.mine ?? false;
	// `n`/`e`/user-`d` need the whole terminal for the input dialog, so the list closes and the loop
	// below re-opens it — which also re-reads the store, so the new/edited row is never a stale snapshot.
	const queue: Array<
		| { kind: "add" }
		| { kind: "edit"; task: Task }
		| { kind: "complete"; task: Task }
		| { kind: "bulk-complete"; tasks: readonly Task[] }
	> = [];
	// Preserved across dialog cancel (e.g. Esc in bulk-complete note prompt); cleared once consumed.
	let reselectIds: string[] = [];
	let pendingNotice: OverlayNotice | undefined;
	// An empty board has no row to press `n` on, so the create dialog opens directly — once, so a
	// cancelled dialog returns the terminal instead of reopening forever (issue #1089).
	let offeredFirstTask = false;
	let taskById = new Map<string, Task>();

	for (;;) {
		const currentTasks = initialTasks ?? deps.listTasks();
		initialTasks = null;
		if (currentTasks.length === 0) {
			if (offeredFirstTask) return;
			log.debug("tasks_overlay_empty_board", { offeredFirstTask });
			offeredFirstTask = true;
			queue.push({ kind: "add" });
		} else {
			const noticeForOpen = pendingNotice;
			pendingNotice = undefined;
			await openListDetailOverlay(ctx, {
				emptyMessage: mineOnly ? "No tasks assigned to you." : TASKS_EMPTY_MESSAGE,
				allowEmpty: true,
				initialSelectionIds: reselectIds,
				initialNotice: noticeForOpen,
				listSpec: {
					emptyBody: () =>
						mineOnly
							? "No tasks assigned to you. Press f for all or n to add."
							: "No tasks. Press n to add.",
					title: mineOnly ? "Tasks · mine" : "Tasks",
					countLabel: (tasks) => `${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
					borderTitle: (tasks) => {
						const done = tasks.filter((t) => t.status === "completed").length;
						return `tasks · ${done} done / ${tasks.length}${mineOnly ? " · mine" : ""}`;
					},
					footerHints: TASKS_LIST_HINTS,
					selectedFooterHints: TASKS_SELECTED_HINTS,
					onSelectionChange: (ids) => {
						reselectIds = ids.map(String);
					},
					listItems: () => {
						const allTasks = deps.listTasks();
						taskById = new Map(allTasks.map((t) => [t.id, t]));
						return selectTaskRows(allTasks, { mine: mineOnly });
					},
					rowParts: (task, theme) => {
						const row = toTaskRowView(task, (id) => taskById.get(id));
						return {
							glyph: theme.fg(glyphColor(task.status), row.glyph),
							title: row.label,
							idLabel: "",
							rightParts: row.blocked ? [theme.fg("warning", "⛔ blocked")] : [],
						};
					},
					onKey: (key, task, selected, notify) => {
						if (matchesOverlayKey(key, "f")) {
							mineOnly = !mineOnly;
							log.debug("tasks_overlay_filter", { mine: mineOnly });
							return "redraw";
						}
						const intent = tasksOverlayIntent(key);
						if (!intent) return false;
						if (selected.length > 0) {
							if (intent === "done") {
								const open = selected.filter((t) => t.status !== "completed");
								if (open.some((t) => t.assignee === "user")) {
									// Open ONE shared optional-note dialog for the whole batch (Esc cancels
									// without modifying tasks or losing selection).
									queue.push({ kind: "bulk-complete", tasks: [...selected] });
									log.debug("tasks_overlay_bulk_complete_prompt", { selected: selected.length, open: open.length });
									return "close";
								}
								const { notice, clearSelection } = applyBulkTaskCompletion(deps, selected);
								notify(notice.message, notice.level);
								return clearSelection ? "redraw-clear" : "redraw";
							}
							// Add/edit are single-row by nature: acting on the focused row while rows are picked
							// would silently ignore the selection, so refuse and leave the rows selected.
							log.debug("tasks_overlay_key_refused", { intent, selected: selected.length });
							const label = intent === "add" ? "Add" : "Edit";
							notify(
								`${label} works on one task — clear the selection (Esc) first.`,
								"warning",
							);
							return "redraw";
						}
						if (intent === "add") queue.push({ kind: "add" });
						else if (intent === "edit") {
							if (!task) return false;
							queue.push({ kind: "edit", task });
						} else {
							if (!task) return false;
							// `completeTask` drops a note for a task it finds already done, so never prompt for one.
							if (task.status === "completed") {
								log.debug("tasks_overlay_complete_unchanged", { taskId: task.id });
								notify(`Task #${task.id} is already completed.`, "info");
								return "redraw";
							}
							// The owner closes their own task with an optional note; the agent's task just closes.
							if (task.assignee === "user") queue.push({ kind: "complete", task });
							else {
								log.info("tasks_overlay_complete", { taskId: task.id });
								deps.completeTask(task.id, { by: "user" });
								return "redraw";
							}
						}
						log.debug("tasks_overlay_key", { intent, taskId: task?.id });
						return "close";
					},
					onX: (task) => {
						log.info("tasks_overlay_delete", { taskId: task.id });
						deps.deleteTask(task.id);
					},
					selectable: true,
					onXSelected: (tasks, notify) => {
						// Same destructive action `x` does per row, so no confirmation — but the row store can
						// reject a delete, and those ids must be named rather than counted as deleted. Each delete
						// is isolated: a throw on one task must not abort the rest of the selection.
						const { failed, errors } = bulkRemove(tasks, (task) => deps.deleteTask(task.id));
						const names = failed.map((task) => `#${task.id}`);
						log.info("tasks_overlay_bulk_delete", { selected: tasks.length, failed: names.length, errors });
						notify(
							bulkResultMessage("deleted", "task", tasks.length, names),
							names.length === 0 ? "info" : "warning",
						);
					},
				},
				createDetail: (task, tui, theme, done) => {
					const taskId = task.id;
					const snapshot = () => {
						const byId = new Map(deps.listTasks().map((t) => [t.id, t]));
						return { live: byId.get(taskId), byId };
					};
					return new OverlayScrollDetail(
						tui,
						theme,
						{
							footerHints: "↑↓/jk scroll · x delete · Esc back",
							onX: () => deps.deleteTask(taskId),
							getHeader: (t) => {
								const { live, byId } = snapshot();
								if (!live) return t.fg("error", "Task deleted.");
								return detailHeader(live, t, byId);
							},
							getBodyLines: (t) => {
								const { live, byId } = snapshot();
								if (!live) {
									return [t.fg("error", "Task deleted."), t.fg("dim", "Esc back")];
								}
								return taskDetailRows(live, (id) => byId.get(id)).map(
									([label, value]) => `${t.fg("muted", label.padEnd(11))}  ${value}`,
								);
							},
						},
						done,
					);
				},
			});
		}

		const request = queue.pop();
		if (!request) return;
		if (request.kind === "bulk-complete") {
			const openCount = request.tasks.filter((t) => t.status !== "completed").length;
			const note = await promptLine(ctx, bulkTaskCompletionPrompt(openCount));
			const plan = planTaskCompletion(note);
			if (plan.kind === "skip") {
				log.debug("tasks_overlay_bulk_completion_skipped", { reason: plan.reason, selected: request.tasks.length });
				continue;
			}
			// Re-read live task snapshots so concurrent completions/deletions during the prompt are accounted for accurately.
			const liveById = new Map(deps.listTasks().map((t) => [t.id, t]));
			const liveSelected = request.tasks.map((t) => liveById.get(t.id) ?? t);
			const { notice, clearSelection } = applyBulkTaskCompletion(deps, liveSelected, plan.note);
			if (clearSelection) reselectIds = [];
			pendingNotice = notice;
			try { ctx.ui?.notify?.(notice.message, notice.level); } catch {}
			continue;
		}
		if (request.kind === "complete") {
			const note = await promptLine(ctx, taskCompletionPrompt(request.task));
			const plan = planTaskCompletion(note);
			if (plan.kind === "skip") {
				log.debug("tasks_overlay_completion_skipped", { reason: plan.reason, taskId: request.task.id });
				continue;
			}
			log.info("tasks_overlay_complete_by_user", { taskId: request.task.id });
			deps.completeTask(request.task.id, { by: "user", ...(plan.note ? { note: plan.note } : {}) });
			continue;
		}
		const editing = request.kind === "edit" ? request.task : undefined;
		const text = await promptLine(ctx, {
			...taskComposePrompt(editing && { id: editing.id, subject: editing.subject }),
			placeholder: "one line: the task subject",
		});
		const plan = planTaskCompose(text, editing && { id: editing.id, subject: editing.subject });
		if (plan.kind === "skip") {
			log.debug("tasks_overlay_compose_skipped", { reason: plan.reason, taskId: editing?.id });
			continue;
		}
		if (plan.kind === "create") {
			const choice = await promptLine(ctx, { title: "Who is this task for?", placeholder: "you or llm" });
			const assignee = choice?.trim().toLowerCase();
			if (assignee !== "you" && assignee !== "llm") {
				log.debug("tasks_overlay_assignee_cancelled");
				continue;
			}
			deps.createTask(plan.subject, assignee === "you" ? "user" : "llm");
		} else deps.updateTaskSubject(plan.id, plan.subject);
	}
}
