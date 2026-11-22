/**
 * Pure cron status display helpers — no TUI deps (unit-testable).
 */
import { createLogger } from "../shared/logger.js";

const log = createLogger("cron_status");

export interface CronStatusTaskView {
  /** Unique scope-qualified overlay row id (e.g. "session:<uuid>"). */
  id: string;
  /** Stable UUID within its session or project scope. */
  taskId: string | number;
  description: string;
  task: string;
  intervalMs?: number;
  atHour?: number;
  atMinute?: number;
  /** "provider/model-id" or bare "model-id"; absent means the session default. */
  model?: string;
  createdAt: number;
  lastRun?: number;
  nextRun?: number;
  /** Paused by the user: kept in the store, never armed (issue #1087). */
  paused?: boolean;
  /** Optional scope and leader-state label shown in overlay rows. */
  sessionLabel?: string;
  isLocal?: boolean;
  cronFile?: string;
}

export function formatCronSchedule(
  task: {
    intervalMs?: number;
    atHour?: number;
    atMinute?: number;
  },
  opts?: { preciseIntervals?: boolean; dailyPrefix?: boolean },
): string {
  const precise = opts?.preciseIntervals === true;
  const dailyPrefix = opts?.dailyPrefix !== false;
  if (task.intervalMs) {
    if (precise) {
      const totalSec = Math.floor(task.intervalMs / 1000);
      if (totalSec < 60) return `every ${totalSec}s`;
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      if (m < 60) return s > 0 ? `every ${m}m${s}s` : `every ${m}m`;
      const h = Math.floor(m / 60);
      const rm = m % 60;
      return rm > 0 ? `every ${h}h${rm}m` : `every ${h}h`;
    }
    if (task.intervalMs < 60000) return `every ${Math.round(task.intervalMs / 1000)}s`;
    if (task.intervalMs < 3600000) {
      return `every ${Math.round(task.intervalMs / 60000)}m`;
    }
    const h = Math.floor(task.intervalMs / 3600000);
    const m = Math.round((task.intervalMs % 3600000) / 60000);
    return m > 0 ? `every ${h}h${m}m` : `every ${h}h`;
  }
  if (task.atHour !== undefined && task.atMinute !== undefined) {
    const time = `${String(task.atHour).padStart(2, "0")}:${String(task.atMinute).padStart(2, "0")}`;
    return dailyPrefix ? `daily at ${time}` : `at ${time}`;
  }
  return "unknown";
}

/** Best-effort next-fire timestamp for display. */
export function resolveNextRunAt(
  task: CronStatusTaskView,
  now = Date.now(),
): number | undefined {
  if (task.nextRun != null) return task.nextRun;
  if (task.intervalMs != null) {
    if (task.lastRun != null) return task.lastRun + task.intervalMs;
    return task.createdAt + task.intervalMs;
  }
  if (task.atHour !== undefined && task.atMinute !== undefined) {
    const target = new Date(now);
    target.setHours(task.atHour, task.atMinute, 0, 0);
    if (target.getTime() <= now) target.setDate(target.getDate() + 1);
    return target.getTime();
  }
  return undefined;
}

export function formatRelativeMs(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 60000) return `${Math.round(abs / 1000)}s`;
  if (abs < 3600000) return `${Math.round(abs / 60000)}m`;
  const h = Math.floor(abs / 3600000);
  const m = Math.round((abs % 3600000) / 60000);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

export function formatLastRunLabel(
  task: CronStatusTaskView,
  now = Date.now(),
): string {
  if (task.lastRun == null) return "never";
  return `${formatRelativeMs(now - task.lastRun)} ago`;
}

export function formatNextRunLabel(
  task: CronStatusTaskView,
  now = Date.now(),
): string {
  const at = resolveNextRunAt(task, now);
  if (at == null) return "—";
  const delta = at - now;
  if (delta <= 0) return "soon";
  return `in ${formatRelativeMs(delta)}`;
}

/** One state word shared by `cron_manage list` and the overlay's paused row. */
export function cronStateLabel(task: { paused?: boolean; leader?: boolean }): string {
  if (task.paused) return "⏸ paused";
  return task.leader === false ? "waiting for leader" : "active";
}

/** Format the TUI status bar cron slot, highlighting paused tasks in warning color. */
export function formatCronStatusSlot(
  tasks: ReadonlyArray<{ paused?: boolean }>,
  theme?: { fg: (color: any, text: string) => string },
): string {
  const fg = (color: string, text: string) => (theme ? theme.fg(color, text) : text);
  const total = tasks.length;
  if (total === 0) return fg("muted", "⏰ 0 crons");
  let pausedCount = 0;
  for (const task of tasks) {
    if (task.paused) pausedCount++;
  }
  const activeCount = total - pausedCount;
  if (pausedCount === 0) return fg("muted", `⏰ ${total} cron${total === 1 ? "" : "s"}`);
  if (activeCount === 0) return fg("warning", `⏸ ${pausedCount} cron${pausedCount === 1 ? "" : "s"}`);
  return `${fg("muted", `⏰ ${activeCount} · `)}${fg("warning", `⏸ ${pausedCount}`)}`;
}

/** Whether the pause reached the store — the caller must not show a state that was never written. */
export type CronPauseResult =
  | { ok: true; paused: boolean }
  | { ok: false; paused: boolean };

/** Detail rows rendered by the cron task overlay, uncolored (label, value). */
export function cronDetailRows(
  task: CronStatusTaskView,
  now = Date.now(),
): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ["Schedule", formatCronSchedule(task)],
    [
      "Last run",
      `${formatLastRunLabel(task, now)}${
        task.lastRun ? ` · ${new Date(task.lastRun).toLocaleString()}` : ""
      }`,
    ],
    ["Next run", formatNextRunLabel(task, now)],
    ["Created", new Date(task.createdAt).toLocaleString()],
  ];
  if (task.sessionLabel) rows.push(["Session", task.sessionLabel]);
  if (task.model) rows.push(["Model", task.model]);
  log.debug("cron_detail_rows", { id: task.id, rows: rows.length, model: task.model || "inherit" });
  return rows;
}

/** Map a CronTask-like object into an overlay row view. */
export function toCronStatusTaskView(
  task: {
    id: string | number;
    description: string;
    task: string;
    intervalMs?: number;
    atHour?: number;
    atMinute?: number;
    model?: string;
    createdAt: number;
    lastRun?: number;
    nextRun?: number;
    paused?: boolean;
  },
  opts: {
    overlayId: string;
    sessionLabel?: string;
    isLocal?: boolean;
    cronFile?: string;
  },
): CronStatusTaskView {
  return {
    id: opts.overlayId,
    taskId: opts.overlayId,
    description: task.description,
    task: task.task,
    intervalMs: task.intervalMs,
    atHour: task.atHour,
    atMinute: task.atMinute,
    model: task.model,
    createdAt: task.createdAt,
    lastRun: task.lastRun,
    nextRun: task.nextRun,
    paused: task.paused,
    sessionLabel: opts.sessionLabel,
    isLocal: opts.isLocal,
    cronFile: opts.cronFile,
  };
}
