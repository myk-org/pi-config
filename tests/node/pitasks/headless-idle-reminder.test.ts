/**
 * #1434 — Fast, bounded idle task reminders for headless supervised COMS peers.
 * Exercises both pure helpers in extensions/pitasks/reminders.ts and live timer
 * wiring in extensions/pitasks/index.ts with controlled clocks and temp stores.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	HEADLESS_IDLE_BACKOFF_MULTIPLIERS,
	HEADLESS_IDLE_MAX_NUDGES,
	countActiveAsyncAgents,
	decideHeadlessIdleReminder,
	headlessIdleReminderContent,
	selectUnblockedOpenTasks,
} from "../../../extensions/pitasks/reminders.ts";
import * as indexModule from "../../../extensions/pitasks/index.ts";
import * as remindersModule from "../../../extensions/pitasks/reminders.ts";
import registerPitasks from "../../../extensions/pitasks/index.ts";
import { SETTINGS_KEYS } from "../../../extensions/orchestrator/project-settings.ts";
import {
	publishWorkloadSources,
	resetSessionBridge,
} from "../../../extensions/shared/session-bridge.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";

const MIN = 60_000;
const BASE_MS = 2 * MIN;
const T0 = Date.parse("2026-01-01T12:00:00.000Z");

function mkTask(overrides: Partial<{
	id: string;
	subject: string;
	status: "pending" | "in_progress" | "completed";
	assignee: "llm" | "user";
	blockedBy: string[];
	createdAt: number;
	completedAt: string | null;
}> = {}) {
	const createdAt = overrides.createdAt ?? T0;
	const iso = new Date(createdAt).toISOString();
	const status = overrides.status ?? "in_progress";
	return {
		id: overrides.id ?? "1",
		subject: overrides.subject ?? `Secret subject ${overrides.id ?? "1"}`,
		description: "",
		status,
		assignee: overrides.assignee ?? "llm",
		blocks: [],
		blockedBy: overrides.blockedBy ?? [],
		metadata: {},
		createdBy: { type: "local" as const, origin: "system", session: "", project: "" },
		createdAt,
		updatedAt: createdAt,
		statusHistory: {
			pending_at: iso,
			in_progress_at: status === "in_progress" ? iso : null,
			completed_at: overrides.completedAt ?? (status === "completed" ? iso : null),
			deleted_at: null,
		},
	};
}

describe("#1434 settings schema", () => {
	it("declares task_headless_idle_reminder_minutes with expected bounds and env", () => {
		const def = SETTINGS_KEYS.task_headless_idle_reminder_minutes;
		assert.ok(def, "setting key must exist in settings-keys.json");
		assert.equal(def.type, "int");
		assert.equal(def.default, 2);
		assert.equal(def.min, 1);
		assert.equal(def.max, 30);
		assert.equal(def.env, "PI_TASK_HEADLESS_IDLE_REMINDER_MINUTES");
		assert.equal(def.group, "Tasks");
	});

	it("re-exports headless idle reminder helpers from index", () => {
		assert.equal(indexModule.countActiveAsyncAgents, remindersModule.countActiveAsyncAgents);
		assert.equal(indexModule.selectUnblockedOpenTasks, remindersModule.selectUnblockedOpenTasks);
		assert.equal(indexModule.decideHeadlessIdleReminder, remindersModule.decideHeadlessIdleReminder);
		assert.equal(indexModule.headlessIdleReminderContent, remindersModule.headlessIdleReminderContent);
		assert.equal(indexModule.HEADLESS_IDLE_BACKOFF_MULTIPLIERS, remindersModule.HEADLESS_IDLE_BACKOFF_MULTIPLIERS);
		assert.equal(indexModule.HEADLESS_IDLE_MAX_NUDGES, remindersModule.HEADLESS_IDLE_MAX_NUDGES);
	});
});

describe("#1434 pure helpers", () => {
	it("countActiveAsyncAgents counts running/queued agents and ignores finished or fireAndForget", () => {
		assert.equal(countActiveAsyncAgents(undefined), 0);
		assert.equal(countActiveAsyncAgents([]), 0);
		assert.equal(
			countActiveAsyncAgents([
				{ status: "complete" },
				{ status: "failed" },
				{ status: "running", fireAndForget: true },
				{ status: "queued", fireAndForget: true },
			]),
			0,
		);
		assert.equal(
			countActiveAsyncAgents([
				{ status: "running" },
				{ status: "queued" },
				{ status: "complete" },
			]),
			2,
		);
	});

	it("selectUnblockedOpenTasks filters user/completed/blocked tasks and orders in_progress before pending", () => {
		const tasks = [
			mkTask({ id: "1", status: "completed" }),
			mkTask({ id: "2", status: "pending" }),
			mkTask({ id: "3", status: "pending", assignee: "user" }),
			mkTask({ id: "4", status: "in_progress" }),
			mkTask({ id: "5", status: "pending", blockedBy: ["4"] }), // blocked by open #4
			mkTask({ id: "6", status: "pending", blockedBy: ["3"] }), // blocked by open user task #3
			mkTask({ id: "7", status: "pending", blockedBy: ["1"] }), // blocker #1 is completed -> unblocked
			mkTask({ id: "8", status: "pending", blockedBy: ["99"] }), // deleted blocker -> unblocked
		];
		const selected = selectUnblockedOpenTasks(tasks);
		assert.deepEqual(
			selected.map((t) => t.id),
			["4", "2", "7", "8"],
		);
	});

	it("decideHeadlessIdleReminder enforces every gate and bounded backoff schedule", () => {
		const openTask = mkTask({ id: "4", status: "in_progress" });
		const base = {
			supervisedPeer: true,
			enabled: true,
			agentBusy: false,
			activeAsyncCount: 0,
			idleSince: T0,
			lastNudgeAt: 0,
			nudgeCount: 0,
			now: T0 + BASE_MS,
			baseDelayMs: BASE_MS,
			tasks: [openTask],
		};

		// Interactive TUI suppressed
		assert.equal(decideHeadlessIdleReminder({ ...base, supervisedPeer: false }).reason, "not-supervised");
		// Disabled suppressed
		assert.equal(decideHeadlessIdleReminder({ ...base, enabled: false }).reason, "disabled");
		// Busy suppressed
		assert.equal(decideHeadlessIdleReminder({ ...base, agentBusy: true }).reason, "busy");
		// Active async agent suppressed
		assert.equal(decideHeadlessIdleReminder({ ...base, activeAsyncCount: 1 }).reason, "active-async");
		// Not idle suppressed
		assert.equal(decideHeadlessIdleReminder({ ...base, idleSince: null }).reason, "not-idle");
		// Below delay suppressed
		assert.equal(decideHeadlessIdleReminder({ ...base, now: T0 + BASE_MS - 1 }).reason, "cooldown");
		// Only blocked/user tasks suppressed
		assert.equal(
			decideHeadlessIdleReminder({
				...base,
				tasks: [
					mkTask({ id: "1", status: "pending", assignee: "user" }),
					mkTask({ id: "2", status: "pending", blockedBy: ["1"] }),
				],
			}).reason,
			"no-unblocked-tasks",
		);

		// Nudge 1 (1x = 2m)
		const n1 = decideHeadlessIdleReminder(base);
		assert.equal(n1.fire, true);
		assert.equal(n1.nextNudgeCount, 1);
		assert.equal(n1.effectiveDelayMs, 2 * MIN);

		// Nudge 2 (2.5x = 5m)
		assert.equal(
			decideHeadlessIdleReminder({
				...base,
				nudgeCount: 1,
				lastNudgeAt: T0 + 2 * MIN,
				now: T0 + 6 * MIN,
			}).reason,
			"cooldown",
		);
		const n2 = decideHeadlessIdleReminder({
			...base,
			nudgeCount: 1,
			lastNudgeAt: T0 + 2 * MIN,
			now: T0 + 7 * MIN,
		});
		assert.equal(n2.fire, true);
		assert.equal(n2.nextNudgeCount, 2);
		assert.equal(n2.effectiveDelayMs, 5 * MIN);

		// Nudge 3 (5x = 10m)
		const n3 = decideHeadlessIdleReminder({
			...base,
			nudgeCount: 2,
			lastNudgeAt: T0 + 7 * MIN,
			now: T0 + 17 * MIN,
		});
		assert.equal(n3.fire, true);
		assert.equal(n3.nextNudgeCount, 3);
		assert.equal(n3.effectiveDelayMs, 10 * MIN);

		// Capped after HEADLESS_IDLE_MAX_NUDGES (3)
		assert.equal(HEADLESS_IDLE_MAX_NUDGES, HEADLESS_IDLE_BACKOFF_MULTIPLIERS.length);
		assert.equal(
			decideHeadlessIdleReminder({
				...base,
				nudgeCount: HEADLESS_IDLE_MAX_NUDGES,
				lastNudgeAt: T0 + 17 * MIN,
				now: T0 + 180 * MIN,
			}).reason,
			"backoff-capped",
		);
	});

	it("headlessIdleReminderContent names open task IDs and 0 active async agents without leaking subjects", () => {
		const content = headlessIdleReminderContent(
			[mkTask({ id: "4", subject: "TopSecret" }), mkTask({ id: "7", status: "pending", subject: "Private" })],
			2,
			1,
			3,
		);
		assert.match(content, /#4, #7/);
		assert.match(content, /0 active async agents/);
		assert.match(content, /nudge 1\/3/);
		assert.equal(content.includes("TopSecret"), false);
		assert.equal(content.includes("Private"), false);
	});
});

interface BootOptions {
	supervised?: boolean;
	settings?: Record<string, unknown>;
	ctxCwd?: string;
	ctxSettings?: Record<string, unknown>;
	initialNow?: number;
}

function bootPeer(tasks: any[], opts: BootOptions = {}) {
	const cwd = makeTempDir("pitasks-headless-");
	const storePath = join(cwd, "tasks.json");
	writeFileSync(storePath, JSON.stringify({ nextId: tasks.length + 1, tasks }));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "pi-config-settings.json"),
		JSON.stringify({
			task_reminder_enabled: true,
			task_reminder_interval_minutes: 10,
			task_stale_in_progress_enabled: true,
			task_stale_in_progress_minutes: 30,
			task_headless_idle_reminder_minutes: 2,
			...(opts.settings ?? {}),
		}),
	);

	let extraCtxDir: string | null = null;
	let ctxCwd = opts.ctxCwd;
	if (opts.ctxSettings) {
		extraCtxDir = makeTempDir("pitasks-headless-ctx-");
		mkdirSync(join(extraCtxDir, ".pi"), { recursive: true });
		writeFileSync(
			join(extraCtxDir, ".pi", "pi-config-settings.json"),
			JSON.stringify(opts.ctxSettings),
		);
		ctxCwd = extraCtxDir;
	}

	let nowMs = opts.initialNow ?? T0;
	const origDateNow = Date.now;
	Date.now = () => nowMs;

	const ticks: Array<() => void> = [];
	const prevSetInterval = global.setInterval;
	const prevCwd = process.cwd();
	const prevTasks = process.env.PI_TASKS;
	const prevSubagent = process.env.PI_SUBAGENT_CHILD;
	const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
	const prevEnvMin = process.env.PI_TASK_HEADLESS_IDLE_REMINDER_MINUTES;

	global.setInterval = ((fn: () => void) => {
		ticks.push(fn);
		return { unref() {} } as any;
	}) as typeof setInterval;
	process.env.PI_TASKS = storePath;
	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_TASK_HEADLESS_IDLE_REMINDER_MINUTES;
	if (opts.supervised ?? true) {
		process.env.PI_COMS_SUPERVISED_PEER = "1";
	} else {
		delete process.env.PI_COMS_SUPERVISED_PEER;
	}
	process.chdir(cwd);

	const sent: Array<{ message: any; options: any }> = [];
	const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<void>>>();
	const pi = {
		on(name: string, handler: any) {
			(handlers.get(name) ?? handlers.set(name, []).get(name)!).push(handler);
		},
		registerTool() {},
		registerCommand() {},
		sendMessage(message: any, options?: any) {
			sent.push({ message, options });
		},
		events: new EventEmitter(),
	};
	registerPitasks(pi as any);

	const defaultCtx = { cwd: ctxCwd ?? cwd, ui: { setWidget() {} } };
	const emit = async (name: string, event: any = {}, ctx: any = defaultCtx) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};

	return {
		sent,
		cwd,
		ctxCwd: ctxCwd ?? cwd,
		storePath,
		emit,
		advance: (ms: number) => { nowMs += ms; },
		now: () => nowMs,
		tick: () => { for (const fn of ticks) fn(); },
		reminders: () => sent.filter((s) => s.message?.customType === "task-focus-reminder"),
		restore: async () => {
			try {
				resetSessionBridge({ slot: "workload" });
				await emit("session_shutdown");
			} finally {
				Date.now = origDateNow;
				global.setInterval = prevSetInterval;
				process.chdir(prevCwd);
				if (prevTasks === undefined) delete process.env.PI_TASKS;
				else process.env.PI_TASKS = prevTasks;
				if (prevSubagent === undefined) delete process.env.PI_SUBAGENT_CHILD;
				else process.env.PI_SUBAGENT_CHILD = prevSubagent;
				if (prevSupervised === undefined) delete process.env.PI_COMS_SUPERVISED_PEER;
				else process.env.PI_COMS_SUPERVISED_PEER = prevSupervised;
				if (prevEnvMin === undefined) delete process.env.PI_TASK_HEADLESS_IDLE_REMINDER_MINUTES;
				else process.env.PI_TASK_HEADLESS_IDLE_REMINDER_MINUTES = prevEnvMin;
				rmSync(cwd, { recursive: true, force: true });
				if (extraCtxDir) rmSync(extraCtxDir, { recursive: true, force: true });
			}
		},
	};
}

describe("#1434 headless supervised peer timer wiring", () => {
	it("fires after 2m idle for an open in_progress task with 0 active async agents", async () => {
		const h = bootPeer([mkTask({ id: "4", status: "in_progress", createdAt: T0 })]);
		try {
			await h.emit("session_start", { reason: "startup" });
			h.advance(1 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 0, "must not fire before 2m threshold");

			h.advance(1 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 1);
			assert.equal(h.reminders()[0].options?.triggerTurn, true);
			assert.match(h.reminders()[0].message.content, /#4/);
			assert.match(h.reminders()[0].message.content, /0 active async agents/);
			assert.match(h.reminders()[0].message.content, /nudge 1\/3/);
		} finally {
			await h.restore();
		}
	});

	it("fires after 2m idle for an open unblocked pending task", async () => {
		const h = bootPeer([mkTask({ id: "2", status: "pending", createdAt: T0 })]);
		try {
			await h.emit("session_start", { reason: "startup" });
			h.advance(2 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 1);
			assert.match(h.reminders()[0].message.content, /#2/);
		} finally {
			await h.restore();
		}
	});

	it("suppresses while agentBusy is true and starts idle timer on turn_end / agent_settled", async () => {
		const h = bootPeer([mkTask({ id: "4", status: "in_progress" })]);
		try {
			await h.emit("before_agent_start", { messageType: "user", prompt: "work" });
			await h.emit("turn_start");
			h.advance(10 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 0, "busy agent must suppress reminder");

			// Aborted turn settles via agent_settled without turn_end
			await h.emit("agent_settled");
			h.advance(1 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 0, "idle timer starts at agent_settled");

			h.advance(1 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 1, "fires 2m after agent_settled");
		} finally {
			await h.restore();
		}
	});

	it("suppresses while any async agent is running or queued, then fires once finished", async () => {
		const h = bootPeer([mkTask({ id: "4", status: "in_progress" })]);
		try {
			let agents: any[] = [{ id: "a1", agent: "worker", task: "check", status: "running", startedAt: T0, taskId: "-1" }];
			publishWorkloadSources({ agents: () => agents, crons: () => [] });

			h.advance(5 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 0, "running async agent suppresses headless nudge");

			agents = [{ id: "a1", agent: "worker", task: "check", status: "queued", startedAt: T0, taskId: "4" }];
			h.advance(5 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 0, "queued async agent suppresses headless nudge");

			agents = [{ id: "a1", agent: "worker", task: "check", status: "complete", startedAt: T0, taskId: "4" }];
			h.tick();
			assert.equal(h.reminders().length, 1, "fires once 0 active async agents remain");
		} finally {
			await h.restore();
		}
	});

	it("suppresses user-assigned tasks and tasks with open blockedBy blockers", async () => {
		const h = bootPeer([
			mkTask({ id: "1", status: "pending", assignee: "user" }),
			mkTask({ id: "2", status: "pending", assignee: "llm", blockedBy: ["1"] }),
		]);
		try {
			h.advance(30 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 0);
		} finally {
			await h.restore();
		}
	});

	it("applies bounded backoff (2m -> 5m -> 10m -> capped at 3) across reminder-triggered turns and resets on real turn", async () => {
		const h = bootPeer([mkTask({ id: "4", status: "in_progress" })]);
		try {
			await h.emit("session_start", { reason: "startup" });

			// Nudge 1 at +2m
			h.advance(2 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 1);
			assert.match(h.reminders()[0].message.content, /nudge 1\/3/);

			// Simulate reminder-triggered multi-turn run (e.g. peer checked TaskList and stopped)
			await h.emit("before_agent_start", {
				messageType: "custom",
				message: { customType: "task-focus-reminder", content: h.reminders()[0].message.content },
			});
			await h.emit("turn_start");
			h.advance(10_000);
			await h.emit("turn_end", { message: { role: "assistant" } });
			await h.emit("turn_start");
			h.advance(5_000);
			await h.emit("turn_end", { message: { role: "assistant" } });
			await h.emit("agent_settled");

			// 4m after reminder run ends (< 5m backoff) -> suppressed
			h.advance(4 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 1);

			// +1m (5m total idle) -> Nudge 2
			h.advance(1 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 2);
			assert.match(h.reminders()[1].message.content, /nudge 2\/3/);

			// Simulate reminder-triggered turn
			await h.emit("before_agent_start", {
				messageType: "custom",
				message: { customType: "task-focus-reminder", content: h.reminders()[1].message.content },
			});
			await h.emit("turn_start");
			await h.emit("turn_end", { message: { role: "assistant" } });
			await h.emit("agent_settled");

			// 9m idle (< 10m backoff) -> suppressed
			h.advance(9 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 2);

			// +1m (10m idle) -> Nudge 3
			h.advance(1 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 3);
			assert.match(h.reminders()[2].message.content, /nudge 3\/3/);

			// Simulate reminder-triggered turn
			await h.emit("before_agent_start", {
				messageType: "custom",
				message: { customType: "task-focus-reminder", content: h.reminders()[2].message.content },
			});
			await h.emit("turn_start");
			await h.emit("turn_end", { message: { role: "assistant" } });
			await h.emit("agent_settled");

			// Capped: even 120m later, no 4th nudge fires
			h.advance(120 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 3, "backoff cap must prevent runaway nudging");

			// Real non-reminder turn resets backoff!
			await h.emit("before_agent_start", { messageType: "user", prompt: "new instruction" });
			await h.emit("turn_start");
			await h.emit("turn_end", { message: { role: "assistant" } });
			await h.emit("agent_settled");

			// 2m after real turn -> fires nudge 1/3 again
			h.advance(2 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 4);
			assert.match(h.reminders()[3].message.content, /nudge 1\/3/);
		} finally {
			await h.restore();
		}
	});

	it("resets backoff on task state change, but NOT on completed-task GC deletions", async () => {
		const completedAt = new Date(T0).toISOString();
		const h = bootPeer(
			[
				mkTask({ id: "1", status: "completed", createdAt: T0, completedAt }),
				mkTask({ id: "4", status: "in_progress", createdAt: T0 }),
			],
			{
				settings: {
					task_auto_clear_enabled: true,
					task_auto_clear_minutes: 30,
				},
			},
		);
		try {
			await h.emit("session_start", { reason: "startup" });
			// Trigger all 3 nudges (at +2m, +7m, +17m) — task #1 is still under 30m GC threshold
			h.advance(2 * MIN);
			h.tick();
			h.advance(5 * MIN);
			h.tick();
			h.advance(10 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 3);

			// Advance past 30m so GC deletes task #1 on this tick — must NOT reset backoff!
			h.advance(20 * MIN);
			h.tick();
			assert.equal(indexModule.listTasks().map((t: any) => t.id).includes("1"), false, "GC should have deleted expired task #1");
			assert.equal(h.reminders().length, 3, "GC deletion must not trigger a 4th nudge");

			// Even after waiting another 10m post-GC, backoff must remain capped
			h.advance(10 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 3, "GC deletion must not reset headless backoff");

			// Real task state change resets backoff and idle clock
			indexModule.updateTask("4", { subject: "Updated progress" });
			h.tick();
			assert.equal(h.reminders().length, 3, "task change resets idle clock so it waits full 2m");
			h.advance(2 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 4);
			assert.match(h.reminders()[3].message.content, /nudge 1\/3/);
		} finally {
			await h.restore();
		}
	});

	it("does not fire when both task_reminder_enabled and task_stale_in_progress_enabled are false", async () => {
		const h = bootPeer([mkTask({ id: "4", status: "in_progress" })], {
			settings: {
				task_reminder_enabled: false,
				task_stale_in_progress_enabled: false,
			},
		});
		try {
			h.advance(10 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 0);
		} finally {
			await h.restore();
		}
	});

	it("reads reminder settings from currentCtx.cwd instead of process.cwd()", async () => {
		const h = bootPeer([mkTask({ id: "4", status: "in_progress" })], {
			settings: {
				task_headless_idle_reminder_minutes: 2,
			},
			ctxSettings: {
				task_reminder_enabled: true,
				task_headless_idle_reminder_minutes: 5,
			},
		});
		try {
			await h.emit("session_start", { reason: "startup" });
			// At 2m (process.cwd setting), ctx.cwd setting (5m) must suppress it
			h.advance(2 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 0, "must honor ctx.cwd threshold (5m), not process.cwd (2m)");

			// At 5m, it fires
			h.advance(3 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 1);
		} finally {
			await h.restore();
		}
	});

	it("leaves interactive TUI sessions unchanged (no 2m nudge for in_progress or fresh pending tasks)", async () => {
		const h = bootPeer([mkTask({ id: "4", status: "in_progress", createdAt: T0 })], {
			supervised: false,
		});
		try {
			await h.emit("session_start", { reason: "startup" });
			h.advance(15 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 0, "interactive TUI must wait for 30m stale threshold, not 2m");

			// At 31m, interactive TUI fires the classic stale reminder (not headless reminder)
			h.advance(16 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 1);
			assert.match(h.reminders()[0].message.content, /stuck in progress \(>30m/);
		} finally {
			await h.restore();
		}
	});
});
