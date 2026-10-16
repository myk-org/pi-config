/**
 * #924 coms enhancements — pure helpers: priority queue insertion, steer cap,
 * broadcast aggregation, busy formatting.
 * Run with: npx tsx --test tests/node/coms/coms-enhancements.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	STEER_CAP_PER_TURN,
	insertInboundByPriority,
	shouldAcceptSteer,
	summarizeBroadcast,
	formatBusyStr,
} from "../../../extensions/coms/coms-shared.js";

interface TestEntry {
	msg_id: string;
	priority?: boolean;
}

describe("insertInboundByPriority (#924 §4)", () => {
	it("appends non-priority entries in arrival order", () => {
		const out = insertInboundByPriority<TestEntry>(
			[{ msg_id: "a" }, { msg_id: "b" }],
			{ msg_id: "c" },
		);
		assert.deepEqual(out.map((e) => e.msg_id), ["a", "b", "c"]);
	});

	it("inserts a priority entry ahead of the first non-priority entry", () => {
		const out = insertInboundByPriority<TestEntry>(
			[{ msg_id: "a" }, { msg_id: "b" }, { msg_id: "c" }],
			{ msg_id: "urgent", priority: true },
		);
		assert.deepEqual(out.map((e) => e.msg_id), ["urgent", "a", "b", "c"]);
	});

	it("keeps arrival order among priorities", () => {
		const out = insertInboundByPriority<TestEntry>(
			[{ msg_id: "u1", priority: true }, { msg_id: "a" }],
			{ msg_id: "u2", priority: true },
		);
		assert.deepEqual(out.map((e) => e.msg_id), ["u1", "u2", "a"]);
	});

	it("priority after only priorities stays at the tail", () => {
		const out = insertInboundByPriority<TestEntry>(
			[{ msg_id: "u1", priority: true }],
			{ msg_id: "u2", priority: true },
		);
		assert.deepEqual(out.map((e) => e.msg_id), ["u1", "u2"]);
	});

	it("does not mutate the input array", () => {
		const input: TestEntry[] = [{ msg_id: "a" }];
		insertInboundByPriority(input, { msg_id: "urgent", priority: true });
		assert.equal(input.length, 1);
	});
});

describe("shouldAcceptSteer (#924 §1)", () => {
	it("accepts while under the cap and rejects at the cap", () => {
		assert.equal(shouldAcceptSteer(0), true);
		assert.equal(shouldAcceptSteer(STEER_CAP_PER_TURN - 1), true);
		assert.equal(shouldAcceptSteer(STEER_CAP_PER_TURN), false);
		assert.equal(shouldAcceptSteer(100), false);
	});
	it("cap is 5 per turn (bug containment, not a security boundary)", () => {
		assert.equal(STEER_CAP_PER_TURN, 5);
	});
});

describe("summarizeBroadcast (#924 §2)", () => {
	it("reports per-peer lines with partial failures, never swallowed", () => {
		const summary = summarizeBroadcast([
			{ target: "alpha", msg_id: "m1", status: "sent" },
			{ target: "beta", status: "error", error: "unreachable" },
			{ target: "gamma", msg_id: "m3", status: "sent" },
		]);
		assert.equal(summary.sent, 2);
		assert.equal(summary.failed, 1);
		assert.ok(summary.text.includes("2/3 sent"));
		assert.ok(summary.text.includes("✓ alpha — m1"));
		assert.ok(summary.text.includes("✗ beta — unreachable"));
		assert.ok(!summary.text.includes("✗ gamma"));
	});
	it("empty result set reports zero", () => {
		const summary = summarizeBroadcast([]);
		assert.equal(summary.sent, 0);
		assert.equal(summary.failed, 0);
		assert.ok(summary.text.includes("0/0 sent"));
	});
});

describe("formatBusyStr (#924 §3)", () => {
	it("marks busy peers and stays empty otherwise", () => {
		assert.equal(formatBusyStr(true), " ⚙busy");
		assert.equal(formatBusyStr(false), "");
		assert.equal(formatBusyStr(undefined), "");
		assert.equal(formatBusyStr(null), "");
	});
});
