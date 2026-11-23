/**
 * task-tools.ts — Task management tool registrations.
 * Copied from @tintinweb/pi-tasks (MIT license).
 * Removed: TaskExecute, TaskOutput, TaskStop (handled by async-agents.ts).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../shared/logger.js";
import type { TaskStore } from "./task-store.js";
import type { TaskWidget } from "./task-widget.js";
import { openTaskBlockers, selectTaskRows, taskAssigneeTag } from "./tasks-view.js";

const log = createLogger("pitasks");

const MAX_SUMMARY_ITEMS = 8;
const MAX_SUMMARY_SUBJECT_LEN = 48;

function textResult(msg: string) {
	return { content: [{ type: "text" as const, text: msg }], details: undefined };
}

function formatOpenTaskSummary(store: TaskStore): string {
	const tasks = store.list();
	const open = tasks
		.filter(t => t.status === "in_progress" || t.status === "pending")
		.sort((a, b) =>
			(a.status === "in_progress" ? 0 : 1) - (b.status === "in_progress" ? 0 : 1) ||
			Number(a.id) - Number(b.id),
		);
	if (log.isDebugEnabled()) log.debug("task_open_summary", { total: tasks.length, open: open.length });
	if (open.length === 0) return tasks.length > 0 ? "All tasks completed" : "No open tasks";
	const taskById = new Map(tasks.map(t => [t.id, t]));
	const getTask = (id: string) => taskById.get(id);
	const items = open.slice(0, MAX_SUMMARY_ITEMS).map(task => {
		const tags: string[] = [task.status];
		if (task.assignee === "user") tags.push("you");
		const blockers = openTaskBlockers(task, getTask);
		if (blockers.length > 0) tags.push(`blocked by ${blockers.map(id => `#${id}`).join(", ")}`);
		const cleanSubject = task.subject.replace(/\s+/g, " ").trim();
		const subject = cleanSubject.length > MAX_SUMMARY_SUBJECT_LEN
			? `${cleanSubject.slice(0, MAX_SUMMARY_SUBJECT_LEN - 1)}…`
			: cleanSubject;
		return subject ? `#${task.id} [${tags.join(", ")}] ${subject}` : `#${task.id} [${tags.join(", ")}]`;
	});
	const more = open.length > MAX_SUMMARY_ITEMS ? ` (+${open.length - MAX_SUMMARY_ITEMS} more)` : "";
	return `Open (${open.length}): ${items.join("; ")}${more}`;
}

export function registerTaskTools(
	pi: ExtensionAPI,
	getStore: () => TaskStore,
	widget: TaskWidget,
): void {
	// ── TaskCreate ──
	pi.registerTool({
		name: "TaskCreate",
		label: "TaskCreate",
		description: `Create a task (starts \`pending\`) for multi-step work (3+ steps), plan mode, or user-listed items. Skip single trivial or conversational tasks. Check \`TaskList\` first to avoid duplicates; wire dependencies via \`TaskUpdate\`.

- **subject** / **description**: imperative outcome title + context/acceptance criteria.
- **activeForm**: present-continuous spinner text while \`in_progress\` (defaults to \`subject\`).
- **assignee**: \`llm\` (default) or \`user\` (owner-only actions: merge, live UI check, approval — one task per action; never assign \`user\` to work an agent could do itself, and never start/edit/complete a \`user\` task — owners close it in \`/tasks\`).
- **agentType**: optional descriptive metadata only; does not dispatch or execute an agent.`,
		promptGuidelines: [
			"When working on complex multi-step tasks, use TaskCreate to track progress and TaskUpdate to update status.",
			"Mark tasks as in_progress before starting work and completed when done.",
			"TaskUpdate and TaskBulkUpdate return a remaining open-task summary; call TaskList only when you need the full board state.",
		],
		parameters: Type.Object({
			subject: Type.String({ description: "A brief title for the task" }),
			description: Type.String({ description: "A detailed description of what needs to be done" }),
			activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress (e.g., 'Running tests')" })),
			assignee: Type.Optional(Type.Unsafe({ type: "string", enum: ["llm", "user"], description: "Who does it: 'llm' (default, the agent) or 'user' (a step only the owner can do: a merge, a live check, an approval)" })),
			agentType: Type.Optional(Type.String({ description: "Optional descriptive metadata for the task. It does not dispatch or execute an agent." })),
			metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata to attach to the task" })),
		}),
		execute(_toolCallId: string, params: any) {
			const store = getStore();
			const meta = params.metadata ?? {};
			if (params.agentType) meta.agentType = params.agentType;
			const createdBy = { type: "local" as const, origin: "system", session: "", project: "" };
			const task = store.create(params.subject, params.description, createdBy, params.activeForm, Object.keys(meta).length > 0 ? meta : undefined, params.assignee === "user" ? "user" : "llm");
			widget.update();
			return Promise.resolve(textResult(`Task #${task.id} created successfully: ${task.subject}`));
		},
	});

	// ── TaskList ──
	pi.registerTool({
		name: "TaskList",
		label: "TaskList",
		description: `List all tasks (id, status, assignee, subject, owner, open \`blockedBy\`) to check progress and find unblocked pending work. Prefer lowest ID first when multiple tasks are available. Use \`TaskGet\` for full descriptions and completion notes.`,
		parameters: Type.Object({}),
		execute() {
			const store = getStore();
			const tasks = store.list();
			if (tasks.length === 0) return Promise.resolve(textResult("No tasks found"));
			const taskById = new Map(tasks.map(t => [t.id, t]));
			const getTask = (id: string) => taskById.get(id);
			const lines = selectTaskRows(tasks).map(task => {
				let line = `#${task.id} [${task.status}] ${taskAssigneeTag(task)} ${task.subject}`;
				if (task.owner) line += ` (${task.owner})`;
				if (task.blockedBy.length > 0) {
					const blockers = openTaskBlockers(task, getTask);
					if (blockers.length > 0) line += ` [blocked by ${blockers.map(id => "#" + id).join(", ")}]`;
				}
				return line;
			});
			return Promise.resolve(textResult(lines.join("\n")));
		},
	});

	// ── TaskGet ──
	pi.registerTool({
		name: "TaskGet",
		label: "TaskGet",
		description: `Retrieve full task details by ID: description, status, \`blocks\`/\`blockedBy\`, timeline, metadata, plus \`completedBy\` and \`completionNote\` (read these back after an owner completion). Verify \`blockedBy\` is empty before starting work.`,
		parameters: Type.Object({
			taskId: Type.String({ description: "The ID of the task to retrieve" }),
		}),
		execute(_toolCallId: string, params: any) {
			const store = getStore();
			const task = store.get(params.taskId);
			if (!task) return Promise.resolve(textResult("Task not found"));
			const desc = task.description.replace(/\\n/g, "\n");
			const lines = [`Task #${task.id}: ${task.subject}`, `Status: ${task.status}`];
			if (task.completedBy) lines.push(`Completed by: ${task.completedBy}`);
			if (task.completionNote) lines.push(`Completion note: ${task.completionNote}`);
			log.debug("task_get", { taskId: task.id, status: task.status });
			if (task.owner) lines.push(`Owner: ${task.owner}`);
			lines.push(`Description: ${desc}`);
			if (task.blockedBy.length > 0) {
				const taskById = new Map(store.list().map(t => [t.id, t]));
				const openBlockers = task.blockedBy.filter(bid => { const b = taskById.get(bid); return b && b.status !== "completed"; });
				if (openBlockers.length > 0) lines.push(`Blocked by: ${openBlockers.map(id => "#" + id).join(", ")}`);
			}
			if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.map(id => "#" + id).join(", ")}`);
			if (task.statusHistory) {
				const sh = task.statusHistory;
				const parts: string[] = [];
				if (sh.pending_at) parts.push(`Created: ${sh.pending_at}`);
				if (sh.in_progress_at) parts.push(`Started: ${sh.in_progress_at}`);
				if (sh.completed_at) parts.push(`Completed: ${sh.completed_at}`);
				if (parts.length > 0) lines.push(`Timeline: ${parts.join(" → ")}`);
			}
			if (task.createdBy) lines.push(`Created by: ${task.createdBy.origin} (${task.createdBy.type})`);
			const metaKeys = Object.keys(task.metadata);
			if (metaKeys.length > 0) lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);
			return Promise.resolve(textResult(lines.join("\n")));
		},
	});

	// ── TaskUpdate ──
	pi.registerTool({
		name: "TaskUpdate",
		label: "TaskUpdate",
		description: `Update a task (\`pending\` → \`in_progress\` → \`completed\`, or \`deleted\` to remove). Refuses starting or completing an existing or resulting \`user\`-assigned task (including reassignment combined with status); reassignment alone is supported.

- Returns remaining open tasks (call \`TaskList\` only when full board state is unknown); use \`TaskGet\` when full details are needed.
- Mark \`in_progress\` BEFORE starting work; mark \`completed\` ONLY when fully done with tests passing and no unresolved blockers.
- \`metadata\` merges keys (set \`null\` to delete); \`addBlocks\`/\`addBlockedBy\` add dependencies.`,
		parameters: Type.Object({
			taskId: Type.String({ description: "The ID of the task to update" }),
			status: Type.Optional(Type.Unsafe({ type: "string", enum: ["pending", "in_progress", "completed", "deleted"], description: "New status for the task" })),
			subject: Type.Optional(Type.String({ description: "New subject for the task" })),
			description: Type.Optional(Type.String({ description: "New description for the task" })),
			activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress" })),
			owner: Type.Optional(Type.String({ description: "New owner for the task" })),
			assignee: Type.Optional(Type.Unsafe({ type: "string", enum: ["llm", "user"], description: "Reassign the task to the agent ('llm') or to the owner ('user')" })),
			metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Metadata keys to merge into the task. Set a key to null to delete it." })),
			addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
			addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
		}),
		execute(_toolCallId: string, params: any) {
			const store = getStore();
			const { taskId, ...fields } = params;
			const existing = store.get(taskId);
			if ((fields.status === "in_progress" || fields.status === "completed") &&
				(existing?.assignee === "user" || fields.assignee === "user")) {
				log.debug("task_update_owner_transition_refused", { taskId, status: fields.status });
				return Promise.resolve(textResult(`Task #${taskId}: only the user may start or complete a user-assigned task`));
			}
			const { task, changedFields, warnings } = store.update(taskId, fields);
			if (changedFields.length === 0 && !task) return Promise.resolve(textResult(`Task #${taskId} not found`));
			if (fields.status === "in_progress") { widget.setActiveTask(taskId); }
			else if (fields.status === "completed" || fields.status === "deleted") {
				widget.setActiveTask(taskId, false);
			}
			widget.update();
			let msg = `Updated task #${taskId} ${changedFields.join(", ")}`;
			if (warnings.length > 0) msg += ` (warning: ${warnings.join("; ")})`;
			msg += `\n${formatOpenTaskSummary(store)}`;
			return Promise.resolve(textResult(msg));
		},
	});

	// ── TaskBulkCreate ──
	pi.registerTool({
		name: "TaskBulkCreate",
		label: "TaskBulkCreate",
		description: "Create multiple tasks at once. More efficient than calling TaskCreate multiple times. Set assignee to 'user' for steps only the owner can perform.",
		parameters: Type.Object({
			tasks: Type.Array(Type.Object({
				subject: Type.String({ description: "Brief task title" }),
				description: Type.String({ description: "Detailed task description" }),
				blockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
				assignee: Type.Optional(Type.Union([Type.Literal("llm"), Type.Literal("user")], { description: "Who executes the task: 'llm' (default) or 'user' when only the owner can perform it" })),
			}), { description: "Array of tasks to create" }),
		}),
		async execute(_callId, params) {
			const store = getStore();
			const createdBy = { type: "local" as const, origin: "system", session: "", project: "" };
			const created = store.createTasks(params.tasks.map(t => ({ ...t, createdBy })));
			widget.update();
			const lines = created.map(t => `#${t.id}: ${t.subject}`);
			return textResult(`Created ${created.length} tasks:\n${lines.join("\n")}`);
		},
	});

	// ── TaskBulkDelete ──
	pi.registerTool({
		name: "TaskBulkDelete",
		label: "TaskBulkDelete",
		description: "Delete multiple tasks at once by ID.",
		parameters: Type.Object({
			taskIds: Type.Array(Type.String(), { description: "Task IDs to delete" }),
		}),
		async execute(_callId, params) {
			const store = getStore();
			const count = store.deleteTasks(params.taskIds);
			widget.update();
			return textResult(`Deleted ${count} task(s)`);
		},
	});

	// ── TaskBulkUpdate ──
	pi.registerTool({
		name: "TaskBulkUpdate",
		label: "TaskBulkUpdate",
		description: "Update multiple tasks at once and return a remaining open-task summary (call TaskList only when full board state is unknown). More efficient than calling TaskUpdate multiple times. User-assigned tasks cannot be started or completed; other updates remain supported.",
		parameters: Type.Object({
			updates: Type.Array(Type.Object({
				taskId: Type.String({ description: "Task ID to update" }),
				status: Type.Optional(Type.Unsafe({ type: "string", enum: ["pending", "in_progress", "completed", "deleted"], description: "New status" })),
				subject: Type.Optional(Type.String({ description: "New subject" })),
				description: Type.Optional(Type.String({ description: "New description" })),
				addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
				addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task blocks" })),
			}), { description: "Array of task updates" }),
		}),
		async execute(_callId, params) {
			log.debug("tasks_bulk_updated", { count: params.updates.length });
			const store = getStore();
			const refused: string[] = [];
			const allowed = params.updates.filter(u => {
				if ((u.status === "in_progress" || u.status === "completed") && store.get(u.taskId)?.assignee === "user") {
					refused.push(`#${u.taskId}: only the user may start or complete a user-assigned task`);
					log.debug("task_bulk_owner_transition_refused", { taskId: u.taskId, status: u.status });
					return false;
				}
				return true;
			});
			const updates = allowed.map(u => ({
				id: u.taskId,
				fields: {
					...(u.status !== undefined ? { status: u.status } : {}),
					...(u.subject !== undefined ? { subject: u.subject } : {}),
					...(u.description !== undefined ? { description: u.description } : {}),
					...(u.addBlockedBy !== undefined ? { addBlockedBy: u.addBlockedBy } : {}),
					...(u.addBlocks !== undefined ? { addBlocks: u.addBlocks } : {}),
				},
			}));
			const results = store.updateTasks(updates);
			for (const update of updates) {
				if (update.fields.status === "in_progress") widget.setActiveTask(update.id);
				else if (update.fields.status !== undefined) widget.setActiveTask(update.id, false);
			}
			widget.update();
			const lines = results.map(r => r.success ? `#${r.id}: ${r.changedFields?.join(", ") || "no changes"}` : `#${r.id}: not found`);
			const summary = formatOpenTaskSummary(store);
			return textResult(`Updated ${results.filter(r => r.success).length} task(s):\n${[...lines, ...refused, summary].join("\n")}`);
		},
	});
}
