/**
 * types.ts — Type definitions for the task management system.
 * Copied from @tintinweb/pi-tasks (MIT license).
 */

export type TaskStatus = "pending" | "in_progress" | "completed";

/** Who does the task: the agent (default) or the session owner (#1090). */
export type TaskAssignee = "llm" | "user";
/** Who closed a completed task. Absent on old records, which can only have been the agent. */
export type TaskCompletedBy = "llm" | "user";

export interface Task {
	id: string;
	subject: string;
	description: string;
	status: TaskStatus;
	/** Always present after a load: a record without it is the agent's task. */
	assignee: TaskAssignee;
	/** The owner's closing note, verbatim; absent when they completed without one. */
	completionNote?: string;
	completedBy?: TaskCompletedBy;
	activeForm?: string;
	owner?: string;
	metadata: Record<string, any>;
	blocks: string[];
	blockedBy: string[];
	createdBy: {
		type: "local" | "coms";
		origin: string;
		session: string;
		project: string;
	};
	createdAt: number;
	updatedAt: number;
	telemetry?: {
		startedAt: number;
		endedAt?: number;
		inputTokens: number;
		outputTokens: number;
	};
	statusHistory: {
		pending_at: string;
		in_progress_at: string | null;
		completed_at: string | null;
		deleted_at: string | null;
	};
}

/** Serialized store format on disk. */
export interface TaskStoreData {
	nextId: number;
	tasks: Task[];
}
