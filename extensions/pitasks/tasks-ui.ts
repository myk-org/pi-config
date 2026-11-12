/**
 * tasks-ui.ts — /tasks fullscreen list → detail overlay.
 *
 * Same shared component as /cron list and /async-status (openListDetailOverlay +
 * OverlayScrollDetail), so j/k, Enter, x and Esc mean the same thing everywhere.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	openListDetailOverlay,
	OverlayScrollDetail,
} from "../orchestrator/overlay-dashboard.js";
import type { Task } from "./types.js";
import {
	TASKS_EMPTY_MESSAGE,
	taskDetailRows,
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

/** Open the task list overlay; loops list → detail until the list is closed. */
export async function openTasksOverlay(
	ctx: ExtensionCommandContext,
	deps: TasksUiDeps,
): Promise<void> {
	log.debug("tasks_overlay_open", { tasks: deps.listTasks().length });
	await openListDetailOverlay(ctx, {
		emptyMessage: TASKS_EMPTY_MESSAGE,
		listSpec: {
			title: "Tasks",
			countLabel: (tasks) => `${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
			borderTitle: (tasks) => {
				const done = tasks.filter((t) => t.status === "completed").length;
				return `tasks · ${done} done / ${tasks.length}`;
			},
			footerHints: "↑↓/jk select · Enter view · x delete · Esc close",
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
