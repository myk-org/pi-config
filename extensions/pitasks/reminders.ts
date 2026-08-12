/**
 * extensions/pitasks/reminders.ts — Pure helpers for the task-focus reminder.
 * Kept dependency-free so both the extension timer and unit tests can import
 * the SAME production logic (no mirrored copies).
 */

/** Content for the pending-only reminder (tasks exist but none in_progress). */
export function pendingReminderContent(activeCount: number): string {
	return `⚠️ You have ${activeCount} active task(s) and none are in progress. Check your TaskList and resume your workflow.`;
}

/** Content for the stale in_progress reminder. */
export function staleReminderContent(staleCount: number): string {
	return `⚠️ You have ${staleCount} task(s) stuck in progress. Check your TaskList and update their status.`;
}

/** Gate: fire the reminder only when the agent is idle and there are matching tasks. */
export function shouldFireReminder(agentBusy: boolean, matchingCount: number): boolean {
	return matchingCount > 0 && !agentBusy;
}

/** Select active tasks (pending or in_progress) and whether any are in_progress. */
export function selectActiveTasks(tasks: Array<{ status: string }>): { active: any[]; anyInProgress: boolean } {
	const active = tasks.filter(t => t.status === "pending" || t.status === "in_progress");
	return { active, anyInProgress: active.some(t => t.status === "in_progress") };
}
