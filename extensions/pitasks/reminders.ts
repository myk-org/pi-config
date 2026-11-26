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

/** Content for the stale in_progress reminder. Accepts stuck tasks (+ optional threshold) or a legacy count. */
export function staleReminderContent(
	staleTasksOrCount: number | ReadonlyArray<{ id?: string | number }>,
	thresholdMinutes?: number,
): string {
	const count = typeof staleTasksOrCount === "number" ? staleTasksOrCount : staleTasksOrCount.length;
	const ids = typeof staleTasksOrCount === "number"
		? []
		: staleTasksOrCount
			.map((t) => (t.id != null ? String(t.id).trim() : ""))
			.filter(Boolean)
			.map((id) => `#${id}`);
	const detailParts: string[] = [];
	if (typeof thresholdMinutes === "number" && Number.isFinite(thresholdMinutes)) {
		detailParts.push(`>${thresholdMinutes}m`);
	}
	if (ids.length > 0) {
		detailParts.push(`no running async agent: ${ids.join(", ")}`);
	}
	const detail = detailParts.length > 0 ? ` (${detailParts.join(", ")})` : "";
	log.debug("staleReminderContent", { count, thresholdMinutes, taskIds: ids });
	return `⚠️ You have ${count} task(s) stuck in progress${detail}. Check your TaskList and update their status.`;
}

/** Collect linked task IDs from running or queued async jobs, ignoring unlinked `"-1"`. */
export function collectActiveAsyncTaskIds(
	agents: ReadonlyArray<{ status?: string; taskId?: string | number | null }> | null | undefined,
): Set<string> {
	const ids = new Set<string>();
	if (agents) {
		for (const job of agents) {
			if (job.status !== "running" && job.status !== "queued") continue;
			const id = job.taskId != null ? String(job.taskId).trim() : "";
			if (id && id !== "-1") ids.add(id);
		}
	}
	log.debug("collectActiveAsyncTaskIds", { agentCount: agents?.length ?? 0, activeTaskCount: ids.size });
	return ids;
}

/** Gate: fire the reminder only when the agent is idle and there are matching tasks. */
export function shouldFireReminder(agentBusy: boolean, matchingCount: number): boolean {
	const result = matchingCount > 0 && !agentBusy;
	log.debug("shouldFireReminder", agentBusy, matchingCount, result);
	return result;
}

/** Select active tasks (pending or in_progress) and whether any are in_progress. A task the OWNER
 *  has to do is never the agent's work, so it never qualifies for a reminder (#1090). */
export function selectActiveTasks(tasks: Array<{ status: string; assignee?: string }>): { active: any[]; anyInProgress: boolean } {
	const active = tasks.filter(t => (t.status === "pending" || t.status === "in_progress") && t.assignee !== "user");
	log.debug("selectActiveTasks", tasks.length, active.length);
	return { active, anyInProgress: active.some(t => t.status === "in_progress") };
}

/**
 * The stale nudge's input: tasks the AGENT started and left in progress past the threshold, with
 * no active (`running` or `queued`) async job linked to them (#1104). A task assigned to the owner
 * never nags, and it is not the agent's stuck work either (#1090).
 */
export function selectStaleTasks<T extends {
	id?: string | number;
	status: string;
	assignee?: string;
	statusHistory?: { in_progress_at?: string | null } | null;
}>(
	tasks: readonly T[],
	now: number,
	threshold: number,
	activeAsyncTaskIds?: ReadonlySet<string>,
): T[] {
	let activeAsyncExcluded = 0;
	const stale = tasks.filter((task) => {
		const startedAt = task.statusHistory?.in_progress_at;
		if (task.status !== "in_progress" || task.assignee === "user" || !startedAt) return false;
		if (now - new Date(startedAt).getTime() <= threshold) return false;
		if (task.id != null && activeAsyncTaskIds?.has(String(task.id))) {
			activeAsyncExcluded++;
			return false;
		}
		return true;
	});
	log.debug("selectStaleTasks", { total: tasks.length, stale: stale.length, activeAsyncExcluded });
	return stale;
}

/** Minimal task shape the pending-age gate needs. */
export interface ReminderTask {
	id?: string;
	status: string;
	assignee?: string;
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
	log.debug("pending_since_unknown", { id: task.id, status: task.status });
	return NaN;
}

/**
 * Oldest pending timestamp among active tasks in ms. NaN when it cannot be
 * determined: no active task, or ANY active task without a usable timestamp.
 * NaN means "treat as old", so a fresh sibling never masks an undated task.
 */
export function oldestPendingAt(active: ReminderTask[]): number {
	let oldest = Number.POSITIVE_INFINITY;
	for (const task of active) {
		const ms = pendingSinceMs(task);
		if (!Number.isFinite(ms)) return NaN;
		if (ms < oldest) oldest = ms;
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

/** Backoff multipliers applied to `task_headless_idle_reminder_minutes` on consecutive headless idle nudges. */
export const HEADLESS_IDLE_BACKOFF_MULTIPLIERS = [1, 2.5, 5] as const;

/** Maximum consecutive headless idle nudges without a real non-reminder turn or task state change. */
export const HEADLESS_IDLE_MAX_NUDGES = HEADLESS_IDLE_BACKOFF_MULTIPLIERS.length;

/** Minimal task shape for the headless-peer idle auto-nudge. */
export interface HeadlessReminderTask {
	id?: string | number;
	status: string;
	assignee?: string;
	blockedBy?: readonly (string | number)[];
}

/** Count running or queued non-fireAndForget async agents; any in-flight agent suppresses headless idle nudges. */
export function countActiveAsyncAgents(
	agents: ReadonlyArray<{ status?: string; fireAndForget?: boolean }> | null | undefined,
): number {
	let count = 0;
	if (agents) {
		for (const job of agents) {
			if (job.fireAndForget) continue;
			if (job.status === "running" || job.status === "queued") count++;
		}
	}
	log.debug("countActiveAsyncAgents", { agentCount: agents?.length ?? 0, activeCount: count });
	return count;
}

/**
 * Select open (`in_progress` or `pending`) agent-assigned tasks with no open blockers,
 * ordered `in_progress` first, then `pending`, then numeric ID ascending.
 */
export function selectUnblockedOpenTasks<T extends HeadlessReminderTask>(tasks: readonly T[]): T[] {
	const byId = new Map<string, T>();
	for (const task of tasks) {
		if (task.id != null) byId.set(String(task.id), task);
	}
	const unblocked = tasks.filter((task) => {
		if (task.status !== "in_progress" && task.status !== "pending") return false;
		if (task.assignee === "user") return false;
		const blockers = task.blockedBy;
		if (Array.isArray(blockers) && blockers.length > 0) {
			const hasOpenBlocker = blockers.some((rawId) => {
				const blocker = byId.get(String(rawId));
				return blocker != null && blocker.status !== "completed" && blocker.status !== "deleted";
			});
			if (hasOpenBlocker) return false;
		}
		return true;
	});
	unblocked.sort((a, b) => {
		const rank = (s: string) => (s === "in_progress" ? 0 : 1);
		const statusOrder = rank(a.status) - rank(b.status);
		if (statusOrder !== 0) return statusOrder;
		const numA = Number(a.id);
		const numB = Number(b.id);
		if (Number.isFinite(numA) && Number.isFinite(numB)) return numA - numB;
		return String(a.id ?? "").localeCompare(String(b.id ?? ""));
	});
	log.debug("selectUnblockedOpenTasks", { total: tasks.length, unblocked: unblocked.length });
	return unblocked;
}

export interface HeadlessIdleReminderDecision<T extends HeadlessReminderTask = HeadlessReminderTask> {
	fire: boolean;
	reason:
		| "fire"
		| "not-supervised"
		| "disabled"
		| "busy"
		| "active-async"
		| "not-idle"
		| "backoff-capped"
		| "cooldown"
		| "no-unblocked-tasks";
	tasks: T[];
	idleMs: number;
	effectiveDelayMs: number;
	nextNudgeCount: number;
}

/**
 * Pure decision helper for the headless supervised COMS peer idle auto-nudge (#1434).
 * Fires only when running as a supervised peer, enabled, idle (`!agentBusy`, `idleSince !== null`),
 * zero running/queued async agents, within the bounded backoff cap, past the current backoff delay,
 * and at least one unblocked non-user `in_progress` or `pending` task exists.
 */
export function decideHeadlessIdleReminder<T extends HeadlessReminderTask>(params: {
	supervisedPeer: boolean;
	enabled: boolean;
	agentBusy: boolean;
	activeAsyncCount: number;
	idleSince: number | null;
	lastNudgeAt: number;
	nudgeCount: number;
	now: number;
	baseDelayMs: number;
	tasks: readonly T[];
}): HeadlessIdleReminderDecision<T> {
	const {
		supervisedPeer,
		enabled,
		agentBusy,
		activeAsyncCount,
		idleSince,
		lastNudgeAt,
		nudgeCount,
		now,
		baseDelayMs,
		tasks,
	} = params;
	const cappedCount = Number.isFinite(nudgeCount)
		? Math.max(0, Math.floor(nudgeCount))
		: HEADLESS_IDLE_MAX_NUDGES;
	const multiplier = HEADLESS_IDLE_BACKOFF_MULTIPLIERS[cappedCount];
	const effectiveDelayMs =
		multiplier !== undefined && Number.isFinite(baseDelayMs) && baseDelayMs > 0
			? Math.round(baseDelayMs * multiplier)
			: 0;

	const skip = (
		reason: HeadlessIdleReminderDecision<T>["reason"],
		idleMs = 0,
	): HeadlessIdleReminderDecision<T> => {
		log.debug("headless_idle_reminder_skipped", {
			reason,
			nudgeCount: cappedCount,
			activeAsyncCount,
		});
		return { fire: false, reason, tasks: [], idleMs, effectiveDelayMs, nextNudgeCount: cappedCount };
	};

	if (!supervisedPeer) return skip("not-supervised");
	if (!enabled || !Number.isFinite(baseDelayMs) || baseDelayMs <= 0) return skip("disabled");
	if (agentBusy) return skip("busy");
	if (activeAsyncCount > 0) return skip("active-async");
	if (idleSince === null || !Number.isFinite(idleSince)) return skip("not-idle");
	if (cappedCount >= HEADLESS_IDLE_MAX_NUDGES || multiplier === undefined) return skip("backoff-capped");

	const anchor = Math.max(idleSince, Number.isFinite(lastNudgeAt) ? lastNudgeAt : 0);
	const idleMs = Math.max(0, now - anchor);
	if (idleMs < effectiveDelayMs) return skip("cooldown", idleMs);

	const open = selectUnblockedOpenTasks(tasks);
	if (open.length === 0) return skip("no-unblocked-tasks", idleMs);

	log.debug("headless_idle_reminder_ready", {
		openCount: open.length,
		nudgeCount: cappedCount + 1,
		effectiveDelayMs,
		idleMs,
	});
	return {
		fire: true,
		reason: "fire",
		tasks: open,
		idleMs,
		effectiveDelayMs,
		nextNudgeCount: cappedCount + 1,
	};
}

/** Content for the headless-peer idle auto-nudge (names open task IDs, notes 0 active async agents, never leaks subjects). */
export function headlessIdleReminderContent(
	openTasks: ReadonlyArray<{ id?: string | number }>,
	idleMinutes: number,
	nudgeNumber?: number,
	maxNudges?: number,
): string {
	const ids = openTasks
		.map((t) => (t.id != null ? String(t.id).trim() : ""))
		.filter(Boolean)
		.map((id) => `#${id}`);
	const idPart = ids.length > 0 ? `: ${ids.join(", ")}` : "";
	const detailParts: string[] = [];
	if (Number.isFinite(idleMinutes)) {
		detailParts.push(`idle ${Math.max(1, Math.round(idleMinutes))}m`);
	}
	detailParts.push("0 active async agents");
	if (typeof nudgeNumber === "number" && typeof maxNudges === "number") {
		detailParts.push(`nudge ${nudgeNumber}/${maxNudges}`);
	}
	log.debug("headlessIdleReminderContent", {
		count: openTasks.length,
		idleMinutes,
		taskIds: ids,
		nudgeNumber,
		maxNudges,
	});
	return `⚠️ Headless peer idle with ${openTasks.length} open unblocked task(s)${idPart} (${detailParts.join(", ")}). Resume your TaskList work or report any blocker to your coordinator via coms_send.`;
}
