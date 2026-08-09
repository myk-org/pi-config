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
import { AutoClearManager } from "./task-auto-clear.js";
import { registerTaskTools } from "./task-tools.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("pitasks");

const AUTO_CLEAR_DELAY = 4;

// Module-level refs — survive closure replacement on /reload
let currentUiCtx: any = null;
let currentWidget: TaskWidget | null = null;

/** Exported store instance — set during extension init. */
export let taskStore: TaskStore;

/** Create a task directly — for use by other extensions (e.g., coms auto-create). */
export function createTask(subject: string, description: string, metadata?: Record<string, any>): any {
	return taskStore.create(subject, description, undefined, metadata);
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
export function createTaskForSession(sessionId: string, subject: string, description: string, metadata?: Record<string, any>, targetCwd?: string, activeForm?: string): any {
	const base = targetCwd || process.cwd();
	const storePath = join(base, ".pi", "tasks", `tasks-${sessionId.replace(/[/\\]/g, "_")}.json`);
	const store = new TaskStore(storePath);
	return store.create(subject, description, activeForm, metadata);
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
	const autoClear = new AutoClearManager(() => store, () => "on_task_complete", AUTO_CLEAR_DELAY);
	const cadence = { currentTurn: 0, turnsSinceTaskTool: 0, reminderFired: false };
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
	registerTaskTools(pi, () => store, widget, autoClear, cadence);

	pi.on("session_shutdown", () => { shuttingDown = true; });

	// Turn tracking
	pi.on("turn_start", async (_event: any, ctx: any) => {
		if (shuttingDown) return;
		cadence.currentTurn++;
		widget.setUICtx(ctx.ui);
		currentUiCtx = ctx.ui;
		upgradeStoreIfNeeded(ctx);
		if (autoClear.onTurnStart(cadence.currentTurn)) widget.update();

		// Task reminder: fire after 4 turns without task tool usage
		cadence.turnsSinceTaskTool++;
		log.debug("reminder_check", "turnsSinceTaskTool", cadence.turnsSinceTaskTool, "reminderFired", cadence.reminderFired, "store_path", store.filePath);
		if ((globalThis as any).__pitasks_active_instance !== instanceId) return;
		if (cadence.turnsSinceTaskTool >= 4 && !cadence.reminderFired) {
			const now = Date.now();
			const lastReminder = (globalThis as any).__pitasks_last_reminder ?? 0;
			if (now - lastReminder < 30000) {
				cadence.reminderFired = true;
				log.debug("reminder_skipped_30s", "last", new Date(lastReminder).toISOString());
			} else {
				const tasks = store.list();
				const active = tasks.filter(t => t.status === "in_progress" || t.status === "pending");
				log.debug("reminder_tasks", "total", tasks.length, "active", active.length, active.map(t => `#${t.id} ${t.subject}`).join(", "));
				active.sort((a, b) => a.status === "in_progress" && b.status !== "in_progress" ? -1 : b.status === "in_progress" && a.status !== "in_progress" ? 1 : 0);
				if (active.length > 0) {
					const summary = active.slice(0, 3).map(t => `#${t.id} [${t.status}] ${t.subject}`).join(", ");
					const more = active.length > 3 ? ` (+${active.length - 3} more)` : "";
					try {
						pi.sendMessage({
							customType: "task-focus-reminder",
							content: `⚠️ You have active tasks — resume your workflow:\n${summary}${more}`,
							display: true,
						}, { triggerTurn: false, deliverAs: "nextTurn" });
						(globalThis as any).__pitasks_last_reminder = now;
					} catch {}
					log.info("reminder_fired", summary);
					cadence.reminderFired = true;
					cadence.turnsSinceTaskTool = 0;
				} else {
					log.debug("reminder_skipped_no_active");
				}
			}
		}
	});

	pi.on("turn_end", async (event: any) => {
		if (shuttingDown) return;
		const msg = (event as any).message;
		if (msg?.role === "assistant" && msg.usage) {
			widget.addTokenUsage(msg.usage.input ?? 0, msg.usage.output ?? 0);
		}
	});

	pi.on("tool_result", async (event: any) => {
		const toolName = event?.toolName as string;
		if (toolName === "TaskUpdate" || toolName === "TaskGet" || toolName === "TaskCreate" || toolName === "TaskList") {
			cadence.turnsSinceTaskTool = 0;
			cadence.reminderFired = false;
		}
	});

	pi.on("session_start", async (event: any, ctx: any) => {
		shuttingDown = false;
		widget.setUICtx(ctx.ui);
		currentUiCtx = ctx.ui;
		const reason = (event as any).reason;
		log.debug("session_start", reason);
		const isSwitch = reason === "new" || reason === "resume" || reason === "fork";
		const forkSeed = reason === "fork" ? store.snapshot() : undefined;
		if (isSwitch) {
			storeUpgraded = false;
			persistedTasksShown = false;
			cadence.currentTurn = 0;
			cadence.turnsSinceTaskTool = 0;
			cadence.reminderFired = false;
			autoClear.reset();
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
	function registerTasksCommand(): void {
		log.debug("registerTasksCommand called");
		pi.registerCommand("tasks", {
			description: "Manage tasks — view, create, clear completed",
			handler: async (_args: string, ctx: any) => {
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
					else if (action === "✓ Complete") { taskStore.update(taskId, { status: "completed" }); autoClear.trackCompletion(taskId, cadence.currentTurn); currentWidget?.setActiveTask(taskId, false); currentWidget?.update(); return viewTasks(); }
					else if (action === "✗ Delete") { taskStore.update(taskId, { status: "deleted" }); currentWidget?.setActiveTask(taskId, false); currentWidget?.update(); return viewTasks(); }
					return viewTasks();
				};
				const createTask = async (): Promise<void> => {
					const subject = await ui.input("Task subject");
					if (!subject) return mainMenu();
					const description = await ui.input("Task description");
					if (!description) return mainMenu();
					taskStore.create(subject, description);
					currentWidget?.update();
					return mainMenu();
				};
				await mainMenu();
			},
		});
	}
	registerTasksCommand();
	log.debug("extension factory complete");
}
