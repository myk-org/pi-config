/**
 * extensions/pitasks/reminders.ts — Pure helpers for the task-focus reminder.
 * Kept dependency-free so both the extension timer and unit tests can import
 * the SAME production logic (no mirrored copies). The shared logger is
 * dependency-light (node builtins only) so importing it here does not pull in
 * pi-tui and keeps the module test-importable.
 */

import { createLogger } from "../shared/logger.js";

const log = createLogger("pitasks-reminders");

/** Content for the pending-only reminder (tasks exist but none in_progress). */
export function pendingReminderContent(activeCount: number): string {
	log.debug("pendingReminderContent", activeCount);
	return `⚠️ You have ${activeCount} active task(s) and none are in progress. Check your TaskList and resume your workflow.`;
}

/** Content for the stale in_progress reminder. */
export function staleReminderContent(staleCount: number): string {
	log.debug("staleReminderContent", staleCount);
	return `⚠️ You have ${staleCount} task(s) stuck in progress. Check your TaskList and update their status.`;
}

/** Gate: fire the reminder only when the agent is idle and there are matching tasks. */
export function shouldFireReminder(agentBusy: boolean, matchingCount: number): boolean {
	const result = matchingCount > 0 && !agentBusy;
	log.debug("shouldFireReminder", agentBusy, matchingCount, result);
	return result;
}

/** Select active tasks (pending or in_progress) and whether any are in_progress. */
export function selectActiveTasks(tasks: Array<{ status: string }>): { active: any[]; anyInProgress: boolean } {
	const active = tasks.filter(t => t.status === "pending" || t.status === "in_progress");
	log.debug("selectActiveTasks", tasks.length, active.length);
	return { active, anyInProgress: active.some(t => t.status === "in_progress") };
}

/** Minimal task shape the pending-age gate needs. */
export interface ReminderTask {
	status: string;
	createdAt?: number;
	statusHistory?: { pending_at?: string | null } | null;
}

/**
 * When a task became pending, in ms. `statusHistory.pending_at` is refreshed on
 * every transition back to pending; `createdAt` is the fallback. Returns NaN
 * when neither is usable — callers treat that as "old" (legacy behaviour).
 */
function pendingSinceMs(task: ReminderTask): number {
	const raw = task.statusHistory?.pending_at;
	const parsed = raw ? Date.parse(raw) : NaN;
	if (Number.isFinite(parsed)) return parsed;
	if (typeof task.createdAt === "number" && Number.isFinite(task.createdAt)) return task.createdAt;
	log.debug("pending_since_unknown", task.status);
	return NaN;
}

/** Oldest pending timestamp among active tasks in ms; NaN when none is usable. */
export function oldestPendingAt(active: ReminderTask[]): number {
	let oldest = Number.POSITIVE_INFINITY;
	for (const task of active) {
		const ms = pendingSinceMs(task);
		if (Number.isFinite(ms) && ms < oldest) oldest = ms;
	}
	return Number.isFinite(oldest) ? oldest : NaN;
}

/**
 * Full decision for the pending-only reminder: no active tasks, any in_progress,
 * agent busy, repeat interval, or the oldest active task being younger than the
 * interval all suppress it. `lastReminderAt = 0` means "never reminded yet".
 */
export function decidePendingReminder(params: {
	tasks: ReminderTask[];
	agentBusy: boolean;
	lastReminderAt: number;
	now: number;
	threshold: number;
}): { fire: boolean; activeCount: number; oldestPendingAt: number } {
	const { tasks, agentBusy, lastReminderAt, now, threshold } = params;
	const { active, anyInProgress } = selectActiveTasks(tasks);
	const oldest = oldestPendingAt(active);
	const decision = { fire: false, activeCount: active.length, oldestPendingAt: oldest };

	if (active.length === 0) {
		log.debug("pending_reminder_skipped", "no-active-tasks");
	} else if (anyInProgress) {
		log.debug("pending_reminder_skipped", "in-progress");
	} else if (agentBusy) {
		log.debug("pending_reminder_skipped", "busy");
	} else if (now - lastReminderAt < threshold) {
		log.debug("pending_reminder_skipped", "interval");
	} else if (Number.isFinite(oldest) && now - oldest < threshold) {
		log.debug("pending_reminder_skipped", "too-young", now - oldest);
	} else {
		decision.fire = true;
	}
	return decision;
}
