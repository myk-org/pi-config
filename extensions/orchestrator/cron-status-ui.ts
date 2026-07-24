/**
 * /cron list + list-all fullscreen overlay — list dashboard → task detail.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  formatCronSchedule,
  formatLastRunLabel,
  formatNextRunLabel,
  type CronStatusTaskView,
} from "./cron-status-format.js";
import {
  openListDetailOverlay,
  OverlayScrollDetail,
} from "./overlay-dashboard.js";

export type { CronStatusTaskView } from "./cron-status-format.js";
export {
  formatCronSchedule,
  formatLastRunLabel,
  formatNextRunLabel,
  resolveNextRunAt,
  toCronStatusTaskView,
} from "./cron-status-format.js";

export interface CronStatusUiDeps {
  listTasks: () => CronStatusTaskView[];
  /** Remove by overlay row id. Return true if removed. */
  removeTask: (id: string) => boolean;
  title?: string;
  emptyMessage?: string;
  borderTitle?: (tasks: readonly CronStatusTaskView[]) => string;
}

/**
 * Open fullscreen cron list. Loops list → detail until user closes list.
 */
export async function openCronStatusOverlay(
  ctx: ExtensionCommandContext,
  deps: CronStatusUiDeps,
): Promise<void> {
  const showSession = () =>
    deps.listTasks().some((t) => !!t.sessionLabel);

  await openListDetailOverlay(ctx, {
    emptyMessage: deps.emptyMessage ?? "No scheduled tasks.",
    listSpec: {
      title: deps.title ?? "Cron tasks",
      countLabel: (tasks) =>
        `${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
      borderTitle:
        deps.borderTitle ??
        ((tasks) => `scheduled · ${tasks.length}`),
      footerHints: "↑↓/jk select · Enter view · x remove · Esc close",
      listItems: () => deps.listTasks(),
      rowParts: (task, theme) => {
        const now = Date.now();
        const rightParts = [
          theme.fg("muted", formatCronSchedule(task)),
          theme.fg("dim", formatLastRunLabel(task, now)),
          theme.fg("muted", formatNextRunLabel(task, now)),
        ];
        if (showSession() && task.sessionLabel) {
          rightParts.unshift(theme.fg("dim", task.sessionLabel));
        }
        return {
          glyph: theme.fg("warning", "■"),
          title: task.description,
          idLabel: theme.fg("dim", `#${task.taskId}`),
          rightParts,
        };
      },
      onX: (task) => {
        deps.removeTask(task.id);
      },
    },
    createDetail: (task, tui, theme, done) => {
      const rowId = task.id;
      return new OverlayScrollDetail(
        tui,
        theme,
        {
          footerHints: "↑↓/jk scroll · x remove · Esc back",
          onX: () => deps.removeTask(rowId),
          getHeader: (t) => {
            const current = deps.listTasks().find((x) => x.id === rowId);
            if (!current) return t.fg("error", "Task removed.");
            const session = current.sessionLabel
              ? t.fg("dim", ` · ${current.sessionLabel}`)
              : "";
            return (
              `${t.fg("warning", "■")} ` +
              t.fg(
                "accent",
                t.bold(`#${current.taskId} · ${current.description}`),
              ) +
              t.fg("muted", ` · ${formatCronSchedule(current)}`) +
              session
            );
          },
          getBodyLines: (t) => {
            const current = deps.listTasks().find((x) => x.id === rowId);
            if (!current) {
              return [t.fg("error", "Task removed."), t.fg("dim", "Esc back")];
            }
            const now = Date.now();
            const lines = [
              `${t.fg("muted", "Schedule")}  ${formatCronSchedule(current)}`,
              `${t.fg("muted", "Last run")}  ${formatLastRunLabel(current, now)}` +
                (current.lastRun
                  ? t.fg(
                      "dim",
                      ` · ${new Date(current.lastRun).toLocaleString()}`,
                    )
                  : ""),
              `${t.fg("muted", "Next run")}  ${formatNextRunLabel(current, now)}`,
              `${t.fg("muted", "Created")}   ${new Date(current.createdAt).toLocaleString()}`,
            ];
            if (current.sessionLabel) {
              lines.push(
                `${t.fg("muted", "Session")}  ${current.sessionLabel}`,
              );
            }
            lines.push("", t.fg("muted", "Task"), current.task);
            return lines;
          },
        },
        done,
      );
    },
  });
}
