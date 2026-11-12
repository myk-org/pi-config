/**
 * /cron list fullscreen overlay for session and project tasks — list dashboard → task detail.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  cronDetailRows,
  cronStateLabel,
  formatCronSchedule,
  formatLastRunLabel,
  formatNextRunLabel,
  type CronPauseResult,
  type CronStatusTaskView,
} from "./cron-status-format.js";
import {
  bulkResultMessage,
  openListDetailOverlay,
  OverlayScrollDetail,
} from "./overlay-dashboard.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("cron_status_ui");

export type { CronPauseResult, CronStatusTaskView } from "./cron-status-format.js";
export {
  cronDetailRows,
  cronStateLabel,
  formatCronSchedule,
  formatLastRunLabel,
  formatNextRunLabel,
  resolveNextRunAt,
  toCronStatusTaskView,
} from "./cron-status-format.js";

export interface CronStatusUiDeps {
  listTasks: () => CronStatusTaskView[];
  /** Remove by scope-qualified task id. Return true if removed. */
  removeTask: (id: string) => boolean;
  /** Pause/resume by scope-qualified task id. `ok` is false when the store write failed. */
  togglePaused: (id: string) => CronPauseResult;
  title?: string;
  emptyMessage?: string;
  borderTitle?: (tasks: readonly CronStatusTaskView[]) => string;
}

/**
 * `p` on a selection sets ONE state for the whole group: any active row means "pause them all",
 * otherwise "resume them all". A per-row toggle would leave a mixed group behind with no way to
 * tell from the notify what actually happened.
 */
function setGroupPaused(
  ctx: ExtensionCommandContext,
  deps: CronStatusUiDeps,
  rows: readonly CronStatusTaskView[],
): void {
  const pause = rows.some((row) => !row.paused);
  const failed: string[] = [];
  for (const row of rows) {
    // Already in the target state: no write, and no failure to report.
    if (!!row.paused === pause) continue;
    if (!deps.togglePaused(row.id).ok) failed.push(`#${row.taskId}`);
  }
  log.info("cron_overlay_bulk_pause", { selected: rows.length, pause, failed: failed.length });
  ctx.ui.notify(
    bulkResultMessage(pause ? "paused" : "resumed", "cron", rows.length, failed),
    failed.length === 0 ? "info" : "warning",
  );
}

/**
 * Open fullscreen cron list for the selected scope. Loops list → detail until closed.
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
      footerHints: "Space select · x remove · p pause/resume · Enter view · Esc close",
      listItems: () => deps.listTasks(),
      rowParts: (task, theme) => {
        const now = Date.now();
        const rightParts = [
          // An active row keeps today's text; only a paused row gains a state label.
          ...(task.paused ? [theme.fg("warning", cronStateLabel(task))] : []),
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
      onKey: (key, task, selected) => {
        if (key !== "p") return false;
        if (selected.length > 0) {
          setGroupPaused(ctx, deps, selected);
          // Stays open: the rows must flip between `⏸ paused` and the active text in place.
          return "redraw";
        }
        if (!task) return false;
        const result = deps.togglePaused(task.id);
        log.debug("cron_overlay_pause_key", { id: task.id, paused: !!task.paused, ok: result.ok });
        // A failed write must not show a green state: the row would claim a pause the store never
        // accepted, and a follow-up `p` would then read the wrong starting state.
        if (!result.ok) ctx.ui.notify(`Could not save the pause state of #${task.taskId}.`, "warning");
        // Stays open: the row must flip between `⏸ paused` and the active text in place.
        return "redraw";
      },
      onX: (task) => {
        deps.removeTask(task.id);
      },
      selectable: true,
      onXSelected: (rows) => {
        // Each removal is persisted on its own; a rejected id must be named, never counted.
        const failed = rows
          .filter((row) => !deps.removeTask(row.id))
          .map((row) => `#${row.taskId}`);
        log.info("cron_overlay_bulk_remove", { selected: rows.length, failed: failed.length });
        ctx.ui.notify(
          bulkResultMessage("removed", "cron", rows.length, failed),
          failed.length === 0 ? "info" : "warning",
        );
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
            const lines = cronDetailRows(current).map(
              ([label, value]) => `${t.fg("muted", label.padEnd(9))}  ${value}`,
            );
            lines.push("", t.fg("muted", "Task"), current.task);
            return lines;
          },
        },
        done,
      );
    },
  });
}
