/**
 * Pure cron status display helpers — no TUI deps (unit-testable).
 */

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
  createdAt: number;
  lastRun?: number;
  nextRun?: number;
  /** Optional scope and leader-state label shown in overlay rows. */
  sessionLabel?: string;
  isLocal?: boolean;
  cronFile?: string;
}

export function formatCronSchedule(task: {
  intervalMs?: number;
  atHour?: number;
  atMinute?: number;
}): string {
  if (task.intervalMs) {
    if (task.intervalMs < 60000) return `every ${Math.round(task.intervalMs / 1000)}s`;
    if (task.intervalMs < 3600000) {
      return `every ${Math.round(task.intervalMs / 60000)}m`;
    }
    const h = Math.floor(task.intervalMs / 3600000);
    const m = Math.round((task.intervalMs % 3600000) / 60000);
    return m > 0 ? `every ${h}h${m}m` : `every ${h}h`;
  }
  if (task.atHour !== undefined && task.atMinute !== undefined) {
    return `daily at ${String(task.atHour).padStart(2, "0")}:${String(task.atMinute).padStart(2, "0")}`;
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

/** Map a CronTask-like object into an overlay row view. */
export function toCronStatusTaskView(
  task: {
    id: string | number;
    description: string;
    task: string;
    intervalMs?: number;
    atHour?: number;
    atMinute?: number;
    createdAt: number;
    lastRun?: number;
    nextRun?: number;
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
    createdAt: task.createdAt,
    lastRun: task.lastRun,
    nextRun: task.nextRun,
    sessionLabel: opts.sessionLabel,
    isLocal: opts.isLocal,
    cronFile: opts.cronFile,
  };
}
