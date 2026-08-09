/**
 * task-widget.ts — Persistent widget showing task list with status icons and progress.
 * Copied from @tintinweb/pi-tasks (MIT license).
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { TaskStore } from "./task-store.js";

const SPINNER = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];
const DEFAULT_MAX_VISIBLE_TASKS = 10;

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
	private metrics = new Map<string, { startedAt: number; inputTokens: number; outputTokens: number }>();
	private tui: any;
	private widgetRegistered = false;

	constructor(private store: TaskStore, private config: Record<string, any> = {}) {}

	setStore(store: TaskStore): void { this.store = store; }
	setUICtx(ctx: any): void { this.uiCtx = ctx; }

	setActiveTask(taskId: string, active = true): void {
		if (taskId && active) {
			this.activeTaskIds.add(taskId);
			if (!this.metrics.has(taskId)) {
				this.metrics.set(taskId, { startedAt: Date.now(), inputTokens: 0, outputTokens: 0 });
			}
			this.ensureTimer();
		} else if (taskId) {
			this.activeTaskIds.delete(taskId);
		}
		this.update();
	}

	addTokenUsage(inputTokens: number, outputTokens: number): void {
		for (const id of this.activeTaskIds) {
			const m = this.metrics.get(id);
			if (m) { m.inputTokens += inputTokens; m.outputTokens += outputTokens; }
		}
	}

	private ensureTimer(): void {
		if (!this.widgetInterval) {
			this.widgetInterval = setInterval(() => this.update(), 150);
		}
	}

	private renderWidget(tui: any, theme: any): string[] {
		try { return this.buildWidgetLines(tui, theme); } catch { return []; }
	}

	private buildWidgetLines(tui: any, theme: any): string[] {
		const sortOrder = this.config.sortOrder ?? "id";
		const tasks = this.store.list(sortOrder);
		const w = tui.terminal.columns;
		const truncate = (line: string) => truncateToWidth(line, w);
		if (tasks.length === 0) return [];

		const completed = tasks.filter(t => t.status === "completed");
		const inProgress = tasks.filter(t => t.status === "in_progress");
		const pending = tasks.filter(t => t.status === "pending");
		const parts: string[] = [];
		if (completed.length > 0) parts.push(`${completed.length} done`);
		if (inProgress.length > 0) parts.push(`${inProgress.length} in progress`);
		if (pending.length > 0) parts.push(`${pending.length} open`);
		const statusText = `${tasks.length} tasks (${parts.join(", ")})`;
		const spinnerChar = SPINNER[this.widgetFrame % SPINNER.length];
		const lines: string[] = [truncate(theme.fg("accent", "●") + " " + theme.fg("accent", statusText))];

		const showAll = this.config.showAll ?? false;
		const limit = this.config.maxVisible ?? DEFAULT_MAX_VISIBLE_TASKS;
		const hiddenAt = this.config.hiddenAt ?? "bottom";
		const visible = showAll ? tasks : TRUNCATE_FNS[hiddenAt](tasks, limit);
		const hiddenCount = tasks.length - visible.length;
		const overflowLine = hiddenCount > 0 ? truncate(theme.fg("dim", `    … and ${hiddenCount} more`)) : undefined;

		if (overflowLine && hiddenAt === "top") lines.push(overflowLine);

		for (const task of visible) {
			const isActive = this.activeTaskIds.has(task.id) && task.status === "in_progress";
			let icon: string;
			if (isActive) icon = theme.fg("accent", spinnerChar);
			else if (task.status === "completed") icon = theme.fg("success", "✔");
			else if (task.status === "in_progress") icon = theme.fg("accent", "◼");
			else icon = "◻";

			let suffix = "";
			if (task.status === "pending" && task.blockedBy.length > 0) {
				const openBlockers = task.blockedBy.filter((bid: string) => {
					const blocker = this.store.get(bid);
					return blocker && blocker.status !== "completed";
				});
				if (openBlockers.length > 0) suffix = theme.fg("dim", ` › blocked by ${openBlockers.map((id: string) => "#" + id).join(", ")}`);
			}

			let text: string;
			if (isActive) {
				const form = task.activeForm || task.subject;
				const agentId = task.metadata?.agentId;
				const agentLabel = agentId ? ` (agent ${agentId.slice(0, 5)})` : "";
				const m = this.metrics.get(task.id);
				let stats = "";
				if (m) {
					const elapsed = formatDuration(Date.now() - m.startedAt);
					const tokenParts: string[] = [];
					if (m.inputTokens > 0) tokenParts.push(`↑ ${formatTokens(m.inputTokens)}`);
					if (m.outputTokens > 0) tokenParts.push(`↓ ${formatTokens(m.outputTokens)}`);
					stats = tokenParts.length > 0
						? ` ${theme.fg("dim", `(${elapsed} · ${tokenParts.join(" ")})`)}`
						: ` ${theme.fg("dim", `(${elapsed})`)}`;
				}
				text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${theme.fg("accent", form + agentLabel + "…")}${stats}`;
			} else if (task.status === "completed") {
				text = `  ${icon} ${theme.fg("dim", theme.strikethrough("#" + task.id + " " + task.subject))}`;
			} else {
				const agentSuffix = task.status === "in_progress" && task.metadata?.agentId
					? theme.fg("dim", ` (agent ${task.metadata.agentId.slice(0, 5)})`) : "";
				text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${task.subject}${agentSuffix}`;
			}
			lines.push(truncate(text + suffix));
		}

		if (overflowLine && hiddenAt !== "top") lines.push(overflowLine);
		return lines;
	}

	update(): void {
		if (!this.uiCtx) return;
		const tasks = this.store.list();
		if (tasks.length === 0) {
			if (this.widgetRegistered) { this.uiCtx.setWidget("tasks", undefined); this.widgetRegistered = false; }
			if (this.widgetInterval) { clearInterval(this.widgetInterval); this.widgetInterval = undefined; }
			return;
		}
		for (const id of this.activeTaskIds) {
			const t = this.store.get(id);
			if (!t || t.status !== "in_progress") { this.activeTaskIds.delete(id); this.metrics.delete(id); }
		}
		const hasActiveSpinner = tasks.some(t => this.activeTaskIds.has(t.id) && t.status === "in_progress");
		if (hasActiveSpinner) this.ensureTimer();
		else if (this.widgetInterval) { clearInterval(this.widgetInterval); this.widgetInterval = undefined; }
		this.widgetFrame++;
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
		if (this.widgetInterval) { clearInterval(this.widgetInterval); this.widgetInterval = undefined; }
		if (this.uiCtx) this.uiCtx.setWidget("tasks", undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
	}
}
