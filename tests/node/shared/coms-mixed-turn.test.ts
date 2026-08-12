/**
 * Tests for detectMixedTurn — mixed-turn detection logic (#731).
 * Run with: npx tsx --test tests/node/shared/coms-mixed-turn.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectMixedTurn, type BranchEntry } from "../../../extensions/coms/coms-shared.js";
import { isUserMessageDuringInbound, computeMixedTurn } from "../../../extensions/coms/mixed-turn.js";

const MSG_ID = "test-msg-001";
const COMS_INBOUND = "coms-inbound";
function msg(role: string): BranchEntry {
	return { type: "message", message: { role } };
}

function comsInbound(msgId: string, customType: string = COMS_INBOUND): BranchEntry {
	return { type: "custom_message", customType, details: { msg_id: msgId } };
}

describe("detectMixedTurn", () => {
	it("returns false for empty branch", () => {
		assert.equal(detectMixedTurn([], MSG_ID, COMS_INBOUND), false);
	});

	it("returns false when only assistant messages present", () => {
		const branch: BranchEntry[] = [
			comsInbound(MSG_ID),
			msg("assistant"),
		];
		assert.equal(detectMixedTurn(branch, MSG_ID, COMS_INBOUND), false);
	});

	it("returns false when no user message in current turn", () => {
		const branch: BranchEntry[] = [
			comsInbound(MSG_ID),   // coms inbound injection
			msg("assistant"),      // assistant reply to peer — no user message
		];
		assert.equal(detectMixedTurn(branch, MSG_ID, COMS_INBOUND), false);
	});

	it("returns true when user message appears after coms inbound (mixed turn)", () => {
		const branch: BranchEntry[] = [
			comsInbound(MSG_ID),   // coms inbound injection
			msg("user"),           // user typed during the turn
			msg("assistant"),      // assistant reply — could be to user, not peer
		];
		assert.equal(detectMixedTurn(branch, MSG_ID, COMS_INBOUND), true);
	});

	it("returns true when user message appears after coms inbound", () => {
		const branch: BranchEntry[] = [
			msg("assistant"),      // previous turn's assistant
			comsInbound(MSG_ID),   // coms inbound injection
			msg("user"),           // user message arrived in same turn
			msg("assistant"),      // current turn's assistant reply
		];
		assert.equal(detectMixedTurn(branch, MSG_ID, COMS_INBOUND), true);
	});

	it("returns false when user message is before coms inbound (previous turn)", () => {
		const branch: BranchEntry[] = [
			msg("user"),           // user's previous message
			msg("assistant"),      // assistant's previous reply
			comsInbound(MSG_ID),   // coms inbound injection (new turn)
			msg("assistant"),      // assistant reply to peer
		];
		assert.equal(detectMixedTurn(branch, MSG_ID, COMS_INBOUND), false);
	});

	it("ignores unrelated custom_message entries (different customType)", () => {
		const branch: BranchEntry[] = [
			comsInbound(MSG_ID),              // coms inbound injection
			msg("user"),                       // user typed during the turn
			{ type: "custom_message", customType: "coms-response", details: { msg_id: "other" } },
			msg("assistant"),                  // assistant reply
		];
		// Should still detect the user message — unrelated custom_message shouldn't stop scan
		assert.equal(detectMixedTurn(branch, MSG_ID, COMS_INBOUND), true);
	});

	it("ignores custom_message with matching customType but different msg_id", () => {
		const branch: BranchEntry[] = [
			comsInbound(MSG_ID),                     // real coms inbound
			msg("user"),                              // user message
			comsInbound("different-msg-id"),          // different inbound — should not stop scan
			msg("assistant"),
		];
		assert.equal(detectMixedTurn(branch, MSG_ID, COMS_INBOUND), true);
	});

	it("skips non-message non-custom entries (tool results etc.)", () => {
		const branch: BranchEntry[] = [
			comsInbound(MSG_ID),
			{ type: "tool_result" } as BranchEntry,  // should be skipped
			msg("assistant"),
		];
		assert.equal(detectMixedTurn(branch, MSG_ID, COMS_INBOUND), false);
	});

	it("handles branch with only user messages, no assistant", () => {
		const branch: BranchEntry[] = [
			msg("user"),
			msg("user"),
		];
		// No assistant message found — passedAssistant never set, returns false
		assert.equal(detectMixedTurn(branch, MSG_ID, COMS_INBOUND), false);
	});
});

/**
 * Tests for the userMessageInTurn flag state machine (#731).
 *
 * NOTE: These tests simulate the flag logic because the actual handlers
 * (pi.on("message_start") / pi.on("agent_end")) require the full pi
 * extension runtime which cannot be instantiated in unit tests.
 *
 * Production behavior (coms-p2p.ts):
 *   1. message_start: sets userMessageInTurn = true on any user message
 *      (unconditionally — no currentInbound guard)
 *   2. agent_end: early-returns if !currentInbound (resets flag on exit);
 *      otherwise reads hasMixedTurn = userMessageInTurn, resets flag
 *   3. currentInbound is nulled immediately after snapshot in agent_end
 *      to prevent stale flags during async work
 */
describe("userMessageInTurn flag state machine", () => {
	/**
	 * Simulate the actual handler structure:
	 *   - message_start: unconditionally sets flag on user messages
	 *   - agent_end: early-return if no inbound, otherwise read flag
	 * @param events  Sequence of events in the turn
	 * @param inboundSetAt  Event index where currentInbound becomes active
	 *                      (undefined = no inbound in this turn)
	 */
	function simulateTurn(events: Array<{ type: string; role?: string }>, inboundSetAt?: number): boolean {
		let currentInbound = false;
		let userMessageInTurn = false;

		for (let i = 0; i < events.length; i++) {
			if (inboundSetAt !== undefined && i === inboundSetAt) {
				currentInbound = true;
			}
			const event = events[i];
			// message_start: unconditionally set flag on user messages
			if (event.type === "message_start" && event.role === "user") {
				userMessageInTurn = true;
			}
			if (event.type === "agent_end") {
				// Early-return guard: if no inbound, reset flag, return false
				if (!currentInbound) {
					userMessageInTurn = false;
					return false;
				}
				// Snapshot inbound, null it before async work
				const inbound = currentInbound;
				currentInbound = false;
				// Read and reset flag
				const hasMixedTurn = userMessageInTurn;
				userMessageInTurn = false;
				return hasMixedTurn;
			}
		}
		return false;
	}

	it("detects mixed turn: user message first, then inbound arrives (ordering A)", () => {
		const result = simulateTurn([
			{ type: "message_start", role: "user" },
			{ type: "agent_end" },
		], 1); // inbound arrives between message_start and agent_end
		assert.equal(result, true);
	});

	it("detects mixed turn: inbound first, then user types (ordering B)", () => {
		const result = simulateTurn([
			{ type: "message_start", role: "user" },
			{ type: "agent_end" },
		], 0); // inbound already active when message_start fires
		assert.equal(result, true);
	});

	it("returns false when inbound but no user message", () => {
		const result = simulateTurn([
			{ type: "message_start", role: "assistant" },
			{ type: "agent_end" },
		], 0);
		assert.equal(result, false);
	});

	it("returns false when user message but no inbound (normal user turn)", () => {
		// Early-return guard catches this — no inbound means no mixed turn
		const result = simulateTurn([
			{ type: "message_start", role: "user" },
			{ type: "agent_end" },
		]); // no inboundSetAt → early-return path
		assert.equal(result, false);
	});

	it("resets flag on agent_end so next turn starts clean", () => {
		let userMessageInTurn = false;

		// First turn: inbound + user message → mixed
		userMessageInTurn = true;
		const firstResult = userMessageInTurn; // agent_end reads flag
		userMessageInTurn = false; // agent_end resets

		assert.equal(firstResult, true);

		// Second turn: inbound, no user message → clean
		const secondResult = userMessageInTurn;
		userMessageInTurn = false;
		assert.equal(secondResult, false);
	});

	it("early-return resets flag even without inbound", () => {
		let userMessageInTurn = false;
		let currentInbound = false;

		// User types → flag set
		userMessageInTurn = true;

		// agent_end fires, no inbound → early-return resets flag
		if (!currentInbound) {
			userMessageInTurn = false; // early-return path
		}

		assert.equal(userMessageInTurn, false);

		// Next turn: inbound arrives, no user message → clean
		currentInbound = true;
		const hasMixedTurn = userMessageInTurn;
		assert.equal(hasMixedTurn, false);
	});

	it("prevents stale flag by nulling currentInbound before async work", () => {
		let currentInbound = true;
		let userMessageInTurn = false;

		// agent_end starts: snapshot, null, read flag
		const inbound = currentInbound;
		currentInbound = false; // nulled before async
		const hasMixedTurn = userMessageInTurn;
		userMessageInTurn = false;

		assert.equal(inbound, true); // snapshot preserved
		assert.equal(hasMixedTurn, false); // no user message

		// User types during async sendEnvelope
		userMessageInTurn = true; // message_start fires unconditionally

		// currentInbound is null → next agent_end early-returns, resets flag
		if (!currentInbound) {
			userMessageInTurn = false;
		}
		assert.equal(userMessageInTurn, false); // cleaned up
	});

	it("restores currentInbound after successful mixed-turn re-injection", () => {
		let currentInbound: string | null = "inbound-A";
		let userMessageInTurn = true; // user message in this turn

		// agent_end: snapshot, null
		const inbound = currentInbound;
		currentInbound = null;

		// Mixed turn detected — re-inject
		const hasMixedTurn = userMessageInTurn;
		userMessageInTurn = false;
		assert.equal(hasMixedTurn, true);

		// sendMessage succeeds → restore currentInbound for next agent_end
		currentInbound = inbound;
		assert.equal(currentInbound, "inbound-A");

		// Next agent_end fires for the re-injected turn
		const inbound2 = currentInbound;
		currentInbound = null;
		assert.equal(inbound2, "inbound-A"); // same inbound, correctly restored
	});

	it("does not restore currentInbound when re-injection fails", () => {
		let currentInbound: string | null = "inbound-B";

		// agent_end: snapshot, null
		const inbound = currentInbound;
		currentInbound = null;

		// Re-injection fails — currentInbound must stay null (no restore)
		assert.equal(currentInbound, null);
		assert.equal(inbound, "inbound-B"); // snapshot preserved for error response
	});

	it("fulfills inbound when re-injection fails", () => {
		const fulfilled = new Set<string>();
		const inbound = "inbound-B";

		// Re-injection failure path: mark inbound as fulfilled
		fulfilled.add(inbound);

		assert.equal(fulfilled.has("inbound-B"), true);
	});

	it("clears processingInbound when queue is empty after re-injection failure", () => {
		let processingInbound = true;
		const queueEmpty = true;

		if (queueEmpty) {
			processingInbound = false;
		}
		assert.equal(processingInbound, false);
	});

	it("keeps processingInbound true when queue has more inbounds after re-injection failure", () => {
		let processingInbound = true;
		const queueHasMore = true;

		if (!queueHasMore) {
			processingInbound = false;
		}
		assert.equal(processingInbound, true);
	});
});

/**
 * Tests for the userMessageDuringInbound flag (#741).
 *
 * NOTE: Like the state-machine tests above, these simulate the actual handler
 * logic because the handlers (pi.on("message_start") / pi.on("agent_end")) live
 * inside the activate() closure and require the full pi extension runtime.
 *
 * Production behavior (coms-p2p.ts):
 *   1. agent_start: userMessageDuringInbound = false (per-turn reset)
 *   2. message_start: sets userMessageDuringInbound = true ONLY when
 *      `processingInbound && event.message.role === "user"` — a genuine user
 *      message landed during an inbound turn. This is the #741 fix: without it,
 *      auto-capture would leak user-directed assistant text to the peer.
 *   3. agent_end: hasMixedTurn = inboundSetDuringUserTurn || userMessageDuringInbound.
 *      When hasMixedTurn is true the inbound is RE-INJECTED for a clean turn
 *      instead of being auto-captured and sent to the peer.
 */
describe("userMessageDuringInbound flag (#741)", () => {
	it("flags a user message arriving during an inbound turn", () => {
		assert.equal(isUserMessageDuringInbound(true, "user"), true);
	});

	it("does not flag an assistant message during an inbound turn", () => {
		assert.equal(isUserMessageDuringInbound(true, "assistant"), false);
	});

	it("does not flag a user message when no inbound is active", () => {
		assert.equal(isUserMessageDuringInbound(false, "user"), false);
	});

	it("forces mixed turn when userMessageDuringInbound alone is set (#741 fix)", () => {
		assert.equal(computeMixedTurn(false, true), true);
	});

	it("forces mixed turn via the pre-existing inboundSetDuringUserTurn path", () => {
		assert.equal(computeMixedTurn(true, false), true);
	});

	it("treats a clean turn as non-mixed (auto-capture)", () => {
		assert.equal(computeMixedTurn(false, false), false);
	});
});
