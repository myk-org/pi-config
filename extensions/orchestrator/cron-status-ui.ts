/**
 * /cron fullscreen overlay for session and project tasks — list dashboard → task detail.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, Text } from "@earendil-works/pi-tui";
import {
  cronDetailRows,
  cronStateLabel,
  filterCronTasksByScope,
  formatCronSchedule,
  formatCronScheduleInput,
  formatLastRunLabel,
  formatNextRunLabel,
  isPersistedCronView,
  nextCronScopeFilter,
  parseCronScheduleInput,
  type CronPauseResult,
  type CronScheduleInputSpec,
  type CronScopeFilter,
  type CronScopeResult,
  type CronStatusTaskView,
} from "./cron-status-format.js";
import {
  bulkRemove,
  bulkResultMessage,
  matchesOverlayKey,
  openListDetailOverlay,
  OverlayScrollDetail,
  type OverlayNotify,
} from "./overlay-dashboard.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("cron_status_ui");

export type {
  CronPauseResult,
  CronScheduleInputSpec,
  CronScopeFilter,
  CronScopeResult,
  CronStatusTaskView,
} from "./cron-status-format.js";
export {
  cronDetailRows,
  cronStateLabel,
  filterCronTasksByScope,
  formatCronSchedule,
  formatCronScheduleInput,
  formatLastRunLabel,
  formatNextRunLabel,
  isPersistedCronView,
  nextCronScopeFilter,
  parseCronScheduleInput,
  resolveNextRunAt,
  toCronStatusTaskView,
} from "./cron-status-format.js";

export interface CronAddInput extends CronScheduleInputSpec {
  scope: "session" | "project";
  task: string;
  description?: string;
  model?: string;
}

export interface CronEditInput extends CronScheduleInputSpec {
  description?: string;
  task?: string;
  model?: string;
}

export interface CronStatusUiDeps {
  listTasks: () => CronStatusTaskView[];
  /** Remove by scope-qualified task id. Return true if removed. */
  removeTask: (id: string) => boolean;
  /** Pause/resume by scope-qualified task id. `ok` is false when the store write failed. */
  togglePaused: (id: string) => CronPauseResult;
  /** Add a new cron task from TUI dialog. */
  addTask?: (input: CronAddInput) => { ok: true; id: string } | { ok: false; error: string };
  /** Edit an existing cron task in place from TUI dialog. */
  editTask?: (id: string, patch: CronEditInput) => { ok: true; id: string } | { ok: false; error: string };
  /** Move a cron task between session and durable project storage. */
  setScope?: (id: string, scope: "session" | "project") => CronScopeResult;
  title?: string;
  emptyMessage?: string;
  borderTitle?: (tasks: readonly CronStatusTaskView[]) => string;
}

async function promptLine(
  ctx: ExtensionCommandContext,
  prompt: { title: string; placeholder: string; initialValue?: string },
): Promise<string | undefined> {
  if (typeof ctx.ui.custom !== "function") return ctx.ui.input(prompt.title, prompt.initialValue ?? "");
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const input = new Input({ placeholder: prompt.placeholder });
    if (prompt.initialValue) input.handleInput(`\x1b[200~${prompt.initialValue}\x1b[201~`);
    input.onSubmit = (value: string) => done(value);
    input.onEscape = () => done(undefined);
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", prompt.title), 1, 0));
    container.addChild(input);
    container.addChild(new Text(theme.fg("dim", "enter save · esc cancel"), 1, 0));
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

/**
 * `p` on a selection sets ONE state for the whole group: any active row means "pause them all",
 * otherwise "resume them all". A per-row toggle would leave a mixed group behind with no way to
 * tell from the notify what actually happened.
 */
function setGroupPaused(
  deps: CronStatusUiDeps,
  rows: readonly CronStatusTaskView[],
  notify: OverlayNotify,
): void {
  const pause = rows.some((row) => !row.paused);
  const failed: string[] = [];
  for (const row of rows) {
    // Already in the target state: no write, and no failure to report.
    if (!!row.paused === pause) continue;
    if (!deps.togglePaused(row.id).ok) failed.push(`#${row.taskId}`);
  }
  log.info("cron_overlay_bulk_pause", { selected: rows.length, pause, failed: failed.length });
  notify(
    bulkResultMessage(pause ? "paused" : "resumed", "cron", rows.length, failed),
    failed.length === 0 ? "info" : "warning",
  );
}

/**
 * `t` on a selection moves all selected rows to ONE scope: any session row means "persist all",
 * otherwise "move all to session".
 */
function setGroupScope(
  deps: CronStatusUiDeps,
  rows: readonly CronStatusTaskView[],
  notify: OverlayNotify,
): void {
  if (!deps.setScope) return;
  const targetScope: "session" | "project" = rows.some((row) => !isPersistedCronView(row))
    ? "project"
    : "session";
  const failed: string[] = [];
  for (const row of rows) {
    const alreadyTarget = (targetScope === "project") === isPersistedCronView(row);
    if (alreadyTarget) continue;
    const res = deps.setScope(row.id, targetScope);
    if (!res.ok) failed.push(`#${row.taskId}`);
  }
  log.info("cron_overlay_bulk_scope", { selected: rows.length, targetScope, failed: failed.length });
  notify(
    bulkResultMessage(targetScope === "project" ? "persisted" : "moved to session", "cron", rows.length, failed),
    failed.length === 0 ? "info" : "warning",
  );
}

async function runAddCronDialog(
  ctx: ExtensionCommandContext,
  deps: CronStatusUiDeps,
  scopeFilter: CronScopeFilter,
): Promise<void> {
  if (!deps.addTask) return;
  const taskRaw = await promptLine(ctx, {
    title: "New cron — prompt or /command",
    placeholder: "e.g. Check open PRs for review comments",
  });
  if (taskRaw === undefined) return;
  const task = taskRaw.trim();
  if (!task) {
    ctx.ui.notify("Cron task cannot be empty.", "warning");
    return;
  }

  const schedRaw = await promptLine(ctx, {
    title: "New cron — schedule",
    placeholder: "e.g. 5m, 2h, 30s, or 09:30",
  });
  if (schedRaw === undefined) return;
  const parsedSched = parseCronScheduleInput(schedRaw);
  if (!parsedSched.ok) {
    ctx.ui.notify(parsedSched.error, "warning");
    return;
  }

  const descRaw = await promptLine(ctx, {
    title: "New cron — description (optional)",
    placeholder: "Enter to use task text",
  });
  if (descRaw === undefined) return;

  const defaultPersist = scopeFilter === "persist";
  const scopeRaw = await promptLine(ctx, {
    title: defaultPersist ? "Persist across sessions? (Y/n)" : "Persist across sessions? (y/N)",
    placeholder: "y = persist in project, n = session only",
    initialValue: defaultPersist ? "y" : "n",
  });
  if (scopeRaw === undefined) return;
  const trimmedScope = scopeRaw.trim().toLowerCase();
  const scope: "session" | "project" =
    trimmedScope === ""
      ? (defaultPersist ? "project" : "session")
      : trimmedScope.startsWith("y") || trimmedScope === "persist" || trimmedScope === "project"
        ? "project"
        : "session";

  const modelRaw = await promptLine(ctx, {
    title: "New cron — model override (optional)",
    placeholder: "Enter to inherit, or provider/model-id",
  });
  if (modelRaw === undefined) return;

  const res = deps.addTask({
    scope,
    task,
    description: descRaw.trim() || undefined,
    model: modelRaw.trim() || undefined,
    ...parsedSched.schedule,
  });
  if (!res.ok) {
    log.warn("cron_overlay_add_failed", { error: res.error });
    ctx.ui.notify(`Could not create cron: ${res.error}`, "warning");
    return;
  }
  log.info("cron_overlay_added", { id: res.id, scope });
  ctx.ui.notify(`Created cron ${res.id}.`, "info");
}

async function runEditCronDialog(
  ctx: ExtensionCommandContext,
  deps: CronStatusUiDeps,
  task: CronStatusTaskView,
): Promise<void> {
  if (!deps.editTask) return;
  const descRaw = await promptLine(ctx, {
    title: `Edit #${task.taskId} — description`,
    placeholder: "Short description",
    initialValue: task.description,
  });
  if (descRaw === undefined) return;

  const taskRaw = await promptLine(ctx, {
    title: `Edit #${task.taskId} — prompt or /command`,
    placeholder: "Task prompt or /command",
    initialValue: task.task,
  });
  if (taskRaw === undefined) return;

  const currentSched = formatCronScheduleInput(task);
  const schedRaw = await promptLine(ctx, {
    title: `Edit #${task.taskId} — schedule`,
    placeholder: "e.g. 5m, 2h, 30s, or 09:30",
    initialValue: currentSched,
  });
  if (schedRaw === undefined) return;
  const parsedSched = parseCronScheduleInput(schedRaw);
  if (!parsedSched.ok) {
    ctx.ui.notify(parsedSched.error, "warning");
    return;
  }

  const modelRaw = await promptLine(ctx, {
    title: `Edit #${task.taskId} — model (empty clears)`,
    placeholder: "provider/model-id or empty to inherit",
    initialValue: task.model ?? "",
  });
  if (modelRaw === undefined) return;

  const patch: CronEditInput = {};
  const nextDesc = descRaw.trim();
  if (nextDesc !== task.description) patch.description = nextDesc;
  const nextTask = taskRaw.trim();
  if (nextTask !== task.task) patch.task = nextTask;
  if (schedRaw.trim() !== currentSched) Object.assign(patch, parsedSched.schedule);
  const nextModel = modelRaw.trim();
  if (nextModel !== (task.model ?? "")) patch.model = nextModel;

  if (Object.keys(patch).length === 0) {
    log.debug("cron_overlay_edit_unchanged", { id: task.id });
    return;
  }
  const res = deps.editTask(task.id, patch);
  if (!res.ok) {
    log.warn("cron_overlay_edit_failed", { id: task.id, error: res.error });
    ctx.ui.notify(`Could not update cron: ${res.error}`, "warning");
    return;
  }
  log.info("cron_overlay_edited", { id: res.id });
  ctx.ui.notify(`Updated cron ${res.id}.`, "info");
}

const CRON_FOOTER_HINTS =
  "Space select · n add · e edit · p pause · t persist · x delete · f scope · Enter view · Esc close";

/**
 * Open fullscreen cron list. Loops list → detail / dialogs until closed.
 */
export async function openCronStatusOverlay(
  ctx: ExtensionCommandContext,
  deps: CronStatusUiDeps,
): Promise<void> {
  let scopeFilter: CronScopeFilter = "all";
  let reselectId: string | undefined;

  for (;;) {
    const queue: Array<{ kind: "add" } | { kind: "edit"; task: CronStatusTaskView }> = [];
    const allowEmpty = Boolean(deps.addTask) || deps.listTasks().length > 0;

    await openListDetailOverlay(ctx, {
      emptyMessage: deps.emptyMessage ?? "No scheduled tasks.",
      allowEmpty,
      initialSelectionId: reselectId,
      listSpec: {
        title: deps.title ?? "Cron tasks",
        countLabel: (tasks) =>
          `${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
        borderTitle:
          deps.borderTitle ??
          ((tasks) => `scheduled · ${tasks.length} · ${scopeFilter}`),
        emptyBody: () =>
          scopeFilter === "all"
            ? "No scheduled tasks. Press n to add."
            : `No ${scopeFilter} cron tasks. Press f to switch scope or n to add.`,
        footerHints: CRON_FOOTER_HINTS,
        listItems: () => filterCronTasksByScope(deps.listTasks(), scopeFilter),
        rowParts: (task, theme) => {
          const now = Date.now();
          const rightParts = [
            // An active row keeps today's text; only a paused row gains a state label.
            ...(task.paused ? [theme.fg("warning", cronStateLabel(task))] : []),
            theme.fg("muted", formatCronSchedule(task)),
            theme.fg("dim", formatLastRunLabel(task, now)),
            theme.fg("muted", formatNextRunLabel(task, now)),
          ];
          if (task.sessionLabel) {
            rightParts.unshift(theme.fg("dim", task.sessionLabel));
          }
          return {
            glyph: theme.fg("warning", "■"),
            title: task.description,
            idLabel: theme.fg("dim", `#${task.taskId}`),
            rightParts,
          };
        },
        onKey: (key, task, selected, notify) => {
          if (task) reselectId = task.id;
          if (matchesOverlayKey(key, "f")) {
            scopeFilter = nextCronScopeFilter(scopeFilter);
            log.debug("cron_overlay_scope_filter", { scopeFilter });
            return "redraw";
          }
          if (matchesOverlayKey(key, "n")) {
            if (!deps.addTask) return false;
            if (selected.length > 0) {
              notify("Add works without a selection — clear the selection (Esc) first.", "warning");
              return "redraw";
            }
            queue.push({ kind: "add" });
            return "close";
          }
          if (matchesOverlayKey(key, "e")) {
            if (!deps.editTask) return false;
            if (selected.length > 0) {
              notify("Edit works on one cron — clear the selection (Esc) first.", "warning");
              return "redraw";
            }
            if (!task) return false;
            queue.push({ kind: "edit", task });
            return "close";
          }
          if (matchesOverlayKey(key, "t")) {
            if (!deps.setScope) return false;
            if (selected.length > 0) {
              setGroupScope(deps, selected, notify);
              return "redraw";
            }
            if (!task) return false;
            const targetScope = isPersistedCronView(task) ? "session" : "project";
            const res = deps.setScope(task.id, targetScope);
            log.info("cron_overlay_toggle_scope", { id: task.id, targetScope, ok: res.ok });
            if (!res.ok) {
              notify(
                res.error || `Could not move #${task.taskId} to ${targetScope === "project" ? "persist" : "session"}.`,
                "warning",
              );
            } else {
              reselectId = res.id;
              notify(
                `Moved #${task.taskId} to ${targetScope === "project" ? "persist" : "session"}.`,
                "info",
              );
            }
            return "redraw";
          }
          if (!matchesOverlayKey(key, "p")) return false;
          if (selected.length > 0) {
            setGroupPaused(deps, selected, notify);
            // Stays open: the rows must flip between `⏸ paused` and the active text in place.
            return "redraw";
          }
          if (!task) return false;
          const result = deps.togglePaused(task.id);
          log.debug("cron_overlay_pause_key", { id: task.id, paused: !!task.paused, ok: result.ok });
          // A failed write must not show a green state: the row would claim a pause the store never
          // accepted, and a follow-up `p` would then read the wrong starting state.
          if (!result.ok) notify(`Could not save the pause state of #${task.taskId}.`, "warning");
          // Stays open: the row must flip between `⏸ paused` and the active text in place.
          return "redraw";
        },
        onX: (task) => {
          deps.removeTask(task.id);
        },
        selectable: true,
        onXSelected: (rows, notify) => {
          // Each removal is persisted on its own: a rejected id must be named, never counted, and a
          // throw on one row (store lock timeout) must not leave the rest of the selection behind.
          const { failed, errors } = bulkRemove(rows, (row) => deps.removeTask(row.id));
          const names = failed.map((row) => `#${row.taskId}`);
          log.info("cron_overlay_bulk_remove", { selected: rows.length, failed: names.length, errors });
          notify(
            bulkResultMessage("removed", "cron", rows.length, names),
            names.length === 0 ? "info" : "warning",
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

    const req = queue.pop();
    if (!req) return;
    if (req.kind === "add") {
      await runAddCronDialog(ctx, deps, scopeFilter);
    } else {
      await runEditCronDialog(ctx, deps, req.task);
    }
  }
}
