/**
 * Regression tests for:
 *   - #1429: followUpQueued undelivered inbound recovery on abort / subsequent turns
 *     (bounded re-injection, FIFO drain on retry exhaustion, agent_settled deferral,
 *     superseded attempt-0 stripping, zero-duplicate normal delivery).
 *   - #1430: preserving queued & undelivered inbound COMS messages across `/reload`
 *     (0600 atomic handoff file, FIFO/priority/metadata preservation, early-started
 *     sessionId continuity, bundle fail_orphans, delivered bundle consistency,
 *     TTL expiry, explicit coms_stop, quit, mid-reload process.exit notification).
 *
 * Run with: npx tsx --test tests/node/coms/coms-abort-and-reload-queue.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
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

function createFakePi(
	flags: Record<string, any> = {},
	opts: { onSendMessage?: (msg: any) => void } = {},
) {
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
		registerMessageRenderer() {},
		getAllTools() { return [...tools.values()]; },
		on(name: string, fn: Function) { handlers.set(name, fn); },
		sendMessage(msg: any) {
			opts.onSendMessage?.(msg);
			messages.push(msg);
		},
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
	onSendMessage?: (msg: any) => void;
}): Promise<TestPeer> {
	const { pi, tools, handlers, messages } = createFakePi(
		{ cname: opts.name, project: opts.project },
		{ onSendMessage: opts.onSendMessage },
	);
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

/** Shared setup for #1430 three-sender reload scenarios (undelivered m1, normal m2, priority m3). */
async function setupThreeSenderReloadQueue(project: string, receiverSessionId: string) {
	const { workspace, comsDir } = makeWorkspace();
	const peerA = await startPeer({ name: "peer-a", sessionId: `${receiverSessionId}-a`, project, cwd: workspace, comsDir });
	const peerB = await startPeer({ name: "peer-b", sessionId: `${receiverSessionId}-b`, project, cwd: workspace, comsDir });
	const peerC = await startPeer({ name: "peer-c", sessionId: `${receiverSessionId}-c`, project, cwd: workspace, comsDir });
	const receiver1 = await startPeer({ name: "receiver", sessionId: receiverSessionId, project, cwd: workspace, comsDir });

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

	await receiver1.shutdown({ reason: "reload" });
	const handoffPath = new ComsRegistry(comsDir).reloadQueuePath(project, receiverSessionId);
	return { workspace, comsDir, project, receiverSessionId, peerA, peerB, peerC, receiver1, m1, m2, m3, handoffPath };
}

describe("COMS abort followUp wedge recovery (#1429)", () => {
	it("delivers normal non-aborted followUp inbound with zero duplicate injections", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const sender = await startPeer({ name: "sender", sessionId: "s-ok", project: "p-1429-ok", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "r-ok", project: "p-1429-ok", cwd: workspace, comsDir });

		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		const r1 = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "normal followup" });
		const m1 = r1.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m1));

		await emitTurnEnd(receiver, "user turn done", "stop");
		await deliverLatestInbound(receiver, m1);
		await emitTurnEnd(receiver, "clean followup reply", "stop");
		await receiver.handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "stop" }] }, receiver.ctx);

		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g1", { msg_id: m1 })).details.status === "complete");
		assert.equal(receiver.messages.filter((m) => m?.details?.msg_id === m1).length, 1);
		assert.equal((await sender.tools.get("coms_get").execute("g1-done", { msg_id: m1 })).details.response, "clean followup reply");
		assert.equal(readRegistry(receiver).busy, false);
	});

	it("replies aborted when a followUpQueued inbound exhausts retries across subsequent turns", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peerA = await startPeer({ name: "peer-a", sessionId: "s-exh-a", project: "p-1429-exh", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "r-exh", project: "p-1429-exh", cwd: workspace, comsDir });

		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		const r1 = await peerA.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "dropped on abort" });
		const m1 = r1.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m1));

		// Turn 1 aborts -> single bounded re-injection.
		await emitTurnEnd(receiver, "Operation aborted", "aborted");
		await receiver.handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "aborted" }] }, receiver.ctx);
		assert.equal(receiver.messages.filter((m) => m?.details?.msg_id === m1).length, 2);

		// Turn 2 finishes without delivering m1 -> retry exhausted -> error: "aborted", idle busy=false.
		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		await emitTurnEnd(receiver, "unrelated normal turn", "stop");
		await receiver.handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "stop" }] }, receiver.ctx);

		await waitUntil(async () => (await peerA.tools.get("coms_get").execute("g1", { msg_id: m1 })).details.status === "complete");
		const g1 = await peerA.tools.get("coms_get").execute("g1-check", { msg_id: m1 });
		assert.equal(g1.details.error, "aborted");
		assert.equal(g1.details.response, null);
		assert.equal(readRegistry(receiver).busy, false);
	});

	it("drains the next FIFO message after followUpQueued retry exhaustion", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peerA = await startPeer({ name: "peer-a", sessionId: "s-drn-a", project: "p-1429-drn", cwd: workspace, comsDir });
		const peerB = await startPeer({ name: "peer-b", sessionId: "s-drn-b", project: "p-1429-drn", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "r-drn", project: "p-1429-drn", cwd: workspace, comsDir });

		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		const r1 = await peerA.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "dropped head" });
		const r2 = await peerB.tools.get("coms_send").execute("s2", { target: "receiver", prompt: "queued behind" });
		const m1 = r1.details.msg_id as string;
		const m2 = r2.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m1));

		await emitTurnEnd(receiver, "aborted", "aborted");
		await receiver.handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "aborted" }] }, receiver.ctx);
		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		await emitTurnEnd(receiver, "normal turn", "stop");
		await receiver.handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "stop" }] }, receiver.ctx);

		await deliverLatestInbound(receiver, m2);
		await emitTurnEnd(receiver, "reply to m2", "stop");
		await waitUntil(async () => (await peerB.tools.get("coms_get").execute("g2", { msg_id: m2 })).details.status === "complete");
		assert.equal((await peerB.tools.get("coms_get").execute("g2-check", { msg_id: m2 })).details.response, "reply to m2");
		assert.equal(readRegistry(receiver).busy, false);
		assert.equal(readRegistry(receiver).queue_depth, 0);
	});

	it("defers followUpQueued re-injection until agent_settled while Pi reports streaming", async () => {
		const { workspace, comsDir } = makeWorkspace();
		let idle = false;
		const sender = await startPeer({ name: "sender", sessionId: "s-set", project: "p-1429-set", cwd: workspace, comsDir });
		const receiver = await startPeer({
			name: "receiver",
			sessionId: "r-set",
			project: "p-1429-set",
			cwd: workspace,
			comsDir,
			isIdle: () => idle,
		});

		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		const r1 = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "wait for settled" });
		const m1 = r1.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m1));

		await emitTurnEnd(receiver, "aborted", "aborted");
		await receiver.handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "aborted" }] }, receiver.ctx);
		assert.equal(receiver.messages.filter((m) => m?.details?.msg_id === m1).length, 1);

		idle = true;
		await receiver.handlers.get("agent_settled")!({ aborted: true }, receiver.ctx);
		const copies = receiver.messages.filter((m) => m?.details?.msg_id === m1);
		assert.equal(copies.length, 2);
		assert.equal(copies[1]?.details?.inject_attempt, 1);
	});

	it("strips a superseded attempt-0 copy from context after attempt-1 re-injection", async () => {
		const { workspace, comsDir } = makeWorkspace();
		let idle = false;
		let abortCalls = 0;
		const sender = await startPeer({ name: "sender", sessionId: "s-sup", project: "p-1429-sup", cwd: workspace, comsDir });
		const receiver = await startPeer({
			name: "receiver",
			sessionId: "r-sup",
			project: "p-1429-sup",
			cwd: workspace,
			comsDir,
			isIdle: () => idle,
			abort: () => { abortCalls++; },
		});

		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		const r1 = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "superseded check" });
		const m1 = r1.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m1));
		const attempt0Msg = { role: "custom", ...receiver.messages.find((m) => m?.details?.msg_id === m1) };

		await emitTurnEnd(receiver, "aborted", "aborted");
		await receiver.handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "aborted" }] }, receiver.ctx);
		idle = true;
		await receiver.handlers.get("agent_settled")!({ aborted: true }, receiver.ctx);

		await receiver.handlers.get("message_start")!({ message: attempt0Msg });
		const priorAssistant = { role: "assistant", content: [{ type: "text", text: "earlier" }] };
		const ctxResult = receiver.handlers.get("context")!(
			{ type: "context", messages: [priorAssistant, attempt0Msg] },
			receiver.ctx,
		);
		assert.deepEqual(ctxResult?.messages, [priorAssistant]);
		assert.equal(abortCalls, 1);

		await deliverLatestInbound(receiver, m1);
		await emitTurnEnd(receiver, "attempt-1 reply", "stop");
		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g1", { msg_id: m1 })).details.status === "complete");
		assert.equal((await sender.tools.get("coms_get").execute("g1-check", { msg_id: m1 })).details.response, "attempt-1 reply");
	});

	it("cancels deferred agent_settled re-injection when auto-retry delivers attempt 0", async () => {
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

		await receiver.handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "error" }] }, receiver.ctx);
		await deliverLatestInbound(receiver, m1);
		await emitTurnEnd(receiver, "delivered via auto-retry", "stop");
		idle = true;
		await receiver.handlers.get("agent_settled")!({ aborted: false }, receiver.ctx);

		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g1", { msg_id: m1 })).details.status === "complete");
		assert.equal(receiver.messages.filter((m) => m?.details?.msg_id === m1).length, 1);
		assert.equal((await sender.tools.get("coms_get").execute("g1-check", { msg_id: m1 })).details.response, "delivered via auto-retry");
	});
});

describe("COMS reload queue persistence (#1430)", () => {
	it("writes a 0600 reload handoff file without sending premature session_closed", async () => {
		const { peerA, peerB, peerC, m1, m2, m3, handoffPath } = await setupThreeSenderReloadQueue("p-1430-mode", "r-mode-1430");

		assert.equal(existsSync(handoffPath), true);
		if (process.platform !== "win32") {
			assert.equal(statSync(handoffPath).mode & 0o777, 0o600);
		}
		assert.equal((await peerA.tools.get("coms_get").execute("ga-pre", { msg_id: m1 })).details.status, "pending");
		assert.equal((await peerB.tools.get("coms_get").execute("gb-pre", { msg_id: m2 })).details.status, "pending");
		assert.equal((await peerC.tools.get("coms_get").execute("gc-pre", { msg_id: m3 })).details.status, "pending");
	});

	it("persists undelivered head followed by priority-before-FIFO order with full metadata", async () => {
		const { m1, m2, m3, handoffPath } = await setupThreeSenderReloadQueue("p-1430-meta", "r-meta-1430");

		const persisted = JSON.parse(readFileSync(handoffPath, "utf-8"));
		assert.deepEqual(
			persisted.items.map((i: any) => i.msg_id),
			[m1, m3, m2],
		);
		assert.equal(persisted.items[0].conversation_id, "conv-1");
		assert.deepEqual(persisted.items[0].tasks, [{ subject: "T1", description: "Do T1" }]);
		assert.equal(persisted.items[1].priority, true);
	});

	it("strips a ghost pre-reload attempt-0 copy on the reloaded peer", async () => {
		const { workspace, comsDir, project, receiverSessionId, receiver1, m1, handoffPath } =
			await setupThreeSenderReloadQueue("p-1430-ghost", "r-ghost-1430");

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
		assert.equal(existsSync(handoffPath), false);

		const ghostM1 = { role: "custom", ...receiver1.messages.find((m) => m?.details?.msg_id === m1) };
		const ctxRes = receiver2.handlers.get("context")!(
			{ type: "context", messages: [{ role: "assistant", content: [{ type: "text", text: "old" }] }, ghostM1] },
			receiver2.ctx,
		);
		assert.equal(ctxRes?.messages.length, 1);
		assert.equal(abortCalls, 1);
	});

	it("delivers the restored head reply with bumped inject_attempt", async () => {
		const { workspace, comsDir, project, receiverSessionId, peerA, m1 } =
			await setupThreeSenderReloadQueue("p-1430-head", "r-head-1430");

		const receiver2 = await startPeer({
			name: "receiver",
			sessionId: receiverSessionId,
			project,
			cwd: workspace,
			comsDir,
			reload: true,
		});

		const m1Restored = await deliverLatestInbound(receiver2, m1);
		assert.equal(m1Restored.details.inject_attempt, 1);
		await emitTurnEnd(receiver2, "reply-m1-after-reload", "stop");
		await waitUntil(async () => (await peerA.tools.get("coms_get").execute("ga-done", { msg_id: m1 })).details.status === "complete");
		assert.equal((await peerA.tools.get("coms_get").execute("ga-check", { msg_id: m1 })).details.response, "reply-m1-after-reload");
	});

	it("drains restored priority messages before normal FIFO messages", async () => {
		const { workspace, comsDir, project, receiverSessionId, peerB, peerC, m1, m2, m3 } =
			await setupThreeSenderReloadQueue("p-1430-prio", "r-prio-1430");

		const receiver2 = await startPeer({
			name: "receiver",
			sessionId: receiverSessionId,
			project,
			cwd: workspace,
			comsDir,
			reload: true,
		});

		await deliverLatestInbound(receiver2, m1);
		await emitTurnEnd(receiver2, "reply-m1", "stop");

		await deliverLatestInbound(receiver2, m3);
		assert.equal(receiver2.messages.some((m) => m?.details?.msg_id === m2), false);
		await emitTurnEnd(receiver2, "reply-m3-priority", "stop");
		await waitUntil(async () => (await peerC.tools.get("coms_get").execute("gc-done", { msg_id: m3 })).details.status === "complete");
		assert.equal((await peerC.tools.get("coms_get").execute("gc-check", { msg_id: m3 })).details.response, "reply-m3-priority");

		await deliverLatestInbound(receiver2, m2);
		await emitTurnEnd(receiver2, "reply-m2-normal", "stop");
		await waitUntil(async () => (await peerB.tools.get("coms_get").execute("gb-done", { msg_id: m2 })).details.status === "complete");
		assert.equal((await peerB.tools.get("coms_get").execute("gb-check", { msg_id: m2 })).details.response, "reply-m2-normal");
	});

	it("resets busy to false with zero queue_depth once all restored items complete", async () => {
		const { workspace, comsDir, project, receiverSessionId, m1, m2, m3 } =
			await setupThreeSenderReloadQueue("p-1430-idle", "r-idle-1430");

		const receiver2 = await startPeer({
			name: "receiver",
			sessionId: receiverSessionId,
			project,
			cwd: workspace,
			comsDir,
			reload: true,
		});

		for (const id of [m1, m3, m2]) {
			await deliverLatestInbound(receiver2, id);
			await emitTurnEnd(receiver2, `reply-${id}`, "stop");
		}
		await waitUntil(() => readRegistry(receiver2).busy === false);
		assert.equal(readRegistry(receiver2).busy, false);
		assert.equal(readRegistry(receiver2).queue_depth, 0);
	});

	it("preserves queued inbounds across coms-wrapper reload", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const project = "p-1430-wrap";
		const receiverSessionId = "r-wrap-1430";
		const sender = await startPeer({ name: "sender", sessionId: "s-wrap-1430", project, cwd: workspace, comsDir });

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
	});

	it("preserves queued inbounds across reload when global session ID is set after initial start", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const project = "p-1430-early";
		const sender = await startPeer({ name: "sender", sessionId: "s-early-1430", project, cwd: workspace, comsDir });

		// Simulate early startup before orchestrator publishes globalThis.__piConfigSessionId.
		delete (globalThis as any).__piConfigSessionId;
		const w1 = createFakePi();
		const reg1 = registerComs(w1.pi, {
			comsDir,
			allowSubagentChild: true,
			registerSignalHandlers: false,
		});
		activePeers.push({ shutdown: () => reg1.runtime.stop({ reason: "test_cleanup" }) });
		const ctx1 = makeCtx(workspace, "pi-sid-early", { entries: w1.customEntries });
		await w1.handlers.get("session_start")!({ reason: "startup" }, ctx1);
		const startRes = await w1.tools.get("coms_start").execute("cs1", { cname: "early-recv", project }, undefined, undefined, ctx1);
		assert.equal(startRes.details.ok, true);
		const initialComsId = reg1.runtime.getSelf()?.sessionId;
		assert.ok(initialComsId, "early-started peer received a generated COMS session ID");

		// Orchestrator later sets a different global session ID before /reload runs.
		(globalThis as any).__piConfigSessionId = "later-orchestrator-sid";

		const sent = await sender.tools.get("coms_send").execute("s1", { target: "early-recv", prompt: "early peer msg" });
		const m1 = sent.details.msg_id as string;
		await waitUntil(() => w1.messages.some((m) => m?.details?.msg_id === m1));

		await w1.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, ctx1);

		const w2 = createFakePi();
		const reg2 = registerComs(w2.pi, {
			comsDir,
			allowSubagentChild: true,
			registerSignalHandlers: false,
		});
		activePeers.push({ shutdown: () => reg2.runtime.stop({ reason: "test_cleanup" }) });
		const ctx2 = makeCtx(workspace, "pi-sid-early", { entries: w1.customEntries });
		await w2.handlers.get("session_start")!({ type: "session_start", reason: "reload" }, ctx2);

		assert.equal(reg2.runtime.getSelf()?.sessionId, initialComsId);
		await waitUntil(() => w2.messages.some((m) => m?.details?.msg_id === m1));
		const restoredMsg = [...w2.messages].reverse().find((m) => m?.details?.msg_id === m1);
		await w2.handlers.get("message_start")!({ message: { role: "custom", ...restoredMsg } });
		await w2.handlers.get("turn_end")!(
			{ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "early peer reply" }], stopReason: "stop" }, toolResults: [] },
			ctx2,
		);
		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g1-done", { msg_id: m1 })).details.status === "complete");
		assert.equal((await sender.tools.get("coms_get").execute("g1-check", { msg_id: m1 })).details.response, "early peer reply");
	});

	it("replies session_closed without writing a handoff file on explicit coms_stop", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const project = "p-1430-stop";
		const receiverSessionId = "r-stop-1430";
		const sender = await startPeer({ name: "sender", sessionId: "s-stop-1430", project, cwd: workspace, comsDir });

		const w = createFakePi();
		const reg = registerComs(w.pi, {
			comsDir,
			sessionId: receiverSessionId,
			allowSubagentChild: true,
			registerSignalHandlers: false,
		});
		activePeers.push({ shutdown: () => reg.runtime.stop({ reason: "test_cleanup" }) });
		const ctx = makeCtx(workspace, receiverSessionId, { entries: w.customEntries });
		await w.handlers.get("session_start")!({ reason: "startup" }, ctx);
		await w.tools.get("coms_start").execute("cs1", { cname: "stop-recv", project }, undefined, undefined, ctx);

		const sent = await sender.tools.get("coms_send").execute("s1", { target: "stop-recv", prompt: "stopped" });
		const m1 = sent.details.msg_id as string;
		await waitUntil(() => w.messages.some((m) => m?.details?.msg_id === m1));

		await w.tools.get("coms_stop").execute("stop1", {}, undefined, undefined, ctx);
		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g1", { msg_id: m1 })).details.status === "complete");
		assert.equal((await sender.tools.get("coms_get").execute("g1-check", { msg_id: m1 })).details.error, "session_closed");
		assert.equal(existsSync(new ComsRegistry(comsDir).reloadQueuePath(project, receiverSessionId)), false);
	});

	it("replies session_closed removing the handoff file when reload TTL expires", async () => {
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

		await receiver.shutdown({ reason: "reload" });
		const handoffPath = new ComsRegistry(comsDir).reloadQueuePath(project, receiverSessionId);
		assert.equal(existsSync(handoffPath), true);

		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g1-exp", { msg_id: m1 })).details.status === "complete");
		assert.equal((await sender.tools.get("coms_get").execute("g1-check", { msg_id: m1 })).details.error, "session_closed");
		assert.equal(existsSync(handoffPath), false);
	});

	it("discards a pre-existing expired handoff file on startup with session_closed", async () => {
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
		assert.equal(receiver2.messages.some((m) => m?.details?.msg_id === m1), false);
		assert.equal(existsSync(handoffPath), false);
	});

	it("replies session_closed without a handoff file on quit shutdown", async () => {
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

	it("notifies waiting senders with session_closed when process.exit fires mid-reload", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const project = "p-1430-exit";
		const receiverSessionId = "r-exit-1430";
		const sender = await startPeer({ name: "sender", sessionId: "s-exit-1430", project, cwd: workspace, comsDir });
		const readyMarker = join(workspace, "child-ready");
		const exitMarker = join(workspace, "child-exit");

		const childScript = `
			import { existsSync, writeFileSync } from "node:fs";
			import { createComsPeerRuntime } from "./extensions/coms/coms-p2p.js";
			const messages = [];
			const pi = {
				registerFlag() {},
				getFlag() { return undefined; },
				registerTool() {},
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer() {},
				getActiveTools() { return []; },
				getAllTools() { return []; },
				setActiveTools() {},
				on() {},
				sendMessage(m) { messages.push(m); },
				events: { emit() {}, on() { return () => {}; } },
			};
			const runtime = createComsPeerRuntime(pi, {
				deferred: true,
				comsDir: ${JSON.stringify(comsDir)},
				sessionId: ${JSON.stringify(receiverSessionId)},
				allowSubagentChild: true,
				registerSignalHandlers: false,
			});
			const ctx = {
				cwd: ${JSON.stringify(workspace)},
				mode: "tui",
				hasUI: false,
				model: { id: "test-model" },
				ui: { notify() {}, setStatus() {}, setWidget() {}, setTheme() { return { success: true }; }, setTitle() {} },
				sessionManager: { getSessionId: () => ${JSON.stringify(receiverSessionId)}, getEntries: () => [], getBranch: () => [] },
			};
			await runtime.start(ctx, { flags: { cname: "exit-recv", project: ${JSON.stringify(project)} } });
			writeFileSync(${JSON.stringify(readyMarker)}, "ready");
			while (!existsSync(${JSON.stringify(exitMarker)})) {
				await new Promise((r) => setTimeout(r, 15));
			}
			await runtime.stop({ reason: "reload" });
			process.exit(0);
		`;
		const childPromise = new Promise<void>((resolve, reject) => {
			execFile(
				process.execPath,
				["--import", "tsx", "--input-type=module", "-e", childScript],
				{ cwd: process.cwd(), timeout: 30_000 },
				(err) => (err ? reject(err) : resolve()),
			);
		});

		await waitUntil(() => existsSync(readyMarker), 20_000);
		const sent = await sender.tools.get("coms_send").execute("s1", { target: "exit-recv", prompt: "interrupted by process.exit" });
		const m1 = sent.details.msg_id as string;
		writeFileSync(exitMarker, "go");
		await childPromise;

		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g1-exit", { msg_id: m1 })).details.status === "complete");
		assert.equal((await sender.tools.get("coms_get").execute("g1-check", { msg_id: m1 })).details.error, "session_closed");
		assert.equal(existsSync(new ComsRegistry(comsDir).reloadQueuePath(project, receiverSessionId)), false);
	});

	it("preserves undelivered bundled same-sender inbounds across reload", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const project = "p-1430-bundle";
		const receiverSessionId = "r-bundle-1430";
		const peerA = await startPeer({ name: "peer-a", sessionId: "s-bnd-a", project, cwd: workspace, comsDir });
		const peerB = await startPeer({ name: "peer-b", sessionId: "s-bnd-b", project, cwd: workspace, comsDir });
		const receiver1 = await startPeer({ name: "receiver", sessionId: receiverSessionId, project, cwd: workspace, comsDir });

		const r0 = await peerA.tools.get("coms_send").execute("s0", { target: "receiver", prompt: "blocker" });
		const m0 = r0.details.msg_id as string;
		await deliverLatestInbound(receiver1, m0);

		const rb1 = await peerB.tools.get("coms_send").execute("sb1", { target: "receiver", prompt: "part 1" });
		const rb2 = await peerB.tools.get("coms_send").execute("sb2", { target: "receiver", prompt: "part 2" });
		const b1 = rb1.details.msg_id as string;
		const b2 = rb2.details.msg_id as string;

		await emitTurnEnd(receiver1, "done blocker", "stop");
		await waitUntil(() => receiver1.messages.some((m) => m?.details?.msg_id === b1));

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

	it("settles all restored senders with injection_failed when reload bundle injection throws", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const project = "p-1430-fail";
		const receiverSessionId = "r-fail-1430";
		const peerA = await startPeer({ name: "peer-a", sessionId: "s-fl-a", project, cwd: workspace, comsDir });
		const peerB = await startPeer({ name: "peer-b", sessionId: "s-fl-b", project, cwd: workspace, comsDir });
		const receiver1 = await startPeer({ name: "receiver", sessionId: receiverSessionId, project, cwd: workspace, comsDir });

		// Queue two messages from peer-a plus one from peer-b behind a delivered blocker so [a1, a2, b1] persist.
		const r0 = await peerB.tools.get("coms_send").execute("s0", { target: "receiver", prompt: "blocker" });
		const m0 = r0.details.msg_id as string;
		await deliverLatestInbound(receiver1, m0);

		const ra1 = await peerA.tools.get("coms_send").execute("sa1", { target: "receiver", prompt: "bundle 1" });
		const ra2 = await peerA.tools.get("coms_send").execute("sa2", { target: "receiver", prompt: "bundle 2" });
		const rb1 = await peerB.tools.get("coms_send").execute("sb1", { target: "receiver", prompt: "tail msg" });
		const a1 = ra1.details.msg_id as string;
		const a2 = ra2.details.msg_id as string;
		const b1 = rb1.details.msg_id as string;

		await receiver1.shutdown({ reason: "reload" });

		// Reloaded peer throws on any inbound sendMessage injection (bundle fail_orphans path).
		const receiver2 = await startPeer({
			name: "receiver",
			sessionId: receiverSessionId,
			project,
			cwd: workspace,
			comsDir,
			reload: true,
			onSendMessage: (msg) => {
				if (msg?.details?.msg_id) throw new Error("simulated sendMessage failure");
			},
		});

		await waitUntil(async () => {
			const ga1 = await peerA.tools.get("coms_get").execute("ga1", { msg_id: a1 });
			const ga2 = await peerA.tools.get("coms_get").execute("ga2", { msg_id: a2 });
			const gb1 = await peerB.tools.get("coms_get").execute("gb1", { msg_id: b1 });
			return ga1.details.status === "complete" && ga2.details.status === "complete" && gb1.details.status === "complete";
		});
		assert.equal((await peerA.tools.get("coms_get").execute("ga1-c", { msg_id: a1 })).details.error, "injection_failed");
		assert.equal((await peerA.tools.get("coms_get").execute("ga2-c", { msg_id: a2 })).details.error, "injection_failed");
		assert.equal((await peerB.tools.get("coms_get").execute("gb1-c", { msg_id: b1 })).details.error, "injection_failed");
		assert.equal(readRegistry(receiver2).busy, false);
	});

	it("closes already-delivered bundled siblings with session_closed during reload while preserving later queued items", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const project = "p-1430-deliv";
		const receiverSessionId = "r-deliv-1430";
		const peerA = await startPeer({ name: "peer-a", sessionId: "s-dlv-a", project, cwd: workspace, comsDir });
		const peerB = await startPeer({ name: "peer-b", sessionId: "s-dlv-b", project, cwd: workspace, comsDir });
		const peerC = await startPeer({ name: "peer-c", sessionId: "s-dlv-c", project, cwd: workspace, comsDir });
		const receiver1 = await startPeer({ name: "receiver", sessionId: receiverSessionId, project, cwd: workspace, comsDir });

		// Occupy receiver with m0, queue [b1, b2] from peer-b, finish m0 so [b1, b2] become the active bundle.
		const r0 = await peerA.tools.get("coms_send").execute("s0", { target: "receiver", prompt: "blocker" });
		const m0 = r0.details.msg_id as string;
		await deliverLatestInbound(receiver1, m0);

		const rb1 = await peerB.tools.get("coms_send").execute("sb1", { target: "receiver", prompt: "bundled 1" });
		const rb2 = await peerB.tools.get("coms_send").execute("sb2", { target: "receiver", prompt: "bundled 2" });
		const b1 = rb1.details.msg_id as string;
		const b2 = rb2.details.msg_id as string;
		await emitTurnEnd(receiver1, "done blocker", "stop");

		// Deliver [b1, b2] into the turn, then queue c1 behind it, then trigger reload shutdown.
		await deliverLatestInbound(receiver1, b1);
		const rc1 = await peerC.tools.get("coms_send").execute("sc1", { target: "receiver", prompt: "queued after bundle" });
		const c1 = rc1.details.msg_id as string;

		await receiver1.shutdown({ reason: "reload" });

		// Both b1 and its already-delivered sibling b2 must receive session_closed; c1 must stay pending.
		await waitUntil(async () => {
			const gb1 = await peerB.tools.get("coms_get").execute("gb1", { msg_id: b1 });
			const gb2 = await peerB.tools.get("coms_get").execute("gb2", { msg_id: b2 });
			return gb1.details.status === "complete" && gb2.details.status === "complete";
		});
		assert.equal((await peerB.tools.get("coms_get").execute("gb1-c", { msg_id: b1 })).details.error, "session_closed");
		assert.equal((await peerB.tools.get("coms_get").execute("gb2-c", { msg_id: b2 })).details.error, "session_closed");
		assert.equal((await peerC.tools.get("coms_get").execute("gc1-pre", { msg_id: c1 })).details.status, "pending");

		// Reloaded peer receives ONLY c1 (never re-runs b1 or b2).
		const receiver2 = await startPeer({
			name: "receiver",
			sessionId: receiverSessionId,
			project,
			cwd: workspace,
			comsDir,
			reload: true,
		});
		await deliverLatestInbound(receiver2, c1);
		assert.equal(receiver2.messages.some((m) => m?.details?.msg_id === b1 || m?.details?.msg_id === b2), false);
		await emitTurnEnd(receiver2, "reply to c1", "stop");
		await waitUntil(async () => (await peerC.tools.get("coms_get").execute("gc1-done", { msg_id: c1 })).details.status === "complete");
		assert.equal((await peerC.tools.get("coms_get").execute("gc1-c", { msg_id: c1 })).details.response, "reply to c1");
	});

	it("retains the reload handoff file when the sender closes without acknowledging on process.exit", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const project = "p-1430-noack";
		const receiverSessionId = "r-noack-1430";
		const silentSock = join(workspace, "silent-sender.sock");
		const server = net.createServer((sock) => {
			sock.once("data", () => { sock.end(); });
		});
		await new Promise<void>((resolve) => server.listen(silentSock, resolve));
		activePeers.push({ shutdown: () => new Promise<void>((resolve) => server.close(() => resolve())) });

		const readyMarker = join(workspace, "noack-ready");
		const exitMarker = join(workspace, "noack-exit");
		const childScript = `
			import { existsSync, writeFileSync } from "node:fs";
			import { createComsPeerRuntime } from "./extensions/coms/coms-p2p.js";
			const pi = {
				registerFlag() {},
				getFlag() { return undefined; },
				registerTool() {},
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer() {},
				getActiveTools() { return []; },
				getAllTools() { return []; },
				setActiveTools() {},
				on() {},
				sendMessage() {},
				events: { emit() {}, on() { return () => {}; } },
			};
			const runtime = createComsPeerRuntime(pi, {
				deferred: true,
				comsDir: ${JSON.stringify(comsDir)},
				sessionId: ${JSON.stringify(receiverSessionId)},
				allowSubagentChild: true,
				registerSignalHandlers: false,
			});
			const ctx = {
				cwd: ${JSON.stringify(workspace)},
				mode: "tui",
				hasUI: false,
				model: { id: "test-model" },
				ui: { notify() {}, setStatus() {}, setWidget() {}, setTheme() { return { success: true }; }, setTitle() {} },
				sessionManager: { getSessionId: () => ${JSON.stringify(receiverSessionId)}, getEntries: () => [], getBranch: () => [] },
			};
			await runtime.start(ctx, { flags: { cname: "noack-recv", project: ${JSON.stringify(project)} } });
			writeFileSync(${JSON.stringify(readyMarker)}, "ready");
			while (!existsSync(${JSON.stringify(exitMarker)})) {
				await new Promise((r) => setTimeout(r, 15));
			}
			await runtime.stop({ reason: "reload" });
			process.exit(0);
		`;
		const childPromise = new Promise<void>((resolve, reject) => {
			execFile(
				process.execPath,
				["--import", "tsx", "--input-type=module", "-e", childScript],
				{ cwd: process.cwd(), timeout: 30_000 },
				(err) => (err ? reject(err) : resolve()),
			);
		});

		await waitUntil(() => existsSync(readyMarker), 20_000);
		const recvSock = new ComsRegistry(comsDir).makeEndpoint(receiverSessionId);
		await new Promise<void>((resolve, reject) => {
			const s = net.createConnection({ path: recvSock }, () => {
				s.write(JSON.stringify({
					type: "prompt",
					msg_id: "msg-noack-1",
					sender_session: "silent-session",
					sender_endpoint: silentSock,
					sender_name: "silent-sender",
					sender_cwd: workspace,
					hops: 0,
					timestamp: new Date().toISOString(),
					prompt: "needs ack",
				}) + "\n");
			});
			s.once("data", () => { s.destroy(); resolve(); });
			s.once("error", reject);
		});
		writeFileSync(exitMarker, "go");
		await childPromise;

		const handoffPath = new ComsRegistry(comsDir).reloadQueuePath(project, receiverSessionId);
		assert.equal(existsSync(handoffPath), true);
	});

	it("replies session_closed without persisting when an explicit stop overlaps reload shutdown", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const project = "p-1430-overlap";
		const receiverSessionId = "r-overlap-1430";
		const sender = await startPeer({ name: "sender", sessionId: "s-overlap-1430", project, cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: receiverSessionId, project, cwd: workspace, comsDir });

		const sent = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "overlapped stop" });
		const m1 = sent.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m1));

		// Fire reload shutdown and immediately overlap an explicit non-reload stop before reload finishes awaiting worker exit.
		const reloadPromise = receiver.shutdown({ reason: "reload" });
		const explicitStopPromise = receiver.shutdown({ reason: "stop" });
		await Promise.all([reloadPromise, explicitStopPromise]);

		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g1-ov", { msg_id: m1 })).details.status === "complete");
		assert.equal((await sender.tools.get("coms_get").execute("g1-check", { msg_id: m1 })).details.error, "session_closed");
		assert.equal(existsSync(new ComsRegistry(comsDir).reloadQueuePath(project, receiverSessionId)), false);
	});

	it("terminates on SIGTERM during reload handoff after notifying waiting senders", async () => {
		if (process.platform === "win32") return;
		const { workspace, comsDir } = makeWorkspace();
		const project = "p-1430-sigterm";
		const receiverSessionId = "r-sigterm-1430";
		const sender = await startPeer({ name: "sender", sessionId: "s-sigterm-1430", project, cwd: workspace, comsDir });
		const readyMarker = join(workspace, "sigterm-ready");
		const persistedMarker = join(workspace, "sigterm-persisted");
		const goReloadMarker = join(workspace, "sigterm-reload");

		const childScript = `
			import { existsSync, writeFileSync } from "node:fs";
			import { createComsPeerRuntime } from "./extensions/coms/coms-p2p.js";
			const pi = {
				registerFlag() {},
				getFlag() { return undefined; },
				registerTool() {},
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer() {},
				getActiveTools() { return []; },
				getAllTools() { return []; },
				setActiveTools() {},
				on() {},
				sendMessage() {},
				events: { emit() {}, on() { return () => {}; } },
			};
			const runtime = createComsPeerRuntime(pi, {
				deferred: true,
				comsDir: ${JSON.stringify(comsDir)},
				sessionId: ${JSON.stringify(receiverSessionId)},
				allowSubagentChild: true,
				registerSignalHandlers: true,
			});
			const ctx = {
				cwd: ${JSON.stringify(workspace)},
				mode: "tui",
				hasUI: false,
				model: { id: "test-model" },
				ui: { notify() {}, setStatus() {}, setWidget() {}, setTheme() { return { success: true }; }, setTitle() {} },
				sessionManager: { getSessionId: () => ${JSON.stringify(receiverSessionId)}, getEntries: () => [], getBranch: () => [] },
			};
			await runtime.start(ctx, { flags: { cname: "sigterm-recv", project: ${JSON.stringify(project)} } });
			writeFileSync(${JSON.stringify(readyMarker)}, "ready");
			while (!existsSync(${JSON.stringify(goReloadMarker)})) {
				await new Promise((r) => setTimeout(r, 15));
			}
			await runtime.stop({ reason: "reload" });
			writeFileSync(${JSON.stringify(persistedMarker)}, "persisted");
			setInterval(() => {}, 1_000);
		`;
		const child = spawn(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", childScript],
			{ cwd: process.cwd(), stdio: "ignore" },
		);
		const exitInfo = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			child.once("exit", (code, signal) => resolve({ code, signal }));
		});
		activePeers.push({ shutdown: async () => { try { child.kill("SIGKILL"); } catch { /* ignore */ } } });

		await waitUntil(() => existsSync(readyMarker), 20_000);
		const sent = await sender.tools.get("coms_send").execute("s1", { target: "sigterm-recv", prompt: "sigterm mid reload" });
		const m1 = sent.details.msg_id as string;
		writeFileSync(goReloadMarker, "go");
		await waitUntil(() => existsSync(persistedMarker), 10_000);

		child.kill("SIGTERM");
		const exited = await exitInfo;
		assert.equal(exited.signal, "SIGTERM");

		await waitUntil(async () => (await sender.tools.get("coms_get").execute("g1-sig", { msg_id: m1 })).details.status === "complete");
		assert.equal((await sender.tools.get("coms_get").execute("g1-check", { msg_id: m1 })).details.error, "session_closed");
		assert.equal(existsSync(new ComsRegistry(comsDir).reloadQueuePath(project, receiverSessionId)), false);
	});
});
