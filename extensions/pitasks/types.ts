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
	createdAt: number;
	updatedAt: number;
}

/** Serialized store format on disk. */
export interface TaskStoreData {
	nextId: number;
	tasks: Task[];
}
