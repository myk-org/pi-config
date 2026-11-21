/**
 * Regression tests for COMS inbound FIFO queue drain & followUp starvation (#1226).
 *
 * Covers:
 *   - turn_end finalization & FIFO drain under active followUp load (agent_end starved)
 *   - Multi-tool-call inbound turns capture only the final zero-tool-call reply
 *   - User-interrupted turns: coms_send unblock + hasMixedTurn precedence over comsSendCalledThisTurn
 *   - Mid-user-turn inbound arrival: no premature block, spurious interrupt, or mixed_turn_reinject
 *   - Abort before delivery: Pi-queued followUp retained (no double-inject / premature aborted);
 *     genuinely lost direct-run retries once, then replies aborted and drains FIFO
 *   - Abort after delivery defers from turn_end to agent_end safety net
 *   - Mid-turn followUp steer defers turn_end finalization until post-steer reply
 *   - Bundled senders receive "bundled" response envelopes in sentDirectlyToSender path
 *   - cleanShutdown(): session_closed notifications, restart state reset, in-flight finalizer ownership,
 *     and generation guard preventing stale pre-shutdown continuations from mutating a restarted session
 *
 * Run with: npx tsx --test tests/node/coms/coms-queue-drain.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
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
	onSendMessage?: (msg: any, opts?: any) => void;
}

interface HoldableSender {
	endpoint: string;
	received: any[];
	sendPrompt: (receiverEndpoint: string, msgId: string, prompt: string) => Promise<any>;
	releaseAll: () => void;
}

const cleanupDirs: string[] = [];
const startedPeers: FakePi[] = [];
const activeServers: net.Server[] = [];
const activeSockets: net.Socket[] = [];

afterEach(async () => {
	for (const sock of activeSockets.splice(0)) {
		try { sock.destroy(); } catch { /* ignore */ }
	}
	for (const srv of activeServers.splice(0)) {
		try { srv.close(); } catch { /* ignore */ }
	}
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

function makeCtx(cwd: string, sessionId: string, branchReply = "", extra: { isIdle?: () => boolean; abort?: () => void } = {}) {
	return {
		cwd,
		model: { id: "test-model" },
		hasUI: false,
		ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {} },
		...(extra.isIdle ? { isIdle: extra.isIdle } : {}),
		...(extra.abort ? { abort: extra.abort } : {}),
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branchReply
				? [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: branchReply }] } }]
				: [],
		},
	};
}

async function startPeer(opts: {
	name: string;
	sessionId: string;
	project: string;
	cwd: string;
	comsDir: string;
	isIdle?: () => boolean;
	abort?: () => void;
}): Promise<FakePi> {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function>();
	const messages: any[] = [];
	const flags = new Map<string, any>([
		["cname", opts.name],
		["project", opts.project],
	]);
	const peer: FakePi = {
		tools,
		handlers,
		messages,
		start: async () => {},
		shutdown: async () => {},
		ctx: null,
		registryFile: "",
		sessionId: opts.sessionId,
	};
	const fakePi: any = {
		tools,
		handlers,
		messages,
		registerFlag: () => {},
		getFlag: (name: string) => flags.get(name),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: (event: string, handler: Function) => handlers.set(event, handler),
		sendMessage: (msg: any, sendOpts?: any) => {
			messages.push(msg);
			peer.onSendMessage?.(msg, sendOpts);
		},
		events: { on: () => () => {}, emit: () => {} },
	};

	withSubagentChildEnv(undefined, () => {
		comsP2p(fakePi);
		assert.ok(tools.get("coms_send"), "coms_send tool must register");
		assert.ok(handlers.get("turn_end"), "turn_end handler must register");
		assert.ok(handlers.get("message_start"), "message_start handler must register");
		assert.ok(handlers.get("context"), "context handler must register");
		assert.ok(handlers.get("agent_end"), "agent_end handler must register");
	});

	(globalThis as any).__piConfigSessionId = opts.sessionId;
	peer.ctx = makeCtx(opts.cwd, opts.sessionId, "", { isIdle: opts.isIdle, abort: opts.abort });
	peer.start = async (event: any, startCtx: any) => {
		await handlers.get("session_start")!(event, startCtx);
	};
	peer.shutdown = async () => {
		await handlers.get("session_shutdown")?.();
	};
	startedPeers.push(peer);
	await peer.start({}, peer.ctx);
	const self = (globalThis as any).__comsSelf;
	assert.ok(self?.sessionId, "peer published coms identity");
	peer.registryFile = join(opts.comsDir, "projects", opts.project, "agents", `${self.sessionId}.json`);
	return peer;
}

function readRegistry(peer: FakePi): { busy?: boolean; queue_depth?: number; endpoint?: string } {
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

async function createHoldableSenderServer(endpoint: string, opts: { holdMsgId?: string; senderSession: string; senderName: string; cwd: string }): Promise<HoldableSender> {
	const received: any[] = [];
	const heldAcks: Array<() => void> = [];
	const srv = net.createServer((sock) => {
		activeSockets.push(sock);
		let buf = "";
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf-8");
			const nl = buf.indexOf("\n");
			if (nl === -1) return;
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			const env = JSON.parse(line);
			received.push(env);
			const ack = () => {
				try {
					sock.write(JSON.stringify({ type: "ack", msg_id: env.msg_id ?? "" }) + "\n");
				} catch { /* ignore */ }
			};
			if (opts.holdMsgId && env.type === "response" && env.msg_id === opts.holdMsgId && env.error !== "session_closed") {
				heldAcks.push(ack);
			} else {
				ack();
			}
		});
	});
	activeServers.push(srv);
	await new Promise<void>((resolve, reject) => {
		srv.once("error", reject);
		srv.listen(endpoint, () => resolve());
	});

	const sendPrompt = (receiverEndpoint: string, msgId: string, prompt: string) =>
		new Promise<any>((resolve, reject) => {
			const sock = net.createConnection({ path: receiverEndpoint });
			activeSockets.push(sock);
			let buf = "";
			sock.once("error", reject);
			sock.once("connect", () => {
				sock.write(JSON.stringify({
					type: "prompt",
					msg_id: msgId,
					sender_session: opts.senderSession,
					sender_endpoint: endpoint,
					sender_name: opts.senderName,
					sender_cwd: opts.cwd,
					hops: 0,
					timestamp: new Date().toISOString(),
					prompt,
				}) + "\n");
			});
			sock.on("data", (chunk) => {
				buf += chunk.toString("utf-8");
				const nl = buf.indexOf("\n");
				if (nl === -1) return;
				const parsed = JSON.parse(buf.slice(0, nl));
				try { sock.destroy(); } catch { /* ignore */ }
				resolve(parsed);
			});
		});

	return {
		endpoint,
		received,
		sendPrompt,
		releaseAll: () => {
			for (const ack of heldAcks.splice(0)) ack();
		},
	};
}

async function setupInterruptedTurn(project: string) {
	const { workspace, comsDir } = makeWorkspace();
	const sender = await startPeer({ name: "sender", sessionId: `su-${project}`, project, cwd: workspace, comsDir });
	const receiver = await startPeer({ name: "receiver", sessionId: `ru-${project}`, project, cwd: workspace, comsDir });
	const sent = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "peer question" });
	const msgId = sent.details.msg_id as string;
	await deliverInbound(receiver, msgId);
	return { sender, receiver, msgId };
}

async function setupShutdownWork(project: string) {
	const { workspace, comsDir } = makeWorkspace();
	const peerA = await startPeer({ name: "peer-a", sessionId: `sha-${project}`, project, cwd: workspace, comsDir });
	const peerB = await startPeer({ name: "peer-b", sessionId: `shb-${project}`, project, cwd: workspace, comsDir });
	const receiver = await startPeer({ name: "receiver", sessionId: `shr-${project}`, project, cwd: workspace, comsDir });

	const r1 = await peerA.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "active before stop" });
	const r2 = await peerB.tools.get("coms_send").execute("s2", { target: "receiver", prompt: "queued before stop" });
	const m1 = r1.details.msg_id as string;
	const m2 = r2.details.msg_id as string;
	await deliverInbound(receiver, m1);
	await receiver.handlers.get("message_start")!({ message: { role: "user", content: "interrupt" } });
	assert.equal(readRegistry(receiver).busy, true);
	assert.equal(readRegistry(receiver).queue_depth, 1);
	return { comsDir, peerA, peerB, receiver, m1, m2 };
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

	it("unblocks coms_send after a user message interrupts a delivered inbound turn", async () => {
		const { receiver } = await setupInterruptedTurn("pu-unblock");

		const blocked = await receiver.tools.get("coms_send").execute("blocked-reply", { target: "sender", prompt: "manual" });
		assert.equal(blocked.details.blocked, true);
		const blockedBroadcast = await receiver.tools.get("coms_broadcast").execute("blocked-bcast", { targets: ["sender"], prompt: "manual" });
		assert.equal(blockedBroadcast.details.failed, 1);
		assert.match(String(blockedBroadcast.details.results[0]?.error ?? ""), /blocked: auto-capture/);

		await receiver.handlers.get("message_start")!({ message: { role: "user", content: "hey, ping sender about X" } });

		const allowed = await receiver.tools.get("coms_send").execute("allowed-send", { target: "sender", prompt: "about X" });
		assert.equal(Boolean(allowed.details.blocked), false, "coms_send must unblock once userMessageDuringInbound is true");
		assert.ok(allowed.details.msg_id, "coms_send delivered normally");
	});

	it("evaluates hasMixedTurn before comsSendCalledThisTurn on an interrupted turn", async () => {
		const { sender, receiver, msgId } = await setupInterruptedTurn("pu-precedence");

		await receiver.handlers.get("message_start")!({ message: { role: "user", content: "hey, ping sender about X" } });
		const allowed = await receiver.tools.get("coms_send").execute("allowed-send", { target: "sender", prompt: "about X" });
		assert.ok(allowed.details.msg_id);

		// Even though comsSendCalledThisTurn now contains sender, hasMixedTurn runs first and re-injects msgId.
		await emitTurnEnd(receiver, { text: "sure, I messaged sender about X", stopReason: "stop", toolResults: [] });
		const mid = await sender.tools.get("coms_get").execute("g-mid", { msg_id: msgId });
		assert.equal(mid.details.status, "pending", "interrupted turn must not silently drop or leak reply");
		assert.ok(
			receiver.messages.some((m) => m?.details?.msg_id === msgId && String(m.content).includes("re-injection")),
			"receiver re-injected inbound after mixed turn despite coms_send during interrupted turn",
		);

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

	it("retains Pi-queued followUp on abort before delivery without duplicate injection or premature aborted reply", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peerA = await startPeer({ name: "peer-a", sessionId: "sfq-a", project: "pfq-1226", cwd: workspace, comsDir });
		const peerB = await startPeer({ name: "peer-b", sessionId: "sfq-b", project: "pfq-1226", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "rfq-1226", project: "pfq-1226", cwd: workspace, comsDir });

		// Active user turn means Pi queues m1 in its followUp queue (retained across aborts).
		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		const r1 = await peerA.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "prompt A" });
		const r2 = await peerB.tools.get("coms_send").execute("s2", { target: "receiver", prompt: "prompt B" });
		const m1 = r1.details.msg_id as string;
		const m2 = r2.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m1));

		// User turn aborts twice before Pi delivers the queued follow-up m1.
		await emitTurnEnd(receiver, { text: "partial user text", stopReason: "aborted", toolResults: [] });
		await receiver.handlers.get("agent_end")!({}, makeCtx(workspace, "rfq-1226", "partial user text"));
		await receiver.handlers.get("agent_end")!({}, makeCtx(workspace, "rfq-1226", "second abort"));

		assert.equal(
			receiver.messages.filter((m) => m?.details?.msg_id === m1).length,
			1,
			"must not enqueue a duplicate follow-up copy while Pi still holds m1",
		);
		assert.equal(
			(await peerA.tools.get("coms_get").execute("g1-still-pending", { msg_id: m1 })).details.status,
			"pending",
			"must not reply aborted while Pi still holds a deliverable follow-up copy of m1",
		);

		// Next run delivers the single retained copy of m1, completes cleanly, and drains m2.
		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		await deliverInbound(receiver, m1);
		await emitTurnEnd(receiver, { text: "single reply A", stopReason: "stop", toolResults: [] });
		await waitUntil(async () => (await peerA.tools.get("coms_get").execute("g1-wait", { msg_id: m1 })).details.status === "complete");
		assert.equal((await peerA.tools.get("coms_get").execute("g1-done", { msg_id: m1 })).details.response, "single reply A");

		await deliverInbound(receiver, m2);
		await emitTurnEnd(receiver, { text: "reply B", stopReason: "stop", toolResults: [] });
		await waitUntil(async () => (await peerB.tools.get("coms_get").execute("g2-wait", { msg_id: m2 })).details.status === "complete");
		assert.equal((await peerB.tools.get("coms_get").execute("g2-done", { msg_id: m2 })).details.response, "reply B");
		assert.equal(readRegistry(receiver).busy, false);
	});

	it("re-injects once when an idle direct-run inbound aborts before delivery", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peerA = await startPeer({ name: "peer-a", sessionId: "sdr-a", project: "pdr-1226", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "rdr-1226", project: "pdr-1226", cwd: workspace, comsDir });

		// Receiver is idle when m1 arrives -> direct run (not queued as followUp).
		const r1 = await peerA.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "prompt A" });
		const m1 = r1.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m1));

		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		await emitTurnEnd(receiver, { text: "partial text", stopReason: "aborted", toolResults: [] });
		await receiver.handlers.get("agent_end")!({}, makeCtx(workspace, "rdr-1226", "partial text"));

		assert.equal((await peerA.tools.get("coms_get").execute("g1-retry", { msg_id: m1 })).details.status, "pending");
		assert.equal(receiver.messages.filter((m) => m?.details?.msg_id === m1).length, 2, "genuinely lost direct-run inbound re-injected once");
	});

	it("replies aborted on direct-run retry exhaustion to drain the remaining FIFO queue", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peerA = await startPeer({ name: "peer-a", sessionId: "sde-a", project: "pde-1226", cwd: workspace, comsDir });
		const peerB = await startPeer({ name: "peer-b", sessionId: "sde-b", project: "pde-1226", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "rde-1226", project: "pde-1226", cwd: workspace, comsDir });

		// Receiver is idle -> m1 starts as a direct run; m2 queues behind m1.
		const r1 = await peerA.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "prompt A" });
		const r2 = await peerB.tools.get("coms_send").execute("s2", { target: "receiver", prompt: "prompt B" });
		const m1 = r1.details.msg_id as string;
		const m2 = r2.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m1));

		// First direct-run abort retries once; second direct-run abort exhausts retry bound.
		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		await receiver.handlers.get("agent_end")!({}, makeCtx(workspace, "rde-1226", "aborted 1"));
		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		await receiver.handlers.get("agent_end")!({}, makeCtx(workspace, "rde-1226", "aborted 2"));

		await waitUntil(async () => (await peerA.tools.get("coms_get").execute("g1-wait", { msg_id: m1 })).details.status === "complete");
		const g1 = await peerA.tools.get("coms_get").execute("g1-done", { msg_id: m1 });
		assert.equal(g1.details.error, "aborted");
		assert.equal(g1.details.response, null);

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

	it("defers turn_end finalization while a mid-turn followUp steer is pending so post-steer text reaches the reply", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const sender = await startPeer({ name: "sender", sessionId: "sst-s", project: "pst-1226", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "sst-r", project: "pst-1226", cwd: workspace, comsDir });

		const sent = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "compute value" });
		const msgId = sent.details.msg_id as string;
		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		await deliverInbound(receiver, msgId);

		// Mid-turn steer arrives as followUp targeting msgId.
		const steerRes = await sender.tools.get("coms_send").execute("st1", {
			target: "receiver",
			prompt: "use 42 instead",
			steer: true,
		});
		const steerId = steerRes.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.steer === true && m?.details?.msg_id === steerId));
		const steerMsg = receiver.messages.find((m) => m?.details?.steer === true && m?.details?.msg_id === steerId);
		assert.equal(steerMsg.details.target_msg_id, msgId);

		// Pre-steer zero-tool-call turn_end must NOT finalize m1 before the steer is delivered.
		await emitTurnEnd(receiver, { text: "pre-steer draft: 7", stopReason: "stop", toolResults: [] });
		assert.equal(
			(await sender.tools.get("coms_get").execute("g-pre-steer", { msg_id: msgId })).details.status,
			"pending",
			"turn_end must wait for pending followUp steer delivery",
		);

		// Pi delivers the steer via message_start, then the model produces the post-steer reply.
		await receiver.handlers.get("message_start")!({ message: { role: "custom", ...steerMsg } });
		await emitTurnEnd(receiver, { text: "post-steer answer: 42", stopReason: "stop", toolResults: [] });

		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g-wait", { msg_id: msgId })).details.status === "complete");
		assert.equal((await sender.tools.get("coms_get").execute("g-done", { msg_id: msgId })).details.response, "post-steer answer: 42");
		assert.equal(readRegistry(receiver).busy, false);
	});

	it("sends bundled response envelopes to secondary inbounds when coms_send skips auto-capture", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peerA = await startPeer({ name: "peer-a", sessionId: "sbn-a", project: "pbn-1226", cwd: workspace, comsDir });
		const peerB = await startPeer({ name: "peer-b", sessionId: "sbn-b", project: "pbn-1226", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "rbn-1226", project: "pbn-1226", cwd: workspace, comsDir });

		// Occupy receiver with m0 so peer-b's two messages queue up and bundle on drain.
		const r0 = await peerA.tools.get("coms_send").execute("s0", { target: "receiver", prompt: "blocking work" });
		const m0 = r0.details.msg_id as string;
		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		await deliverInbound(receiver, m0);

		const rb1 = await peerB.tools.get("coms_send").execute("sb1", { target: "receiver", prompt: "part 1" });
		const rb2 = await peerB.tools.get("coms_send").execute("sb2", { target: "receiver", prompt: "part 2" });
		const b1 = rb1.details.msg_id as string;
		const b2 = rb2.details.msg_id as string;

		// Finishing m0 drains [b1, b2] as a bundle (b1 primary, b2 in bundledInbounds).
		await emitTurnEnd(receiver, { text: "done m0", stopReason: "stop", toolResults: [] });
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === b1));
		const b1Msg = [...receiver.messages].reverse().find((m) => m?.details?.msg_id === b1);
		assert.deepEqual(b1Msg.details.bundled_msg_ids, [b1, b2]);

		// Simulate a coms_send to peer-b that passed isAutoCaptureReplyBlocked before delivery,
		// then settled right after b1 emitted message_start so comsSendCalledThisTurn contains peer-b.
		let deliveredDuringSend = false;
		peerB.onSendMessage = () => {
			if (deliveredDuringSend) return;
			deliveredDuringSend = true;
			receiver.handlers.get("message_start")!({ message: { role: "custom", ...b1Msg } });
		};
		const directRes = await receiver.tools.get("coms_send").execute("direct-b", { target: "peer-b", prompt: "direct reply" });
		assert.ok(directRes.details.msg_id, "direct coms_send succeeded");
		assert.equal(deliveredDuringSend, true);

		// Finalizing b1 enters the sentDirectlyToSender branch; b2 must receive error: "bundled".
		await emitTurnEnd(receiver, { text: "sent directly", stopReason: "stop", toolResults: [] });
		await waitUntil(async () => (await peerB.tools.get("coms_get").execute("gb2-wait", { msg_id: b2 })).details.status === "complete");
		const gb2 = await peerB.tools.get("coms_get").execute("gb2-done", { msg_id: b2 });
		assert.equal(gb2.details.error, "bundled");
		assert.equal(gb2.details.response, null);
		assert.equal(readRegistry(receiver).busy, false);
	});

	it("notifies waiting senders with session_closed during cleanShutdown()", async () => {
		const { peerA, peerB, receiver, m1, m2 } = await setupShutdownWork("psh-notify");

		await receiver.shutdown();
		await waitUntil(async () => {
			const g1 = await peerA.tools.get("coms_get").execute("g1", { msg_id: m1 });
			const g2 = await peerB.tools.get("coms_get").execute("g2", { msg_id: m2 });
			return g1.details.status === "complete" && g2.details.status === "complete";
		});
		assert.equal((await peerA.tools.get("coms_get").execute("g1-check", { msg_id: m1 })).details.error, "session_closed");
		assert.equal((await peerB.tools.get("coms_get").execute("g2-check", { msg_id: m2 })).details.error, "session_closed");
	});

	it("resets in-memory inbound queue state across cleanShutdown() restart", async () => {
		const { comsDir, peerA, receiver } = await setupShutdownWork("psh-reset");

		await receiver.shutdown();

		// Restart the SAME closure (simulating /coms stop -> /coms start): state must be clean.
		await receiver.start({}, receiver.ctx);
		const restartedSelf = (globalThis as any).__comsSelf;
		assert.ok(restartedSelf?.sessionId, "restarted peer published coms identity");
		receiver.registryFile = join(comsDir, "projects", "psh-reset", "agents", `${restartedSelf.sessionId}.json`);
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

	it("omits conflicting session_closed for an inbound whose response send is already in flight during cleanShutdown()", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peerB = await startPeer({ name: "peer-b", sessionId: "sif-b", project: "pif-1226", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "rif-1226", project: "pif-1226", cwd: workspace, comsDir });
		const receiverEndpoint = readRegistry(receiver).endpoint!;

		const senderSock = join(workspace, "hold-sender-a.sock");
		const senderA = await createHoldableSenderServer(senderSock, {
			holdMsgId: "msg-inflight-1",
			senderSession: "fake-sender-a",
			senderName: "fake-a",
			cwd: workspace,
		});

		await senderA.sendPrompt(receiverEndpoint, "msg-inflight-1", "first work");
		const r2 = await peerB.tools.get("coms_send").execute("s2", { target: "receiver", prompt: "queued behind" });
		const m2 = r2.details.msg_id as string;
		await deliverInbound(receiver, "msg-inflight-1");

		// Start finalizing msg-inflight-1; senderA holds the ACK so finalizeCurrentInbound suspends in sendEnvelope.
		const finalizePromise = emitTurnEnd(receiver, { text: "normal reply", stopReason: "stop", toolResults: [] });
		await waitUntil(() => senderA.received.some((e) => e.type === "response" && e.msg_id === "msg-inflight-1"));

		// Shut down while normal response is in flight: m2 gets session_closed, msg-inflight-1 does NOT.
		await receiver.shutdown();
		await waitUntil(async () => (await peerB.tools.get("coms_get").execute("g2-wait", { msg_id: m2 })).details.status === "complete");
		assert.equal((await peerB.tools.get("coms_get").execute("g2-done", { msg_id: m2 })).details.error, "session_closed");

		senderA.releaseAll();
		await finalizePromise;

		const repliesForM1 = senderA.received.filter((e) => e.type === "response" && e.msg_id === "msg-inflight-1");
		assert.equal(repliesForM1.length, 1, "must not send a conflicting session_closed envelope for an in-flight finalization");
		assert.equal(repliesForM1[0].response, "normal reply");
		assert.equal(repliesForM1[0].error, null);
	});

	it("ignores stale pre-shutdown finalization completions after restart so new session state stays untouched", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peerB = await startPeer({ name: "peer-b", sessionId: "sgen-b", project: "pgen-1226", cwd: workspace, comsDir });
		const peerC = await startPeer({ name: "peer-c", sessionId: "sgen-c", project: "pgen-1226", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "rgen-1226", project: "pgen-1226", cwd: workspace, comsDir });
		const receiverEndpoint = readRegistry(receiver).endpoint!;

		const senderSock = join(workspace, "hold-sender-gen.sock");
		const senderA = await createHoldableSenderServer(senderSock, {
			holdMsgId: "msg-old-1",
			senderSession: "fake-sender-gen",
			senderName: "fake-gen",
			cwd: workspace,
		});

		await senderA.sendPrompt(receiverEndpoint, "msg-old-1", "old session work");
		await deliverInbound(receiver, "msg-old-1");

		// Suspend old session's finalizeCurrentInbound inside sendEnvelope.
		const oldFinalizePromise = emitTurnEnd(receiver, { text: "old reply", stopReason: "stop", toolResults: [] });
		await waitUntil(() => senderA.received.some((e) => e.type === "response" && e.msg_id === "msg-old-1"));

		// Shut down AND restart receiver BEFORE old sendEnvelope resolves.
		await receiver.shutdown();
		await receiver.start({}, receiver.ctx);
		const restartedSelf = (globalThis as any).__comsSelf;
		receiver.registryFile = join(comsDir, "projects", "pgen-1226", "agents", `${restartedSelf.sessionId}.json`);

		// Queue fresh work in the restarted session: n1 active (undelivered), n2 queued behind it.
		const rn1 = await peerB.tools.get("coms_send").execute("sn1", { target: "receiver", prompt: "new work 1" });
		const rn2 = await peerC.tools.get("coms_send").execute("sn2", { target: "receiver", prompt: "new work 2" });
		const n1 = rn1.details.msg_id as string;
		const n2 = rn2.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === n1));

		// Release the old session's sendEnvelope now; its stale continuation MUST exit without draining n2 or altering state.
		senderA.releaseAll();
		await oldFinalizePromise;

		assert.equal(receiver.messages.some((m) => m?.details?.msg_id === n2), false, "stale finalizer must not drain n2 in restarted session");
		assert.equal(readRegistry(receiver).busy, true);
		assert.equal(readRegistry(receiver).queue_depth, 1);

		// Restarted session processes n1 then n2 cleanly.
		await deliverInbound(receiver, n1);
		await emitTurnEnd(receiver, { text: "new reply 1", stopReason: "stop", toolResults: [] });
		await waitUntil(async () => (await peerB.tools.get("coms_get").execute("gn1-wait", { msg_id: n1 })).details.status === "complete");
		assert.equal((await peerB.tools.get("coms_get").execute("gn1-done", { msg_id: n1 })).details.response, "new reply 1");

		await deliverInbound(receiver, n2);
		await emitTurnEnd(receiver, { text: "new reply 2", stopReason: "stop", toolResults: [] });
		await waitUntil(async () => (await peerC.tools.get("coms_get").execute("gn2-wait", { msg_id: n2 })).details.status === "complete");
		assert.equal((await peerC.tools.get("coms_get").execute("gn2-done", { msg_id: n2 })).details.response, "new reply 2");
		assert.equal(readRegistry(receiver).busy, false);
		assert.equal(readRegistry(receiver).queue_depth, 0);
	});

	it("suppresses a closed queued follow-up after cleanShutdown() so the model never runs it", async () => {
		const { workspace, comsDir } = makeWorkspace();
		let abortCalls = 0;
		const peerA = await startPeer({ name: "peer-a", sessionId: "scl-a", project: "pcl-1226", cwd: workspace, comsDir });
		const receiver = await startPeer({
			name: "receiver",
			sessionId: "rcl-1226",
			project: "pcl-1226",
			cwd: workspace,
			comsDir,
			abort: () => { abortCalls++; },
		});

		// Active user turn means Pi queues m1 in its followUp queue (undelivered).
		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		const r1 = await peerA.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "do not run after stop" });
		const m1 = r1.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m1));
		const staleMsg = { role: "custom", ...receiver.messages.find((m) => m?.details?.msg_id === m1) };

		// Stop COMS while m1 is still sitting in Pi's follow-up queue.
		await receiver.shutdown();
		await waitUntil(async () => (await peerA.tools.get("coms_get").execute("g1-wait", { msg_id: m1 })).details.status === "complete");
		assert.equal((await peerA.tools.get("coms_get").execute("g1-done", { msg_id: m1 })).details.error, "session_closed");

		// Agent resumes and Pi drains the stale queued follow-up: message_start suppresses it
		// and context strips it + aborts the turn before any LLM call can execute it.
		const priorUser = { role: "user", content: "earlier question" };
		const priorAssistant = { role: "assistant", content: [{ type: "text", text: "earlier answer" }] };
		await receiver.handlers.get("message_start")!({ message: staleMsg });
		const ctxResult = receiver.handlers.get("context")!(
			{ type: "context", messages: [priorUser, priorAssistant, staleMsg] },
			receiver.ctx,
		);
		assert.deepEqual(ctxResult?.messages, [priorUser, priorAssistant], "closed follow-up must be stripped from LLM context");
		assert.equal(abortCalls, 1, "standalone closed follow-up turn must abort before reaching the model");
	});

	it("filters a closed pre-shutdown follow-up after same-closure restart while allowing fresh work", async () => {
		const { workspace, comsDir } = makeWorkspace();
		let abortCalls = 0;
		const peerA = await startPeer({ name: "peer-a", sessionId: "scr-a", project: "pcr-1226", cwd: workspace, comsDir });
		const receiver = await startPeer({
			name: "receiver",
			sessionId: "rcr-1226",
			project: "pcr-1226",
			cwd: workspace,
			comsDir,
			abort: () => { abortCalls++; },
		});

		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		const r1 = await peerA.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "stale before restart" });
		const m1 = r1.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m1));
		const staleMsg = { role: "custom", ...receiver.messages.find((m) => m?.details?.msg_id === m1) };

		await receiver.shutdown();
		await waitUntil(async () => (await peerA.tools.get("coms_get").execute("g1-wait", { msg_id: m1 })).details.status === "complete");
		assert.equal((await peerA.tools.get("coms_get").execute("g1-done", { msg_id: m1 })).details.error, "session_closed");

		// Restart the same closure and receive a fresh prompt m2.
		await receiver.start({}, receiver.ctx);
		const restartedSelf = (globalThis as any).__comsSelf;
		receiver.registryFile = join(comsDir, "projects", "pcr-1226", "agents", `${restartedSelf.sessionId}.json`);
		const r2 = await peerA.tools.get("coms_send").execute("s2", { target: "receiver", prompt: "fresh after restart" });
		const m2 = r2.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m2));
		const freshMsg = { role: "custom", ...receiver.messages.find((m) => m?.details?.msg_id === m2) };

		// Pi delivers stale m1 alongside fresh m2: m1 is stripped, m2 runs normally without abort.
		const priorAssistant = { role: "assistant", content: [{ type: "text", text: "earlier answer" }] };
		await receiver.handlers.get("message_start")!({ message: staleMsg });
		await receiver.handlers.get("message_start")!({ message: freshMsg });
		const ctxResult = receiver.handlers.get("context")!(
			{ type: "context", messages: [priorAssistant, staleMsg, freshMsg] },
			receiver.ctx,
		);
		assert.deepEqual(ctxResult?.messages, [priorAssistant, freshMsg], "stale pre-shutdown prompt must be stripped while fresh prompt remains");
		assert.equal(abortCalls, 0, "turn carrying a live prompt must not be aborted");

		await emitTurnEnd(receiver, { text: "reply to fresh work", stopReason: "stop", toolResults: [] });
		await waitUntil(async () => (await peerA.tools.get("coms_get").execute("g2-wait", { msg_id: m2 })).details.status === "complete");
		assert.equal((await peerA.tools.get("coms_get").execute("g2-done", { msg_id: m2 })).details.response, "reply to fresh work");
		assert.equal(readRegistry(receiver).busy, false);
	});

	it("resolves accumulated same-sender inbounds with bundled envelopes during multi-message FIFO drain", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const sender = await startPeer({ name: "sender", sessionId: "sac-s", project: "pac-1226", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "sac-r", project: "pac-1226", cwd: workspace, comsDir });

		// Prompt 1 starts running.
		const r1 = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "P1-BASE" });
		const m1 = r1.details.msg_id as string;
		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		await deliverInbound(receiver, m1);

		// While m1 is busy, the same sender sends a mid-turn steer plus two queued prompts (m2, m3).
		const steerRes = await sender.tools.get("coms_send").execute("st1", {
			target: "receiver",
			prompt: "STEER-OK",
			steer: true,
		});
		const steerId = steerRes.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.steer === true && m?.details?.msg_id === steerId));
		const steerMsg = receiver.messages.find((m) => m?.details?.steer === true && m?.details?.msg_id === steerId);

		const r2 = await sender.tools.get("coms_send").execute("s2", { target: "receiver", prompt: "P2-OLD" });
		const r3 = await sender.tools.get("coms_send").execute("s3", { target: "receiver", prompt: "OVERRIDE-P3-OK" });
		const m2 = r2.details.msg_id as string;
		const m3 = r3.details.msg_id as string;
		assert.equal(readRegistry(receiver).queue_depth, 2);

		// Pre-steer turn_end defers until steer delivery.
		await emitTurnEnd(receiver, { text: "P1-BASE draft", stopReason: "stop", toolResults: [] });
		assert.equal((await sender.tools.get("coms_get").execute("g1-pre", { msg_id: m1 })).details.status, "pending");

		// Deliver steer, then finalize m1: morePending accumulates m1's reply, resolves m1 as "bundled",
		// and drains [m2, m3] together as a bundle.
		await receiver.handlers.get("message_start")!({ message: { role: "custom", ...steerMsg } });
		await emitTurnEnd(receiver, { text: "P1-BASE STEER-OK", stopReason: "stop", toolResults: [] });

		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g1-wait", { msg_id: m1 })).details.status === "complete");
		const g1 = await sender.tools.get("coms_get").execute("g1-done", { msg_id: m1 });
		assert.equal(g1.details.error, "bundled", "accumulated primary inbound m1 must resolve with error:'bundled' instead of hanging pending");

		const bundledMsg = await deliverInbound(receiver, m2);
		assert.deepEqual(bundledMsg.details.bundled_msg_ids, [m2, m3]);

		// Finalize [m2, m3]: m2 gets the combined reply, m3 gets "bundled", queue drains to 0.
		await emitTurnEnd(receiver, { text: "OVERRIDE-P3-OK", stopReason: "stop", toolResults: [] });
		await waitUntil(async () => {
			const g2 = await sender.tools.get("coms_get").execute("g2-wait", { msg_id: m2 });
			const g3 = await sender.tools.get("coms_get").execute("g3-wait", { msg_id: m3 });
			return g2.details.status === "complete" && g3.details.status === "complete";
		});

		const g2 = await sender.tools.get("coms_get").execute("g2-done", { msg_id: m2 });
		const g3 = await sender.tools.get("coms_get").execute("g3-done", { msg_id: m3 });
		assert.equal(g2.details.error, null);
		assert.equal(g2.details.response, "P1-BASE STEER-OK\n\n---\n\nOVERRIDE-P3-OK");
		assert.equal(g3.details.error, "bundled");
		assert.equal(readRegistry(receiver).busy, false);
		assert.equal(readRegistry(receiver).queue_depth, 0);
	});

	it("clears accumulated responses when a follow-up turn replies directly via coms_send", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const sender = await startPeer({ name: "sender", sessionId: "sad-s2", project: "pad-1226b", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "sad-r2", project: "pad-1226b", cwd: workspace, comsDir });

		const r1 = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "first" });
		const m1 = r1.details.msg_id as string;
		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		await deliverInbound(receiver, m1);

		const r2 = await sender.tools.get("coms_send").execute("s2", { target: "receiver", prompt: "second" });
		const m2 = r2.details.msg_id as string;

		// Finalize m1 -> accumulates "reply-1", resolves m1 as "bundled", drains m2.
		await emitTurnEnd(receiver, { text: "reply-1", stopReason: "stop", toolResults: [] });
		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g1-wait", { msg_id: m1 })).details.status === "complete");
		assert.equal((await sender.tools.get("coms_get").execute("g1-done", { msg_id: m1 })).details.error, "bundled");

		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m2));
		const m2Msg = [...receiver.messages].reverse().find((m) => m?.details?.msg_id === m2);

		// Enter sentDirectlyToSender on m2 by delivering m2 right as a direct coms_send settles.
		let deliveredDuringSend = false;
		sender.onSendMessage = () => {
			if (deliveredDuringSend) return;
			deliveredDuringSend = true;
			receiver.handlers.get("message_start")!({ message: { role: "custom", ...m2Msg } });
		};
		const directRes = await receiver.tools.get("coms_send").execute("direct-s", { target: "sender", prompt: "direct reply for m2" });
		assert.ok(directRes.details.msg_id, "direct coms_send succeeded");
		assert.equal(deliveredDuringSend, true);

		await emitTurnEnd(receiver, { text: "direct-turn-text", stopReason: "stop", toolResults: [] });
		assert.equal(readRegistry(receiver).busy, false);

		// A fresh unrelated m3 must receive only its own reply without stale "reply-1" prepended.
		const r3 = await sender.tools.get("coms_send").execute("s3", { target: "receiver", prompt: "third" });
		const m3 = r3.details.msg_id as string;
		await deliverInbound(receiver, m3);
		await emitTurnEnd(receiver, { text: "reply-3", stopReason: "stop", toolResults: [] });
		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g3-wait", { msg_id: m3 })).details.status === "complete");
		assert.equal((await sender.tools.get("coms_get").execute("g3-done", { msg_id: m3 })).details.response, "reply-3");
	});
});
