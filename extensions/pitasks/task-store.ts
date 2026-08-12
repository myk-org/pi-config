/**
 * task-store.ts — File-backed task store with CRUD, dependency management, and file locking.
 * Copied from @tintinweb/pi-tasks (MIT license).
 *
 * Session-scoped (default): in-memory Map — no disk I/O.
 * Shared (PI_TASK_LIST_ID set): ~/.pi/tasks/<listId>.json with file locking.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Task, TaskStatus, TaskStoreData } from "./types.js";

function sortById(a: Task, b: Task): number {
	return Number(a.id) - Number(b.id);
}
function sortByStatus(a: Task, b: Task): number {
	const rank = (s: string) => s === "completed" ? 0 : s === "in_progress" ? 1 : 2;
	return rank(a.status) - rank(b.status) || Number(a.id) - Number(b.id);
}
function sortByRecent(a: Task, b: Task): number {
	return b.updatedAt - a.updatedAt || Number(b.id) - Number(a.id);
}
function sortByOldest(a: Task, b: Task): number {
	return a.updatedAt - b.updatedAt || Number(a.id) - Number(b.id);
}

const SORT_FNS: Record<string, (a: Task, b: Task) => number> = { id: sortById, status: sortByStatus, recent: sortByRecent, oldest: sortByOldest };
const TASKS_DIR = join(homedir(), ".pi", "tasks");
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

function acquireLock(lockPath: string): void {
	mkdirSync(dirname(lockPath), { recursive: true });
	for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
		try {
			writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
			return;
		} catch (e: any) {
			if (e.code === "EEXIST") {
				try {
					const pid = parseInt(readFileSync(lockPath, "utf-8"), 10);
					if (pid && !isProcessRunning(pid)) { unlinkSync(lockPath); continue; }
				} catch { /* ignore */ }
				const start = Date.now();
				while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
				continue;
			}
			throw e;
		}
	}
	throw new Error(`Failed to acquire lock: ${lockPath}`);
}

function releaseLock(lockPath: string): void {
	try { unlinkSync(lockPath); } catch { /* ignore */ }
}

function isProcessRunning(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

function normalizeTask(t: any): Task {
	const now = Date.now();
	return {
		...t,
		createdBy: t.createdBy && typeof t.createdBy === "object" ? t.createdBy :
			(t.metadata?.coms_origin ? { type: "coms" as const, origin: t.metadata.coms_origin.sender_name || "", session: t.metadata.coms_origin.sender_session || "", project: "" } :
			{ type: "local" as const, origin: "system", session: "", project: "" }),
		metadata: (() => {
			const m = t.metadata && typeof t.metadata === "object" && !Array.isArray(t.metadata) ? { ...t.metadata } : {};
			delete m.coms_origin;
			return m;
		})(),
		blocks: Array.isArray(t.blocks) ? t.blocks : [],
		blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy : [],
		createdAt: typeof t.createdAt === "number" ? t.createdAt : now,
		updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : now,
		statusHistory: t.statusHistory && typeof t.statusHistory === "object" ? {
			pending_at: typeof t.statusHistory.pending_at === "number" ? new Date(t.statusHistory.pending_at).toISOString() : (t.statusHistory.pending_at || new Date(typeof t.createdAt === "number" ? t.createdAt : now).toISOString()),
			in_progress_at: typeof t.statusHistory.in_progress_at === "number" ? new Date(t.statusHistory.in_progress_at).toISOString() : (t.statusHistory.in_progress_at || null),
			completed_at: typeof t.statusHistory.completed_at === "number" ? new Date(t.statusHistory.completed_at).toISOString() : (t.statusHistory.completed_at || null),
			deleted_at: typeof t.statusHistory.deleted_at === "number" ? new Date(t.statusHistory.deleted_at).toISOString() : (t.statusHistory.deleted_at || null),
		} : {
			pending_at: new Date(typeof t.createdAt === "number" ? t.createdAt : now).toISOString(),
			in_progress_at: null,
			completed_at: null,
			deleted_at: null,
		},
	};
}

export class TaskStore {
	filePath: string | undefined;
	lockPath: string | undefined;
	private nextId = 1;
	private tasks = new Map<string, Task>();
	private _watcher: FSWatcher | null = null;
	private _selfWrite = false;
	private _onChange: (() => void) | null = null;

	constructor(listIdOrPath?: string) {
		if (!listIdOrPath) return;
		const isAbsPath = isAbsolute(listIdOrPath);
		const filePath = isAbsPath ? listIdOrPath : join(TASKS_DIR, `${listIdOrPath}.json`);
		this.filePath = filePath;
		this.lockPath = filePath + ".lock";
		this.load();
		// Watch for external file changes (e.g. remote task creation via coms)
		this._startWatcher();
	}

	private _startWatcher(): void {
		if (!this.filePath) return;
		// Subagent children must not keep watchers — they prevent the child
		// process from exiting, which blocks the parent's proc.on("close").
		if (process.env.PI_SUBAGENT_CHILD === "1") return;
		try {
			if (existsSync(this.filePath)) {
				this._watcher = watch(this.filePath, (eventType) => {
					if (eventType === "change" || eventType === "rename") {
						if (this._selfWrite) { this._selfWrite = false; return; }
						try { this.load(); if (this._onChange) this._onChange(); } catch {}
					}
				});
			} else {
				const dir = dirname(this.filePath);
				const filename = this.filePath.split("/").pop() || this.filePath.split("\\").pop() || "";
				try {
					mkdirSync(dir, { recursive: true });
					this._watcher = watch(dir, (eventType, changedFile) => {
						if (changedFile !== filename) return;
						if (this._selfWrite) { this._selfWrite = false; return; }
						try { this.load(); if (this._onChange) this._onChange(); } catch {}
					});
				} catch {}
			}
		} catch {}
	}

	setOnChange(cb: () => void): void {
		this._onChange = cb;
	}

	close(): void {
		if (this._watcher) { this._watcher.close(); this._watcher = null; }
	}

	private load(): void {
		if (!this.filePath) return;
		if (!existsSync(this.filePath)) return;
		try {
			const data = JSON.parse(readFileSync(this.filePath, "utf-8"));
			this.nextId = data.nextId;
			this.tasks.clear();
			for (const t of data.tasks) {
				this.tasks.set(t.id, normalizeTask(t));
			}
		} catch { /* corrupt file — start fresh */ }
	}

	private save(): void {
		if (!this.filePath) return;
		this._selfWrite = true;
		const data: TaskStoreData = { nextId: this.nextId, tasks: Array.from(this.tasks.values()) };
		mkdirSync(dirname(this.filePath), { recursive: true });
		const tmpPath = this.filePath + ".tmp";
		writeFileSync(tmpPath, JSON.stringify(data, null, 2));
		renameSync(tmpPath, this.filePath);
	}

	private withLock<T>(fn: () => T): T {
		if (!this.lockPath) return fn();
		acquireLock(this.lockPath);
		try {
			this.load();
			const result = fn();
			this.save();
			return result;
		} finally {
			releaseLock(this.lockPath);
		}
	}

	create(subject: string, description: string, createdBy: Task["createdBy"], activeForm?: string, metadata?: Record<string, any>): Task {
		return this.withLock(() => {
			const now = Date.now();
			const task: Task = {
				id: String(this.nextId++),
				subject,
				description,
				status: "pending",
				activeForm,
				owner: undefined,
				createdBy,
				metadata: metadata ?? {},
				blocks: [],
				blockedBy: [],
				createdAt: now,
				updatedAt: now,
				statusHistory: {
					pending_at: new Date(now).toISOString(),
					in_progress_at: null,
					completed_at: null,
					deleted_at: null,
				},
			};
			this.tasks.set(task.id, task);
			return task;
		});
	}

	createTasks(tasks: Array<{ subject: string; description: string; createdBy: Task["createdBy"]; blockedBy?: string[]; activeForm?: string; metadata?: Record<string, any> }>): Task[] {
		return this.withLock(() => {
			const now = Date.now();
			const created: Task[] = [];
			for (const t of tasks) {
				const task: Task = {
					id: String(this.nextId++),
					subject: t.subject,
					description: t.description,
					status: "pending",
					activeForm: t.activeForm,
					owner: undefined,
					createdBy: t.createdBy,
					metadata: t.metadata ?? {},
					blocks: [],
					blockedBy: t.blockedBy ?? [],
					createdAt: now,
					updatedAt: now,
					statusHistory: {
						pending_at: new Date(now).toISOString(),
						in_progress_at: null,
						completed_at: null,
						deleted_at: null,
					},
				};
				this.tasks.set(task.id, task);
				created.push(task);
			}
			return created;
		});
	}

	get(id: string): Task | undefined {
		if (this.filePath) this.load();
		return this.tasks.get(id);
	}

	list(sortOrder: "id" | "status" | "recent" | "oldest" = "id"): Task[] {
		if (this.filePath) this.load();
		return Array.from(this.tasks.values()).sort(SORT_FNS[sortOrder]);
	}

	update(id: string, fields: {
		status?: TaskStatus | "deleted";
		subject?: string;
		description?: string;
		activeForm?: string;
		owner?: string;
		metadata?: Record<string, any>;
		addBlocks?: string[];
		addBlockedBy?: string[];
	}): { task: Task | undefined; changedFields: string[]; warnings: string[] } {
		return this.withLock(() => {
			const task = this.tasks.get(id);
			if (!task) return { task: undefined, changedFields: [], warnings: [] };
			const changedFields: string[] = [];
			const warnings: string[] = [];

			if (fields.status === "deleted") {
				task.statusHistory.deleted_at = new Date().toISOString();
				this.tasks.delete(id);
				for (const t of this.tasks.values()) {
					t.blocks = t.blocks.filter(bid => bid !== id);
					t.blockedBy = t.blockedBy.filter(bid => bid !== id);
				}
				return { task: undefined, changedFields: ["deleted"], warnings: [] };
			}

			if (fields.status !== undefined) {
				task.status = fields.status as TaskStatus;
				changedFields.push("status");
				const now = Date.now();
				const isoNow = new Date(now).toISOString();
				if (fields.status === "in_progress") task.statusHistory.in_progress_at = isoNow;
				if (fields.status === "completed") task.statusHistory.completed_at = isoNow;
				if (fields.status === "pending") task.statusHistory.pending_at = isoNow;
			}
			if (fields.subject !== undefined) { task.subject = fields.subject; changedFields.push("subject"); }
			if (fields.description !== undefined) { task.description = fields.description; changedFields.push("description"); }
			if (fields.activeForm !== undefined) { task.activeForm = fields.activeForm; changedFields.push("activeForm"); }
			if (fields.owner !== undefined) { task.owner = fields.owner; changedFields.push("owner"); }

			if (fields.metadata !== undefined) {
				for (const [key, value] of Object.entries(fields.metadata)) {
					if (value === null) delete task.metadata[key];
					else task.metadata[key] = value;
				}
				changedFields.push("metadata");
			}

			if (fields.addBlocks?.length) {
				for (const targetId of fields.addBlocks) {
					if (!task.blocks.includes(targetId)) task.blocks.push(targetId);
					const target = this.tasks.get(targetId);
					if (target && !target.blockedBy.includes(id)) { target.blockedBy.push(id); target.updatedAt = Date.now(); }
					if (targetId === id) warnings.push(`#${id} blocks itself`);
					else if (!target) warnings.push(`#${targetId} does not exist`);
					else if (target.blocks.includes(id)) warnings.push(`cycle: #${id} and #${targetId} block each other`);
				}
				changedFields.push("blocks");
			}

			if (fields.addBlockedBy?.length) {
				for (const targetId of fields.addBlockedBy) {
					if (!task.blockedBy.includes(targetId)) task.blockedBy.push(targetId);
					const target = this.tasks.get(targetId);
					if (target && !target.blocks.includes(id)) { target.blocks.push(id); target.updatedAt = Date.now(); }
					if (targetId === id) warnings.push(`#${id} blocks itself`);
					else if (!target) warnings.push(`#${targetId} does not exist`);
					else if (task.blocks.includes(targetId)) warnings.push(`cycle: #${id} and #${targetId} block each other`);
				}
				changedFields.push("blockedBy");
			}

			task.updatedAt = Date.now();
			return { task, changedFields, warnings };
		});
	}

	updateTasks(updates: Array<{ id: string; fields: Record<string, any> }>): Array<{ id: string; success: boolean; changedFields?: string[] }> {
		return this.withLock(() => {
			const results: Array<{ id: string; success: boolean; changedFields?: string[] }> = [];
			for (const { id, fields } of updates) {
				const task = this.tasks.get(id);
				if (!task) { results.push({ id, success: false }); continue; }
				const changedFields: string[] = [];

				if (fields.status === "deleted") {
					task.statusHistory.deleted_at = new Date().toISOString();
					this.tasks.delete(id);
					for (const t of this.tasks.values()) {
						t.blocks = t.blocks.filter(bid => bid !== id);
						t.blockedBy = t.blockedBy.filter(bid => bid !== id);
					}
					results.push({ id, success: true, changedFields: ["deleted"] });
					continue;
				}

				if (fields.status !== undefined) {
					task.status = fields.status as TaskStatus;
					changedFields.push("status");
					const isoNow = new Date().toISOString();
					if (fields.status === "in_progress") task.statusHistory.in_progress_at = isoNow;
					if (fields.status === "completed") task.statusHistory.completed_at = isoNow;
					if (fields.status === "pending") task.statusHistory.pending_at = isoNow;
				}
				if (fields.subject !== undefined) { task.subject = fields.subject; changedFields.push("subject"); }
				if (fields.description !== undefined) { task.description = fields.description; changedFields.push("description"); }
				if (fields.activeForm !== undefined) { task.activeForm = fields.activeForm; changedFields.push("activeForm"); }
				if (fields.owner !== undefined) { task.owner = fields.owner; changedFields.push("owner"); }

				if (fields.metadata !== undefined) {
					for (const [key, value] of Object.entries(fields.metadata)) {
						if (value === null) delete task.metadata[key];
						else task.metadata[key] = value;
					}
					changedFields.push("metadata");
				}

				if (fields.addBlocks?.length) {
					for (const targetId of fields.addBlocks) {
						if (!task.blocks.includes(targetId)) task.blocks.push(targetId);
						const target = this.tasks.get(targetId);
						if (target && !target.blockedBy.includes(id)) { target.blockedBy.push(id); target.updatedAt = Date.now(); }
					}
					changedFields.push("blocks");
				}

				if (fields.addBlockedBy?.length) {
					for (const targetId of fields.addBlockedBy) {
						if (!task.blockedBy.includes(targetId)) task.blockedBy.push(targetId);
						const target = this.tasks.get(targetId);
						if (target && !target.blocks.includes(id)) { target.blocks.push(id); target.updatedAt = Date.now(); }
					}
					changedFields.push("blockedBy");
				}

				task.updatedAt = Date.now();
				results.push({ id, success: true, changedFields });
			}
			return results;
		});
	}

	delete(id: string): boolean {
		return this.withLock(() => {
			if (!this.tasks.has(id)) return false;
			this.tasks.delete(id);
			for (const t of this.tasks.values()) {
				t.blocks = t.blocks.filter(bid => bid !== id);
				t.blockedBy = t.blockedBy.filter(bid => bid !== id);
			}
			return true;
		});
	}

	deleteTasks(ids: string[]): number {
		return this.withLock(() => {
			let count = 0;
			for (const id of ids) {
				if (this.tasks.has(id)) {
					this.tasks.delete(id);
					count++;
				}
			}
			if (count > 0) {
				for (const t of this.tasks.values()) {
					t.blocks = t.blocks.filter(bid => !ids.includes(bid));
					t.blockedBy = t.blockedBy.filter(bid => !ids.includes(bid));
				}
			}
			return count;
		});
	}

	clearAll(): number {
		return this.withLock(() => { const count = this.tasks.size; this.tasks.clear(); return count; });
	}

	snapshot(): TaskStoreData {
		if (this.filePath) this.load();
		return { nextId: this.nextId, tasks: Array.from(this.tasks.values()) };
	}

	seed(data: TaskStoreData): void {
		if (this.tasks.size > 0) return;
		this.withLock(() => {
			this.nextId = data.nextId;
			this.tasks.clear();
			for (const t of data.tasks) this.tasks.set(t.id, t);
		});
	}

	deleteFileIfEmpty(): boolean {
		if (!this.filePath || this.tasks.size > 0) return false;
		try { unlinkSync(this.filePath); } catch { /* ignore */ }
		return true;
	}

	clearCompleted(): number {
		return this.withLock(() => {
			let count = 0;
			for (const [id, task] of this.tasks) {
				if (task.status === "completed") { this.tasks.delete(id); count++; }
			}
			if (count > 0) {
				const validIds = new Set(this.tasks.keys());
				for (const t of this.tasks.values()) {
					t.blocks = t.blocks.filter(bid => validIds.has(bid));
					t.blockedBy = t.blockedBy.filter(bid => validIds.has(bid));
				}
			}
			return count;
		});
	}
}
