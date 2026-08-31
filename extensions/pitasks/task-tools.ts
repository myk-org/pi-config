/**
 * task-tools.ts — Task management tool registrations.
 * Copied from @tintinweb/pi-tasks (MIT license).
 * Removed: TaskExecute, TaskOutput, TaskStop (handled by async-agents.ts).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TaskStore } from "./task-store.js";
import type { TaskWidget } from "./task-widget.js";

function textResult(msg: string) {
	return { content: [{ type: "text" as const, text: msg }], details: undefined };
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
		description: `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: Detailed description of what needs to be done, including context and acceptance criteria
- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.

All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- Include enough detail in the description for another agent to understand and complete the task
- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed
- Check TaskList first to avoid creating duplicate tasks
- Use \`agentType\` only as optional descriptive metadata; it does not dispatch or execute an agent`,
		promptGuidelines: [
			"When working on complex multi-step tasks, use TaskCreate to track progress and TaskUpdate to update status.",
			"Mark tasks as in_progress before starting work and completed when done.",
			"Use TaskList to check for available work after completing a task.",
		],
		parameters: Type.Object({
			subject: Type.String({ description: "A brief title for the task" }),
			description: Type.String({ description: "A detailed description of what needs to be done" }),
			activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress (e.g., 'Running tests')" })),
			agentType: Type.Optional(Type.String({ description: "Optional descriptive metadata for the task. It does not dispatch or execute an agent." })),
			metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata to attach to the task" })),
		}),
		execute(_toolCallId: string, params: any) {
			const store = getStore();
			const meta = params.metadata ?? {};
			if (params.agentType) meta.agentType = params.agentType;
			const createdBy = { type: "local" as const, origin: "system", session: "", project: "" };
			const task = store.create(params.subject, params.description, createdBy, params.activeForm, Object.keys(meta).length > 0 ? meta : undefined);
			widget.update();
			return Promise.resolve(textResult(`Task #${task.id} created successfully: ${task.subject}`));
		},
	});

	// ── TaskList ──
	pi.registerTool({
		name: "TaskList",
		label: "TaskList",
		description: `Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- After completing a task, to check for newly unblocked work or claim the next available task
- **Prefer working on tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones

## Output

Returns a summary of each task:
- **id**: Task identifier (use with TaskGet, TaskUpdate)
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'
- **owner**: Agent ID if assigned, empty if available
- **blockedBy**: List of open task IDs that must be resolved first (tasks with blockedBy cannot be claimed until dependencies resolve)

Use TaskGet with a specific task ID to view full details including description and comments.`,
		parameters: Type.Object({}),
		execute() {
			const store = getStore();
			const tasks = store.list();
			if (tasks.length === 0) return Promise.resolve(textResult("No tasks found"));
			const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };
			const sorted = [...tasks].sort((a, b) => {
				const so = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
				if (so !== 0) return so;
				return Number(a.id) - Number(b.id);
			});
			const lines = sorted.map(task => {
				let line = `#${task.id} [${task.status}] ${task.subject}`;
				if (task.owner) line += ` (${task.owner})`;
				if (task.blockedBy.length > 0) {
					const openBlockers = task.blockedBy.filter(bid => {
						const blocker = store.get(bid);
						return blocker && blocker.status !== "completed";
					});
					if (openBlockers.length > 0) line += ` [blocked by ${openBlockers.map(id => "#" + id).join(", ")}]`;
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
		description: `Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Tasks that must complete before this one can start

## Tips

- After fetching a task, verify its blockedBy list is empty before beginning work.
- Use TaskList to see all tasks in summary form.`,
		parameters: Type.Object({
			taskId: Type.String({ description: "The ID of the task to retrieve" }),
		}),
		execute(_toolCallId: string, params: any) {
			const store = getStore();
			const task = store.get(params.taskId);
			if (!task) return Promise.resolve(textResult("Task not found"));
			const desc = task.description.replace(/\\n/g, "\n");
			const lines = [`Task #${task.id}: ${task.subject}`, `Status: ${task.status}`];
			if (task.owner) lines.push(`Owner: ${task.owner}`);
			lines.push(`Description: ${desc}`);
			if (task.blockedBy.length > 0) {
				const openBlockers = task.blockedBy.filter(bid => { const b = store.get(bid); return b && b.status !== "completed"; });
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
		description: `Use this tool to update a task in the task list.

## When to Use This Tool

**Before starting work on a task:**
- Mark it in_progress BEFORE beginning — do not start work without updating status first
- After resolving, call TaskList to find your next task

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call TaskList to find your next task

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Delete tasks:**
- When a task is no longer relevant or was created in error
- Setting status to \`deleted\` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- **owner**: Change the task owner (agent name)
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark tasks that must complete before this one can start

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task.

## Staleness

Make sure to read a task's latest state using \`TaskGet\` before updating it.

## Examples

Mark task as in progress when starting work:
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Delete a task:
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

Claim a task by setting owner:
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

Set up task dependencies:
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\``,
		parameters: Type.Object({
			taskId: Type.String({ description: "The ID of the task to update" }),
			status: Type.Optional(Type.Unsafe({ type: "string", enum: ["pending", "in_progress", "completed", "deleted"], description: "New status for the task" })),
			subject: Type.Optional(Type.String({ description: "New subject for the task" })),
			description: Type.Optional(Type.String({ description: "New description for the task" })),
			activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress" })),
			owner: Type.Optional(Type.String({ description: "New owner for the task" })),
			metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Metadata keys to merge into the task. Set a key to null to delete it." })),
			addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
			addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
		}),
		execute(_toolCallId: string, params: any) {
			const store = getStore();
			const { taskId, ...fields } = params;
			const { task, changedFields, warnings } = store.update(taskId, fields);
			if (changedFields.length === 0 && !task) return Promise.resolve(textResult(`Task #${taskId} not found`));
			if (fields.status === "in_progress") { widget.setActiveTask(taskId); }
			else if (fields.status === "completed" || fields.status === "deleted") {
				widget.setActiveTask(taskId, false);
			}
			widget.update();
			let msg = `Updated task #${taskId} ${changedFields.join(", ")}`;
			if (warnings.length > 0) msg += ` (warning: ${warnings.join("; ")})`;
			return Promise.resolve(textResult(msg));
		},
	});

	// ── TaskBulkCreate ──
	pi.registerTool({
		name: "TaskBulkCreate",
		label: "TaskBulkCreate",
		description: "Create multiple tasks at once. More efficient than calling TaskCreate multiple times.",
		parameters: Type.Object({
			tasks: Type.Array(Type.Object({
				subject: Type.String({ description: "Brief task title" }),
				description: Type.String({ description: "Detailed task description" }),
				blockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
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
		description: "Update multiple tasks at once. More efficient than calling TaskUpdate multiple times.",
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
			const store = getStore();
			const updates = params.updates.map(u => ({
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
			widget.update();
			const lines = results.map(r => r.success ? `#${r.id}: ${r.changedFields?.join(", ") || "no changes"}` : `#${r.id}: not found`);
			return textResult(`Updated ${results.filter(r => r.success).length} task(s):\n${lines.join("\n")}`);
		},
	});
}
