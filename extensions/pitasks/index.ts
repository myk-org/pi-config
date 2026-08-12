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
import { getSetting } from "../orchestrator/project-settings.js";

const log = createLogger("pitasks");

// Module-level refs — survive closure replacement on /reload
let currentUiCtx: any = null;
let currentWidget: TaskWidget | null = null;

/** Exported store instance — set during extension init. */
export let taskStore: TaskStore;

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
	return taskStore.update(id, fields);
}

/** Delete a task — for use by other extensions. */
export function deleteTask(id: string): boolean {
	return taskStore.delete(id);
}

// ── Session-targeted task operations (for cross-session/peer access) ────

/** Create a task on a specific session's store. Used by coms for sender-side task creation. */
export function createTaskForSession(sessionId: string, subject: string, description: string, createdBy?: any, metadata?: Record<string, any>, targetCwd?: string, activeForm?: string): any {
	const base = targetCwd || process.cwd();
	const storePath = join(base, ".pi", "tasks", `tasks-${sessionId.replace(/[/\\]/g, "_")}.json`);
	const store = new TaskStore(storePath);
	return store.create(subject, description, createdBy || { type: "local", origin: "system", session: "", project: "" }, activeForm, metadata);
}

/** Create multiple tasks on a specific session's store. Used by coms for bulk task creation. */
export function createTasksForSession(sessionId: string, tasks: Array<{ subject: string; description: string; createdBy: any; blockedBy?: string[]; activeForm?: string; metadata?: Record<string, any> }>, targetCwd?: string): any[] {
	const base = targetCwd || process.cwd();
	const storePath = join(base, ".pi", "tasks", `tasks-${sessionId.replace(/[/\\]/g, "_")}.json`);
	const store = new TaskStore(storePath);
	return store.createTasks(tasks);
}

/** Get a task from a specific session's store. */
export function getTaskForSession(sessionId: string, taskId: string, targetCwd?: string): any {
	const base = targetCwd || process.cwd();
	const storePath = join(base, ".pi", "tasks", `tasks-${sessionId.replace(/[/\\]/g, "_")}.json`);
	const store = new TaskStore(storePath);
	return store.get(taskId);
}

/** List tasks from a specific session's store. */
export function listTasksForSession(sessionId: string, targetCwd?: string): any[] {
	const base = targetCwd || process.cwd();
	const storePath = join(base, ".pi", "tasks", `tasks-${sessionId.replace(/[/\\]/g, "_")}.json`);
	const store = new TaskStore(storePath);
	return store.list();
}

/** Update a task on a specific session's store. */
export function updateTaskForSession(sessionId: string, taskId: string, fields: any, targetCwd?: string): any {
	const base = targetCwd || process.cwd();
	const storePath = join(base, ".pi", "tasks", `tasks-${sessionId.replace(/[/\\]/g, "_")}.json`);
	const store = new TaskStore(storePath);
	return store.update(taskId, fields);
}

/** Update multiple tasks on a specific session's store. Used by coms for bulk updates. */
export function updateTasksForSession(sessionId: string, updates: Array<{ id: string; fields: Record<string, any> }>, targetCwd?: string): any[] {
	const base = targetCwd || process.cwd();
	const storePath = join(base, ".pi", "tasks", `tasks-${sessionId.replace(/[/\\]/g, "_")}.json`);
	const store = new TaskStore(storePath);
	return store.updateTasks(updates);
}

/** Delete a task from a specific session's store. */
export function deleteTaskForSession(sessionId: string, taskId: string, targetCwd?: string): boolean {
	const base = targetCwd || process.cwd();
	const storePath = join(base, ".pi", "tasks", `tasks-${sessionId.replace(/[/\\]/g, "_")}.json`);
	const store = new TaskStore(storePath);
	return store.delete(taskId);
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;
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

	let store = new TaskStore(resolveStorePath());
	taskStore = store;
	const widget = new TaskWidget(store);
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
			store = new TaskStore(path);
			taskStore = store;
			widget.setStore(store);
			store.setOnChange(() => { widget.update(); });
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
					if (now - lastReminderAt >= threshold) {
						const tasks = store.list();
						const active = tasks.filter(t => t.status === "pending" || t.status === "in_progress");
						if (active.length > 0 && !active.some(t => t.status === "in_progress")) {
							if (agentBusy) {
								log.debug("reminder_skipped", "busy");
							} else {
								lastReminderAt = now;
								try {
									pi.sendMessage({
										customType: "task-focus-reminder",
										content: `⚠️ You have ${active.length} active task(s) and none are in progress. Check your TaskList and resume your workflow.`,
										display: true,
									}, { triggerTurn: true });
									log.info("reminder_fired", "active", active.length);
								} catch {}
							}
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
					if (agentBusy) {
						log.debug("reminder_skipped", "busy");
					} else {
						lastStaleReminderAt = now2;
						try {
							pi.sendMessage({
								customType: "task-focus-reminder",
								content: `⚠️ You have ${staleTasks.length} task(s) stuck in progress. Check your TaskList and update their status.`,
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
		widget.setUICtx(ctx.ui);
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
			description: "Manage tasks — view, create, clear completed",
			handler: tasksCmdHandler = async (_args: string, ctx: any) => {
				log.debug("/tasks handler called");
				const ui = ctx.ui;
				const mainMenu = async (): Promise<void> => {
					const tasks = taskStore.list();
					const taskCount = tasks.length;
					const completedCount = tasks.filter(t => t.status === "completed").length;
					const choices = [`View all tasks (${taskCount})`, "Create task"];
					if (completedCount > 0) choices.push(`Clear completed (${completedCount})`);
					if (taskCount > 0) choices.push(`Clear all (${taskCount})`);
					const choice = await ui.select("Tasks", choices);
					if (!choice) return;
					if (choice.startsWith("View")) await viewTasks();
					else if (choice === "Create task") await createTask();
					else if (choice.startsWith("Clear completed")) { taskStore.clearCompleted(); if (taskScope === "session") taskStore.deleteFileIfEmpty(); currentWidget?.update(); await mainMenu(); }
					else if (choice.startsWith("Clear all")) { taskStore.clearAll(); if (taskScope === "session") taskStore.deleteFileIfEmpty(); currentWidget?.update(); await mainMenu(); }
				};
				const viewTasks = async (): Promise<void> => {
					const tasks = taskStore.list();
					if (tasks.length === 0) { await ui.select("No tasks", ["← Back"]); return mainMenu(); }
					const statusIcon = (s: string) => s === "completed" ? "✔" : s === "in_progress" ? "◼" : "◻";
					const choices = tasks.map(t => `${statusIcon(t.status)} #${t.id} [${t.status}] ${t.subject}`);
					choices.push("← Back");
					const selected = await ui.select("Tasks", choices);
					if (!selected || selected === "← Back") return mainMenu();
					const match = selected.match(/#(\d+)/);
					if (match) await viewTaskDetail(match[1]);
					else return viewTasks();
				};
				const viewTaskDetail = async (taskId: string): Promise<void> => {
					const task = taskStore.get(taskId);
					if (!task) return viewTasks();
					const actions: string[] = [];
					if (task.status === "pending") actions.push("▸ Start (in_progress)");
					if (task.status === "in_progress") actions.push("✓ Complete");
					actions.push("✗ Delete", "← Back");
					const title = `#${task.id} [${task.status}] ${task.subject}\n${task.description}`;
					const action = await ui.select(title, actions);
					if (action === "▸ Start (in_progress)") { taskStore.update(taskId, { status: "in_progress" }); currentWidget?.setActiveTask(taskId); currentWidget?.update(); return viewTasks(); }
					else if (action === "✓ Complete") { taskStore.update(taskId, { status: "completed" }); currentWidget?.setActiveTask(taskId, false); currentWidget?.update(); return viewTasks(); }
					else if (action === "✗ Delete") { taskStore.update(taskId, { status: "deleted" }); currentWidget?.setActiveTask(taskId, false); currentWidget?.update(); return viewTasks(); }
					return viewTasks();
				};
				const createTask = async (): Promise<void> => {
					const subject = await ui.input("Task subject");
					if (!subject) return mainMenu();
					const description = await ui.input("Task description");
					if (!description) return mainMenu();
					taskStore.create(subject, description, { type: "local", origin: "user", session: "", project: process.cwd() });
					currentWidget?.update();
					return mainMenu();
				};
				await mainMenu();
			},
		});
	}
	registerTasksCommand();
		// Expose handler to pidash for browser command dispatch
		try {
			if ((globalThis as any).__pitasks_pidash_listener) {
				try { pi.events.removeListener("pidash:request-commands", (globalThis as any).__pitasks_pidash_listener); } catch {}
			}
			const registerWithPidash = () => pi.events.emit("pidash:register-command", { name: "tasks", handler: tasksCmdHandler });
			(globalThis as any).__pitasks_pidash_listener = registerWithPidash;
			registerWithPidash();
			pi.events.on("pidash:request-commands", registerWithPidash);
		} catch {}
	log.debug("extension factory complete");
}
