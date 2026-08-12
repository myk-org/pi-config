/**
 * types.ts — Type definitions for the task management system.
 * Copied from @tintinweb/pi-tasks (MIT license).
 */

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
	id: string;
	subject: string;
	description: string;
	status: TaskStatus;
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
