/**
 * task-auto-clear.ts — Turn-based auto-clearing of completed tasks.
 * Copied from @tintinweb/pi-tasks (MIT license).
 */
import type { TaskStore } from "./task-store.js";

export class AutoClearManager {
	private completedAtTurn = new Map<string, number>();
	private allCompletedAtTurn: number | null = null;

	constructor(
		private getStore: () => TaskStore,
		private getMode: () => string,
		private clearDelayTurns: number = 4,
	) {}

	trackCompletion(taskId: string, currentTurn: number): void {
		const mode = this.getMode();
		if (mode === "never") return;
		if (mode === "on_task_complete") {
			this.completedAtTurn.set(taskId, currentTurn);
		} else if (mode === "on_list_complete") {
			this.checkAllCompleted(currentTurn);
		}
	}

	private checkAllCompleted(currentTurn: number): void {
		const tasks = this.getStore().list();
		if (tasks.length > 0 && tasks.every(t => t.status === "completed")) {
			if (this.allCompletedAtTurn === null) this.allCompletedAtTurn = currentTurn;
		} else {
			this.allCompletedAtTurn = null;
		}
	}

	resetBatchCountdown(): void { this.allCompletedAtTurn = null; }
	reset(): void { this.completedAtTurn.clear(); this.allCompletedAtTurn = null; }

	onTurnStart(currentTurn: number): boolean {
		const mode = this.getMode();
		let cleared = false;

		if (mode === "on_task_complete") {
			for (const [taskId, turn] of this.completedAtTurn) {
				const task = this.getStore().get(taskId);
				if (!task || task.status !== "completed") {
					this.completedAtTurn.delete(taskId);
				} else if (currentTurn - turn >= this.clearDelayTurns) {
					this.getStore().delete(taskId);
					this.completedAtTurn.delete(taskId);
					cleared = true;
				}
			}
		} else if (mode === "on_list_complete" && this.allCompletedAtTurn !== null) {
			if (currentTurn - this.allCompletedAtTurn >= this.clearDelayTurns) {
				this.getStore().clearCompleted();
				this.allCompletedAtTurn = null;
				cleared = true;
			}
		}
		return cleared;
	}
}
