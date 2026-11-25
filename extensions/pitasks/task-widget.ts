/**
 * task-widget.ts — Persistent widget showing task list with status icons and progress.
 * Copied from @tintinweb/pi-tasks (MIT license).
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import { createLogger } from "../shared/logger.js";
import { formatWidgetShortcutHint, type WidgetMode } from "../shared/widget-visibility.js";
import type { TaskStore } from "./task-store.js";
import { taskAssigneeRank, toTaskRowView } from "./tasks-view.js";

const log = createLogger("pitasks");

const SPINNER = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];
const DEFAULT_MAX_VISIBLE_TASKS = 10;
const MAX_BADGE_AGENT_CHARS = 28;
const MAX_BADGE_NAME_CHARS = 24;

export interface BoundAsyncAgent {
	id?: string;
	agent: string;
	name?: string;
	status?: string;
	taskId?: string;
}

export type BoundAgentsProvider = () => ReadonlyArray<BoundAsyncAgent> | null | undefined;

function sanitizeBadgeText(raw: string | undefined): string {
	if (typeof raw !== "string") return "";
	return raw
		.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
		.replace(/[\x00-\x1f\x7f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function truncateBadgeText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

/** Format a compact live async-agent badge for a task row (empty string when none). */
export function formatBoundAgentsBadge(
	agents: ReadonlyArray<Pick<BoundAsyncAgent, "agent" | "name">> | null | undefined,
): string {
	if (!agents || agents.length === 0) return "";
	if (agents.length === 1) {
		const rawAgent = sanitizeBadgeText(agents[0]?.agent);
		const agent = truncateBadgeText(rawAgent, MAX_BADGE_AGENT_CHARS) || "agent";
		const rawName = sanitizeBadgeText(agents[0]?.name);
		if (rawName && rawName !== rawAgent && rawName !== agent) {
			return `[⏳ ${agent} · ${truncateBadgeText(rawName, MAX_BADGE_NAME_CHARS)}]`;
		}
		return `[⏳ ${agent}]`;
	}
	const types = agents.map((a) => truncateBadgeText(sanitizeBadgeText(a?.agent), MAX_BADGE_AGENT_CHARS) || "agent");
	const uniqueTypes = [...new Set(types)];
	if (uniqueTypes.length === 1) {
		return `[⏳ ${uniqueTypes[0]} ×${agents.length}]`;
	}
	const listed = uniqueTypes.length <= 2
		? uniqueTypes.join(", ")
		: `${uniqueTypes.slice(0, 2).join(", ")}, +${uniqueTypes.length - 2}`;
	return `[⏳ ${agents.length} agents: ${listed}]`;
}

function truncateFromTop(tasks: any[], limit: number): any[] { return tasks.slice(-limit); }
function truncateFromBottom(tasks: any[], limit: number): any[] { return tasks.slice(0, limit); }
const TRUNCATE_FNS: Record<string, (t: any[], l: number) => any[]> = { top: truncateFromTop, bottom: truncateFromBottom };

function formatDuration(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
	const hr = Math.floor(min / 60);
	const remMin = min % 60;
	return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}

export class TaskWidget {
	private uiCtx: any;
	private widgetFrame = 0;
	private widgetInterval: ReturnType<typeof setInterval> | undefined;
	private activeTaskIds = new Set<string>();
	private turnEligibleIds = new Set<string>();
	private metrics = new Map<string, { startedAt: number; inputTokens: number; outputTokens: number }>();
	private tui: any;
	private widgetRegistered = false;
	private disposed = false;
	private mode: WidgetMode = "expanded";
	private shortcutHint: string | null = null;

	constructor(
		private store: TaskStore,
		private config: Record<string, any> = {},
		private getBoundAgents?: BoundAgentsProvider,
	) {
		if (log.isDebugEnabled()) log.debug("widget_created", { taskCount: store.list().length });
	}

	setStore(store: TaskStore): void {
		this.store = store;
		this.activeTaskIds.clear();
		this.turnEligibleIds.clear();
		this.metrics.clear();
		if (log.isDebugEnabled()) log.debug("widget_store_set", { taskCount: store.list().length });
	}
	setUICtx(ctx: any): void { this.uiCtx = ctx; }
	getActiveTaskIds(): string[] { return [...this.activeTaskIds]; }
	getMode(): WidgetMode { return this.mode; }
	hasActiveTimer(): boolean { return this.widgetInterval !== undefined; }

	setShortcutHint(hint: string | null): void {
		this.shortcutHint = hint;
		if (this.tui && this.widgetRegistered) {
			this.tui.requestRender();
		}
	}

	setMode(mode: WidgetMode): void {
		this.mode = mode;
		log.debug("task_widget_mode_changed", { mode });
		if (mode === "collapsed" && this.widgetInterval) {
			clearInterval(this.widgetInterval);
			this.widgetInterval = undefined;
		}
		this.update();
	}

	private getInProgressActiveIds(): string[] {
		return [...this.activeTaskIds].filter(
			(id) => this.metrics.has(id) && this.store.get(id)?.status === "in_progress",
		);
	}

	beginTurn(): void {
		this.turnEligibleIds = new Set(this.getInProgressActiveIds());
		log.debug("task_telemetry_turn_start", { eligibleTaskCount: this.turnEligibleIds.size });
	}

	reactivate(ctx: any): void {
		this.disposed = false;
		this.uiCtx = ctx;
		if (log.isDebugEnabled()) log.debug("widget_reactivated", { taskCount: this.store.list().length });
	}

	deactivate(): void {
		log.debug("widget_deactivated", { hadWidget: this.widgetRegistered, hadTimer: !!this.widgetInterval });
		if (this.widgetInterval) { clearInterval(this.widgetInterval); this.widgetInterval = undefined; }
		if (this.uiCtx) this.uiCtx.setWidget("tasks", undefined);
		this.turnEligibleIds.clear();
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
	}

	setActiveTask(taskId: string, active = true): void {
		const task = this.store.get(taskId);
		log.debug("task_telemetry_active", { taskId, active, status: task?.status });
		if (taskId && active && task) {
			this.activeTaskIds.add(taskId);
			if (task.status === "in_progress") this.turnEligibleIds.add(taskId);
			const existing = task.telemetry;
			const telemetry = existing
				? { startedAt: existing.startedAt, inputTokens: existing.inputTokens, outputTokens: existing.outputTokens }
				: { startedAt: Date.now(), inputTokens: 0, outputTokens: 0 };
			if (!existing || existing.endedAt !== undefined) this.store.update(taskId, { telemetry });
			this.metrics.set(taskId, telemetry);
			this.ensureTimer();
		} else if (taskId) {
			this.activeTaskIds.delete(taskId);
			if (task?.telemetry && !task.telemetry.endedAt) this.store.update(taskId, { telemetry: { ...task.telemetry, endedAt: Date.now() } });
		}
		this.update();
	}

	addTokenUsage(inputTokens: number, outputTokens: number, turnTaskRefs?: Iterable<string>): void {
		const activeIds = this.getInProgressActiveIds();
		const eligibleIds = new Set<string>(activeIds);
		for (const id of this.turnEligibleIds) {
			const task = this.store.get(id);
			if (task && (this.metrics.has(id) || task.telemetry !== undefined)) {
				eligibleIds.add(id);
			}
		}
		this.turnEligibleIds = new Set(activeIds);

		const refSet = new Set<string>();
		if (turnTaskRefs) {
			for (const raw of turnTaskRefs) {
				const id = String(raw).trim();
				if (id && id !== "-1") refSet.add(id);
			}
		}
		const refs = refSet.size > 0 ? [...refSet].filter((id) => eligibleIds.has(id)) : [];
		const targetIds = refSet.size > 0 ? refs : activeIds.length === 1 ? activeIds : [];
		log.debug("task_telemetry_usage", {
			activeTaskCount: activeIds.length,
			eligibleTaskCount: eligibleIds.size,
			turnRefCount: refSet.size,
			matchedRefCount: refs.length,
			creditedTaskIds: targetIds,
			inputTokens,
			outputTokens,
		});
		if (targetIds.length === 0) return;
		const n = targetIds.length;
		const inEach = Math.floor(inputTokens / n);
		const outEach = Math.floor(outputTokens / n);
		const inRem = inputTokens - inEach * n;
		const outRem = outputTokens - outEach * n;
		targetIds.forEach((id, i) => {
			const task = this.store.get(id);
			if (!task) return;
			const isActive = this.activeTaskIds.has(id) && task.status === "in_progress";
			const base = isActive
				? this.metrics.get(id) ?? task.telemetry
				: task.telemetry ?? this.metrics.get(id);
			if (!base) return;
			const inDelta = inEach + (i === 0 ? inRem : 0);
			const outDelta = outEach + (i === 0 ? outRem : 0);
			if (isActive) {
				const next = {
					startedAt: base.startedAt,
					inputTokens: base.inputTokens + inDelta,
					outputTokens: base.outputTokens + outDelta,
				};
				this.metrics.set(id, next);
				this.store.update(id, { telemetry: next });
			} else {
				const endedAt = task.telemetry?.endedAt;
				const next = {
					startedAt: base.startedAt,
					...(endedAt !== undefined ? { endedAt } : {}),
					inputTokens: base.inputTokens + inDelta,
					outputTokens: base.outputTokens + outDelta,
				};
				this.metrics.delete(id);
				this.store.update(id, { telemetry: next });
			}
		});
	}

	private ensureTimer(): void {
		// Pause spinner animation while collapsed so header-only mode causes zero idle redraws.
		if (this.mode === "collapsed") return;
		if (!this.widgetInterval) {
			this.widgetInterval = setInterval(() => this.update(), 150);
		}
	}

	private renderWidget(tui: any, theme: any): string[] {
		try { return this.buildWidgetLines(tui, theme); } catch { return []; }
	}

	private collectBoundAgentsByTask(): Map<string, BoundAsyncAgent[]> {
		const byTask = new Map<string, BoundAsyncAgent[]>();
		if (!this.getBoundAgents) return byTask;
		let raw: ReadonlyArray<BoundAsyncAgent> | null | undefined;
		try {
			raw = this.getBoundAgents();
		} catch (err) {
			log.debug("bound_agents_lookup_failed", { error: String(err) });
			return byTask;
		}
		if (!raw) return byTask;
		for (const job of raw) {
			if (!job) continue;
			if (job.status !== "running" && job.status !== "queued") continue;
			const taskId = job.taskId != null ? String(job.taskId).trim() : "";
			if (!taskId || taskId === "-1") continue;
			const list = byTask.get(taskId);
			if (list) list.push(job);
			else byTask.set(taskId, [job]);
		}
		return byTask;
	}

	private sortTasks(snapshot: any[]): any[] {
		// Active work first so truncation never hides a running spinner behind 10+ pending rows;
		// within each status group, the owner's tasks sort before the agent's (#1090).
		const statusRank = (status: string): number =>
			status === "in_progress" ? 0 : status === "pending" ? 1 : 2;
		return [...snapshot].sort(
			(a, b) =>
				statusRank(a.status) - statusRank(b.status) ||
				taskAssigneeRank(a) - taskAssigneeRank(b) ||
				Number(a.id) - Number(b.id),
		);
	}

	private selectVisibleTasks(sortedTasks: any[]): { visible: any[]; hiddenAt: string } {
		const showAll = this.config.showAll ?? false;
		const limit = this.config.maxVisible ?? DEFAULT_MAX_VISIBLE_TASKS;
		const hiddenAt = this.config.hiddenAt ?? "bottom";
		return {
			visible: showAll ? sortedTasks : TRUNCATE_FNS[hiddenAt](sortedTasks, limit),
			hiddenAt,
		};
	}

	private buildWidgetLines(tui: any, theme: any): string[] {
		const snapshot = this.store.list();
		if (log.isDebugEnabled()) log.debug("task_widget_render", { taskCount: snapshot.length });
		if (snapshot.length === 0) return [];
		const taskById = new Map(snapshot.map((t) => [t.id, t]));
		const tasks = this.sortTasks(snapshot);
		const w = tui.terminal.columns;
		const truncate = (line: string) => truncateToWidth(line, w);

		const completed = tasks.filter(t => t.status === "completed");
		const inProgress = tasks.filter(t => t.status === "in_progress");
		const pending = tasks.filter(t => t.status === "pending");
		// "yours" is the owner's OPEN work: completed rows are already counted as done.
		const yours = tasks.filter(t => t.assignee === "user" && t.status !== "completed").length;
		const parts: string[] = [];
		if (completed.length > 0) parts.push(`${completed.length} done`);
		if (inProgress.length > 0) parts.push(`${inProgress.length} in progress`);
		if (pending.length > 0) parts.push(`${pending.length} open`);
		const yoursText = yours > 0 ? `${parts.length > 0 ? " · " : ""}${yours} yours` : "";
		const statusText = `${tasks.length} tasks (${parts.join(", ")}${yoursText})`;
		const spinnerChar = SPINNER[this.widgetFrame % SPINNER.length];
		const hintBadge = formatWidgetShortcutHint(this.shortcutHint, this.mode);
		const hintSuffix = hintBadge ? " " + theme.fg("dim", hintBadge) : "";
		const headerLine = truncate(theme.fg("accent", "●") + " " + theme.fg("accent", statusText) + hintSuffix);
		if (this.mode === "collapsed") return [headerLine];
		const lines: string[] = [headerLine];

		const { visible, hiddenAt } = this.selectVisibleTasks(tasks);
		const hiddenCount = tasks.length - visible.length;
		const overflowLine = hiddenCount > 0 ? truncate(theme.fg("dim", `    … and ${hiddenCount} more`)) : undefined;

		if (overflowLine && hiddenAt === "top") lines.push(overflowLine);

		const boundByTask = this.collectBoundAgentsByTask();

		for (const task of visible) {
			let icon: string;
			if (task.status === "in_progress") icon = theme.fg("accent", spinnerChar);
			else if (task.status === "completed") icon = theme.fg("success", "✔");
			else icon = "◻";

			let suffix = "";
			if (task.status === "pending" && task.blockedBy.length > 0) {
				const openBlockers = task.blockedBy.filter((bid: string) => {
					const blocker = taskById.get(bid);
					return blocker && blocker.status !== "completed";
				});
				if (openBlockers.length > 0) suffix = theme.fg("dim", ` › blocked by ${openBlockers.map((id: string) => "#" + id).join(", ")}`);
			}

			const m = task.telemetry ?? this.metrics.get(task.id);
			const stats = m ? (() => {
				const elapsed = formatDuration(Math.max(0, (m.endedAt ?? Date.now()) - m.startedAt));
				const tokenParts = [m.inputTokens > 0 && `↑ ${formatTokens(m.inputTokens)}`, m.outputTokens > 0 && `↓ ${formatTokens(m.outputTokens)}`].filter(Boolean);
				return ` ${theme.fg("dim", tokenParts.length ? `(${elapsed} · ${tokenParts.join(" ")})` : `(${elapsed})`)}`;
			})() : "";

			const boundBadgeText = task.status === "completed" ? "" : formatBoundAgentsBadge(boundByTask.get(task.id));
			const boundBadge = boundBadgeText ? ` ${theme.fg("warning", boundBadgeText)}` : "";

			const tag = theme.fg("dim", toTaskRowView(task).tag);
			let text: string;
			if (task.status === "in_progress") {
				const form = task.activeForm || task.subject;
				const agentId = !boundBadgeText ? task.metadata?.agentId : undefined;
				const agentLabel = agentId ? ` (agent ${agentId.slice(0, 5)})` : "";
				text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${tag} ${theme.fg("accent", form + agentLabel + "…")}${boundBadge}${stats}`;
			} else if (task.status === "completed") {
				text = `  ${icon} ${tag} ${theme.fg("dim", theme.strikethrough("#" + task.id + " " + task.subject))}${stats}`;
			} else {
				text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${tag} ${task.subject}${boundBadge}${stats}`;
			}
			lines.push(truncate(text + suffix));
		}

		if (overflowLine && hiddenAt !== "top") lines.push(overflowLine);
		return lines;
	}

	private hasVisibleBoundAgents(tasks: any[]): boolean {
		const boundByTask = this.collectBoundAgentsByTask();
		if (boundByTask.size === 0) return false;
		const { visible } = this.selectVisibleTasks(this.sortTasks(tasks));
		return visible.some((t) => t.status !== "completed" && boundByTask.has(t.id));
	}

	update(): void {
		if (this.disposed || !this.uiCtx) {
			if (log.isDebugEnabled()) log.debug("widget_update", { disposed: this.disposed, hasUi: !!this.uiCtx });
			return;
		}
		const tasks = this.store.list();
		if (log.isDebugEnabled()) log.debug("widget_update", { disposed: this.disposed, hasUi: !!this.uiCtx, taskCount: tasks.length, mode: this.mode });
		const taskById = new Map(tasks.map((t) => [t.id, t]));
		for (const id of this.activeTaskIds) {
			const t = taskById.get(id);
			if (!t || t.status !== "in_progress") { this.activeTaskIds.delete(id); this.metrics.delete(id); }
		}
		if (tasks.length === 0) {
			if (this.widgetRegistered) { this.uiCtx.setWidget("tasks", undefined); this.widgetRegistered = false; this.tui = undefined; }
			if (this.widgetInterval) { clearInterval(this.widgetInterval); this.widgetInterval = undefined; }
			return;
		}
		const hasActiveSpinner =
			this.mode === "expanded" &&
			(tasks.some(t => t.status === "in_progress") || this.hasVisibleBoundAgents(tasks));
		if (hasActiveSpinner) this.ensureTimer();
		else if (this.widgetInterval) { clearInterval(this.widgetInterval); this.widgetInterval = undefined; }
		if (this.mode === "expanded") this.widgetFrame++;
		if (!this.widgetRegistered) {
			this.uiCtx.setWidget("tasks", (tui: any, theme: any) => {
				this.tui = tui;
				return { render: () => this.renderWidget(tui, theme), invalidate: () => {} };
			}, { placement: "aboveEditor" });
			this.widgetRegistered = true;
		} else if (this.tui) {
			this.tui.requestRender();
		}
	}

	dispose(): void {
		log.debug("widget_disposed", { hadWidget: this.widgetRegistered, hadTimer: !!this.widgetInterval });
		this.disposed = true;
		this.deactivate();
	}
}
