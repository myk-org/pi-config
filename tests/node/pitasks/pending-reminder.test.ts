/**
 * #1022 — pending-task reminder must respect task age.
 * Imports the REAL production decision helper from extensions/pitasks/reminders.ts
 * (no mirrored logic here) so regressions in the timer wiring are caught.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decidePendingReminder, oldestPendingAt } from "../../../extensions/pitasks/reminders.ts";
import * as indexModule from "../../../extensions/pitasks/index.ts";
import * as reminders from "../../../extensions/pitasks/reminders.ts";

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

	it("treats a missing timestamp as old (fires) and logs it", () => {
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

	it("oldestPendingAt ignores unusable timestamps when a usable one exists", () => {
		assert.equal(oldestPendingAt([{ status: "pending" }, pending(30 * MIN)]), NOW - 30 * MIN);
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

	it("the timer passes agentBusy into the decision (wiring)", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "../../../extensions/pitasks/index.ts"),
			"utf8",
		);
		const start = source.indexOf("decidePendingReminder({");
		assert.notEqual(start, -1, "pending branch must use decidePendingReminder");
		const call = source.slice(start, source.indexOf("})", start));
		assert.match(call, /agentBusy/);
		assert.match(call, /lastReminderAt/);
		assert.equal(indexModule.decidePendingReminder, reminders.decidePendingReminder);
	});
});
