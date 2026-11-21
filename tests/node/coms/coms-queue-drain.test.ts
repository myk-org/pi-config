/**
 * Regression tests for COMS inbound FIFO queue followUp starvation (#1226).
 *
 * Covers:
 *   1. turn_end finalization & FIFO drain under active followUp load (agent_end starved)
 *   2. Multi-tool-call inbound turns capture only the final zero-tool-call reply
 *   3. User-interrupted turns unblock coms_send and evaluate hasMixedTurn before comsSendCalledThisTurn
 *   4. Mid-user-turn inbound arrival does not block coms_send, flag userMessageDuringInbound, or force mixed_turn_reinject
 *   5. Abort before delivery re-injects once (bounded), then fails with "aborted" and drains FIFO
 *   6. Abort after delivery defers from turn_end to agent_end safety net
 *   7. cleanShutdown() notifies waiting senders ("session_closed") and resets all inbound state across restart
 *
 * Run with: npx tsx --test tests/node/coms/coms-queue-drain.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import comsP2p from "../../../extensions/coms/coms-p2p.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

interface FakePi {
	tools: Map<string, any>;
	handlers: Map<string, Function>;
	messages: any[];
	start: (event: any, ctx: any) => Promise<void>;
	shutdown: () => Promise<void>;
	ctx: any;
	registryFile: string;
	sessionId: string;
}

const cleanupDirs: string[] = [];
const startedPeers: FakePi[] = [];

afterEach(async () => {
	for (const peer of startedPeers.splice(0)) {
		try { await peer.shutdown(); } catch { /* ignore */ }
	}
	(globalThis as any).__comsSelf = null;
	(globalThis as any).__comsUserSend = null;
	for (const dir of cleanupDirs.splice(0)) {
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
});

async function waitUntil(pred: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await pred()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`waitUntil timed out after ${timeoutMs}ms`);
}

function makeWorkspace() {
	const workspace = makeTempDir("coms-queue-drain-");
	cleanupDirs.push(workspace);
	const comsDir = join(workspace, "coms");
	mkdirSync(join(workspace, ".pi"), { recursive: true });
	writeFileSync(join(workspace, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: comsDir }));
	return { workspace, comsDir };
}

function makeCtx(cwd: string, sessionId: string, branchReply = "") {
	return {
		cwd,
		model: { id: "test-model" },
		hasUI: false,
		ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {} },
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branchReply
				? [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: branchReply }] } }]
				: [],
		},
	};
}

async function startPeer(opts: { name: string; sessionId: string; project: string; cwd: string; comsDir: string }): Promise<FakePi> {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function>();
	const messages: any[] = [];
	const flags = new Map<string, any>([
		["cname", opts.name],
		["project", opts.project],
	]);
	const fakePi: any = {
		tools,
		handlers,
		messages,
		registerFlag: () => {},
		getFlag: (name: string) => flags.get(name),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: (event: string, handler: Function) => handlers.set(event, handler),
		sendMessage: (msg: any) => messages.push(msg),
		events: { on: () => () => {}, emit: () => {} },
	};

	withSubagentChildEnv(undefined, () => {
		comsP2p(fakePi);
		assert.ok(tools.get("coms_send"), "coms_send tool must register");
		assert.ok(handlers.get("turn_end"), "turn_end handler must register");
		assert.ok(handlers.get("message_start"), "message_start handler must register");
		assert.ok(handlers.get("agent_end"), "agent_end handler must register");
	});

	(globalThis as any).__piConfigSessionId = opts.sessionId;
	const ctx = makeCtx(opts.cwd, opts.sessionId);
	const start = async (event: any, startCtx: any) => {
		await handlers.get("session_start")!(event, startCtx);
	};
	const shutdown = async () => {
		await handlers.get("session_shutdown")?.();
	};
	const peer: FakePi = {
		tools,
		handlers,
		messages,
		start,
		shutdown,
		ctx,
		registryFile: "",
		sessionId: opts.sessionId,
	};
	startedPeers.push(peer);
	await start({}, ctx);
	const self = (globalThis as any).__comsSelf;
	assert.ok(self?.sessionId, "peer published coms identity");
	peer.registryFile = join(opts.comsDir, "projects", opts.project, "agents", `${self.sessionId}.json`);
	return peer;
}

function readRegistry(peer: FakePi): { busy?: boolean; queue_depth?: number } {
	return JSON.parse(readFileSync(peer.registryFile, "utf-8"));
}

async function deliverInbound(peer: FakePi, msgId: string): Promise<any> {
	await waitUntil(() => peer.messages.some((m) => m?.details?.msg_id === msgId));
	const msg = [...peer.messages].reverse().find((m) => m?.details?.msg_id === msgId);
	assert.ok(msg, `expected injected inbound ${msgId}`);
	await peer.handlers.get("message_start")!({ message: { role: "custom", ...msg } });
	return msg;
}

async function emitTurnEnd(peer: FakePi, opts: {
	text: string;
	stopReason?: string;
	toolResults?: any[];
	extraBlocks?: any[];
	branchReply?: string;
}): Promise<void> {
	const content: any[] = [{ type: "text", text: opts.text }, ...(opts.extraBlocks ?? [])];
	const message = { role: "assistant", stopReason: opts.stopReason ?? "stop", content };
	await peer.handlers.get("turn_end")!(
		{ type: "turn_end", turnIndex: 0, message, toolResults: opts.toolResults ?? [] },
		makeCtx(peer.ctx.cwd, peer.sessionId, opts.branchReply ?? ""),
	);
}

describe("COMS inbound FIFO queue drain & followUp starvation (#1226)", { concurrency: false }, () => {
	it("drains FIFO at turn_end under active followUp starvation without ever firing agent_end", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peerA = await startPeer({ name: "peer-a", sessionId: "sa-1226", project: "p-1226", cwd: workspace, comsDir });
		const peerB = await startPeer({ name: "peer-b", sessionId: "sb-1226", project: "p-1226", cwd: workspace, comsDir });
		const peerC = await startPeer({ name: "peer-c", sessionId: "sc-1226", project: "p-1226", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "sr-1226", project: "p-1226", cwd: workspace, comsDir });

		const r1 = await peerA.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "first" });
		const r2 = await peerB.tools.get("coms_send").execute("s2", { target: "receiver", prompt: "second" });
		const r3 = await peerC.tools.get("coms_send").execute("s3", { target: "receiver", prompt: "third" });
		const m1 = r1.details.msg_id as string;
		const m2 = r2.details.msg_id as string;
		const m3 = r3.details.msg_id as string;

		// Deliver m1 via message_start; agent_end will NEVER fire in this entire test.
		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		await deliverInbound(receiver, m1);

		// Intermediate tool-call turn must NOT finalize m1 or drain m2.
		await emitTurnEnd(receiver, {
			text: "running tool...",
			stopReason: "toolUse",
			toolResults: [{ role: "toolResult", toolCallId: "tc-1", content: [{ type: "text", text: "ok" }] }],
		});
		const g1Mid = await peerA.tools.get("coms_get").execute("g1-mid", { msg_id: m1 });
		assert.equal(g1Mid.details.status, "pending", "tool-call turn must not prematurely finalize m1");
		assert.equal(receiver.messages.some((m) => m?.details?.msg_id === m2), false, "m2 stays queued during m1 tool loop");

		// Final zero-tool-call turn for m1 -> replies to peer-a and drains m2 at turn_end!
		await emitTurnEnd(receiver, { text: "reply-1", stopReason: "stop", toolResults: [] });
		await waitUntil(async () => (await peerA.tools.get("coms_get").execute("g1-wait", { msg_id: m1 })).details.status === "complete");
		const g1 = await peerA.tools.get("coms_get").execute("g1", { msg_id: m1 });
		assert.equal(g1.details.response, "reply-1");
		assert.ok(receiver.messages.some((m) => m?.details?.msg_id === m2), "m2 drained and injected at turn_end");
		assert.equal(readRegistry(receiver).busy, true);
		assert.equal(readRegistry(receiver).queue_depth, 1, "queue_depth decremented from 2 to 1");

		// Intervening async-agent-result followUp runs BEFORE Pi delivers m2:
		// inboundDelivered is false for m2, so its turn_end must NOT capture for peer-b!
		await receiver.handlers.get("message_start")!({
			message: { role: "custom", customType: "async-agent-result", details: { jobId: "async-42" }, content: "job done" },
		});
		await emitTurnEnd(receiver, { text: "async job acknowledged", stopReason: "stop", toolResults: [] });
		const g2Before = await peerB.tools.get("coms_get").execute("g2-before", { msg_id: m2 });
		assert.equal(g2Before.details.status, "pending", "intervening followUp turn must not misattribute reply to undelivered m2");

		// Now Pi delivers m2 and completes it at turn_end -> replies to peer-b and drains m3.
		await deliverInbound(receiver, m2);
		await emitTurnEnd(receiver, { text: "reply-2", stopReason: "stop", toolResults: [] });
		await waitUntil(async () => (await peerB.tools.get("coms_get").execute("g2-wait", { msg_id: m2 })).details.status === "complete");
		assert.equal((await peerB.tools.get("coms_get").execute("g2", { msg_id: m2 })).details.response, "reply-2");
		assert.ok(receiver.messages.some((m) => m?.details?.msg_id === m3), "m3 drained and injected at turn_end");

		// Now Pi delivers m3 and completes it at turn_end -> replies to peer-c and clears busy.
		await deliverInbound(receiver, m3);
		await emitTurnEnd(receiver, { text: "reply-3", stopReason: "stop", toolResults: [] });
		await waitUntil(async () => (await peerC.tools.get("coms_get").execute("g3-wait", { msg_id: m3 })).details.status === "complete");
		assert.equal((await peerC.tools.get("coms_get").execute("g3", { msg_id: m3 })).details.response, "reply-3");
		assert.equal(readRegistry(receiver).busy, false, "busy cleared at turn_end once FIFO empties");
		assert.equal(readRegistry(receiver).queue_depth, 0);
	});

	it("captures only the final zero-tool-call assistant message text across a multi-tool loop", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const sender = await startPeer({ name: "sender", sessionId: "sm-1226", project: "pm-1226", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "rm-1226", project: "pm-1226", cwd: workspace, comsDir });

		const sent = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "inspect files" });
		const msgId = sent.details.msg_id as string;
		await deliverInbound(receiver, msgId);

		// Turn 1: toolResults non-empty
		await emitTurnEnd(receiver, {
			text: "step 1: reading file",
			stopReason: "toolUse",
			toolResults: [{ role: "toolResult", toolCallId: "t1", content: [] }],
			branchReply: "stale branch text",
		});
		// Turn 2: toolCall content block even if toolResults array is empty
		await emitTurnEnd(receiver, {
			text: "step 2: calling another tool",
			stopReason: "toolUse",
			toolResults: [],
			extraBlocks: [{ type: "toolCall", id: "t2", name: "read", arguments: {} }],
			branchReply: "stale branch text",
		});
		assert.equal((await sender.tools.get("coms_get").execute("g-mid", { msg_id: msgId })).details.status, "pending");

		// Turn 3: final text reply; extract directly from event.message, ignoring stale branch text
		await emitTurnEnd(receiver, {
			text: "final verified answer",
			stopReason: "stop",
			toolResults: [],
			branchReply: "stale branch text from earlier turn",
		});
		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g-wait", { msg_id: msgId })).details.status === "complete");
		assert.equal((await sender.tools.get("coms_get").execute("g-done", { msg_id: msgId })).details.response, "final verified answer");
	});

	it("unblocks coms_send after userMessageDuringInbound and evaluates hasMixedTurn before comsSendCalledThisTurn", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const sender = await startPeer({ name: "sender", sessionId: "su-1226", project: "pu-1226", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "ru-1226", project: "pu-1226", cwd: workspace, comsDir });

		const sent = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "peer question" });
		const msgId = sent.details.msg_id as string;
		await deliverInbound(receiver, msgId);

		// Before user interruption, both coms_send and coms_broadcast back to sender are blocked by auto-capture guard.
		const blocked = await receiver.tools.get("coms_send").execute("blocked-reply", { target: "sender", prompt: "manual" });
		assert.equal(blocked.details.blocked, true);
		const blockedBroadcast = await receiver.tools.get("coms_broadcast").execute("blocked-bcast", { targets: ["sender"], prompt: "manual" });
		assert.equal(blockedBroadcast.details.failed, 1);
		assert.match(String(blockedBroadcast.details.results[0]?.error ?? ""), /blocked: auto-capture/);

		// Real user message interrupts the delivered inbound turn.
		await receiver.handlers.get("message_start")!({ message: { role: "user", content: "hey, ping sender about X" } });

		// Now coms_send to sender MUST be allowed (auto-capture will discard this interrupted turn).
		const allowed = await receiver.tools.get("coms_send").execute("allowed-send", { target: "sender", prompt: "about X" });
		assert.equal(Boolean(allowed.details.blocked), false, "coms_send must unblock once userMessageDuringInbound is true");
		assert.ok(allowed.details.msg_id, "coms_send delivered normally");

		// turn_end fires: even though comsSendCalledThisTurn now contains sender,
		// hasMixedTurn MUST run first and re-inject msgId instead of silently dropping it.
		await emitTurnEnd(receiver, { text: "sure, I messaged sender about X", stopReason: "stop", toolResults: [] });
		const mid = await sender.tools.get("coms_get").execute("g-mid", { msg_id: msgId });
		assert.equal(mid.details.status, "pending", "interrupted turn must not silently drop or leak reply");
		assert.ok(
			receiver.messages.some((m) => m?.details?.msg_id === msgId && String(m.content).includes("re-injection")),
			"receiver re-injected inbound after mixed turn despite coms_send during interrupted turn",
		);

		// Clean dedicated retry turn completes normally.
		await deliverInbound(receiver, msgId);
		await emitTurnEnd(receiver, { text: "dedicated reply to peer question", stopReason: "stop", toolResults: [] });
		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g-wait", { msg_id: msgId })).details.status === "complete");
		assert.equal((await sender.tools.get("coms_get").execute("g-done", { msg_id: msgId })).details.response, "dedicated reply to peer question");
	});

	it("handles mid-user-turn inbound arrival without premature block, spurious user interrupt, or false mixed_turn_reinject", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const sender = await startPeer({ name: "sender", sessionId: "smu-1226", project: "pmu-1226", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "rmu-1226", project: "pmu-1226", cwd: workspace, comsDir });

		// User starts a turn first -> agentRunningUserTurn = true.
		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		await receiver.handlers.get("message_start")!({ message: { role: "user", content: "user task" } });

		// Inbound arrives while user turn is active (queued as Pi followUp, NOT yet delivered).
		const sent = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "when free, report status" });
		const msgId = sent.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === msgId));

		// Before delivery: coms_send to sender is NOT blocked, and another user message does NOT flag userMessageDuringInbound.
		const midTurnSend = await receiver.tools.get("coms_send").execute("mid-send", { target: "sender", prompt: "unrelated ping" });
		assert.equal(Boolean(midTurnSend.details.blocked), false, "coms_send must not block before inbound is delivered");
		await receiver.handlers.get("message_start")!({ message: { role: "user", content: "user follow-up" } });

		// User's turn finishes at turn_end: inbound is undelivered, so it is NOT captured and NOT re-injected.
		await emitTurnEnd(receiver, { text: "answer for the user", stopReason: "stop", toolResults: [] });
		assert.equal((await sender.tools.get("coms_get").execute("g-after-user", { msg_id: msgId })).details.status, "pending");
		assert.equal(
			receiver.messages.filter((m) => m?.details?.msg_id === msgId).length,
			1,
			"inbound must not be spuriously re-injected before delivery",
		);

		// Pi now pulls the followUp inbound into context (message_start clears inboundSetDuringUserTurn & comsSendCalledThisTurn).
		await deliverInbound(receiver, msgId);
		const nowBlocked = await receiver.tools.get("coms_send").execute("now-blocked", { target: "sender", prompt: "dup" });
		assert.equal(nowBlocked.details.blocked, true, "coms_send blocks once inbound is actually delivered");

		// Peer turn completes cleanly on the FIRST try with zero re-injections.
		await emitTurnEnd(receiver, { text: "status is green", stopReason: "stop", toolResults: [] });
		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g-wait", { msg_id: msgId })).details.status === "complete");
		assert.equal((await sender.tools.get("coms_get").execute("g-done", { msg_id: msgId })).details.response, "status is green");
		assert.equal(
			receiver.messages.filter((m) => m?.details?.msg_id === msgId).length,
			1,
			"no mixed_turn_reinject occurred",
		);
	});

	it("re-injects once on abort before delivery, then fails with aborted and drains FIFO at agent_end", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peerA = await startPeer({ name: "peer-a", sessionId: "sab-a", project: "pab-1226", cwd: workspace, comsDir });
		const peerB = await startPeer({ name: "peer-b", sessionId: "sab-b", project: "pab-1226", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "rab-1226", project: "pab-1226", cwd: workspace, comsDir });

		// User turn active when m1 arrives; m2 queues behind m1.
		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		const r1 = await peerA.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "prompt A" });
		const r2 = await peerB.tools.get("coms_send").execute("s2", { target: "receiver", prompt: "prompt B" });
		const m1 = r1.details.msg_id as string;
		const m2 = r2.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m1));

		// Run aborts BEFORE m1 is ever delivered via message_start.
		await emitTurnEnd(receiver, { text: "partial user text", stopReason: "aborted", toolResults: [] });
		await receiver.handlers.get("agent_end")!({}, makeCtx(workspace, "rab-1226", "partial user text"));

		// First undelivered abort -> re-injects m1 once (does NOT leak "partial user text").
		assert.equal((await peerA.tools.get("coms_get").execute("g1-retry", { msg_id: m1 })).details.status, "pending");
		assert.equal(receiver.messages.filter((m) => m?.details?.msg_id === m1).length, 2, "m1 re-injected once after abort before delivery");

		// Second abort before delivery -> exhausts bound, sends error: "aborted" to peer-a, drains m2!
		await receiver.handlers.get("agent_end")!({}, makeCtx(workspace, "rab-1226", "still aborted"));
		await waitUntil(async () => (await peerA.tools.get("coms_get").execute("g1-wait", { msg_id: m1 })).details.status === "complete");
		const g1 = await peerA.tools.get("coms_get").execute("g1-done", { msg_id: m1 });
		assert.equal(g1.details.error, "aborted");
		assert.equal(g1.details.response, null);

		// m2 drained cleanly and completes.
		await deliverInbound(receiver, m2);
		await emitTurnEnd(receiver, { text: "reply B after A aborted", stopReason: "stop", toolResults: [] });
		await waitUntil(async () => (await peerB.tools.get("coms_get").execute("g2-wait", { msg_id: m2 })).details.status === "complete");
		assert.equal((await peerB.tools.get("coms_get").execute("g2-done", { msg_id: m2 })).details.response, "reply B after A aborted");
		assert.equal(readRegistry(receiver).busy, false, "busy is not stranded true at idle");
	});

	it("defers aborted delivered turns from turn_end to agent_end safety net", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const sender = await startPeer({ name: "sender", sessionId: "sad-s", project: "pad-1226", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "sad-r", project: "pad-1226", cwd: workspace, comsDir });

		const sent = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "work" });
		const msgId = sent.details.msg_id as string;
		await deliverInbound(receiver, msgId);

		// turn_end with stopReason: "aborted" defers to agent_end.
		await emitTurnEnd(receiver, { text: "partial", stopReason: "aborted", toolResults: [] });
		assert.equal((await sender.tools.get("coms_get").execute("g-before", { msg_id: msgId })).details.status, "pending");

		await receiver.handlers.get("agent_end")!({}, makeCtx(workspace, "sad-r", "partial"));
		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g-wait", { msg_id: msgId })).details.status === "complete");
		assert.equal((await sender.tools.get("coms_get").execute("g-done", { msg_id: msgId })).details.response, "partial");
		assert.equal(readRegistry(receiver).busy, false);
	});

	it("resets all in-memory inbound queue state and notifies waiting senders (session_closed) in cleanShutdown()", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peerA = await startPeer({ name: "peer-a", sessionId: "ssh-a", project: "psh-1226", cwd: workspace, comsDir });
		const peerB = await startPeer({ name: "peer-b", sessionId: "ssh-b", project: "psh-1226", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "ssh-r", project: "psh-1226", cwd: workspace, comsDir });

		// Populate active + queued inbound state and dirty turn flags.
		const r1 = await peerA.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "active before stop" });
		const r2 = await peerB.tools.get("coms_send").execute("s2", { target: "receiver", prompt: "queued before stop" });
		const m1 = r1.details.msg_id as string;
		const m2 = r2.details.msg_id as string;
		await deliverInbound(receiver, m1);
		await receiver.handlers.get("message_start")!({ message: { role: "user", content: "interrupt" } });
		assert.equal(readRegistry(receiver).busy, true);
		assert.equal(readRegistry(receiver).queue_depth, 1);

		// Shut down receiver (simulating /coms stop): both waiting senders get error: "session_closed".
		await receiver.shutdown();
		await waitUntil(async () => {
			const g1 = await peerA.tools.get("coms_get").execute("g1", { msg_id: m1 });
			const g2 = await peerB.tools.get("coms_get").execute("g2", { msg_id: m2 });
			return g1.details.status === "complete" && g2.details.status === "complete";
		});
		assert.equal((await peerA.tools.get("coms_get").execute("g1-check", { msg_id: m1 })).details.error, "session_closed");
		assert.equal((await peerB.tools.get("coms_get").execute("g2-check", { msg_id: m2 })).details.error, "session_closed");

		// Restart the SAME closure (simulating /coms stop -> /coms start): state must be clean.
		await receiver.start({}, receiver.ctx);
		const restartedSelf = (globalThis as any).__comsSelf;
		assert.ok(restartedSelf?.sessionId, "restarted peer published coms identity");
		receiver.registryFile = join(comsDir, "projects", "psh-1226", "agents", `${restartedSelf.sessionId}.json`);
		assert.equal(Boolean(readRegistry(receiver).busy), false, "busy must be false after restart");
		assert.equal(readRegistry(receiver).queue_depth ?? 0, 0, "queue_depth must be 0 after restart");

		// New prompt injects immediately and completes cleanly (no stale mixed-turn or busy wedge).
		const r3 = await peerA.tools.get("coms_send").execute("s3", { target: "receiver", prompt: "after restart" });
		const m3 = r3.details.msg_id as string;
		await deliverInbound(receiver, m3);
		assert.equal(readRegistry(receiver).busy, true);
		assert.equal(readRegistry(receiver).queue_depth, 0);
		await emitTurnEnd(receiver, { text: "fresh after restart", stopReason: "stop", toolResults: [] });
		await waitUntil(async () => (await peerA.tools.get("coms_get").execute("g3-wait", { msg_id: m3 })).details.status === "complete");
		assert.equal((await peerA.tools.get("coms_get").execute("g3-done", { msg_id: m3 })).details.response, "fresh after restart");
		assert.equal(readRegistry(receiver).busy, false);
		assert.equal(readRegistry(receiver).queue_depth, 0);
	});
});
