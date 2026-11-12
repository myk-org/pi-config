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
	openListDetailOverlay,
	OverlayScrollDetail,
} from "../orchestrator/overlay-dashboard.js";
import type { Task } from "./types.js";
import {
	TASKS_EMPTY_MESSAGE,
	planTaskCompose,
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

function detailHeader(task: Task, theme: Theme): string {
	const row = toTaskRowView(task);
	return (
		`${theme.fg(glyphColor(task.status), row.glyph)} ` +
		theme.fg("accent", theme.bold(row.label)) +
		theme.fg("muted", ` · ${task.owner || "unassigned"}`) +
		(row.blocked ? theme.fg("warning", " · ⛔ blocked") : "")
	);
}

/** The subject dialog, PRE-FILLED with the current subject — `ctx.ui.input` can only show it as a
 *  placeholder, which turns a rename into a full retype (issue #1089). Enter accepts, Esc cancels. */
async function promptSubject(
	ctx: ExtensionCommandContext,
	prompt: { title: string; initialValue: string },
): Promise<string | undefined> {
	if (typeof ctx.ui.custom !== "function") return ctx.ui.input(prompt.title, prompt.initialValue);
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const input = new Input({ placeholder: "one line: the task subject" });
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

/** Open the task list overlay; loops list → detail until the list is closed. */
export async function openTasksOverlay(
	ctx: ExtensionCommandContext,
	deps: TasksUiDeps,
): Promise<void> {
	log.debug("tasks_overlay_open", { tasks: deps.listTasks().length });
	// `n`/`e` need the whole terminal for the input dialog, so the list closes and the loop below
	// re-opens it — which also re-reads the store, so the new/edited row is never a stale snapshot.
	const queue: Array<{ kind: "add" } | { kind: "edit"; task: Task }> = [];
	// An empty board has no row to press `n` on, so the create dialog opens directly — once, so a
	// cancelled dialog returns the terminal instead of reopening forever (issue #1089).
	let offeredFirstTask = false;

	for (;;) {
		if (deps.listTasks().length === 0) {
			if (offeredFirstTask) return;
			log.debug("tasks_overlay_empty_board", { offeredFirstTask });
			offeredFirstTask = true;
			queue.push({ kind: "add" });
		} else {
			await openListDetailOverlay(ctx, {
				emptyMessage: TASKS_EMPTY_MESSAGE,
				listSpec: {
					title: "Tasks",
					countLabel: (tasks) => `${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
					borderTitle: (tasks) => {
						const done = tasks.filter((t) => t.status === "completed").length;
						return `tasks · ${done} done / ${tasks.length}`;
					},
					footerHints: "↑↓/jk select · Enter view · n add · e edit · x delete · Esc close",
					listItems: () => deps.listTasks(),
					rowParts: (task, theme) => {
						const row = toTaskRowView(task);
						return {
							glyph: theme.fg(glyphColor(task.status), row.glyph),
							title: row.label,
							idLabel: "",
							rightParts: row.blocked ? [theme.fg("warning", "⛔ blocked")] : [],
						};
					},
					onKey: (key, task) => {
						const intent = tasksOverlayIntent(key);
						if (!intent) return false;
						if (intent === "add") queue.push({ kind: "add" });
						else if (task) queue.push({ kind: "edit", task });
						else return false;
						log.debug("tasks_overlay_key", { intent, taskId: task?.id });
						return "close";
					},
					onX: (task) => {
						log.info("tasks_overlay_delete", { taskId: task.id });
						deps.deleteTask(task.id);
					},
				},
				createDetail: (task, tui, theme, done) => {
					const taskId = task.id;
					const current = () => deps.listTasks().find((t) => t.id === taskId);
					return new OverlayScrollDetail(
						tui,
						theme,
						{
							footerHints: "↑↓/jk scroll · x delete · Esc back",
							onX: () => deps.deleteTask(taskId),
							getHeader: (t) => {
								const live = current();
								if (!live) return t.fg("error", "Task deleted.");
								return detailHeader(live, t);
							},
							getBodyLines: (t) => {
								const live = current();
								if (!live) {
									return [t.fg("error", "Task deleted."), t.fg("dim", "Esc back")];
								}
								return taskDetailRows(live).map(
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
		const editing = request.kind === "edit" ? request.task : undefined;
		const text = await promptSubject(
			ctx,
			taskComposePrompt(editing && { id: editing.id, subject: editing.subject }),
		);
		const plan = planTaskCompose(text, editing && { id: editing.id, subject: editing.subject });
		if (plan.kind === "skip") {
			log.debug("tasks_overlay_compose_skipped", { reason: plan.reason, taskId: editing?.id });
			continue;
		}
		if (plan.kind === "create") deps.createTask(plan.subject);
		else deps.updateTaskSubject(plan.id, plan.subject);
	}
}
