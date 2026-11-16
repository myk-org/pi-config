/**
 * task-store.ts — File-backed task store with CRUD, dependency management, and file locking.
 * Copied from @tintinweb/pi-tasks (MIT license).
 *
 * Session-scoped (default): in-memory Map — no disk I/O.
 * Shared (PI_TASK_LIST_ID set): ~/.pi/tasks/<listId>.json with file locking.
 */
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, unlinkSync, writeFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Task, TaskAssignee, TaskCompletedBy, TaskStatus, TaskStoreData } from "./types.js";
import { createLogger } from "../shared/logger.js";
import { taskAssigneeRank } from "./tasks-view.js";

const log = createLogger("pitasks");

function sortById(a: Task, b: Task): number {
	return Number(a.id) - Number(b.id);
}
function sortByStatus(a: Task, b: Task): number {
	const rank = (s: string) => s === "completed" ? 0 : s === "in_progress" ? 1 : 2;
	return rank(a.status) - rank(b.status) || taskAssigneeRank(a) - taskAssigneeRank(b) || Number(a.id) - Number(b.id);
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
const MAX_SYMLINK_HOPS = 8;

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
	log.debug("task_normalized", { taskId: t.id, hasTelemetry: !!t.telemetry });
	const { completionNote, completedBy, ...rest } = t ?? {};
	return {
		...rest,
		// #1090: old records carry no assignee; the agent was the only possibility back then.
		assignee: t?.assignee === "user" ? "user" : "llm",
		...(typeof completionNote === "string" && completionNote ? { completionNote } : {}),
		...(completedBy === "user" || completedBy === "llm" ? { completedBy } : t?.status === "completed" ? { completedBy: "llm" as const } : {}),
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
		telemetry: t.telemetry && typeof t.telemetry === "object" &&
			typeof t.telemetry.startedAt === "number" && typeof t.telemetry.inputTokens === "number" && typeof t.telemetry.outputTokens === "number" ? {
			startedAt: t.telemetry.startedAt,
			...(typeof t.telemetry.endedAt === "number" ? { endedAt: t.telemetry.endedAt } : {}),
			inputTokens: t.telemetry.inputTokens,
			outputTokens: t.telemetry.outputTokens,
		} : undefined,
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
	private _targetWatchers = new Map<string, FSWatcher>();
	private _corruptOnLoad = false;
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
		if (process.env.PI_SUBAGENT_CHILD === "1") {
			log.debug("task_watch_skipped_child", { filePath: this.filePath });
			return;
		}
		this._watcher = this._watchPath(resolve(this.filePath), true);
		this._syncTargetWatchers();
	}

	private _syncTargetWatchers(): void {
		if (!this.filePath) return;
		const rootPath = resolve(this.filePath);
		const seen = new Set<string>([rootPath]);
		const desired = new Set<string>();
		let current = rootPath;
		for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
			let linkTarget: string;
			try {
				linkTarget = readlinkSync(current);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException)?.code;
				if (code !== "ENOENT" && code !== "EINVAL") {
					log.warn("task_watch_symlink_failed", { path: current, code });
				}
				break;
			}
			const next = resolve(dirname(current), linkTarget);
			for (;;) {
				let watchTarget = next;
				while (!existsSync(dirname(watchTarget))) {
					const parent = dirname(watchTarget);
					if (parent === watchTarget) break;
					watchTarget = parent;
				}
				if (watchTarget === rootPath) break;
				if (!this._targetWatchers.has(watchTarget)) {
					const watcher = this._watchPath(watchTarget);
					if (watcher) this._targetWatchers.set(watchTarget, watcher);
				}
				if (watchTarget === next || !existsSync(watchTarget) || !this._targetWatchers.has(watchTarget)) {
					if (this._targetWatchers.has(watchTarget)) desired.add(watchTarget);
					break;
				}
			}
			if (seen.has(next)) break;
			seen.add(next);
			current = next;
		}
		for (const [watchedPath, watcher] of this._targetWatchers) {
			if (!desired.has(watchedPath)) {
				watcher.close();
				this._targetWatchers.delete(watchedPath);
			}
		}
		log.debug("task_watch_target_updated", { filePath: this.filePath, targets: Array.from(this._targetWatchers.keys()) });
	}

	private _watchPath(path: string, ensureParent = false): FSWatcher | null {
		const dir = dirname(path);
		const filename = basename(path);
		try {
			if (ensureParent) mkdirSync(dir, { recursive: true });
			// Watch the directory so atomic replacements do not detach the watch from the pathname.
			const watcher = watch(dir, (eventType, changedFile) => {
				log.debug("task_watch_event", { filePath: this.filePath, eventType, changedFile });
				if (changedFile !== filename) return;
				// Events are invalidations, not one-to-one write receipts, including our own writes.
				try {
					this._syncTargetWatchers();
					this.load();
					this.notifyChange();
					log.debug("task_watch_refreshed", { filePath: this.filePath, hasCallback: this._onChange !== null });
				} catch (error) {
					log.warn("task_watch_refresh_failed", { filePath: this.filePath, error: String(error) });
				}
			});
			watcher.on("error", error => {
				log.error("task_watch_error", { filePath: this.filePath, path, recovery: "explicit reopen required", error: String(error) });
				watcher.close();
				this.close();
			});
			log.debug("task_watch_started", { filePath: this.filePath, dir, filename });
			return watcher;
		} catch (error) {
			log.warn("task_watch_start_failed", { filePath: this.filePath, dir, error: String(error) });
			return null;
		}
	}

	setOnChange(cb: () => void): void {
		this._onChange = cb;
	}

	/** #968 A: fire the change callback for an in-process mutation (external
	 *  file changes fire it via the watcher; in-process ops must fire it too). */
	notifyChange(): void {
		if (this._onChange) this._onChange();
	}

	close(): void {
		const hadWatcher = this._watcher !== null || this._targetWatchers.size > 0;
		for (const watcher of this._targetWatchers.values()) watcher.close();
		this._targetWatchers.clear();
		if (this._watcher) {
			this._watcher.close();
			this._watcher = null;
		}
		log.debug("task_watch_close", { filePath: this.filePath, hadWatcher });
	}

	reopen(): void {
		const hadWatcher = this._watcher !== null;
		if (!hadWatcher) this._startWatcher();
		else this._syncTargetWatchers();
		log.debug("task_watch_reopen", { filePath: this.filePath, reopened: !hadWatcher && this._watcher !== null });
	}

	private load(): void {
		if (!this.filePath) return;
		if (!existsSync(this.filePath)) {
			this._corruptOnLoad = false;
			return;
		}
		try {
			const data = JSON.parse(readFileSync(this.filePath, "utf-8"));
			this._corruptOnLoad = false;
			this.nextId = data.nextId;
			this.tasks.clear();
			for (const t of data.tasks) {
				this.tasks.set(t.id, normalizeTask(t));
			}
		} catch (error) {
			this._corruptOnLoad = error instanceof SyntaxError;
			log.error("task_store_load_failed", { filePath: this.filePath, errorType: error instanceof Error ? error.name : "unknown", errorCode: (error as NodeJS.ErrnoException)?.code });
		}
	}

	private save(): void {
		if (!this.filePath) return;
		if (this._corruptOnLoad) {
			const backupPath = `${this.filePath}.corrupt`;
			try {
				copyFileSync(this.filePath, backupPath, constants.COPYFILE_EXCL);
				log.warn("task_store_corrupt_preserved", { filePath: this.filePath, backupPath });
			} catch (error) {
				const errorCode = (error as NodeJS.ErrnoException)?.code;
				if (errorCode === "EEXIST") {
					log.debug("task_store_corrupt_preserve_skipped", { filePath: this.filePath, backupPath, errorCode });
				} else {
					log.warn("task_store_corrupt_preserve_failed", { filePath: this.filePath, backupPath, errorCode });
				}
			}
			this._corruptOnLoad = false;
		}
		log.debug("task_store_save", { filePath: this.filePath, taskCount: this.tasks.size });
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

	create(subject: string, description: string, createdBy: Task["createdBy"], activeForm?: string, metadata?: Record<string, any>, assignee: TaskAssignee = "llm"): Task {
		const __task = this.withLock(() => {
			const now = Date.now();
			const task: Task = {
				id: String(this.nextId++),
				subject,
				description,
				status: "pending",
				assignee,
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
		this.notifyChange();
		return __task;
	}

	createTasks(tasks: Array<{ subject: string; description: string; createdBy: Task["createdBy"]; blockedBy?: string[]; activeForm?: string; metadata?: Record<string, any>; assignee?: TaskAssignee }>): Task[] {
		const __tasks = this.withLock(() => {
			const now = Date.now();
			const created: Task[] = [];
			for (const t of tasks) {
				const task: Task = {
					id: String(this.nextId++),
					subject: t.subject,
					description: t.description,
					status: "pending",
					assignee: t.assignee === "user" ? "user" : "llm",
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
		this.notifyChange();
		return __tasks;
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
		assignee?: TaskAssignee;
		completedBy?: TaskCompletedBy;
		completionNote?: string;
		metadata?: Record<string, any>;
		telemetry?: Task["telemetry"];
		addBlocks?: string[];
		addBlockedBy?: string[];
	}): { task: Task | undefined; changedFields: string[]; warnings: string[] } {
		const __result = this.withLock(() => {
			const task = this.tasks.get(id);
			log.debug("task_updated", { taskId: id, status: fields.status, hasTelemetry: fields.telemetry !== undefined });
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
				if (fields.status !== "completed" || task.status !== "completed") {
					delete task.completedBy;
					delete task.completionNote;
					log.debug("task_outcome_reset", { id, status: fields.status });
				}
				if (fields.status === "completed") task.completedBy = fields.completedBy ?? task.completedBy ?? "llm";
				task.status = fields.status as TaskStatus;
				changedFields.push("status");
				const now = Date.now();
				const isoNow = new Date(now).toISOString();
				if (fields.status === "in_progress") {
					task.statusHistory.in_progress_at = isoNow;
					if (!task.telemetry || task.telemetry.endedAt !== undefined) {
						task.telemetry = { startedAt: now, inputTokens: 0, outputTokens: 0 };
					}
				}
				if (fields.status === "completed") {
					task.statusHistory.completed_at = isoNow;
					if (!task.telemetry) task.telemetry = { startedAt: now, inputTokens: 0, outputTokens: 0 };
					if (!task.telemetry.endedAt) task.telemetry.endedAt = now;
				}
				if (fields.status === "pending") task.statusHistory.pending_at = isoNow;
			}
			if (fields.subject !== undefined) { task.subject = fields.subject; changedFields.push("subject"); }
			if (fields.description !== undefined) { task.description = fields.description; changedFields.push("description"); }
			if (fields.activeForm !== undefined) { task.activeForm = fields.activeForm; changedFields.push("activeForm"); }
			if (fields.owner !== undefined) { task.owner = fields.owner; changedFields.push("owner"); }
			if (fields.assignee !== undefined) { task.assignee = fields.assignee === "user" ? "user" : "llm"; changedFields.push("assignee"); }
			if (fields.completedBy !== undefined) { task.completedBy = fields.completedBy; changedFields.push("completedBy"); }
			if (fields.completionNote !== undefined) { task.completionNote = fields.completionNote; changedFields.push("completionNote"); }

			if (fields.metadata !== undefined) {
				for (const [key, value] of Object.entries(fields.metadata)) {
					if (value === null) delete task.metadata[key];
					else task.metadata[key] = value;
				}
				changedFields.push("metadata");
			}
			if (fields.telemetry !== undefined) { task.telemetry = fields.telemetry; changedFields.push("telemetry"); }

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
		this.notifyChange();
		return __result;
	}

	updateTasks(updates: Array<{ id: string; fields: Record<string, any> }>): Array<{ id: string; success: boolean; changedFields?: string[] }> {
		const __results = this.withLock(() => {
			log.debug("tasks_updated", { count: updates.length, statusUpdates: updates.filter(update => update.fields.status !== undefined).length });
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
					if (fields.status !== "completed" || task.status !== "completed") {
						delete task.completedBy;
						delete task.completionNote;
						log.debug("task_outcome_reset", { id, status: fields.status });
					}
					if (fields.status === "completed") task.completedBy = fields.completedBy ?? task.completedBy ?? "llm";
					task.status = fields.status as TaskStatus;
					changedFields.push("status");
					const now = Date.now();
					const isoNow = new Date(now).toISOString();
					if (fields.status === "in_progress") {
						task.statusHistory.in_progress_at = isoNow;
						if (!task.telemetry || task.telemetry.endedAt !== undefined) {
							task.telemetry = { startedAt: now, inputTokens: 0, outputTokens: 0 };
						}
					}
					if (fields.status === "completed") {
						task.statusHistory.completed_at = isoNow;
						if (!task.telemetry) task.telemetry = { startedAt: now, inputTokens: 0, outputTokens: 0 };
						if (!task.telemetry.endedAt) task.telemetry.endedAt = now;
					}
					if (fields.status === "pending") task.statusHistory.pending_at = isoNow;
				}
				if (fields.subject !== undefined) { task.subject = fields.subject; changedFields.push("subject"); }
				if (fields.description !== undefined) { task.description = fields.description; changedFields.push("description"); }
				if (fields.activeForm !== undefined) { task.activeForm = fields.activeForm; changedFields.push("activeForm"); }
				if (fields.owner !== undefined) { task.owner = fields.owner; changedFields.push("owner"); }
				if (fields.assignee !== undefined) { task.assignee = fields.assignee === "user" ? "user" : "llm"; changedFields.push("assignee"); }
				if (fields.completedBy !== undefined) { task.completedBy = fields.completedBy; changedFields.push("completedBy"); }
				if (fields.completionNote !== undefined) { task.completionNote = fields.completionNote; changedFields.push("completionNote"); }

				if (fields.metadata !== undefined) {
					for (const [key, value] of Object.entries(fields.metadata)) {
						if (value === null) delete task.metadata[key];
						else task.metadata[key] = value;
					}
					changedFields.push("metadata");
				}
				if (fields.telemetry !== undefined) { task.telemetry = fields.telemetry; changedFields.push("telemetry"); }

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
		this.notifyChange();
		return __results;
	}

	delete(id: string): boolean {
		const __deleted = this.withLock(() => {
			if (!this.tasks.has(id)) return false;
			this.tasks.delete(id);
			for (const t of this.tasks.values()) {
				t.blocks = t.blocks.filter(bid => bid !== id);
				t.blockedBy = t.blockedBy.filter(bid => bid !== id);
			}
			return true;
		});
		this.notifyChange();
		return __deleted;
	}

	deleteTasks(ids: string[]): number {
		const count = this.withLock(() => {
			let deleted = 0;
			for (const id of ids) {
				if (this.tasks.has(id)) {
					this.tasks.delete(id);
					deleted++;
				}
			}
			if (deleted > 0) {
				for (const t of this.tasks.values()) {
					t.blocks = t.blocks.filter(bid => !ids.includes(bid));
					t.blockedBy = t.blockedBy.filter(bid => !ids.includes(bid));
				}
			}
			return deleted;
		});
		// Broadcast the post-delete snapshot — bulk deletes must reach browser
		// task panels like single deletes do (Qodo R1: stale entries otherwise
		// linger until the next unrelated list request).
		this.notifyChange();
		return count;
	}

	clearAll(): number {
		const __count = this.withLock(() => { const count = this.tasks.size; this.tasks.clear(); return count; });
		this.notifyChange();
		return __count;
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
		const __cleared = this.withLock(() => {
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
		this.notifyChange();
		return __cleared;
	}
}
