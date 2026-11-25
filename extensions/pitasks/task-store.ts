/**
 * task-store.ts — File-backed task store with CRUD, dependency management, and file locking.
 * Copied from @tintinweb/pi-tasks (MIT license).
 *
 * Session-scoped (default): in-memory Map — no disk I/O.
 * Shared (PI_TASK_LIST_ID set): ~/.pi/tasks/<listId>.json with file locking.
 */
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync, watch, type FSWatcher } from "node:fs";
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

export interface ResolveStorePathOptions {
	cwd?: string;
	piTasks?: string;
	taskScope?: "session" | "project";
}

export interface TaskStoreOptions {
	watch?: boolean;
}

export interface TaskUpdateFields {
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
	blockedBy?: string[];
	addBlocks?: string[];
	addBlockedBy?: string[];
}

/**
 * Resolve the exact file path a session's TaskStore reads and writes.
 * Shared by pitasks itself and coms peer task operations so readers and writers agree.
 */
export function resolveStorePath(sessionId?: string, options: ResolveStorePathOptions = {}): string | undefined {
	const baseCwd = options.cwd || process.cwd();
	const piTasks = "piTasks" in options ? options.piTasks : process.env.PI_TASKS;
	const taskScope = options.taskScope ?? (process.env.PI_TASK_SCOPE === "project" ? "project" : "session");
	if (piTasks === "off") {
		log.debug("store_path_disabled", { reason: "pi_tasks_off" });
		return undefined;
	}
	if (piTasks) {
		const resolved = isAbsolute(piTasks)
			? piTasks
			: piTasks.startsWith(".")
				? resolve(baseCwd, piTasks)
				: join(TASKS_DIR, `${piTasks}.json`);
		log.debug("store_path_resolved", { source: "pi_tasks", storePath: resolved });
		return resolved;
	}
	if (taskScope === "project") {
		const resolved = join(baseCwd, ".pi", "tasks", "tasks.json");
		log.debug("store_path_resolved", { source: "project_scope", storePath: resolved });
		return resolved;
	}
	const normalizedSession = typeof sessionId === "string" ? sessionId.trim().replace(/[/\\]/g, "_") : "";
	if (!normalizedSession) {
		log.debug("store_path_unresolved", { source: "session_scope_missing_id" });
		return undefined;
	}
	const resolved = join(baseCwd, ".pi", "tasks", `tasks-${normalizedSession}.json`);
	log.debug("store_path_resolved", { source: "session_scope", sessionId: normalizedSession, storePath: resolved });
	return resolved;
}

function syncSleepMs(ms: number): void {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		const start = Date.now();
		while (Date.now() - start < ms) { /* spin fallback */ }
	}
}

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
				syncSleepMs(LOCK_RETRY_MS);
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
	if (log.isDebugEnabled()) log.debug("task_normalized", { taskId: t.id, hasTelemetry: !!t.telemetry });
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
	private _lastStat: { mtimeMs: number; size: number; ino: number } | null = null;
	private _onChange: (() => void) | null = null;

	constructor(listIdOrPath?: string, opts: TaskStoreOptions = {}) {
		if (!listIdOrPath) return;
		const isAbsPath = isAbsolute(listIdOrPath);
		const filePath = isAbsPath ? listIdOrPath : join(TASKS_DIR, `${listIdOrPath}.json`);
		this.filePath = filePath;
		this.lockPath = filePath + ".lock";
		if (opts.watch !== false) {
			this.load();
			// Watch for external file changes (e.g. remote task creation via coms)
			this._startWatcher();
		} else {
			log.debug("task_store_unwatched_init", { filePath });
		}
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
					// Invalidate stat cache on watcher events so same-ms same-size in-place writes still reload.
					this._lastStat = null;
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
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(this.filePath);
		} catch (error) {
			const errorCode = (error as NodeJS.ErrnoException)?.code;
			this._lastStat = null;
			if (errorCode === "ENOENT") {
				this._corruptOnLoad = false;
				return;
			}
			log.error("task_store_load_failed", { filePath: this.filePath, errorType: error instanceof Error ? error.name : "unknown", errorCode });
			return;
		}
		if (
			this._lastStat &&
			this._lastStat.mtimeMs === st.mtimeMs &&
			this._lastStat.size === st.size &&
			this._lastStat.ino === st.ino
		) {
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
			this._lastStat = { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino };
		} catch (error) {
			this._lastStat = null;
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
		try {
			const st = statSync(this.filePath);
			this._lastStat = { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino };
		} catch {
			this._lastStat = null;
		}
	}

	private withLock<T>(fn: () => T): T {
		if (!this.lockPath) return fn();
		acquireLock(this.lockPath);
		try {
			this.load();
			const result = fn();
			this.save();
			return result;
		} catch (error) {
			// Roll back failed/partial in-memory mutations so cached stat cannot hide them or persist them later.
			this._lastStat = null;
			if (this.filePath && !existsSync(this.filePath)) {
				this.tasks.clear();
				this.nextId = 1;
				this._corruptOnLoad = false;
			} else {
				this.load();
			}
			throw error;
		} finally {
			releaseLock(this.lockPath);
		}
	}

	private buildTask(input: {
		subject: string;
		description: string;
		createdBy: Task["createdBy"];
		activeForm?: string;
		metadata?: Record<string, any>;
		assignee?: TaskAssignee;
		blockedBy?: string[];
	}, now: number): Task {
		return {
			id: String(this.nextId++),
			subject: input.subject,
			description: input.description,
			status: "pending",
			assignee: input.assignee === "user" ? "user" : "llm",
			activeForm: input.activeForm,
			owner: undefined,
			createdBy: input.createdBy,
			metadata: input.metadata ?? {},
			blocks: [],
			blockedBy: input.blockedBy ?? [],
			createdAt: now,
			updatedAt: now,
			statusHistory: {
				pending_at: new Date(now).toISOString(),
				in_progress_at: null,
				completed_at: null,
				deleted_at: null,
			},
		};
	}

	private pruneReferences(ids: Set<string>, keepOnly = false): void {
		for (const t of this.tasks.values()) {
			t.blocks = t.blocks.filter(bid => (keepOnly ? ids.has(bid) : !ids.has(bid)));
			t.blockedBy = t.blockedBy.filter(bid => (keepOnly ? ids.has(bid) : !ids.has(bid)));
		}
	}

	private applyUpdateLocked(
		id: string,
		fields: TaskUpdateFields,
		collectWarnings = false,
	): { task: Task | undefined; changedFields: string[]; warnings: string[]; found: boolean } {
		const task = this.tasks.get(id);
		if (!task) return { task: undefined, changedFields: [], warnings: [], found: false };
		const changedFields: string[] = [];
		const warnings: string[] = [];

		if (fields.status === "deleted") {
			task.statusHistory.deleted_at = new Date().toISOString();
			this.tasks.delete(id);
			this.pruneReferences(new Set([id]));
			return { task: undefined, changedFields: ["deleted"], warnings: [], found: true };
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
			if (fields.status === "pending") {
				task.statusHistory.pending_at = isoNow;
				task.statusHistory.completed_at = null;
			}
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
		if (Array.isArray(fields.blockedBy)) {
			const prevSet = new Set(task.blockedBy);
			const nextList = Array.from(new Set(fields.blockedBy));
			const nextSet = new Set(nextList);
			const now = Date.now();
			for (const oldId of prevSet) {
				if (!nextSet.has(oldId)) {
					const oldTarget = this.tasks.get(oldId);
					if (oldTarget) {
						oldTarget.blocks = oldTarget.blocks.filter(bid => bid !== id);
						oldTarget.updatedAt = now;
					}
				}
			}
			for (const newId of nextList) {
				const newTarget = this.tasks.get(newId);
				if (newTarget && !newTarget.blocks.includes(id)) {
					newTarget.blocks.push(id);
					newTarget.updatedAt = now;
				}
			}
			task.blockedBy = nextList;
			changedFields.push("blockedBy");
		}

		if (fields.addBlocks?.length) {
			for (const targetId of fields.addBlocks) {
				if (!task.blocks.includes(targetId)) task.blocks.push(targetId);
				const target = this.tasks.get(targetId);
				if (target && !target.blockedBy.includes(id)) { target.blockedBy.push(id); target.updatedAt = Date.now(); }
				if (collectWarnings) {
					if (targetId === id) warnings.push(`#${id} blocks itself`);
					else if (!target) warnings.push(`#${targetId} does not exist`);
					else if (target.blocks.includes(id)) warnings.push(`cycle: #${id} and #${targetId} block each other`);
				}
			}
			changedFields.push("blocks");
		}

		if (fields.addBlockedBy?.length) {
			for (const targetId of fields.addBlockedBy) {
				if (!task.blockedBy.includes(targetId)) task.blockedBy.push(targetId);
				const target = this.tasks.get(targetId);
				if (target && !target.blocks.includes(id)) { target.blocks.push(id); target.updatedAt = Date.now(); }
				if (collectWarnings) {
					if (targetId === id) warnings.push(`#${id} blocks itself`);
					else if (!target) warnings.push(`#${targetId} does not exist`);
					else if (task.blocks.includes(targetId)) warnings.push(`cycle: #${id} and #${targetId} block each other`);
				}
			}
			changedFields.push("blockedBy");
		}

		task.updatedAt = Date.now();
		return { task, changedFields, warnings, found: true };
	}

	create(subject: string, description: string, createdBy: Task["createdBy"], activeForm?: string, metadata?: Record<string, any>, assignee: TaskAssignee = "llm"): Task {
		const __task = this.withLock(() => {
			const task = this.buildTask({ subject, description, createdBy, activeForm, metadata, assignee }, Date.now());
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
				const task = this.buildTask(t, now);
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

	update(id: string, fields: TaskUpdateFields): { task: Task | undefined; changedFields: string[]; warnings: string[] } {
		const __result = this.withLock(() => {
			log.debug("task_updated", { taskId: id, status: fields.status, hasTelemetry: fields.telemetry !== undefined });
			const { task, changedFields, warnings } = this.applyUpdateLocked(id, fields, true);
			return { task, changedFields, warnings };
		});
		this.notifyChange();
		return __result;
	}

	updateTasks(updates: Array<{ id: string; fields: Record<string, any> }>): Array<{ id: string; success: boolean; changedFields?: string[] }> {
		const __results = this.withLock(() => {
			log.debug("tasks_updated", { count: updates.length, statusUpdates: updates.filter(update => update.fields.status !== undefined).length });
			return updates.map(({ id, fields }) => {
				const { found, changedFields } = this.applyUpdateLocked(id, fields as TaskUpdateFields);
				return found ? { id, success: true, changedFields } : { id, success: false };
			});
		});
		this.notifyChange();
		return __results;
	}

	delete(id: string): boolean {
		const __deleted = this.withLock(() => {
			if (!this.tasks.has(id)) return false;
			this.tasks.delete(id);
			this.pruneReferences(new Set([id]));
			return true;
		});
		this.notifyChange();
		return __deleted;
	}

	deleteTasks(ids: string[]): number {
		const count = this.withLock(() => {
			const removed = new Set<string>();
			for (const id of ids) {
				if (this.tasks.delete(id)) removed.add(id);
			}
			if (removed.size > 0) this.pruneReferences(removed);
			return removed.size;
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
		try {
			unlinkSync(this.filePath);
			this._lastStat = null;
		} catch { /* ignore */ }
		return true;
	}

	clearCompleted(): number {
		const __cleared = this.withLock(() => {
			let count = 0;
			for (const [id, task] of this.tasks) {
				if (task.status === "completed") {
					this.tasks.delete(id);
					count++;
				}
			}
			if (count > 0) this.pruneReferences(new Set(this.tasks.keys()), true);
			return count;
		});
		this.notifyChange();
		return __cleared;
	}
}
