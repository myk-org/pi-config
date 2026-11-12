/**
 * extensions/pitasks/index.ts — Owned task management system.
 * Based on @tintinweb/pi-tasks (MIT license).
 * Removed: TaskExecute, auto-cascade, subagent RPC, reminder cadence.
 * Added: store export for coms direct access.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { TaskStore } from "./task-store.js";
import { TaskWidget } from "./task-widget.js";
import { registerTaskTools } from "./task-tools.js";
import { createLogger } from "../shared/logger.js";
import { publishTaskStore } from "../shared/task-store-bridge.js";
import { createBridgedUi } from "../shared/ui-bridge.js";
import { openTasksOverlay } from "./tasks-ui.js";
import {
	TASKS_USAGE,
	applyTaskAction,
	formatTasksPlainText,
	parseTasksCommand,
	tasksOverlayDeps,
} from "./tasks-view.js";
import { isBrowserDispatch } from "../shared/ui-bridge.js";
import { getSetting } from "../orchestrator/project-settings.js";
import { shouldSkipOneshotRegister } from "../shared/oneshot.js";
import {
	decidePendingReminder,
	oldestPendingAt,
	pendingReminderContent,
	staleReminderContent,
	shouldFireReminder,
	selectActiveTasks,
} from "./reminders.js";

// Re-export reminder pure helpers so consumers (and tests) can import from index.
export {
	decidePendingReminder,
	oldestPendingAt,
	pendingReminderContent,
	staleReminderContent,
	shouldFireReminder,
	selectActiveTasks,
};

const log = createLogger("pitasks");

// Module-level refs — survive closure replacement on /reload
let currentUiCtx: any = null;
let currentStore: TaskStore | null = null;
let currentWidget: TaskWidget | null = null;
export function setTaskTelemetryActive(taskId: string, active = true): void {
	log.debug("task_telemetry_active", { taskId, active });
	currentWidget?.setActiveTask(taskId, active);
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
	const result = taskStore.update(id, fields);
	if (result.changedFields.includes("status")) setTaskTelemetryActive(id, fields.status === "in_progress");
	return result;
}

/** Delete a task — for use by other extensions. */
export function deleteTask(id: string): boolean {
	return taskStore.delete(id);
}

// ── Session-targeted task operations (for cross-session/peer access) ────

/** Create a task on a specific session's store. Used by coms for sender-side task creation. */
export function createTaskForSession(sessionId: string, subject: string, description: string, createdBy?: any, metadata?: Record<string, any>, targetCwd?: string, activeForm?: string): any {
	log.debug("session_task_created", { sessionId });
	const base = targetCwd || process.cwd();
	const storePath = join(base, ".pi", "tasks", `tasks-${sessionId.replace(/[/\\]/g, "_")}.json`);
	const store = new TaskStore(storePath);
	try {
		return store.create(subject, description, createdBy || { type: "local", origin: "system", session: "", project: "" }, activeForm, metadata);
	} finally {
		store.close();
	}
}

/** Create multiple tasks on a specific session's store. Used by coms for bulk task creation. */
export function createTasksForSession(sessionId: string, tasks: Array<{ subject: string; description: string; createdBy: any; blockedBy?: string[]; activeForm?: string; metadata?: Record<string, any> }>, targetCwd?: string): any[] {
	log.debug("session_tasks_created", { sessionId, count: tasks.length });
	const base = targetCwd || process.cwd();
	const storePath = join(base, ".pi", "tasks", `tasks-${sessionId.replace(/[/\\]/g, "_")}.json`);
	const store = new TaskStore(storePath);
	try {
		return store.createTasks(tasks);
	} finally {
		store.close();
	}
}

/** Get a task from a specific session's store. */
export function getTaskForSession(sessionId: string, taskId: string, targetCwd?: string): any {
	log.debug("session_task_read", { sessionId, taskId });
	const base = targetCwd || process.cwd();
	const storePath = join(base, ".pi", "tasks", `tasks-${sessionId.replace(/[/\\]/g, "_")}.json`);
	const store = new TaskStore(storePath);
	try {
		return store.get(taskId);
	} finally {
		store.close();
	}
}

/** List tasks from a specific session's store. */
export function listTasksForSession(sessionId: string, targetCwd?: string): any[] {
	log.debug("session_tasks_listed", { sessionId });
	const base = targetCwd || process.cwd();
	const storePath = join(base, ".pi", "tasks", `tasks-${sessionId.replace(/[/\\]/g, "_")}.json`);
	const store = new TaskStore(storePath);
	try {
		return store.list();
	} finally {
		store.close();
	}
}

/** Update a task on a specific session's store. */
export function updateTaskForSession(sessionId: string, taskId: string, fields: any, targetCwd?: string): any {
	log.debug("session_task_updated", { sessionId, taskId, fieldNames: Object.keys(fields) });
	const base = targetCwd || process.cwd();
	const storePath = join(base, ".pi", "tasks", `tasks-${sessionId.replace(/[/\\]/g, "_")}.json`);
	const store = new TaskStore(storePath);
	try {
		return store.update(taskId, fields);
	} finally {
		store.close();
	}
}

/** Update multiple tasks on a specific session's store. Used by coms for bulk updates. */
export function updateTasksForSession(sessionId: string, updates: Array<{ id: string; fields: Record<string, any> }>, targetCwd?: string): any[] {
	log.debug("session_tasks_updated", { sessionId, count: updates.length });
	const base = targetCwd || process.cwd();
	const storePath = join(base, ".pi", "tasks", `tasks-${sessionId.replace(/[/\\]/g, "_")}.json`);
	const store = new TaskStore(storePath);
	try {
		return store.updateTasks(updates);
	} finally {
		store.close();
	}
}

/** Delete a task from a specific session's store. */
export function deleteTaskForSession(sessionId: string, taskId: string, targetCwd?: string): boolean {
	log.debug("session_task_deleted", { sessionId, taskId });
	const base = targetCwd || process.cwd();
	const storePath = join(base, ".pi", "tasks", `tasks-${sessionId.replace(/[/\\]/g, "_")}.json`);
	const store = new TaskStore(storePath);
	try {
		return store.delete(taskId);
	} finally {
		store.close();
	}
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;
	if (shouldSkipOneshotRegister(log)) return;
	let shuttingDown = false;
	const taskScope = "session";
	const piTasks = process.env.PI_TASKS;

	function resolveStorePath(sessionId?: string): string | undefined {
		if (piTasks === "off") return undefined;
		if (piTasks?.startsWith("/")) return piTasks;
		if (piTasks?.startsWith(".")) return resolve(piTasks);
		if (piTasks) return piTasks;
		if (taskScope === "session" && sessionId) {
			return join(process.cwd(), ".pi", "tasks", `tasks-${sessionId}.json`);
		}
		if (taskScope === "session") return undefined;
		return join(process.cwd(), ".pi", "tasks", "tasks.json");
	}

	const resumedActiveTaskIds = currentWidget?.getActiveTaskIds() ?? [];
	currentStore?.setOnChange(() => {});
	currentStore?.close();
	currentWidget?.dispose();
	let store = new TaskStore(resolveStorePath());
	taskStore = store;
	// Registration is the only publish site: the getter follows store swaps.
	publishTaskStore(() => taskStore);
	currentStore = store;
	const widget = new TaskWidget(store);
	store.setOnChange(() => { widget.update(); broadcastTasks(); });
	for (const taskId of resumedActiveTaskIds) widget.setActiveTask(taskId);
	currentWidget = widget;
	const instanceId = Math.random().toString(36).slice(2, 8);
	(globalThis as any).__pitasks_active_instance = instanceId;

	let storeUpgraded = false;
	let persistedTasksShown = false;

	function upgradeStoreIfNeeded(ctx: any): void {
		if (storeUpgraded) return;
		if (taskScope === "session" && !piTasks) {
			const sessionId = ctx.sessionManager?.getSessionId?.();
			const path = resolveStorePath(sessionId);
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
					if (data.taskId) { store.update(data.taskId, { status: "completed" }); widget.setActiveTask(data.taskId, false); }
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
				let cleared = false;
				for (const task of tasks) {
					if (task.status === "completed" && task.statusHistory?.completed_at) {
						if (now - new Date(task.statusHistory.completed_at).getTime() > threshold) {
							store.delete(task.id);
							cleared = true;
						}
					}
				}
				if (cleared) widget.update();
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
				const staleTasks = allTasks.filter(t =>
					t.status === "in_progress" &&
					t.statusHistory?.in_progress_at &&
					now2 - new Date(t.statusHistory.in_progress_at).getTime() > staleThreshold
				);
				if (staleTasks.length > 0) {
					if (!shouldFireReminder(agentBusy, staleTasks.length)) {
						log.debug("reminder_skipped", "busy");
					} else {
						lastStaleReminderAt = now2;
						try {
							pi.sendMessage({
								customType: "task-focus-reminder",
								content: staleReminderContent(staleTasks.length),
								display: true,
							}, { triggerTurn: true });
							log.info("stale_reminder_fired", "stale", staleTasks.length);
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
		if (gcTimer) { clearInterval(gcTimer); gcTimer = null; }
		if (reminderTimer) { clearInterval(reminderTimer); reminderTimer = null; }
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
		agentBusy = true;
		log.debug("agentBusy", "turn_start");
		widget.setUICtx(ctx.ui);
		currentUiCtx = ctx.ui;
		upgradeStoreIfNeeded(ctx);
	});

	pi.on("turn_end", async (event: any) => {
		if (shuttingDown) return;
		agentBusy = false;
		log.debug("agentBusy", "turn_end");
		const msg = (event as any).message;
		if (msg?.role === "assistant" && msg.usage) {
			widget.addTokenUsage(msg.usage.input ?? 0, msg.usage.output ?? 0);
		}
	});

	// agent_settled is guaranteed to fire even if turn_end is skipped (abort/error).
	// Reset agentBusy defensively so reminders are never suppressed forever.
	pi.on("agent_settled", async () => {
		if (shuttingDown) return;
		agentBusy = false;
		log.debug("agentBusy", "agent_settled reset");
	});

	pi.on("session_start", async (event: any, ctx: any) => {
		shuttingDown = false;
		agentBusy = false;
		log.debug("agentBusy", "session_start reset");
		widget.reactivate(ctx.ui);
		store.reopen();
		store.setOnChange(() => { widget.update(); broadcastTasks(); });
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
		showPersistedTasks(reason === "reload" || reason === "resume" || reason === "fork");
	});

	pi.on("before_agent_start", async (_event: any, ctx: any) => {
		if (shuttingDown) return;
		agentBusy = true;
		log.debug("agentBusy", "before_agent_start");
		widget.setUICtx(ctx.ui);
		currentUiCtx = ctx.ui;
		upgradeStoreIfNeeded(ctx);
		showPersistedTasks();
	});

	pi.on("tool_execution_start", async (_event: any, ctx: any) => {
		if (shuttingDown) return;
		widget.setUICtx(ctx.ui);
		currentUiCtx = ctx.ui;
		upgradeStoreIfNeeded(ctx);
		widget.update();
	});

	// /tasks command — extracted so it can be re-registered on reload
	let tasksCmdHandler: any;
	function registerTasksCommand(): void {
		log.debug("registerTasksCommand called");
		pi.registerCommand("tasks", {
			description: "Tasks: list overlay, create, clear completed|all",
			handler: tasksCmdHandler = async (args: string, ctx: any) => {
				const cmd = parseTasksCommand(args);
				log.debug("/tasks handler called", cmd.kind);
				if (cmd.kind === "usage") { ctx.ui?.notify(TASKS_USAGE, "warning"); return; }
				if (cmd.kind === "clear-completed" || cmd.kind === "clear-all") {
					const cleared = cmd.kind === "clear-completed" ? taskStore.clearCompleted() : taskStore.clearAll();
					if (taskScope === "session") taskStore.deleteFileIfEmpty();
					currentWidget?.update();
					log.info("tasks_cleared", { scope: cmd.kind, cleared });
					ctx.ui?.notify(`Cleared ${cleared} task${cleared === 1 ? "" : "s"}.`, "info");
					return;
				}
				if (cmd.kind === "start" || cmd.kind === "done") {
					const outcome = applyTaskAction(cmd.kind, cmd.id, {
						get: (taskId) => taskStore.get(taskId),
						update: (taskId, status) => { taskStore.update(taskId, { status }); },
						onChanged: (taskId, status) => {
							currentWidget?.setActiveTask(taskId, status === "in_progress");
							currentWidget?.update();
						},
					});
					if (outcome === "missing") { ctx.ui?.notify(`No task #${cmd.id}.`, "warning"); return; }
					if (outcome === "refused") { ctx.ui?.notify(`Task #${cmd.id} is completed; it is not restarted by /tasks start.`, "warning"); return; }
					if (outcome === "unchanged") { ctx.ui?.notify(`Task #${cmd.id} is already ${cmd.kind === "done" ? "completed" : "in progress"}.`, "info"); return; }
					ctx.ui?.notify(`Task #${cmd.id} → ${cmd.kind === "done" ? "completed" : "in progress"}.`, "info");
					return;
				}
				if (cmd.kind === "create") {
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
					log.debug("tasks_list_plain_text", { hasUI: !!ctx.hasUI, browser: isBrowserDispatch(ctx), count: taskStore.list().length });
					ctx.ui?.notify(formatTasksPlainText(taskStore.list()), "info");
					return;
				}
				await openTasksOverlay(ctx, tasksOverlayDeps(taskStore, (taskId) => {
					currentWidget?.setActiveTask(taskId, false);
					currentWidget?.update();
				}));
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
