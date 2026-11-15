/**
 * #1022 — pending-task reminder must respect task age.
 * Imports the REAL production decision helper from extensions/pitasks/reminders.ts
 * (no mirrored logic here), and boots the extension with a captured setInterval so
 * the timer wiring is exercised behaviourally instead of grepped out of the source.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import {
	collectActiveAsyncTaskIds,
	decidePendingReminder,
	oldestPendingAt,
	selectStaleTasks,
	staleReminderContent,
} from "../../../extensions/pitasks/reminders.ts";
import * as indexModule from "../../../extensions/pitasks/index.ts";
import * as reminders from "../../../extensions/pitasks/reminders.ts";
import registerPitasks from "../../../extensions/pitasks/index.ts";
import {
	clearWorkloadSources,
	publishWorkloadSources,
} from "../../../extensions/shared/workload-bridge.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";


const MIN = 60_000;
const THRESHOLD = 10 * MIN;
const NOW = Date.parse("2024-01-01T12:00:00.000Z");

function pending(agoMs: number, status: string = "pending") {
	return {
		status,
		createdAt: NOW - agoMs,
		statusHistory: { pending_at: new Date(NOW - agoMs).toISOString() },
	};
}

function decide(tasks: any[], opts: { agentBusy?: boolean; lastReminderAt?: number; now?: number } = {}) {
	return decidePendingReminder({
		tasks,
		agentBusy: opts.agentBusy ?? false,
		lastReminderAt: opts.lastReminderAt ?? 0,
		now: opts.now ?? NOW,
		threshold: THRESHOLD,
	});
}

describe("#1022 pending reminder age gate", () => {
	it("does NOT fire for a task created moments ago (the reported bug)", () => {
		// Timer ticks every 60s; lastReminderAt = 0 (never reminded yet).
		assert.equal(decide([pending(1 * MIN)], { now: NOW }).fire, false);
	});

	it("fires once the task has been pending for the interval", () => {
		assert.equal(decide([pending(THRESHOLD)]).fire, true);
		assert.equal(decide([pending(30 * MIN)]).fire, true);
	});

	it("fires for a fresh+old mix — the oldest task wins", () => {
		const result = decide([pending(1 * MIN), pending(30 * MIN)]);
		assert.equal(result.fire, true);
		assert.equal(result.activeCount, 2);
	});

	it("treats a missing timestamp as old", () => {
		const result = decide([{ status: "pending" }]);
		assert.equal(result.fire, true);
		assert.ok(Number.isNaN(result.oldestPendingAt));
	});

	it("falls back to createdAt when pending_at is missing or unparseable", () => {
		assert.equal(decide([{ status: "pending", createdAt: NOW - 30 * MIN }]).fire, true);
		assert.equal(decide([{ status: "pending", createdAt: NOW - 1 * MIN }]).fire, false);
		assert.equal(
			decide([{ status: "pending", createdAt: NOW - 30 * MIN, statusHistory: { pending_at: "not-a-date" } }]).fire,
			true,
		);
	});

	it("does not fire while any task is in_progress", () => {
		assert.equal(decide([pending(30 * MIN, "in_progress"), pending(30 * MIN)]).fire, false);
	});

	it("does not fire when there are no active tasks", () => {
		assert.equal(decide([pending(30 * MIN, "completed")]).fire, false);
	});

	it("suppresses repeats until the interval elapses again", () => {
		const tasks = [pending(30 * MIN)];
		const first = decide(tasks);
		assert.equal(first.fire, true);

		// Next tick, one minute later: still inside the interval.
		assert.equal(decide(tasks, { lastReminderAt: NOW, now: NOW + 1 * MIN }).fire, false);
		// After the interval: fires again.
		assert.equal(decide(tasks, { lastReminderAt: NOW, now: NOW + THRESHOLD }).fire, true);
	});

	it("a fresh task must not mask an undated task", () => {
		assert.ok(Number.isNaN(oldestPendingAt([{ status: "pending" }, pending(1 * MIN)])));
		assert.equal(decide([pending(1 * MIN), { status: "pending" }]).fire, true);
	});
});

describe("#1022 agentBusy gating (regression: previously untested)", () => {
	it("a busy agent suppresses the reminder even for an old pending task", () => {
		assert.equal(decide([pending(30 * MIN)], { agentBusy: true }).fire, false);
	});

	it("the reminder resumes once the agent is idle again", () => {
		const tasks = [pending(30 * MIN)];
		assert.equal(decide(tasks, { agentBusy: true, now: NOW }).fire, false);
		// Same instant, agent idle (turn_end / agent_settled): fires.
		assert.equal(decide(tasks, { agentBusy: false, now: NOW }).fire, true);
	});

	it("re-exports the same decision helper from index", () => {
		assert.equal(indexModule.decidePendingReminder, reminders.decidePendingReminder);
	});
});

/** A task store entry whose pending_at sits `agoMs` before now. */
function task(agoMs: number, status: string = "pending") {
	const at = Date.now() - agoMs;
	return {
		id: "1",
		subject: "reminder",
		description: "",
		status,
		createdAt: at,
		statusHistory: { pending_at: new Date(at).toISOString() },
	};
}

/** Boot the extension with a captured setInterval and a temp task store. */
function boot(tasks: any[], settingsOverrides: Record<string, unknown> = {}) {
	const cwd = makeTempDir("pitasks-reminder-");
	const storePath = join(cwd, "tasks.json");
	writeFileSync(storePath, JSON.stringify({ nextId: tasks.length + 1, tasks }));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "pi-config-settings.json"),
		JSON.stringify({
			task_reminder_enabled: true,
			task_reminder_interval_minutes: 10,
			task_stale_in_progress_enabled: false,
			...settingsOverrides,
		}),
	);

	const ticks: Array<() => void> = [];
	const prevSetInterval = global.setInterval;
	const prevCwd = process.cwd();
	const prevTasks = process.env.PI_TASKS;
	const prevSubagent = process.env.PI_SUBAGENT_CHILD;
	global.setInterval = ((fn: () => void) => {
		ticks.push(fn);
		return { unref() {} } as any;
	}) as typeof setInterval;
	process.env.PI_TASKS = storePath;
	delete process.env.PI_SUBAGENT_CHILD; // the extension skips register inside subagents
	process.chdir(cwd);

	const sent: any[] = [];
	const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<void>>>();
	const pi = {
		on(name: string, handler: any) {
			(handlers.get(name) ?? handlers.set(name, []).get(name)!).push(handler);
		},
		registerTool() {},
		registerCommand() {},
		sendMessage(message: any) {
			sent.push(message);
		},
		events: new EventEmitter(),
	};
	registerPitasks(pi as any);

	const emit = async (name: string, event: any = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, {});
	};
	return {
		sent,
		emit,
		tick: () => { for (const fn of ticks) fn(); },
		reminders: () => sent.filter(m => m.customType === "task-focus-reminder"),
		restore: async () => {
			clearWorkloadSources();
			await emit("session_shutdown");
			global.setInterval = prevSetInterval;
			process.chdir(prevCwd);
			if (prevTasks === undefined) delete process.env.PI_TASKS;
			else process.env.PI_TASKS = prevTasks;
			if (prevSubagent !== undefined) process.env.PI_SUBAGENT_CHILD = prevSubagent;
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

describe("#1022 reminder timer wiring", () => {
	it("a freshly created task does not trigger the reminder", async () => {
		const h = boot([task(1 * MIN)]);
		try {
			h.tick();
			assert.equal(h.reminders().length, 0);
		} finally {
			await h.restore();
		}
	});

	it("a task pending past the interval triggers the reminder", async () => {
		const h = boot([task(60 * MIN)]);
		try {
			h.tick();
			assert.equal(h.reminders().length, 1);
		} finally {
			await h.restore();
		}
	});

	it("does not fire while the agent is busy, then fires on turn_end", async () => {
		const h = boot([task(60 * MIN)]);
		try {
			await h.emit("turn_start");
			h.tick();
			assert.equal(h.reminders().length, 0, "busy agent must suppress the reminder");
			await h.emit("turn_end", { message: { role: "assistant" } });
			h.tick();
			assert.equal(h.reminders().length, 1);
		} finally {
			await h.restore();
		}
	});
});

function inProgressTask(id: string, agoMs: number, assignee: "llm" | "user" = "llm") {
	const at = Date.now() - agoMs;
	return {
		id,
		subject: `Secret task ${id}`,
		description: "",
		status: "in_progress",
		assignee,
		createdAt: at,
		statusHistory: {
			pending_at: new Date(at).toISOString(),
			in_progress_at: new Date(at).toISOString(),
		},
	};
}

describe("#1104 stale in-progress reminder", () => {
	const STALE_MIN = 30;
	const STALE_MS = STALE_MIN * MIN;

	it("excludes an over-threshold task backed by a running async job", () => {
		const candidate = { id: "590", status: "in_progress", assignee: "llm", statusHistory: { in_progress_at: new Date(NOW - 33 * MIN).toISOString() } };
		const activeIds = collectActiveAsyncTaskIds([
			{ id: "job-1", status: "running", taskId: "590" },
		]);
		assert.deepEqual(selectStaleTasks([candidate], NOW, STALE_MS, activeIds), []);
	});

	it("excludes an over-threshold task backed by a queued async job", () => {
		const candidate = { id: "590", status: "in_progress", assignee: "llm", statusHistory: { in_progress_at: new Date(NOW - 33 * MIN).toISOString() } };
		const activeIds = collectActiveAsyncTaskIds([
			{ id: "job-1", status: "queued", taskId: "590" },
		]);
		assert.deepEqual(selectStaleTasks([candidate], NOW, STALE_MS, activeIds), []);
	});

	it("nags an over-threshold task whose async job finished or failed with threshold plus id", () => {
		const candidate = { id: "590", status: "in_progress", assignee: "llm", statusHistory: { in_progress_at: new Date(NOW - 33 * MIN).toISOString() } };
		const activeIds = collectActiveAsyncTaskIds([
			{ id: "job-done", status: "complete", taskId: "590" },
			{ id: "job-fail", status: "failed", taskId: "590" },
			{ id: "job-unlinked", status: "running", taskId: "-1" },
		]);
		const stale = selectStaleTasks([candidate], NOW, STALE_MS, activeIds);
		assert.equal(stale.length, 1);
		assert.equal(
			staleReminderContent(stale, STALE_MIN),
			"⚠️ You have 1 task(s) stuck in progress (>30m, no running async agent: #590). Check your TaskList and update their status.",
		);
	});

	it("excludes in-progress tasks younger than the stale threshold", () => {
		const freshA = { id: "592", status: "in_progress", assignee: "llm", statusHistory: { in_progress_at: new Date(NOW - 1 * MIN).toISOString() } };
		const boundary = { id: "593", status: "in_progress", assignee: "llm", statusHistory: { in_progress_at: new Date(NOW - STALE_MS).toISOString() } };
		assert.deepEqual(selectStaleTasks([freshA, boundary], NOW, STALE_MS, new Set()), []);
	});

	it("excludes user-assigned in-progress tasks past the stale threshold", () => {
		const ownerTask = { id: "594", status: "in_progress", assignee: "user", statusHistory: { in_progress_at: new Date(NOW - 90 * MIN).toISOString() } };
		assert.deepEqual(selectStaleTasks([ownerTask], NOW, STALE_MS, new Set()), []);
	});

	it("suppresses the timer nudge while a linked async job is running", async () => {
		const h = boot(
			[inProgressTask("590", 33 * MIN), inProgressTask("592", 1 * MIN)],
			{
				task_reminder_enabled: false,
				task_stale_in_progress_enabled: true,
				task_stale_in_progress_minutes: 30,
			},
		);
		try {
			publishWorkloadSources({
				agents: () => [{ id: "e2e-1", agent: "worker", task: "run e2e", status: "running", startedAt: Date.now() - 33 * MIN, taskId: "590" }],
				crons: () => [],
			});
			h.tick();
			assert.equal(h.reminders().length, 0);
		} finally {
			await h.restore();
		}
	});

	it("emits threshold plus stuck task ids when no running async job backs the task", async () => {
		const h = boot(
			[
				inProgressTask("590", 33 * MIN, "llm"),
				inProgressTask("592", 1 * MIN, "llm"),
				inProgressTask("593", 45 * MIN, "user"),
			],
			{
				task_reminder_enabled: false,
				task_stale_in_progress_enabled: true,
				task_stale_in_progress_minutes: 30,
			},
		);
		try {
			publishWorkloadSources({
				agents: () => [{ id: "done-1", agent: "worker", task: "finished", status: "complete", startedAt: Date.now() - 33 * MIN, taskId: "590" }],
				crons: () => [],
			});
			h.tick();
			assert.equal(h.reminders().length, 1);
			assert.equal(
				h.reminders()[0].content,
				"⚠️ You have 1 task(s) stuck in progress (>30m, no running async agent: #590). Check your TaskList and update their status.",
			);
			assert.equal(h.reminders()[0].content.includes("Secret task"), false);
		} finally {
			await h.restore();
		}
	});
});
