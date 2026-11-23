/**
 * extensions/pitasks/index.ts — Owned task management system.
 * Based on @tintinweb/pi-tasks (MIT license).
 * Removed: TaskExecute, auto-cascade, subagent RPC, reminder cadence.
 * Added: store export for coms direct access.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";
import { isAbsolute } from "node:path";
import { TaskStore, resolveStorePath, type ResolveStorePathOptions } from "./task-store.js";
import { TaskWidget } from "./task-widget.js";
import { registerTaskTools } from "./task-tools.js";
import { createLogger } from "../shared/logger.js";
import { isLiveExtensionCtx } from "../shared/live-ctx.js";
import {
	TOGGLE_ALL_WIDGETS_EVENT,
	applyWidgetAction,
	cycleWidgetMode,
	getRegisteredWidgetShortcut,
	getWidgetMode,
	registerWidgetShortcut,
	type ToggleAllWidgetsEvent,
} from "../shared/widget-visibility.js";
import {
	DEFAULT_BRIDGE_SESSION_KEY,
	publishTaskStore,
	publishTaskTelemetryActive,
	publishedTaskTelemetryActive,
	publishedWorkloadSources,
	resolveBridgeSessionKey,
	type TaskTelemetryActiveCallback,
} from "../shared/session-bridge.js";
import { createBridgedUi } from "../shared/ui-bridge.js";
import { openTasksOverlay } from "./tasks-ui.js";
import {
	TASKS_USAGE,
	applyTaskAction,
	formatTasksPlainText,
	parseTasksCommand,
	selectTaskRows,
	taskCompletionNotice,
	tasksOverlayDeps,
} from "./tasks-view.js";
import { isBrowserDispatch } from "../shared/ui-bridge.js";
import { getSetting } from "../orchestrator/project-settings.js";
import { shouldSkipOneshotRegister } from "../shared/oneshot.js";
import {
	collectActiveAsyncTaskIds,
	decidePendingReminder,
	oldestPendingAt,
	pendingReminderContent,
	staleReminderContent,
	selectActiveTasks,
	selectStaleTasks,
	shouldFireReminder,
} from "./reminders.js";

// Re-export reminder pure helpers so consumers (and tests) can import from index.
export {
	collectActiveAsyncTaskIds,
	decidePendingReminder,
	oldestPendingAt,
	pendingReminderContent,
	resolveStorePath,
	staleReminderContent,
	selectActiveTasks,
	selectStaleTasks,
	shouldFireReminder,
	type ResolveStorePathOptions,
};

const log = createLogger("pitasks");

// Module-level refs — survive closure replacement on /reload
let currentUiCtx: any = null;
let currentStore: TaskStore | null = null;
let currentWidget: TaskWidget | null = null;
export function setTaskTelemetryActive(taskId: string, active = true, sessionKey?: string): void {
	if (typeof sessionKey === "string" && sessionKey.trim()) {
		const normalizedKey = sessionKey.trim();
		const bridged = publishedTaskTelemetryActive(normalizedKey);
		log.debug("task_telemetry_active", { taskId, active, sessionKey: normalizedKey, via: bridged ? "bridge" : "none" });
		bridged?.(taskId, active);
		return;
	}
	if (currentWidget) {
		log.debug("task_telemetry_active", { taskId, active, via: "local" });
		currentWidget.setActiveTask(taskId, active);
		return;
	}
	const bridged = publishedTaskTelemetryActive();
	log.debug("task_telemetry_active", { taskId, active, via: bridged ? "bridge" : "none" });
	bridged?.(taskId, active);
}

/** Exported store instance — set during extension init. */
export let taskStore: TaskStore;

// The store is published to other extension modules through the shared bridge: they
// cannot read this `export let` binding (they would snapshot `undefined`), which silently
// disabled task-id validation (issue #1016). Published once, from registration only —
// the bridge's getter follows later store swaps, so the upgrade path needs no republish.

/** Create a task directly — for use by other extensions (e.g., coms auto-create). */
export function createTask(subject: string, description: string, createdBy?: any, metadata?: Record<string, any>): any {
	return taskStore.create(subject, description, createdBy || { type: "local", origin: "system", session: "", project: "" }, undefined, metadata);
}

/** Get a task by ID — for use by other extensions (e.g., coms heartbeat). */
export function getTask(id: string): any {
	return taskStore?.get(id);
}

/** List all tasks — for use by other extensions (e.g., coms heartbeat). */
export function listTasks(): any[] {
	return taskStore?.list() ?? [];
}

/** Update a task — for use by other extensions. */
export function updateTask(id: string, fields: any): any {
	log.debug("task_updated", { taskId: id, fieldNames: Object.keys(fields) });
	guardPeerTaskTransition(taskStore?.get(id)?.assignee, "", id, fields);
	const result = taskStore.update(id, fields);
	if (result.changedFields.includes("status")) setTaskTelemetryActive(id, fields.status === "in_progress");
	return result;
}

/** Delete a task — for use by other extensions. */
export function deleteTask(id: string): boolean {
	return taskStore.delete(id);
}

// ── Session-targeted & store-path-targeted task operations (for cross-session/peer access) ────

function withStoreAtPath<T>(storePath: string, fn: (store: TaskStore) => T): T {
	const trimmed = typeof storePath === "string" ? storePath.trim() : "";
	if (!trimmed || !isAbsolute(trimmed)) {
		log.error("store_path_invalid", { storePath, isAbsolute: Boolean(trimmed && isAbsolute(trimmed)) });
		throw new Error(`Valid absolute task store path required (got ${JSON.stringify(storePath)})`);
	}
	const store = new TaskStore(trimmed, { watch: false });
	try {
		return fn(store);
	} finally {
		store.close();
	}
}

function requireSessionStorePath(sessionId: string, targetCwd?: string): string {
	const storePath = resolveStorePath(sessionId, { cwd: targetCwd, piTasks: undefined, taskScope: "session" });
	if (!storePath) {
		log.error("session_store_path_unresolved", { sessionId, hasTargetCwd: Boolean(targetCwd) });
		throw new Error("Session task store requires a non-empty sessionId");
	}
	return storePath;
}

function guardPeerTaskTransition(assignee: unknown, scopeId: string, taskId: string, fields: Record<string, any>): void {
	if ((fields.status === "in_progress" || fields.status === "completed") &&
		(assignee === "user" || fields.assignee === "user")) {
		log.debug("session_task_owner_transition_refused", { sessionId: scopeId, taskId, status: fields.status });
		throw new Error(`Task #${taskId}: only the user may start or complete a user-assigned task`);
	}
	if (assignee === "user" && fields.assignee !== undefined) {
		log.debug("session_task_owner_reassign_refused", { sessionId: scopeId, taskId });
		throw new Error(`Task #${taskId}: only the user may reassign a user-assigned task`);
	}
	if (fields.completedBy !== undefined || fields.completionNote !== undefined) {
		log.debug("session_task_peer_outcome_refused", { sessionId: scopeId, taskId });
		throw new Error(`Task #${taskId}: only the user may record completion attribution or notes`);
	}
}

/** Create multiple tasks at a resolved task store path. */
export function createTasksAtStorePath(
	storePath: string,
	tasks: Array<{ subject: string; description: string; createdBy: any; blockedBy?: string[]; activeForm?: string; metadata?: Record<string, any> }>,
): any[] {
	log.debug("store_path_tasks_created", { storePath, count: tasks.length });
	return withStoreAtPath(storePath, (store) => store.createTasks(tasks));
}

/** Get a task by ID from a resolved task store path. */
export function getTaskAtStorePath(storePath: string, taskId: string): any {
	log.debug("store_path_task_read", { storePath, taskId });
	return withStoreAtPath(storePath, (store) => store.get(taskId));
}

/** List all tasks from a resolved task store path. */
export function listTasksAtStorePath(storePath: string): any[] {
	log.debug("store_path_tasks_listed", { storePath });
	return withStoreAtPath(storePath, (store) => store.list());
}

/** Update a task at a resolved task store path. */
export function updateTaskAtStorePath(storePath: string, taskId: string, fields: any, scopeId = storePath): any {
	log.debug("store_path_task_updated", { storePath, taskId, fieldNames: Object.keys(fields) });
	return withStoreAtPath(storePath, (store) => {
		guardPeerTaskTransition(store.get(taskId)?.assignee, scopeId, taskId, fields);
		return store.update(taskId, fields);
	});
}

/** Delete a task from a resolved task store path. */
export function deleteTaskAtStorePath(storePath: string, taskId: string): boolean {
	log.debug("store_path_task_deleted", { storePath, taskId });
	return withStoreAtPath(storePath, (store) => store.delete(taskId));
}

/** Create a task on a specific session's store. Used by coms for sender-side task creation. */
export function createTaskForSession(sessionId: string, subject: string, description: string, createdBy?: any, metadata?: Record<string, any>, targetCwd?: string, activeForm?: string): any {
	log.debug("session_task_created", { sessionId });
	const storePath = requireSessionStorePath(sessionId, targetCwd);
	return withStoreAtPath(storePath, (store) =>
		store.create(subject, description, createdBy || { type: "local", origin: "system", session: "", project: "" }, activeForm, metadata),
	);
}

/** Create multiple tasks on a specific session's store. Used by coms for bulk task creation. */
export function createTasksForSession(sessionId: string, tasks: Array<{ subject: string; description: string; createdBy: any; blockedBy?: string[]; activeForm?: string; metadata?: Record<string, any> }>, targetCwd?: string): any[] {
	log.debug("session_tasks_created", { sessionId, count: tasks.length });
	return createTasksAtStorePath(requireSessionStorePath(sessionId, targetCwd), tasks);
}

/** Get a task from a specific session's store. */
export function getTaskForSession(sessionId: string, taskId: string, targetCwd?: string): any {
	log.debug("session_task_read", { sessionId, taskId });
	return getTaskAtStorePath(requireSessionStorePath(sessionId, targetCwd), taskId);
}

/** List tasks from a specific session's store. */
export function listTasksForSession(sessionId: string, targetCwd?: string): any[] {
	log.debug("session_tasks_listed", { sessionId });
	return listTasksAtStorePath(requireSessionStorePath(sessionId, targetCwd));
}

/** Update a task on a specific session's store. */
export function updateTaskForSession(sessionId: string, taskId: string, fields: any, targetCwd?: string): any {
	log.debug("session_task_updated", { sessionId, taskId, fieldNames: Object.keys(fields) });
	return updateTaskAtStorePath(requireSessionStorePath(sessionId, targetCwd), taskId, fields, sessionId);
}

/** Update multiple tasks on a specific session's store. Used by coms for bulk updates. */
export function updateTasksForSession(sessionId: string, updates: Array<{ id: string; fields: Record<string, any> }>, targetCwd?: string): any[] {
	log.debug("session_tasks_updated", { sessionId, count: updates.length });
	const storePath = requireSessionStorePath(sessionId, targetCwd);
	return withStoreAtPath(storePath, (store) => {
		const assignees = new Map<string, unknown>();
		for (const { id, fields } of updates) {
			const assignee = assignees.has(id) ? assignees.get(id) : store.get(id)?.assignee;
			guardPeerTaskTransition(assignee, sessionId, id, fields);
			assignees.set(id, fields.assignee !== undefined ? (fields.assignee === "user" ? "user" : "llm") : assignee);
		}
		return store.updateTasks(updates);
	});
}

/** Delete a task from a specific session's store. */
export function deleteTaskForSession(sessionId: string, taskId: string, targetCwd?: string): boolean {
	log.debug("session_task_deleted", { sessionId, taskId });
	return deleteTaskAtStorePath(requireSessionStorePath(sessionId, targetCwd), taskId);
}

function normalizeTaskRefId(raw: unknown): string | null {
	const id = typeof raw === "string"
		? raw.trim()
		: typeof raw === "number" && Number.isFinite(raw)
			? String(raw)
			: "";
	return id && id !== "-1" ? id : null;
}

function extractToolTaskRefs(args: any): string[] {
	if (!args || typeof args !== "object") return [];
	const out: string[] = [];
	const push = (raw: unknown) => {
		const id = normalizeTaskRefId(raw);
		if (id && !out.includes(id)) out.push(id);
	};
	// Only camelCase taskId/taskIds belong to local tools; snake_case task_id targets remote peers (coms_task_*).
	push(args.taskId);
	if (Array.isArray(args.updates)) {
		for (const item of args.updates) push(item?.taskId);
	}
	if (Array.isArray(args.taskIds)) {
		for (const id of args.taskIds) push(id);
	}
	if (Array.isArray(args.tasks)) {
		for (const item of args.tasks) push(item?.taskId);
	}
	if (Array.isArray(args.chain)) {
		for (const step of args.chain) push(step?.taskId);
	}
	return out;
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;
	if (shouldSkipOneshotRegister(log)) return;
	let shuttingDown = false;
	const turnTaskRefs = new Set<string>();
	const taskScope: "session" | "project" = process.env.PI_TASK_SCOPE === "project" ? "project" : "session";
	const piTasks = process.env.PI_TASKS;

	const resumedActiveTaskIds = currentWidget?.getActiveTaskIds() ?? [];
	currentStore?.setOnChange(() => {});
	currentStore?.close();
	currentWidget?.dispose();
	let store = new TaskStore(resolveStorePath(undefined, { cwd: process.cwd(), piTasks, taskScope }));
	taskStore = store;
	currentStore = store;
	const widget = new TaskWidget(store);
	widget.setMode(getWidgetMode("tasks", process.cwd()));
	let currentCtx: any = null;
	const tasksShortcut = registerWidgetShortcut(
		pi,
		"widget_tasks_shortcut",
		process.cwd(),
		"Collapse/expand tasks widget",
		(ctx) => {
			if (shuttingDown || !isLiveExtensionCtx(ctx)) return;
			currentCtx = ctx;
			currentUiCtx = ctx.ui;
			widget.setUICtx(ctx.ui);
			const next = cycleWidgetMode("tasks", ctx.cwd || process.cwd());
			widget.setMode(next);
			log.info("tasks_widget_shortcut_cycled", { mode: next });
		},
	);
	widget.setShortcutHint(tasksShortcut);
	let unsubToggleAll: (() => void) | undefined;
	function subscribeToggleAll(): void {
		try { unsubToggleAll?.(); } catch {}
		try { (globalThis as any).__pitasks_toggle_all_unsubscribe?.(); } catch {}
		unsubToggleAll = undefined;
		try {
			unsubToggleAll = pi.events.on(TOGGLE_ALL_WIDGETS_EVENT, (data: unknown) => {
				if (shuttingDown) return;
				const payload = data as Partial<ToggleAllWidgetsEvent> | undefined;
				const cwd = payload?.cwd || (currentCtx && isLiveExtensionCtx(currentCtx) ? currentCtx.cwd : undefined) || process.cwd();
				const next = payload?.modes?.tasks ?? getWidgetMode("tasks", cwd);
				if (currentCtx && isLiveExtensionCtx(currentCtx)) {
					currentUiCtx = currentCtx.ui;
					widget.setUICtx(currentCtx.ui);
				}
				widget.setMode(next);
				log.debug("tasks_widget_toggle_all_applied", { mode: next });
			});
			(globalThis as any).__pitasks_toggle_all_unsubscribe = unsubToggleAll;
		} catch (e: any) {
			log.warn("tasks_widget_toggle_all_subscribe_failed", { error: e?.message });
		}
	}
	subscribeToggleAll();
	store.setOnChange(() => { widget.update(); broadcastTasks(); });
	for (const taskId of resumedActiveTaskIds) widget.setActiveTask(taskId);
	currentWidget = widget;
	// Registration and session transitions publish closure-local bindings keyed by sessionId so
	// concurrent sessions in pi-sidecar never clobber each other's store or telemetry callback.
	let bridgeSessionKey = DEFAULT_BRIDGE_SESSION_KEY;
	let unregisterTaskStore: (() => void) | null = null;
	let unregisterTaskTelemetry: (() => void) | null = null;
	const getLiveStore = () => (shuttingDown ? null : store);
	const onTelemetryActive: TaskTelemetryActiveCallback = (taskId, active = true) => {
		log.debug("task_telemetry_active_bridged", { taskId, active, hasWidget: Boolean(!shuttingDown && widget) });
		if (!shuttingDown) widget.setActiveTask(taskId, active);
	};
	const syncTaskBridge = (ctx?: any, preserveNamedOnMissingId = false): void => {
		const resolvedKey = ctx ? resolveBridgeSessionKey(ctx) : bridgeSessionKey;
		const nextKey =
			preserveNamedOnMissingId &&
			resolvedKey === DEFAULT_BRIDGE_SESSION_KEY &&
			bridgeSessionKey !== DEFAULT_BRIDGE_SESSION_KEY
				? bridgeSessionKey
				: resolvedKey;
		if (unregisterTaskStore && unregisterTaskTelemetry && nextKey === bridgeSessionKey) return;
		unregisterTaskStore?.();
		unregisterTaskTelemetry?.();
		bridgeSessionKey = nextKey;
		unregisterTaskStore = publishTaskStore(getLiveStore, bridgeSessionKey);
		unregisterTaskTelemetry = publishTaskTelemetryActive(onTelemetryActive, bridgeSessionKey);
	};
	syncTaskBridge();
	const instanceId = Math.random().toString(36).slice(2, 8);
	(globalThis as any).__pitasks_active_instance = instanceId;

	let storeUpgraded = false;
	let persistedTasksShown = false;

	function upgradeStoreIfNeeded(ctx: any): void {
		if (storeUpgraded) return;
		const baseCwd = ctx?.cwd || process.cwd();
		const sessionId = ctx?.sessionManager?.getSessionId?.();
		const path = resolveStorePath(sessionId, { cwd: baseCwd, piTasks, taskScope });
		if (!piTasks && taskScope === "session" && !path) {
			log.debug("store_upgrade_deferred", { reason: "missing_session_id", cwd: baseCwd });
			return;
		}
		if (path !== store.filePath) {
			store.setOnChange(() => {});
			store.close();
			store = new TaskStore(path);
			taskStore = store;
			currentStore = store;
			widget.setStore(store);
			store.setOnChange(() => { widget.update(); broadcastTasks(); });
			log.debug("store upgraded", path);
		}
		storeUpgraded = true;
	}

	function showPersistedTasks(isResume = false): void {
		if (persistedTasksShown) return;
		persistedTasksShown = true;
		const tasks = store.list();
		if (tasks.length > 0) {
			if (!isResume && tasks.every(t => t.status === "completed")) {
				store.clearCompleted();
				if (taskScope === "session") store.deleteFileIfEmpty();
			} else {
				widget.update();
			}
		}
	}

	// Register tools
	registerTaskTools(pi, () => store, widget);

	// ── #968 part A: pidash browser bridge ─────────────────────────────
	// Operations go through THIS live store (single writer); results broadcast
	// to every browser watching the session via pidash event forwarding.
	function broadcastTasks(): void {
		try {
			pi.events.emit("pidash:tasks-list", { tasks: store.list().filter((t: any) => t.status !== "deleted") });
		} catch (e: any) { log.warn("pidash_task_broadcast_failed", { error: e?.message }); }
	}
	function manualTaskOperations(ui: any) {
		return tasksOverlayDeps(store, (taskId) => {
			widget.setActiveTask(taskId, false);
			widget.update();
		}, (task) => {
			try {
				pi.sendMessage(taskCompletionNotice(task), { triggerTurn: true, deliverAs: "followUp" });
				log.info("task_completed_notice_sent", { taskId: task.id });
			} catch (error) {
				// Submission may have succeeded before throwing; never retry or log its content.
				log.error("task_completed_notice_failed", { taskId: task.id, errorType: error instanceof Error ? error.name : typeof error });
				ui?.notify(`Task #${task.id} completed, but its notice could not be submitted. Read it with TaskGet.`, "warning");
			}
		});
	}
	function handleTaskOp(data: any): void {
		const op = data?.op;
		try {
			switch (op) {
				case "create":
					if (!data.subject) return;
					store.create(data.subject, data.description || "", { type: "local", origin: "user", session: "", project: process.cwd() });
					log.info("pidash_task_created", { subject: data.subject });
					break;
				case "start":
					if (data.taskId) { store.update(data.taskId, { status: "in_progress" }); widget.setActiveTask(data.taskId, true); }
					break;
				case "complete":
					if (data.taskId) { manualTaskOperations(currentUiCtx).completeTask(data.taskId, { by: "user" }); widget.setActiveTask(data.taskId, false); }
					break;
				case "delete":
					if (data.taskId) { store.update(data.taskId, { status: "deleted" }); widget.setActiveTask(data.taskId, false); }
					break;
				case "clear-completed":
					store.clearCompleted();
					if (taskScope === "session") store.deleteFileIfEmpty();
					break;
				case "clear-all":
					store.clearAll();
					if (taskScope === "session") store.deleteFileIfEmpty();
					break;
				default:
					log.debug("pidash_task_op_unknown", op);
					return;
			}
			widget.update();
			broadcastTasks();
			log.info("pidash_task_op", { op, taskId: data.taskId });
		} catch (e: any) {
			log.warn("pidash_task_op_failed", { op, error: e?.message });
		}
	}
	pi.events.on("pidash:tasks-list-request", () => broadcastTasks());
	pi.events.on("pidash:task-op", (data: unknown) => handleTaskOp(data as any));

	// Time-based GC: auto-clear completed tasks after configured minutes
	let gcTimer: ReturnType<typeof setInterval> | null = null;
	const startGcTimer = () => {
		if (gcTimer) clearInterval(gcTimer);
		gcTimer = setInterval(() => {
			try {
				if (!getSetting(process.cwd(), "task_auto_clear_enabled")) return;
				const minutes = getSetting(process.cwd(), "task_auto_clear_minutes");
				const threshold = minutes * 60000;
				const now = Date.now();
				const tasks = store.list();
				const expiredIds: string[] = [];
				for (const task of tasks) {
					if (task.status === "completed" && task.statusHistory?.completed_at) {
						if (now - new Date(task.statusHistory.completed_at).getTime() > threshold) {
							expiredIds.push(task.id);
						}
					}
				}
				if (expiredIds.length > 0 && store.deleteTasks(expiredIds) > 0) {
					log.debug("task_gc_cleared", { count: expiredIds.length });
					widget.update();
				}
			} catch {}
		}, 60000);
		if (gcTimer.unref) gcTimer.unref();
	};
	startGcTimer();

	// Time-based reminder: periodic nudge when tasks exist but none in_progress
	let reminderTimer: ReturnType<typeof setInterval> | null = null;
	let lastReminderAt = 0;
	let lastStaleReminderAt = 0;
	let agentBusy = false;       // true while the agent is actively running a turn
	const startReminderTimer = () => {
		if (reminderTimer) clearInterval(reminderTimer);
		reminderTimer = setInterval(() => {
			// Pending-only reminder: nudge when tasks exist but none in_progress
			try {
				if (getSetting(process.cwd(), "task_reminder_enabled")) {
					const minutes = getSetting(process.cwd(), "task_reminder_interval_minutes");
					const threshold = minutes * 60000;
					const now = Date.now();
					// Interval gate first: never reload the task list while cooling down.
					if (now - lastReminderAt >= threshold) {
						// Same interval gates both the age of the oldest pending task and repeats.
						const { fire, activeCount } = decidePendingReminder({
							tasks: store.list(),
							agentBusy,
							lastReminderAt,
							now,
							threshold,
						});
						if (fire) {
							lastReminderAt = now;
							try {
								pi.sendMessage({
									customType: "task-focus-reminder",
									content: pendingReminderContent(activeCount),
									display: true,
								}, { triggerTurn: true });
								log.info("reminder_fired", "active", activeCount);
							} catch {}
						}
					}
				}
			} catch {}

			// Stale in_progress reminder
			try {
				if (!getSetting(process.cwd(), "task_stale_in_progress_enabled")) return;
				const staleMinutes = getSetting(process.cwd(), "task_stale_in_progress_minutes");
				const staleThreshold = staleMinutes * 60000;
				const now2 = Date.now();
				if (now2 - lastStaleReminderAt < staleThreshold) return;
				const allTasks = store.list();
				const activeAsyncIds = collectActiveAsyncTaskIds(
					publishedWorkloadSources(currentCtx?.sessionManager?.getSessionId?.())?.agents(),
				);
				const staleTasks = selectStaleTasks(allTasks, now2, staleThreshold, activeAsyncIds);
				if (staleTasks.length > 0) {
					if (!shouldFireReminder(agentBusy, staleTasks.length)) {
						log.debug("reminder_skipped", "busy");
					} else {
						lastStaleReminderAt = now2;
						try {
							pi.sendMessage({
								customType: "task-focus-reminder",
								content: staleReminderContent(staleTasks, staleMinutes),
								display: true,
							}, { triggerTurn: true });
							log.info("stale_reminder_fired", {
								stale: staleTasks.length,
								thresholdMinutes: staleMinutes,
								taskIds: staleTasks.map((t: any) => t.id),
							});
						} catch {}
					}
				}
			} catch {}
		}, 60000);
		if (reminderTimer.unref) reminderTimer.unref();
	};
	startReminderTimer();

	pi.on("session_shutdown", () => {
		shuttingDown = true;
		unregisterTaskStore?.();
		unregisterTaskStore = null;
		unregisterTaskTelemetry?.();
		unregisterTaskTelemetry = null;
		turnTaskRefs.clear();
		if (gcTimer) { clearInterval(gcTimer); gcTimer = null; }
		if (reminderTimer) { clearInterval(reminderTimer); reminderTimer = null; }
		try { unsubToggleAll?.(); } catch {}
		unsubToggleAll = undefined;
		currentCtx = null;
		widget.deactivate();
		store.setOnChange(() => {});
		store.close();
		if (currentWidget === widget) {
			currentWidget = null;
			currentStore = null;
		}
	});

	pi.on("turn_start", async (_event: any, ctx: any) => {
		if (shuttingDown) return;
		turnTaskRefs.clear();
		agentBusy = true;
		log.debug("agentBusy", "turn_start");
		currentCtx = ctx;
		syncTaskBridge(ctx, true);
		widget.setUICtx(ctx.ui);
		currentUiCtx = ctx.ui;
		upgradeStoreIfNeeded(ctx);
		widget.beginTurn();
	});

	pi.on("turn_end", async (event: any) => {
		const refsSnapshot = new Set(turnTaskRefs);
		turnTaskRefs.clear();
		if (shuttingDown) return;
		agentBusy = false;
		log.debug("agentBusy", "turn_end", { turnRefCount: refsSnapshot.size });
		const msg = (event as any).message;
		if (msg?.role === "assistant" && msg.usage) {
			widget.addTokenUsage(msg.usage.input ?? 0, msg.usage.output ?? 0, refsSnapshot);
		} else {
			widget.beginTurn();
		}
	});

	// agent_settled is guaranteed to fire even if turn_end is skipped (abort/error).
	// Reset agentBusy defensively so reminders are never suppressed forever.
	pi.on("agent_settled", async () => {
		turnTaskRefs.clear();
		if (shuttingDown) return;
		agentBusy = false;
		widget.beginTurn();
		log.debug("agentBusy", "agent_settled reset");
	});

	pi.on("session_start", async (event: any, ctx: any) => {
		shuttingDown = false;
		turnTaskRefs.clear();
		agentBusy = false;
		log.debug("agentBusy", "session_start reset");
		currentCtx = ctx;
		syncTaskBridge(ctx);
		widget.reactivate(ctx.ui);
		store.reopen();
		store.setOnChange(() => { widget.update(); broadcastTasks(); });
		currentWidget = widget;
		currentStore = store;
		currentUiCtx = ctx.ui;
		const reason = (event as any).reason;
		log.debug("session_start", reason);
		const isSwitch = reason === "new" || reason === "resume" || reason === "fork";
		const forkSeed = reason === "fork" ? store.snapshot() : undefined;
		if (isSwitch) {
			storeUpgraded = false;
			persistedTasksShown = false;
			if (reason === "new") store.clearAll();
		}
		// Re-register command on reload to replace stale registration from old runtime
		if (reason === "reload") {
			log.debug("session_start reload — re-registering command");
			registerTasksCommand();
		}
		upgradeStoreIfNeeded(ctx);
		if (forkSeed?.tasks.length) store.seed(forkSeed);
		const sessionCwd = ctx?.cwd || process.cwd();
		// Re-subscribe after session_shutdown so /new, /resume, and /fork still receive toggle-all.
		subscribeToggleAll();
		// Always advertise the shortcut binding accepted at registration (never an unbound edit).
		widget.setShortcutHint(getRegisteredWidgetShortcut("widget_tasks_shortcut"));
		widget.setMode(getWidgetMode("tasks", sessionCwd));
		widget.beginTurn();
		showPersistedTasks(reason === "reload" || reason === "resume" || reason === "fork");
	});

	pi.on("before_agent_start", async (_event: any, ctx: any) => {
		if (shuttingDown) return;
		turnTaskRefs.clear();
		agentBusy = true;
		log.debug("agentBusy", "before_agent_start");
		currentCtx = ctx;
		syncTaskBridge(ctx, true);
		widget.setUICtx(ctx.ui);
		currentUiCtx = ctx.ui;
		upgradeStoreIfNeeded(ctx);
		widget.beginTurn();
		showPersistedTasks();
	});

	pi.on("tool_execution_start", async (event: any, ctx: any) => {
		if (shuttingDown) return;
		const refTaskIds = extractToolTaskRefs(event?.args);
		if (refTaskIds.length > 0) {
			for (const refTaskId of refTaskIds) turnTaskRefs.add(refTaskId);
			log.debug("task_telemetry_ref_collected", { toolName: event?.toolName, taskIds: refTaskIds });
		} else if (event?.args?.taskId !== undefined || event?.args?.task_id !== undefined) {
			log.debug("task_telemetry_ref_ignored", { toolName: event?.toolName, taskId: event?.args?.taskId ?? event?.args?.task_id });
		}
		currentCtx = ctx;
		widget.setUICtx(ctx.ui);
		currentUiCtx = ctx.ui;
		upgradeStoreIfNeeded(ctx);
		widget.update();
	});

	// /tasks command — extracted so it can be re-registered on reload
	let tasksCmdHandler: any;
	function completeTasksArgs(prefix: string): AutocompleteItem[] | null {
		const tokens = prefix.trim().split(/\s+/).filter(Boolean);
		const atNextToken = prefix.endsWith(" ") || tokens.length === 0;
		const lastPart = atNextToken ? "" : tokens[tokens.length - 1];
		const completed = atNextToken ? tokens : tokens.slice(0, -1);
		const base = atNextToken ? prefix : prefix.slice(0, prefix.length - lastPart.length);
		const mk = (items: { v: string; l: string; d: string }[]): AutocompleteItem[] | null => {
			const mapped: AutocompleteItem[] = items.map((i) => ({ value: base + i.v, label: i.l, description: i.d }));
			if (!lastPart.trim()) return mapped.length > 0 ? mapped : null;
			const filtered = fuzzyFilter(mapped, lastPart, (i) => `${i.label} ${i.description || ""}`);
			return filtered.length > 0 ? filtered : null;
		};
		if (completed.length === 0) {
			return mk([
				{ v: "mine", l: "mine", d: "Show only tasks assigned to you" },
				{ v: "create", l: "create", d: "Create a new task" },
				{ v: "start ", l: "start", d: "Mark a task in progress: start <id>" },
				{ v: "done ", l: "done", d: "Mark a task completed: done <id>" },
				{ v: "clear ", l: "clear", d: "Clear completed or all tasks" },
				{ v: "widget ", l: "widget", d: "Collapse or expand tasks widget: expand | collapse | toggle" },
			]);
		}
		if (completed[0] === "clear" && completed.length === 1) {
			return mk([
				{ v: "completed", l: "completed", d: "Remove completed tasks" },
				{ v: "all", l: "all", d: "Remove all tasks" },
			]);
		}
		if (completed[0] === "widget" && completed.length === 1) {
			return mk([
				{ v: "expand", l: "expand", d: "Show full task list widget" },
				{ v: "collapse", l: "collapse", d: "Collapse to 1-line header (pauses spinner)" },
				{ v: "toggle", l: "toggle", d: "Toggle between expanded and collapsed" },
			]);
		}
		return null;
	}
	function registerTasksCommand(): void {
		log.debug("registerTasksCommand called");
		pi.registerCommand("tasks", {
			description: "Tasks: list overlay, create, start, done, clear completed|all, widget [expand|collapse|toggle]",
			getArgumentCompletions: completeTasksArgs,
			handler: tasksCmdHandler = async (args: string, ctx: any) => {
				const cmd = parseTasksCommand(args);
				log.debug("/tasks handler called", cmd.kind);
				if (cmd.kind === "usage") { ctx.ui?.notify(TASKS_USAGE, "warning"); return; }
				if (cmd.kind === "widget") {
					const cwd = ctx?.cwd || process.cwd();
					const next = applyWidgetAction("tasks", cmd.action, cwd);
					if (ctx?.ui) {
						currentCtx = ctx;
						currentUiCtx = ctx.ui;
						currentWidget?.setUICtx(ctx.ui);
					}
					currentWidget?.setMode(next);
					log.info("tasks_widget_mode_updated", { mode: next, action: cmd.action });
					ctx.ui?.notify(`Tasks widget: ${next}`, "info");
					return;
				}
				if (cmd.kind === "clear-completed" || cmd.kind === "clear-all") {
					const cleared = cmd.kind === "clear-completed" ? taskStore.clearCompleted() : taskStore.clearAll();
					if (taskScope === "session") taskStore.deleteFileIfEmpty();
					currentWidget?.update();
					log.info("tasks_cleared", { scope: cmd.kind, cleared });
					ctx.ui?.notify(`Cleared ${cleared} task${cleared === 1 ? "" : "s"}.`, "info");
					return;
				}
				const manualTasks = manualTaskOperations(ctx.ui);
				if (cmd.kind === "start" || cmd.kind === "done") {
					const outcome = applyTaskAction(cmd.kind, cmd.id, {
						get: (taskId) => taskStore.get(taskId),
						update: (taskId, status) => {
							if (status === "completed") manualTasks.completeTask(taskId, { by: "user" });
							else taskStore.update(taskId, { status });
						},
						onChanged: (taskId, status) => {
							currentWidget?.setActiveTask(taskId, status === "in_progress");
							currentWidget?.update();
						},
					});
					if (outcome === "blocked") { ctx.ui?.notify(`Task #${cmd.id} has open blockers; complete them before /tasks start ${cmd.id}.`, "warning"); return; }
					if (outcome === "missing") { ctx.ui?.notify(`No task #${cmd.id}.`, "warning"); return; }
					if (outcome === "refused") { ctx.ui?.notify(`Task #${cmd.id} is completed; it is not restarted by /tasks start.`, "warning"); return; }
					if (outcome === "unchanged") { ctx.ui?.notify(`Task #${cmd.id} is already ${cmd.kind === "done" ? "completed" : "in progress"}.`, "info"); return; }
					ctx.ui?.notify(`Task #${cmd.id} → ${cmd.kind === "done" ? "completed" : "in progress"}.`, "info");
					return;
				}
				if (cmd.kind === "create") {
					if (!ctx.hasUI && !isBrowserDispatch(ctx)) {
						log.info("tasks_create_requires_input");
						ctx.ui?.notify("/tasks create requires an interactive UI. Use the TaskCreate tool with subject and description in a headless session.", "warning");
						return;
					}
					// #968 part B: prompts are bridged — answerable from TUI or pidash browser
					const bridgedUi = createBridgedUi(pi);
					const subject = await bridgedUi.input(ctx, "Task subject");
					if (!subject) return;
					const description = await bridgedUi.input(ctx, "Task description");
					if (!description) return;
					taskStore.create(subject, description, { type: "local", origin: "user", session: "", project: process.cwd() });
					currentWidget?.update();
					log.info("tasks_created_via_command");
					return;
				}
				// list — the fullscreen overlay needs a real terminal. No UI, or a command dispatched
				// from the pidash browser (whose user cannot see the terminal), gets the same plain text.
				if (!ctx.hasUI || isBrowserDispatch(ctx)) {
					const allTasks = taskStore.list();
					const tasks = selectTaskRows(allTasks, { mine: cmd.mine });
					log.debug("tasks_list_plain_text", { hasUI: !!ctx.hasUI, browser: isBrowserDispatch(ctx), count: tasks.length, mine: !!cmd.mine });
					ctx.ui?.notify(formatTasksPlainText(tasks, (id) => allTasks.find((t) => t.id === id)), "info");
					return;
				}
				await openTasksOverlay(ctx, manualTasks, { mine: cmd.mine });
			},
		});
	}
	registerTasksCommand();
		// Expose handler to pidash for browser command dispatch
		try {
			try { (globalThis as any).__pitasks_pidash_unsubscribe?.(); } catch {}
			const registerWithPidash = () => pi.events.emit("pidash:register-command", { name: "tasks", handler: tasksCmdHandler });
			(globalThis as any).__pitasks_pidash_unsubscribe = pi.events.on("pidash:request-commands", registerWithPidash);
			registerWithPidash();
		} catch {}
	log.debug("extension factory complete");
}
