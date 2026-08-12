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
