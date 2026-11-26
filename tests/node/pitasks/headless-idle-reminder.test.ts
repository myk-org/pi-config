/**
 * #1434 — Fast, bounded idle task reminders for headless supervised COMS peers.
 * Exercises pure helpers in extensions/pitasks/reminders.ts and live timer
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
	openTasksFingerprint,
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

function baseDecisionParams(overrides: Partial<Parameters<typeof decideHeadlessIdleReminder>[0]> = {}) {
	return {
		supervisedPeer: true,
		enabled: true,
		agentBusy: false,
		activeAsyncCount: 0,
		idleSince: T0,
		lastNudgeAt: 0,
		nudgeCount: 0,
		now: T0 + BASE_MS,
		baseDelayMs: BASE_MS,
		tasks: [mkTask({ id: "4", status: "in_progress" })],
		...overrides,
	};
}

describe("#1434 settings schema", () => {
	it("declares task_headless_idle_reminder_minutes with expected bounds", () => {
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
		assert.equal(indexModule.openTasksFingerprint, remindersModule.openTasksFingerprint);
		assert.equal(indexModule.selectUnblockedOpenTasks, remindersModule.selectUnblockedOpenTasks);
		assert.equal(indexModule.decideHeadlessIdleReminder, remindersModule.decideHeadlessIdleReminder);
		assert.equal(indexModule.headlessIdleReminderContent, remindersModule.headlessIdleReminderContent);
		assert.equal(indexModule.HEADLESS_IDLE_BACKOFF_MULTIPLIERS, remindersModule.HEADLESS_IDLE_BACKOFF_MULTIPLIERS);
		assert.equal(indexModule.HEADLESS_IDLE_MAX_NUDGES, remindersModule.HEADLESS_IDLE_MAX_NUDGES);
	});
});

describe("#1434 pure helpers", () => {
	it("countActiveAsyncAgents counts running or queued non-fireAndForget agents", () => {
		assert.equal(
			countActiveAsyncAgents([
				{ status: "running" },
				{ status: "queued" },
				{ status: "complete" },
			]),
			2,
		);
	});

	it("countActiveAsyncAgents ignores finished or fireAndForget agents", () => {
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
	});

	it("countActiveAsyncAgents excludes running agents owned by another session", () => {
		assert.equal(
			countActiveAsyncAgents(
				[
					{ status: "running", sessionId: "session-old" },
					{ status: "queued", sessionId: "session-old" },
					{ status: "running", sessionId: "session-cur" },
					{ status: "running" },
				],
				"session-cur",
			),
			2,
		);
	});

	it("selectUnblockedOpenTasks excludes user, completed, or blocked tasks", () => {
		const tasks = [
			mkTask({ id: "1", status: "completed" }),
			mkTask({ id: "2", status: "pending" }),
			mkTask({ id: "3", status: "pending", assignee: "user" }),
			mkTask({ id: "4", status: "in_progress" }),
			mkTask({ id: "5", status: "pending", blockedBy: ["4"] }),
			mkTask({ id: "6", status: "pending", blockedBy: ["3"] }),
			mkTask({ id: "7", status: "pending", blockedBy: ["1"] }),
			mkTask({ id: "8", status: "pending", blockedBy: ["99"] }),
		];
		const ids = selectUnblockedOpenTasks(tasks).map((t) => t.id);
		assert.deepEqual(ids.sort(), ["2", "4", "7", "8"]);
	});

	it("selectUnblockedOpenTasks orders in_progress tasks ahead of pending by ID", () => {
		const tasks = [
			mkTask({ id: "10", status: "pending" }),
			mkTask({ id: "2", status: "pending" }),
			mkTask({ id: "7", status: "in_progress" }),
			mkTask({ id: "3", status: "in_progress" }),
		];
		assert.deepEqual(
			selectUnblockedOpenTasks(tasks).map((t) => t.id),
			["3", "7", "2", "10"],
		);
	});

	it("openTasksFingerprint ignores telemetry or completed tasks", () => {
		const baseTasks = [
			mkTask({ id: "1", status: "completed" }),
			mkTask({ id: "4", status: "in_progress", subject: "Alpha" }),
		];
		const withTelemetry = [
			{
				...mkTask({ id: "4", status: "in_progress", subject: "Beta" }),
				telemetry: { startedAt: T0, inputTokens: 999, outputTokens: 123 },
			},
		];
		assert.equal(openTasksFingerprint(baseTasks), openTasksFingerprint(withTelemetry));
	});

	it("openTasksFingerprint changes on structural task status edit", () => {
		assert.notEqual(
			openTasksFingerprint([mkTask({ id: "4", status: "in_progress" })]),
			openTasksFingerprint([mkTask({ id: "4", status: "pending" })]),
		);
	});

	it("openTasksFingerprint distinguishes blocker lists containing separator commas", () => {
		const splitBlockers = [mkTask({ id: "4", status: "pending", blockedBy: ["2", "3"] })];
		const combinedBlocker = [mkTask({ id: "4", status: "pending", blockedBy: ["2,3"] })];
		assert.notEqual(openTasksFingerprint(splitBlockers), openTasksFingerprint(combinedBlocker));
	});

	it("decideHeadlessIdleReminder skips non-supervised sessions", () => {
		assert.equal(decideHeadlessIdleReminder(baseDecisionParams({ supervisedPeer: false })).reason, "not-supervised");
	});

	it("decideHeadlessIdleReminder skips when disabled", () => {
		assert.equal(decideHeadlessIdleReminder(baseDecisionParams({ enabled: false })).reason, "disabled");
	});

	it("decideHeadlessIdleReminder skips when baseDelayMs is non-positive", () => {
		assert.equal(decideHeadlessIdleReminder(baseDecisionParams({ baseDelayMs: 0 })).reason, "disabled");
	});

	it("decideHeadlessIdleReminder skips while agentBusy is true", () => {
		assert.equal(decideHeadlessIdleReminder(baseDecisionParams({ agentBusy: true })).reason, "busy");
	});

	it("decideHeadlessIdleReminder skips when workload source is unknown", () => {
		assert.equal(decideHeadlessIdleReminder(baseDecisionParams({ activeAsyncCount: null })).reason, "workload-unknown");
	});

	it("decideHeadlessIdleReminder skips when active async agents exist", () => {
		assert.equal(decideHeadlessIdleReminder(baseDecisionParams({ activeAsyncCount: 1 })).reason, "active-async");
	});

	it("decideHeadlessIdleReminder skips when idleSince is null", () => {
		assert.equal(decideHeadlessIdleReminder(baseDecisionParams({ idleSince: null })).reason, "not-idle");
	});

	it("decideHeadlessIdleReminder skips during cooldown before effectiveDelayMs", () => {
		assert.equal(decideHeadlessIdleReminder(baseDecisionParams({ now: T0 + BASE_MS - 1 })).reason, "cooldown");
	});

	it("decideHeadlessIdleReminder skips when only user or blocked tasks exist", () => {
		const decision = decideHeadlessIdleReminder(
			baseDecisionParams({
				tasks: [
					mkTask({ id: "1", status: "pending", assignee: "user" }),
					mkTask({ id: "2", status: "pending", blockedBy: ["1"] }),
				],
			}),
		);
		assert.equal(decision.reason, "no-unblocked-tasks");
	});

	it("decideHeadlessIdleReminder fires nudge 1 at 1x base delay", () => {
		const n1 = decideHeadlessIdleReminder(baseDecisionParams());
		assert.equal(n1.fire, true);
		assert.equal(n1.nextNudgeCount, 1);
		assert.equal(n1.effectiveDelayMs, 2 * MIN);
	});

	it("decideHeadlessIdleReminder holds nudge 2 in cooldown before 2.5x base delay", () => {
		const decision = decideHeadlessIdleReminder(
			baseDecisionParams({
				nudgeCount: 1,
				lastNudgeAt: T0 + 2 * MIN,
				now: T0 + 6 * MIN,
			}),
		);
		assert.equal(decision.reason, "cooldown");
	});

	it("decideHeadlessIdleReminder fires nudge 2 at 2.5x base delay", () => {
		const n2 = decideHeadlessIdleReminder(
			baseDecisionParams({
				nudgeCount: 1,
				lastNudgeAt: T0 + 2 * MIN,
				now: T0 + 7 * MIN,
			}),
		);
		assert.equal(n2.fire, true);
		assert.equal(n2.nextNudgeCount, 2);
		assert.equal(n2.effectiveDelayMs, 5 * MIN);
	});

	it("decideHeadlessIdleReminder fires nudge 3 at 5x base delay", () => {
		const n3 = decideHeadlessIdleReminder(
			baseDecisionParams({
				nudgeCount: 2,
				lastNudgeAt: T0 + 7 * MIN,
				now: T0 + 17 * MIN,
			}),
		);
		assert.equal(n3.fire, true);
		assert.equal(n3.nextNudgeCount, 3);
		assert.equal(n3.effectiveDelayMs, 10 * MIN);
	});

	it("decideHeadlessIdleReminder caps nudges at HEADLESS_IDLE_MAX_NUDGES", () => {
		assert.equal(HEADLESS_IDLE_MAX_NUDGES, HEADLESS_IDLE_BACKOFF_MULTIPLIERS.length);
		const capped = decideHeadlessIdleReminder(
			baseDecisionParams({
				nudgeCount: HEADLESS_IDLE_MAX_NUDGES,
				lastNudgeAt: T0 + 17 * MIN,
				now: T0 + 180 * MIN,
			}),
		);
		assert.equal(capped.reason, "backoff-capped");
	});

	it("headlessIdleReminderContent formats open IDs with zero-async detail", () => {
		const content = headlessIdleReminderContent(
			[mkTask({ id: "4", subject: "TopSecret" }), mkTask({ id: "7", status: "pending", subject: "Private" })],
			2,
			1,
			3,
		);
		assert.match(content, /#4, #7/);
		assert.match(content, /0 active async agents/);
		assert.match(content, /nudge 1\/3/);
	});

	it("headlessIdleReminderContent omits task subjects", () => {
		const content = headlessIdleReminderContent(
			[mkTask({ id: "4", subject: "TopSecret" }), mkTask({ id: "7", status: "pending", subject: "Private" })],
			2,
			1,
			3,
		);
		assert.equal(content.includes("TopSecret"), false);
		assert.equal(content.includes("Private"), false);
	});
});

interface BootOptions {
	supervised?: boolean;
	settings?: Record<string, unknown>;
	ctxCwd?: string;
	ctxSettings?: Record<string, unknown>;
	sessionId?: string;
	publishWorkload?: boolean;
	initialNow?: number;
	shouldThrowSend?: () => boolean;
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

	if (opts.publishWorkload !== false) {
		publishWorkloadSources({ agents: () => [], crons: () => [] }, opts.sessionId);
	}

	const sent: Array<{ message: any; options: any }> = [];
	const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<void>>>();
	const pi = {
		on(name: string, handler: any) {
			(handlers.get(name) ?? handlers.set(name, []).get(name)!).push(handler);
		},
		registerTool() {},
		registerCommand() {},
		sendMessage(message: any, options?: any) {
			if (opts.shouldThrowSend?.()) {
				throw new Error("simulated send failure");
			}
			sent.push({ message, options });
		},
		events: new EventEmitter(),
	};
	registerPitasks(pi as any);

	const defaultCtx = {
		cwd: ctxCwd ?? cwd,
		ui: { setWidget() {} },
		...(opts.sessionId ? { sessionManager: { getSessionId: () => opts.sessionId } } : {}),
	};
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
				resetSessionBridge({ all: true });
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

async function runReminderTurn(
	h: ReturnType<typeof bootPeer>,
	content: string,
	usage?: { input: number; output: number },
) {
	await h.emit("before_agent_start", {
		messageType: "custom",
		message: { customType: "task-focus-reminder", content },
	});
	await h.emit("turn_start");
	h.advance(10_000);
	await h.emit("turn_end", {
		message: usage ? { role: "assistant", usage } : { role: "assistant" },
	});
	await h.emit("agent_settled");
}

describe("#1434 headless supervised peer timer wiring", () => {
	it("fires followUp nudge after 2m idle for an open in_progress task", async () => {
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
			assert.equal(h.reminders()[0].options?.deliverAs, "followUp");
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

	it("suppresses nudges while agentBusy is true", async () => {
		const h = bootPeer([mkTask({ id: "4", status: "in_progress" })]);
		try {
			await h.emit("before_agent_start", { messageType: "user", prompt: "work" });
			await h.emit("turn_start");
			h.advance(10 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 0);
		} finally {
			await h.restore();
		}
	});

	it("suppresses nudges between continuing turns before agent_settled", async () => {
		const h = bootPeer([mkTask({ id: "4", status: "in_progress" })]);
		try {
			await h.emit("before_agent_start", { messageType: "user", prompt: "multi-turn work" });
			await h.emit("turn_start");
			await h.emit("turn_end", { message: { role: "assistant" } });

			h.advance(5 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 0, "continuing run must remain ineligible until agent_settled");

			await h.emit("agent_settled");
			h.advance(1 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 0, "idle clock begins at agent_settled");

			h.advance(1 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 1, "fires 2m after agent_settled");
		} finally {
			await h.restore();
		}
	});

	it("starts idle timer on agent_settled after an aborted run without turn_end", async () => {
		const h = bootPeer([mkTask({ id: "4", status: "in_progress" })]);
		try {
			await h.emit("before_agent_start", { messageType: "user", prompt: "work" });
			await h.emit("turn_start");
			await h.emit("agent_settled");
			h.advance(1 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 0);

			h.advance(1 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 1);
		} finally {
			await h.restore();
		}
	});

	it("suppresses nudges while a current-session async agent is running or queued", async () => {
		const h = bootPeer([mkTask({ id: "4", status: "in_progress" })], { sessionId: "sess-a" });
		try {
			await h.emit("session_start", { reason: "startup" });
			let agents: any[] = [
				{ id: "a1", agent: "worker", task: "check", status: "running", startedAt: T0, taskId: "-1", sessionId: "sess-a" },
			];
			publishWorkloadSources({ agents: () => agents, crons: () => [] }, "sess-a");

			h.advance(5 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 0);

			agents = [
				{ id: "a1", agent: "worker", task: "check", status: "queued", startedAt: T0, taskId: "4", sessionId: "sess-a" },
			];
			h.advance(5 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 0);

			agents = [
				{ id: "a1", agent: "worker", task: "check", status: "complete", startedAt: T0, taskId: "4", sessionId: "sess-a" },
			];
			h.tick();
			assert.equal(h.reminders().length, 1);
		} finally {
			await h.restore();
		}
	});

	it("retains named workload session key when a later context omits sessionId", async () => {
		const h = bootPeer([mkTask({ id: "4", status: "in_progress" })], { sessionId: "sess-named" });
		try {
			await h.emit("session_start", { reason: "startup" });
			publishWorkloadSources(
				{
					agents: () => [
						{ id: "a1", agent: "worker", task: "running", status: "running", startedAt: T0, taskId: "4", sessionId: "sess-named" } as any,
					],
					crons: () => [],
				},
				"sess-named",
			);

			// Later turn receives a context without sessionManager.getSessionId()
			await h.emit("before_agent_start", { messageType: "user", prompt: "go" }, { cwd: h.cwd, ui: { setWidget() {} } });
			await h.emit("turn_start", {}, { cwd: h.cwd, ui: { setWidget() {} } });
			await h.emit("turn_end", { message: { role: "assistant" } }, { cwd: h.cwd, ui: { setWidget() {} } });
			await h.emit("agent_settled", {}, { cwd: h.cwd, ui: { setWidget() {} } });

			h.advance(5 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 0, "named workload source must remain bound despite omitted sessionId");
		} finally {
			await h.restore();
		}
	});

	it("suppresses nudges when no matching workload source is published", async () => {
		const h = bootPeer([mkTask({ id: "4", status: "in_progress" })], {
			sessionId: "sess-unpub",
			publishWorkload: false,
		});
		try {
			await h.emit("session_start", { reason: "startup" });
			h.advance(10 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 0, "absent workload source must not be treated as zero active async agents");
		} finally {
			await h.restore();
		}
	});

	it("ignores retained running async agents belonging to another session", async () => {
		const h = bootPeer([mkTask({ id: "4", status: "in_progress" })], { sessionId: "sess-new" });
		try {
			await h.emit("session_start", { reason: "resume" });
			publishWorkloadSources(
				{
					agents: () => [
						{ id: "old-job", agent: "worker", task: "stale", status: "running", startedAt: T0, taskId: "9", sessionId: "sess-old" } as any,
					],
					crons: () => [],
				},
				"sess-new",
			);

			h.advance(2 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 1);
		} finally {
			await h.restore();
		}
	});

	it("suppresses nudges when only user-assigned or blocked tasks exist", async () => {
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

	it("escalates headless backoff 2m -> 5m -> 10m across reminder turns", async () => {
		const h = bootPeer([mkTask({ id: "4", status: "in_progress" })]);
		try {
			await h.emit("session_start", { reason: "startup" });

			h.advance(2 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 1);
			assert.match(h.reminders()[0].message.content, /nudge 1\/3/);

			await runReminderTurn(h, h.reminders()[0].message.content);
			h.advance(4 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 1);

			h.advance(1 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 2);
			assert.match(h.reminders()[1].message.content, /nudge 2\/3/);

			await runReminderTurn(h, h.reminders()[1].message.content);
			h.advance(9 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 2);

			h.advance(1 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 3);
			assert.match(h.reminders()[2].message.content, /nudge 3\/3/);
		} finally {
			await h.restore();
		}
	});

	it("preserves backoff progression through token-telemetry writes at reminder turn_end", async () => {
		const h = bootPeer([mkTask({ id: "4", status: "in_progress" })]);
		try {
			await h.emit("session_start", { reason: "startup" });
			indexModule.setTaskTelemetryActive("4", true);

			h.advance(2 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 1);
			await runReminderTurn(h, h.reminders()[0].message.content, { input: 500, output: 120 });

			h.advance(2 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 1, "telemetry write must not reset backoff to 2m");

			h.advance(3 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 2);
			assert.match(h.reminders()[1].message.content, /nudge 2\/3/);
			await runReminderTurn(h, h.reminders()[1].message.content, { input: 500, output: 120 });

			h.advance(10 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 3);
			assert.match(h.reminders()[2].message.content, /nudge 3\/3/);
			await runReminderTurn(h, h.reminders()[2].message.content, { input: 500, output: 120 });

			h.advance(60 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 3, "cap must hold even after telemetry writes");
		} finally {
			await h.restore();
		}
	});

	it("caps consecutive headless nudges at 3 without a real turn", async () => {
		const h = bootPeer([mkTask({ id: "4", status: "in_progress" })]);
		try {
			await h.emit("session_start", { reason: "startup" });
			h.advance(2 * MIN);
			h.tick();
			await runReminderTurn(h, h.reminders()[0].message.content);
			h.advance(5 * MIN);
			h.tick();
			await runReminderTurn(h, h.reminders()[1].message.content);
			h.advance(10 * MIN);
			h.tick();
			await runReminderTurn(h, h.reminders()[2].message.content);
			assert.equal(h.reminders().length, 3);

			h.advance(120 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 3);
		} finally {
			await h.restore();
		}
	});

	it("resets headless backoff after a real non-reminder turn", async () => {
		const h = bootPeer([mkTask({ id: "4", status: "in_progress" })]);
		try {
			await h.emit("session_start", { reason: "startup" });
			h.advance(2 * MIN);
			h.tick();
			h.advance(5 * MIN);
			h.tick();
			h.advance(10 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 3);

			await h.emit("before_agent_start", { messageType: "user", prompt: "new instruction" });
			await h.emit("turn_start");
			await h.emit("turn_end", { message: { role: "assistant" } });
			await h.emit("agent_settled");

			h.advance(2 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 4);
			assert.match(h.reminders()[3].message.content, /nudge 1\/3/);
		} finally {
			await h.restore();
		}
	});

	it("resets headless backoff on structural open-task state change", async () => {
		const h = bootPeer([
			mkTask({ id: "4", status: "in_progress", createdAt: T0 }),
			mkTask({ id: "5", status: "pending", createdAt: T0 }),
		]);
		try {
			await h.emit("session_start", { reason: "startup" });
			h.advance(2 * MIN);
			h.tick();
			h.advance(5 * MIN);
			h.tick();
			h.advance(10 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 3);

			indexModule.updateTask("4", { status: "completed" });
			h.tick();
			assert.equal(h.reminders().length, 3, "state change re-arms idle clock for full 2m");

			h.advance(2 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 4);
			assert.match(h.reminders()[3].message.content, /nudge 1\/3/);
			assert.match(h.reminders()[3].message.content, /#5/);
		} finally {
			await h.restore();
		}
	});

	it("keeps backoff capped across completed-task GC deletions including async watcher echoes", async () => {
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
			h.advance(2 * MIN);
			h.tick();
			h.advance(5 * MIN);
			h.tick();
			h.advance(10 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 3);

			h.advance(20 * MIN);
			h.tick();
			assert.equal(indexModule.listTasks().map((t: any) => t.id).includes("1"), false);

			indexModule.taskStore.notifyChange();
			h.advance(10 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 3);
		} finally {
			await h.restore();
		}
	});

	it("rolls back backoff state when pi.sendMessage throws", async () => {
		let shouldThrow = true;
		const h = bootPeer([mkTask({ id: "4", status: "in_progress" })], {
			shouldThrowSend: () => shouldThrow,
		});
		try {
			await h.emit("session_start", { reason: "startup" });
			h.advance(2 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 0, "failed send records no reminder");

			shouldThrow = false;
			h.tick();
			assert.equal(h.reminders().length, 1);
			assert.match(h.reminders()[0].message.content, /nudge 1\/3/);
		} finally {
			await h.restore();
		}
	});

	it("stays silent when both reminder settings are disabled", async () => {
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
			h.advance(2 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 0);

			h.advance(3 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 1);
		} finally {
			await h.restore();
		}
	});

	it("leaves interactive TUI sessions on existing 30m stale threshold", async () => {
		const h = bootPeer([mkTask({ id: "4", status: "in_progress", createdAt: T0 })], {
			supervised: false,
		});
		try {
			await h.emit("session_start", { reason: "startup" });
			h.advance(15 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 0);

			h.advance(16 * MIN);
			h.tick();
			assert.equal(h.reminders().length, 1);
			assert.match(h.reminders()[0].message.content, /stuck in progress \(>30m/);
		} finally {
			await h.restore();
		}
	});
});
