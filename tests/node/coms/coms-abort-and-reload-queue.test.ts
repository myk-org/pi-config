/**
 * Regression tests for:
 *   - #1429: followUpQueued undelivered inbound recovery on abort / subsequent turns
 *     (no permanent processingInbound wedge; zero-duplicate on normal followUp delivery;
 *     deferred agent_settled re-injection & superseded copy stripping).
 *   - #1430: preserving queued & undelivered inbound COMS messages across `/reload`
 *     (FIFO + priority order, metadata preservation, 0600 atomic handoff file,
 *     explicit coms_stop & non-reload shutdown still emit session_closed,
 *     TTL expiry and reload failure cleanup).
 *
 * Run with: npx tsx --test tests/node/coms/coms-abort-and-reload-queue.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	createComsPeerRuntime,
	type ComsPeerRuntime,
	type ComsPeerStopOptions,
} from "../../../extensions/coms/coms-p2p.js";
import { ComsRegistry } from "../../../extensions/coms/coms-registry.js";
import { registerComs } from "../../../extensions/coms/coms-wrapper.js";
import { resetSessionBridge } from "../../../extensions/shared/session-bridge.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

interface TestPeer {
	name: string;
	sessionId: string;
	project: string;
	comsDir: string;
	registryFile: string;
	tools: Map<string, any>;
	handlers: Map<string, Function>;
	messages: any[];
	ctx: any;
	runtime: ComsPeerRuntime;
	shutdown: (opts?: ComsPeerStopOptions) => Promise<void>;
}

const activePeers: Array<{ shutdown: () => Promise<void> }> = [];

afterEach(async () => {
	while (activePeers.length > 0) {
		const p = activePeers.pop()!;
		try { await p.shutdown(); } catch { /* ignore */ }
	}
	resetSessionBridge({ all: true });
	delete (globalThis as any).__piConfigSessionId;
});

function makeWorkspace(): { workspace: string; comsDir: string } {
	const workspace = makeTempDir("coms-1429-1430-");
	const comsDir = join(workspace, "coms");
	mkdirSync(join(workspace, ".pi"), { recursive: true });
	writeFileSync(join(workspace, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: comsDir }));
	return { workspace, comsDir };
}

function makeCtx(
	cwd: string,
	sessionId: string,
	opts: { isIdle?: () => boolean; abort?: () => void; entries?: any[]; branchText?: string } = {},
): any {
	return {
		cwd,
		mode: "tui",
		hasUI: false,
		model: { id: "test-model" },
		...(opts.isIdle ? { isIdle: opts.isIdle } : {}),
		...(opts.abort ? { abort: opts.abort } : {}),
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setTheme: () => ({ success: true }),
			setTitle: () => {},
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => opts.entries ?? [],
			getBranch: () =>
				opts.branchText
					? [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: opts.branchText }] } }]
					: [],
		},
	};
}

function createFakePi(flags: Record<string, any> = {}) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function>();
	const messages: any[] = [];
	const customEntries: any[] = [];
	const listeners = new Map<string, Set<(data?: any) => void>>();
	const events = {
		emit(event: string, data?: any) {
			for (const fn of [...(listeners.get(event) ?? [])]) fn(data);
		},
		on(event: string, fn: (data?: any) => void) {
			if (!listeners.has(event)) listeners.set(event, new Set());
			listeners.get(event)!.add(fn);
			return () => { listeners.get(event)?.delete(fn); };
		},
	};
	const pi: any = {
		registerFlag() {},
		getFlag(name: string) { return flags[name]; },
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand() {},
		registerShortcut() {},
		on(name: string, fn: Function) { handlers.set(name, fn); },
		sendMessage(msg: any) { messages.push(msg); },
		appendEntry(customType: string, data: any) { customEntries.push({ type: "custom", customType, data }); },
		getActiveTools() { return [...tools.keys()]; },
		setActiveTools() {},
		events,
	};
	return { pi, tools, handlers, messages, customEntries };
}

async function waitUntil(pred: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await pred()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("waitUntil timed out");
}

async function startPeer(opts: {
	name: string;
	sessionId: string;
	project: string;
	cwd: string;
	comsDir: string;
	isIdle?: () => boolean;
	abort?: () => void;
	reload?: boolean;
	reloadQueueTtlMs?: number;
}): Promise<TestPeer> {
	const { pi, tools, handlers, messages } = createFakePi({
		cname: opts.name,
		project: opts.project,
	});
	const runtime = createComsPeerRuntime(pi, {
		deferred: true,
		comsDir: opts.comsDir,
		sessionId: opts.sessionId,
		allowSubagentChild: true,
		registerSignalHandlers: false,
		reloadQueueTtlMs: opts.reloadQueueTtlMs,
	});
	const ctx = makeCtx(opts.cwd, opts.sessionId, { isIdle: opts.isIdle, abort: opts.abort });
	const self = await runtime.start(ctx, {
		flags: { cname: opts.name, project: opts.project },
		reload: opts.reload,
	});
	assert.ok(self, `peer ${opts.name} failed to start`);
	if (process.platform !== "win32") {
		await waitUntil(() => existsSync(`${self.endpoint}.ping`));
	}

	const peer: TestPeer = {
		name: opts.name,
		sessionId: opts.sessionId,
		project: opts.project,
		comsDir: opts.comsDir,
		registryFile: self.registryFile,
		tools,
		handlers,
		messages,
		ctx,
		runtime,
		shutdown: (stopOpts?: ComsPeerStopOptions) => runtime.stop(stopOpts),
	};
	activePeers.push({ shutdown: () => runtime.stop({ reason: "test_cleanup" }) });
	return peer;
}

function readRegistry(peer: TestPeer): { busy?: boolean; queue_depth?: number } {
	return JSON.parse(readFileSync(peer.registryFile, "utf-8"));
}

async function deliverLatestInbound(peer: TestPeer, msgId: string): Promise<any> {
	await waitUntil(() => peer.messages.some((m) => m?.details?.msg_id === msgId));
	const msg = [...peer.messages].reverse().find((m) => m?.details?.msg_id === msgId);
	await peer.handlers.get("message_start")!({ message: { role: "custom", ...msg } });
	return msg;
}

async function emitTurnEnd(peer: TestPeer, text: string, stopReason = "stop"): Promise<void> {
	await peer.handlers.get("turn_end")!(
		{
			type: "turn_end",
			message: { role: "assistant", content: [{ type: "text", text }], stopReason },
			toolResults: [],
		},
		peer.ctx,
	);
}

describe("COMS abort followUp wedge recovery (#1429)", () => {
	it("delivers normal non-aborted followUp inbound with zero duplicate injections", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const sender = await startPeer({ name: "sender", sessionId: "s-ok", project: "p-1429-ok", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "r-ok", project: "p-1429-ok", cwd: workspace, comsDir });

		// User turn is active -> inbound m1 is queued as followUp.
		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		const r1 = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "normal followup" });
		const m1 = r1.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m1));

		// User turn finishes normally and Pi pulls m1 from followUpQueue BEFORE agent_end.
		await emitTurnEnd(receiver, "user turn done", "stop");
		await deliverLatestInbound(receiver, m1);
		await emitTurnEnd(receiver, "clean followup reply", "stop");
		await receiver.handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "stop" }] }, receiver.ctx);

		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g1", { msg_id: m1 })).details.status === "complete");
		assert.equal(receiver.messages.filter((m) => m?.details?.msg_id === m1).length, 1, "no duplicate injection on normal followUp delivery");
		assert.equal((await sender.tools.get("coms_get").execute("g1-done", { msg_id: m1 })).details.response, "clean followup reply");
		assert.equal(readRegistry(receiver).busy, false);
	});

	it("fails with aborted and drains FIFO instead of wedging across subsequent completed turns (#1429)", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peerA = await startPeer({ name: "peer-a", sessionId: "s-wedge-a", project: "p-1429-wedge", cwd: workspace, comsDir });
		const peerB = await startPeer({ name: "peer-b", sessionId: "s-wedge-b", project: "p-1429-wedge", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "r-wedge", project: "p-1429-wedge", cwd: workspace, comsDir });

		// User turn active -> m1 queued as followUp, m2 queued behind it.
		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		const r1 = await peerA.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "dropped on abort" });
		const r2 = await peerB.tools.get("coms_send").execute("s2", { target: "receiver", prompt: "queued behind" });
		const m1 = r1.details.msg_id as string;
		const m2 = r2.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m1));

		// Turn 1 aborts and Pi drops m1 -> bounded single re-injection.
		await emitTurnEnd(receiver, "Operation aborted", "aborted");
		await receiver.handlers.get("agent_end")!(
			{ messages: [{ role: "assistant", stopReason: "aborted" }] },
			receiver.ctx,
		);
		assert.equal(receiver.messages.filter((m) => m?.details?.msg_id === m1).length, 2, "re-injected once after abort");

		// Subsequent completed turn runs without ever emitting message_start for m1 -> retry exhausted -> aborted + drains m2!
		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		await emitTurnEnd(receiver, "unrelated normal turn", "stop");
		await receiver.handlers.get("agent_end")!(
			{ messages: [{ role: "assistant", stopReason: "stop" }] },
			receiver.ctx,
		);

		await waitUntil(async () => (await peerA.tools.get("coms_get").execute("g1", { msg_id: m1 })).details.status === "complete");
		const g1 = await peerA.tools.get("coms_get").execute("g1-check", { msg_id: m1 });
		assert.equal(g1.details.error, "aborted");
		assert.equal(g1.details.response, null);

		// m2 drained cleanly and idle resets busy to false!
		await deliverLatestInbound(receiver, m2);
		await emitTurnEnd(receiver, "reply to m2", "stop");
		await waitUntil(async () => (await peerB.tools.get("coms_get").execute("g2", { msg_id: m2 })).details.status === "complete");
		assert.equal((await peerB.tools.get("coms_get").execute("g2-check", { msg_id: m2 })).details.response, "reply to m2");
		assert.equal(readRegistry(receiver).busy, false, "processingInbound must never stay stranded true at idle");
		assert.equal(readRegistry(receiver).queue_depth, 0);
	});

	it("defers re-injection to agent_settled when Pi is still streaming at agent_end and strips superseded attempt-0 copies", async () => {
		const { workspace, comsDir } = makeWorkspace();
		let idle = false;
		let abortCalls = 0;
		const sender = await startPeer({ name: "sender", sessionId: "s-settled", project: "p-1429-settled", cwd: workspace, comsDir });
		const receiver = await startPeer({
			name: "receiver",
			sessionId: "r-settled",
			project: "p-1429-settled",
			cwd: workspace,
			comsDir,
			isIdle: () => idle,
			abort: () => { abortCalls++; },
		});

		// Active run (isIdle() === false): m1 queued as followUp (attempt 0).
		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		const r1 = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "need settled reinject" });
		const m1 = r1.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m1));
		const attempt0Msg = { role: "custom", ...receiver.messages.find((m) => m?.details?.msg_id === m1) };

		// Run aborts: during agent_end, Pi still reports isIdle() === false -> defer re-inject to agent_settled.
		await emitTurnEnd(receiver, "aborted", "aborted");
		await receiver.handlers.get("agent_end")!(
			{ messages: [{ role: "assistant", stopReason: "aborted" }] },
			receiver.ctx,
		);
		assert.equal(receiver.messages.filter((m) => m?.details?.msg_id === m1).length, 1, "must wait for agent_settled while streaming");

		// Pi finishes settling (isIdle() === true) and fires agent_settled -> re-injects attempt 1!
		idle = true;
		await receiver.handlers.get("agent_settled")!({ aborted: true }, receiver.ctx);
		const copies = receiver.messages.filter((m) => m?.details?.msg_id === m1);
		assert.equal(copies.length, 2, "agent_settled triggers fresh re-injection");
		assert.equal(copies[1]?.details?.inject_attempt, 1);

		// If Pi still had ghost attempt-0 in its queue, message_start ignores it and context strips + aborts it.
		await receiver.handlers.get("message_start")!({ message: attempt0Msg });
		const priorAssistant = { role: "assistant", content: [{ type: "text", text: "earlier" }] };
		const ctxResult = receiver.handlers.get("context")!(
			{ type: "context", messages: [priorAssistant, attempt0Msg] },
			receiver.ctx,
		);
		assert.deepEqual(ctxResult?.messages, [priorAssistant], "superseded attempt-0 copy must be stripped");
		assert.equal(abortCalls, 1, "standalone superseded copy aborts before reaching LLM");

		// Attempt 1 delivers and completes cleanly.
		await deliverLatestInbound(receiver, m1);
		await emitTurnEnd(receiver, "attempt-1 reply", "stop");
		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g1", { msg_id: m1 })).details.status === "complete");
		assert.equal((await sender.tools.get("coms_get").execute("g1-check", { msg_id: m1 })).details.response, "attempt-1 reply");
		assert.equal(readRegistry(receiver).busy, false);
	});

	it("cancels deferred agent_settled re-injection when auto-retry delivers attempt 0 before agent_settled", async () => {
		const { workspace, comsDir } = makeWorkspace();
		let idle = false;
		const sender = await startPeer({ name: "sender", sessionId: "s-retry", project: "p-1429-retry", cwd: workspace, comsDir });
		const receiver = await startPeer({
			name: "receiver",
			sessionId: "r-retry",
			project: "p-1429-retry",
			cwd: workspace,
			comsDir,
			isIdle: () => idle,
		});

		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		const r1 = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "survives auto retry" });
		const m1 = r1.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m1));

		// Transient error ends agent_loop while isIdle() stays false (Pi auto-retry will continue).
		await receiver.handlers.get("agent_end")!(
			{ messages: [{ role: "assistant", stopReason: "error" }] },
			receiver.ctx,
		);
		// Auto-retry succeeds and Pi delivers the original attempt-0 copy before agent_settled.
		await deliverLatestInbound(receiver, m1);
		await emitTurnEnd(receiver, "delivered via auto-retry", "stop");
		idle = true;
		await receiver.handlers.get("agent_settled")!({ aborted: false }, receiver.ctx);

		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g1", { msg_id: m1 })).details.status === "complete");
		assert.equal(receiver.messages.filter((m) => m?.details?.msg_id === m1).length, 1, "no duplicate when delivered before agent_settled");
		assert.equal((await sender.tools.get("coms_get").execute("g1-check", { msg_id: m1 })).details.response, "delivered via auto-retry");
	});
});

describe("COMS reload queue persistence (#1430)", () => {
	it("persists undelivered currentInbound + FIFO + priority queue with 0600 perms across /reload and delivers all replies", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const project = "p-1430-fifo";
		const receiverSessionId = "r-reload-1430";
		const peerA = await startPeer({ name: "peer-a", sessionId: "s-1430-a", project, cwd: workspace, comsDir });
		const peerB = await startPeer({ name: "peer-b", sessionId: "s-1430-b", project, cwd: workspace, comsDir });
		const peerC = await startPeer({ name: "peer-c", sessionId: "s-1430-c", project, cwd: workspace, comsDir });
		const receiver1 = await startPeer({ name: "receiver", sessionId: receiverSessionId, project, cwd: workspace, comsDir });

		// Send 3 messages: m1 (undelivered active), m2 (normal queued), m3 (priority queued -> jumps ahead of m2).
		const r1 = await peerA.tools.get("coms_send").execute("s1", {
			target: "receiver",
			prompt: "first undelivered",
			conversation_id: "conv-1",
			tasks: [{ subject: "T1", description: "Do T1" }],
		});
		const m1 = r1.details.msg_id as string;
		await waitUntil(() => receiver1.messages.some((m) => m?.details?.msg_id === m1));

		const r2 = await peerB.tools.get("coms_send").execute("s2", { target: "receiver", prompt: "normal second" });
		const m2 = r2.details.msg_id as string;
		const r3 = await peerC.tools.get("coms_send").execute("s3", {
			target: "receiver",
			prompt: "urgent priority",
			priority: true,
		});
		const m3 = r3.details.msg_id as string;

		// Reload shutdown: persists queue atomically with 0600 perms and does NOT send session_closed!
		await receiver1.shutdown({ reason: "reload" });

		const reg = new ComsRegistry(comsDir);
		const handoffPath = reg.reloadQueuePath(project, receiverSessionId);
		assert.equal(existsSync(handoffPath), true, "reload handoff file must be created on reload shutdown");
		if (process.platform !== "win32") {
			assert.equal(statSync(handoffPath).mode & 0o777, 0o600, "reload handoff file must have 0600 permissions");
		}
		const persisted = JSON.parse(readFileSync(handoffPath, "utf-8"));
		assert.deepEqual(
			persisted.items.map((i: any) => i.msg_id),
			[m1, m3, m2],
			"persisted order must preserve undelivered head + priority before normal FIFO",
		);
		assert.equal(persisted.items[0].conversation_id, "conv-1");
		assert.deepEqual(persisted.items[0].tasks, [{ subject: "T1", description: "Do T1" }]);
		assert.equal(persisted.items[1].priority, true);

		// None of the waiting senders received premature session_closed.
		assert.equal((await peerA.tools.get("coms_get").execute("ga-pre", { msg_id: m1 })).details.status, "pending");
		assert.equal((await peerB.tools.get("coms_get").execute("gb-pre", { msg_id: m2 })).details.status, "pending");
		assert.equal((await peerC.tools.get("coms_get").execute("gc-pre", { msg_id: m3 })).details.status, "pending");

		// Reloaded runtime instance starts with the same sessionId and consumes the handoff file atomically.
		let abortCalls = 0;
		const receiver2 = await startPeer({
			name: "receiver",
			sessionId: receiverSessionId,
			project,
			cwd: workspace,
			comsDir,
			reload: true,
			abort: () => { abortCalls++; },
		});
		assert.equal(existsSync(handoffPath), false, "handoff file must be atomically removed on reload startup");

		// Ghost pre-reload attempt-0 copy of m1 is stripped by context without affecting attempt-1.
		const ghostM1 = { role: "custom", ...receiver1.messages.find((m) => m?.details?.msg_id === m1) };
		const ctxRes = receiver2.handlers.get("context")!(
			{ type: "context", messages: [{ role: "assistant", content: [{ type: "text", text: "old" }] }, ghostM1] },
			receiver2.ctx,
		);
		assert.equal(ctxRes?.messages.length, 1, "ghost pre-reload attempt-0 copy must be stripped");
		assert.equal(abortCalls, 1);

		// Restored queue drains in exact order: m1 -> m3 (priority) -> m2 (normal).
		const m1Restored = await deliverLatestInbound(receiver2, m1);
		assert.equal(m1Restored.details.inject_attempt, 1);
		await emitTurnEnd(receiver2, "reply-m1-after-reload", "stop");
		await waitUntil(async () => (await peerA.tools.get("coms_get").execute("ga-done", { msg_id: m1 })).details.status === "complete");
		assert.equal((await peerA.tools.get("coms_get").execute("ga-check", { msg_id: m1 })).details.response, "reply-m1-after-reload");

		// Priority m3 drains BEFORE normal m2.
		await deliverLatestInbound(receiver2, m3);
		assert.equal(receiver2.messages.some((m) => m?.details?.msg_id === m2), false, "priority m3 must drain before normal m2");
		await emitTurnEnd(receiver2, "reply-m3-priority", "stop");
		await waitUntil(async () => (await peerC.tools.get("coms_get").execute("gc-done", { msg_id: m3 })).details.status === "complete");
		assert.equal((await peerC.tools.get("coms_get").execute("gc-check", { msg_id: m3 })).details.response, "reply-m3-priority");

		await deliverLatestInbound(receiver2, m2);
		await emitTurnEnd(receiver2, "reply-m2-normal", "stop");
		await waitUntil(async () => (await peerB.tools.get("coms_get").execute("gb-done", { msg_id: m2 })).details.status === "complete");
		assert.equal((await peerB.tools.get("coms_get").execute("gb-check", { msg_id: m2 })).details.response, "reply-m2-normal");
		assert.equal(readRegistry(receiver2).busy, false);
		assert.equal(readRegistry(receiver2).queue_depth, 0);
	});

	it("preserves queued inbounds across coms-wrapper reload and sends session_closed on explicit coms_stop", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const project = "p-1430-wrap";
		const receiverSessionId = "r-wrap-1430";
		const sender = await startPeer({ name: "sender", sessionId: "s-wrap-1430", project, cwd: workspace, comsDir });

		// First wrapper session starts via coms_start.
		const w1 = createFakePi();
		const reg1 = registerComs(w1.pi, {
			comsDir,
			sessionId: receiverSessionId,
			allowSubagentChild: true,
			registerSignalHandlers: false,
		});
		activePeers.push({ shutdown: () => reg1.runtime.stop({ reason: "test_cleanup" }) });
		const ctx1 = makeCtx(workspace, receiverSessionId, { entries: w1.customEntries });
		await w1.handlers.get("session_start")!({ reason: "startup" }, ctx1);
		const startRes = await w1.tools.get("coms_start").execute("cs1", { cname: "wrap-recv", project }, undefined, undefined, ctx1);
		assert.equal(startRes.details.ok, true);

		const sent = await sender.tools.get("coms_send").execute("s1", { target: "wrap-recv", prompt: "survive wrapper reload" });
		const m1 = sent.details.msg_id as string;
		await waitUntil(() => w1.messages.some((m) => m?.details?.msg_id === m1));

		// Simulate Pi /reload: session_shutdown(reason: "reload") -> new registerComs -> session_start(reason: "reload").
		await w1.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, ctx1);
		assert.equal((await sender.tools.get("coms_get").execute("g1-mid", { msg_id: m1 })).details.status, "pending");

		const w2 = createFakePi();
		const reg2 = registerComs(w2.pi, {
			comsDir,
			sessionId: receiverSessionId,
			allowSubagentChild: true,
			registerSignalHandlers: false,
		});
		activePeers.push({ shutdown: () => reg2.runtime.stop({ reason: "test_cleanup" }) });
		const ctx2 = makeCtx(workspace, receiverSessionId, { entries: w1.customEntries });
		await w2.handlers.get("session_start")!({ type: "session_start", reason: "reload" }, ctx2);

		await waitUntil(() => w2.messages.some((m) => m?.details?.msg_id === m1));
		const restoredMsg = [...w2.messages].reverse().find((m) => m?.details?.msg_id === m1);
		await w2.handlers.get("message_start")!({ message: { role: "custom", ...restoredMsg } });
		await w2.handlers.get("turn_end")!(
			{ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "wrapper reloaded reply" }], stopReason: "stop" }, toolResults: [] },
			ctx2,
		);
		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g1-done", { msg_id: m1 })).details.status === "complete");
		assert.equal((await sender.tools.get("coms_get").execute("g1-check", { msg_id: m1 })).details.response, "wrapper reloaded reply");

		// Now queue a second message and call explicit coms_stop -> must emit session_closed and leave no reload file!
		const sent2 = await sender.tools.get("coms_send").execute("s2", { target: "wrap-recv", prompt: "will be stopped" });
		const m2 = sent2.details.msg_id as string;
		await waitUntil(() => w2.messages.some((m) => m?.details?.msg_id === m2));

		await w2.tools.get("coms_stop").execute("stop1", {}, undefined, undefined, ctx2);
		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g2-done", { msg_id: m2 })).details.status === "complete");
		assert.equal((await sender.tools.get("coms_get").execute("g2-check", { msg_id: m2 })).details.error, "session_closed");
		assert.equal(existsSync(new ComsRegistry(comsDir).reloadQueuePath(project, receiverSessionId)), false);
	});

	it("notifies waiting senders with session_closed and removes handoff file when reload TTL expires", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const project = "p-1430-ttl";
		const receiverSessionId = "r-ttl-1430";
		const sender = await startPeer({ name: "sender", sessionId: "s-ttl-1430", project, cwd: workspace, comsDir });
		const receiver = await startPeer({
			name: "receiver",
			sessionId: receiverSessionId,
			project,
			cwd: workspace,
			comsDir,
			reloadQueueTtlMs: 60,
		});

		const sent = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "expires if reload stalls" });
		const m1 = sent.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m1));

		// Reload shutdown persists file, but reloaded peer never comes back -> TTL safety timer fires.
		await receiver.shutdown({ reason: "reload" });
		const handoffPath = new ComsRegistry(comsDir).reloadQueuePath(project, receiverSessionId);
		assert.equal(existsSync(handoffPath), true);

		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g1-exp", { msg_id: m1 })).details.status === "complete");
		assert.equal((await sender.tools.get("coms_get").execute("g1-check", { msg_id: m1 })).details.error, "session_closed");
		assert.equal(existsSync(handoffPath), false, "expired reload handoff file must be cleaned up");
	});

	it("discards a pre-existing expired handoff file on startup with session_closed instead of restoring stale work", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const project = "p-1430-stale";
		const receiverSessionId = "r-stale-1430";
		const sender = await startPeer({ name: "sender", sessionId: "s-stale-1430", project, cwd: workspace, comsDir });
		const receiver1 = await startPeer({ name: "receiver", sessionId: receiverSessionId, project, cwd: workspace, comsDir });

		const sent = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "stale persisted msg" });
		const m1 = sent.details.msg_id as string;
		await waitUntil(() => receiver1.messages.some((m) => m?.details?.msg_id === m1));

		await receiver1.shutdown({ reason: "reload" });
		const handoffPath = new ComsRegistry(comsDir).reloadQueuePath(project, receiverSessionId);
		const payload = JSON.parse(readFileSync(handoffPath, "utf-8"));
		payload.expires_at_ms = Date.now() - 1_000;
		writeFileSync(handoffPath, JSON.stringify(payload), { mode: 0o600 });

		const receiver2 = await startPeer({
			name: "receiver",
			sessionId: receiverSessionId,
			project,
			cwd: workspace,
			comsDir,
			reload: true,
		});
		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g1-stale", { msg_id: m1 })).details.status === "complete");
		assert.equal((await sender.tools.get("coms_get").execute("g1-check", { msg_id: m1 })).details.error, "session_closed");
		assert.equal(receiver2.messages.some((m) => m?.details?.msg_id === m1), false, "expired message must not be injected");
		assert.equal(existsSync(handoffPath), false, "expired file must be deleted on startup");
	});

	it("sends session_closed and leaves no reload file on non-reload shutdown (quit / signal)", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const project = "p-1430-quit";
		const receiverSessionId = "r-quit-1430";
		const sender = await startPeer({ name: "sender", sessionId: "s-quit-1430", project, cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: receiverSessionId, project, cwd: workspace, comsDir });

		const sent = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "lost on quit" });
		const m1 = sent.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m1));

		await receiver.shutdown({ reason: "quit" });
		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g1-quit", { msg_id: m1 })).details.status === "complete");
		assert.equal((await sender.tools.get("coms_get").execute("g1-check", { msg_id: m1 })).details.error, "session_closed");
		assert.equal(existsSync(new ComsRegistry(comsDir).reloadQueuePath(project, receiverSessionId)), false);
	});

	it("preserves bundled undelivered same-sender inbounds across /reload and delivers reply + bundled ack", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const project = "p-1430-bundle";
		const receiverSessionId = "r-bundle-1430";
		const peerA = await startPeer({ name: "peer-a", sessionId: "s-bnd-a", project, cwd: workspace, comsDir });
		const peerB = await startPeer({ name: "peer-b", sessionId: "s-bnd-b", project, cwd: workspace, comsDir });
		const receiver1 = await startPeer({ name: "receiver", sessionId: receiverSessionId, project, cwd: workspace, comsDir });

		// Occupy receiver with m0 (delivered), queue two messages from peer-b (b1, b2) so finishing m0 drains them as a bundle.
		const r0 = await peerA.tools.get("coms_send").execute("s0", { target: "receiver", prompt: "blocker" });
		const m0 = r0.details.msg_id as string;
		await deliverLatestInbound(receiver1, m0);

		const rb1 = await peerB.tools.get("coms_send").execute("sb1", { target: "receiver", prompt: "part 1" });
		const rb2 = await peerB.tools.get("coms_send").execute("sb2", { target: "receiver", prompt: "part 2" });
		const b1 = rb1.details.msg_id as string;
		const b2 = rb2.details.msg_id as string;

		// Finalize m0 -> drains [b1, b2] as an undelivered bundle (`currentInbound = b1`, `bundledInbounds = [b2]`).
		await emitTurnEnd(receiver1, "done blocker", "stop");
		await waitUntil(() => receiver1.messages.some((m) => m?.details?.msg_id === b1));

		// Reload while [b1, b2] are still undelivered.
		await receiver1.shutdown({ reason: "reload" });
		const receiver2 = await startPeer({
			name: "receiver",
			sessionId: receiverSessionId,
			project,
			cwd: workspace,
			comsDir,
			reload: true,
		});

		const restoredBundle = await deliverLatestInbound(receiver2, b1);
		assert.deepEqual(restoredBundle.details.bundled_msg_ids, [b1, b2]);
		assert.equal(restoredBundle.details.inject_attempt, 1);

		await emitTurnEnd(receiver2, "reloaded bundle reply", "stop");
		await waitUntil(async () => {
			const g1 = await peerB.tools.get("coms_get").execute("gb1", { msg_id: b1 });
			const g2 = await peerB.tools.get("coms_get").execute("gb2", { msg_id: b2 });
			return g1.details.status === "complete" && g2.details.status === "complete";
		});
		assert.equal((await peerB.tools.get("coms_get").execute("gb1-check", { msg_id: b1 })).details.response, "reloaded bundle reply");
		assert.equal((await peerB.tools.get("coms_get").execute("gb2-check", { msg_id: b2 })).details.error, "bundled");
	});
});
