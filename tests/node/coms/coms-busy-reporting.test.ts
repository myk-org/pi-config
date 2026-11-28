/**
 * Unit tests for #1466: accurate COMS busy reporting during non-inbound agent turns
 * (async follow-ups, reminder turns, user turns) across registry entries and agent cards.
 *
 * Run with: npx tsx --test --test-concurrency=4 tests/node/coms/coms-busy-reporting.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

import {
	createComsPeerRuntime,
	type ComsPeerRuntime,
	type ComsPeerStopOptions,
} from "../../../extensions/coms/coms-p2p.js";
import { resetSessionBridge } from "../../../extensions/shared/session-bridge.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

interface TestPeer {
	name: string;
	sessionId: string;
	endpoint: string;
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
		const peer = activePeers.pop()!;
		try { await peer.shutdown(); } catch { /* ignore */ }
	}
	resetSessionBridge({ all: true });
	delete (globalThis as any).__piConfigSessionId;
});

function makeWorkspace(): { workspace: string; comsDir: string } {
	const workspace = makeTempDir("coms-busy-1466-");
	const comsDir = join(workspace, "coms");
	mkdirSync(join(workspace, ".pi"), { recursive: true });
	writeFileSync(join(workspace, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: comsDir }));
	return { workspace, comsDir };
}

function makeCtx(cwd: string, sessionId: string, opts: { isIdle?: () => boolean } = {}): any {
	return {
		cwd,
		mode: "tui",
		hasUI: false,
		model: { id: "test-model" },
		...(opts.isIdle ? { isIdle: opts.isIdle } : {}),
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setTheme: () => ({ success: true }),
			setTitle: () => {},
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => [],
			getBranch: () => [],
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
}): Promise<TestPeer> {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function>();
	const messages: any[] = [];
	const flags: Record<string, any> = { cname: opts.name, project: opts.project };
	const listeners = new Map<string, Set<(data?: any) => void>>();
	const pi: any = {
		registerFlag() {},
		getFlag(name: string) { return flags[name]; },
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		getAllTools() { return [...tools.values()]; },
		on(name: string, fn: Function) { handlers.set(name, fn); },
		sendMessage(msg: any) { messages.push(msg); },
		appendEntry() {},
		getActiveTools() { return [...tools.keys()]; },
		setActiveTools() {},
		events: {
			emit(event: string, data?: any) {
				for (const fn of [...(listeners.get(event) ?? [])]) fn(data);
			},
			on(event: string, fn: (data?: any) => void) {
				if (!listeners.has(event)) listeners.set(event, new Set());
				listeners.get(event)!.add(fn);
				return () => { listeners.get(event)?.delete(fn); };
			},
		},
	};

	const runtime = createComsPeerRuntime(pi, {
		deferred: true,
		comsDir: opts.comsDir,
		sessionId: opts.sessionId,
		allowSubagentChild: true,
	});
	const ctx = makeCtx(opts.cwd, opts.sessionId, { isIdle: opts.isIdle });
	const self = await runtime.start(ctx, { origin: "tool" });
	assert.ok(self, `peer ${opts.name} must start`);

	const shutdown = async (stopOpts?: ComsPeerStopOptions) => {
		await runtime.stop(stopOpts);
	};
	activePeers.push({ shutdown });
	return {
		name: opts.name,
		sessionId: opts.sessionId,
		endpoint: self.endpoint,
		registryFile: self.registryFile,
		tools,
		handlers,
		messages,
		ctx,
		runtime,
		shutdown,
	};
}

function readRegistry(peer: TestPeer): { busy?: boolean; queue_depth?: number } {
	return JSON.parse(readFileSync(peer.registryFile, "utf-8"));
}

async function pingAgentCard(endpoint: string): Promise<{ busy: boolean; queue_depth: number; name: string }> {
	return await new Promise((resolve, reject) => {
		const sock = net.createConnection({ path: endpoint });
		let buf = "";
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error(`ping timed out for ${endpoint}`));
		}, 2_000);
		sock.on("connect", () => {
			sock.write(JSON.stringify({
				type: "ping",
				msg_id: "ping-1466",
				sender_session: "probe",
				sender_endpoint: "",
				hops: 0,
				timestamp: new Date().toISOString(),
			}) + "\n");
		});
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf-8");
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			clearTimeout(timer);
			sock.destroy();
			const pong = JSON.parse(buf.slice(0, nl));
			resolve(pong.agent_card);
		});
		sock.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

async function waitUntil(pred: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await pred()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	assert.fail(`waitUntil timed out after ${timeoutMs}ms`);
}

describe("COMS busy reporting during non-inbound agent turns (#1466)", () => {
	it("reports busy true in the registry during a non-inbound agent_start turn", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peer = await startPeer({ name: "worker", sessionId: "s-reg-1466", project: "p-1466", cwd: workspace, comsDir });

		assert.equal(Boolean(readRegistry(peer).busy), false);

		await peer.handlers.get("agent_start")!({}, peer.ctx);

		assert.equal(readRegistry(peer).busy, true);
		assert.equal(readRegistry(peer).queue_depth, 0);
	});

	it("reports busy true in the ping agent card during a non-inbound agent_start turn", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peer = await startPeer({ name: "worker", sessionId: "s-card-1466", project: "p-1466", cwd: workspace, comsDir });

		assert.equal((await pingAgentCard(peer.endpoint)).busy, false);

		await peer.handlers.get("agent_start")!({}, peer.ctx);

		const mainCard = await pingAgentCard(peer.endpoint);
		assert.equal(mainCard.busy, true);
		await waitUntil(async () => {
			try {
				return (await pingAgentCard(`${peer.endpoint}.ping`)).busy === true;
			} catch {
				return false;
			}
		});
	});

	it("marks the ping agent card busy on before_agent_start before agent_start fires", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peer = await startPeer({ name: "worker", sessionId: "s-before-1466", project: "p-1466", cwd: workspace, comsDir });

		await peer.handlers.get("before_agent_start")!({}, peer.ctx);

		assert.equal((await pingAgentCard(peer.endpoint)).busy, true);
	});

	it("writes busy true to the registry on before_agent_start before agent_start fires", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peer = await startPeer({ name: "worker", sessionId: "s-before-reg-1466", project: "p-1466", cwd: workspace, comsDir });

		assert.equal(Boolean(readRegistry(peer).busy), false);

		await peer.handlers.get("before_agent_start")!({}, peer.ctx);

		assert.equal(readRegistry(peer).busy, true);
	});

	it("updates the ping worker card to busy on before_agent_start before agent_start fires", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peer = await startPeer({ name: "worker", sessionId: "s-before-ping-1466", project: "p-1466", cwd: workspace, comsDir });

		await peer.handlers.get("before_agent_start")!({}, peer.ctx);

		await waitUntil(async () => {
			try {
				return (await pingAgentCard(`${peer.endpoint}.ping`)).busy === true;
			} catch {
				return false;
			}
		});
	});

	it("self-heals busy to false when live ctx.isIdle reports true after a missed agent_end", async () => {
		const { workspace, comsDir } = makeWorkspace();
		let idle = false;
		const peer = await startPeer({
			name: "worker",
			sessionId: "s-heal-1466",
			project: "p-1466",
			cwd: workspace,
			comsDir,
			isIdle: () => idle,
		});

		await peer.handlers.get("before_agent_start")!({}, peer.ctx);
		await peer.handlers.get("agent_start")!({}, peer.ctx);
		assert.equal(readRegistry(peer).busy, true);
		assert.equal((await pingAgentCard(peer.endpoint)).busy, true);

		// Simulate a missed agent_end/agent_settled: Pi returns to idle without emitting end hooks.
		idle = true;
		assert.equal((await pingAgentCard(peer.endpoint)).busy, false);
	});

	it("resets registry busy to false once agent_end finishes a non-inbound turn", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peer = await startPeer({ name: "worker", sessionId: "s-end-reg-1466", project: "p-1466", cwd: workspace, comsDir });

		await peer.handlers.get("agent_start")!({}, peer.ctx);
		assert.equal(readRegistry(peer).busy, true);

		await peer.handlers.get("agent_end")!({ messages: [] }, peer.ctx);

		assert.equal(readRegistry(peer).busy, false);
	});

	it("resets ping agent card busy to false once agent_end finishes a non-inbound turn", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peer = await startPeer({ name: "worker", sessionId: "s-end-card-1466", project: "p-1466", cwd: workspace, comsDir });

		await peer.handlers.get("agent_start")!({}, peer.ctx);
		assert.equal((await pingAgentCard(peer.endpoint)).busy, true);

		await peer.handlers.get("agent_end")!({ messages: [] }, peer.ctx);

		assert.equal((await pingAgentCard(peer.endpoint)).busy, false);
		await waitUntil(async () => {
			try {
				return (await pingAgentCard(`${peer.endpoint}.ping`)).busy === false;
			} catch {
				return false;
			}
		});
	});

	it("keeps busy true while ctx.isIdle returns false until agent_settled clears it", async () => {
		const { workspace, comsDir } = makeWorkspace();
		let idle = true;
		const peer = await startPeer({
			name: "worker",
			sessionId: "s-settled-1466",
			project: "p-1466",
			cwd: workspace,
			comsDir,
			isIdle: () => idle,
		});

		idle = false;
		await peer.handlers.get("agent_start")!({}, peer.ctx);
		assert.equal(readRegistry(peer).busy, true);

		// Pi emits agent_end while still settling (isIdle() === false).
		await peer.handlers.get("agent_end")!({ messages: [] }, peer.ctx);
		assert.equal(readRegistry(peer).busy, true);
		assert.equal((await pingAgentCard(peer.endpoint)).busy, true);

		// Once Pi settles (isIdle() === true), agent_settled flips busy back to false.
		idle = true;
		await peer.handlers.get("agent_settled")!({}, peer.ctx);
		assert.equal(readRegistry(peer).busy, false);
		assert.equal((await pingAgentCard(peer.endpoint)).busy, false);
	});

	it("clears busy tracking on stop so a restarted peer reports idle", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peer = await startPeer({ name: "worker", sessionId: "s-stop-1466", project: "p-1466", cwd: workspace, comsDir });

		await peer.handlers.get("agent_start")!({}, peer.ctx);
		assert.equal(readRegistry(peer).busy, true);

		await peer.shutdown();
		const restarted = await peer.runtime.start(peer.ctx, { origin: "tool" });
		assert.ok(restarted, "peer must restart cleanly");
		peer.registryFile = restarted.registryFile;
		peer.endpoint = restarted.endpoint;

		assert.equal(Boolean(readRegistry(peer).busy), false);
		assert.equal((await pingAgentCard(peer.endpoint)).busy, false);
	});

	it("preserves COMS inbound reply capture when non-inbound busy tracking toggles during an overlapping turn", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const sender = await startPeer({ name: "sender", sessionId: "s-send-1466", project: "p-overlap", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "s-recv-1466", project: "p-overlap", cwd: workspace, comsDir });

		// Non-inbound turn (e.g. async subagent follow-up) starts first.
		await receiver.handlers.get("before_agent_start")!({}, receiver.ctx);
		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		assert.equal(readRegistry(receiver).busy, true);

		// Peer inbound arrives during the non-inbound turn: processingInbound is false so it injects as followUp.
		const sent = await sender.tools.get("coms_send").execute("send-1", { target: "receiver", prompt: "status check" });
		const msgId = sent.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === msgId));
		const inboundMsg = receiver.messages.find((m) => m?.details?.msg_id === msgId);

		// Non-inbound turn ends before inbound delivery — must not capture the non-inbound text as peer reply.
		await receiver.handlers.get("turn_end")!({
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "async reminder done" }] },
			toolResults: [],
		}, receiver.ctx);
		assert.equal((await sender.tools.get("coms_get").execute("get-pre", { msg_id: msgId })).details.status, "pending");

		// Pi delivers the inbound message; its turn_end captures the exact peer reply.
		await receiver.handlers.get("message_start")!({ message: { role: "custom", ...inboundMsg } });
		await receiver.handlers.get("turn_end")!({
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "all green" }] },
			toolResults: [],
		}, receiver.ctx);
		await receiver.handlers.get("agent_end")!({ messages: [] }, receiver.ctx);

		await waitUntil(async () => (await sender.tools.get("coms_get").execute("get-wait", { msg_id: msgId })).details.status === "complete");
		const reply = await sender.tools.get("coms_get").execute("get-done", { msg_id: msgId });
		assert.equal(reply.details.error, null);
		assert.equal(reply.details.response, "all green");
		assert.equal(readRegistry(receiver).busy, false);
	});

	it("preserves FIFO queue drain across consecutive peer inbounds while non-inbound busy tracking toggles", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const peerA = await startPeer({ name: "peer-a", sessionId: "s-a-1466", project: "p-fifo", cwd: workspace, comsDir });
		const peerB = await startPeer({ name: "peer-b", sessionId: "s-b-1466", project: "p-fifo", cwd: workspace, comsDir });
		const receiver = await startPeer({ name: "receiver", sessionId: "s-r-1466", project: "p-fifo", cwd: workspace, comsDir });

		const r1 = await peerA.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "first task" });
		const r2 = await peerB.tools.get("coms_send").execute("s2", { target: "receiver", prompt: "second task" });
		const m1 = r1.details.msg_id as string;
		const m2 = r2.details.msg_id as string;
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m1));

		await receiver.handlers.get("agent_start")!({}, receiver.ctx);
		const msg1 = receiver.messages.find((m) => m?.details?.msg_id === m1);
		await receiver.handlers.get("message_start")!({ message: { role: "custom", ...msg1 } });
		await receiver.handlers.get("turn_end")!({
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "reply-one" }] },
			toolResults: [],
		}, receiver.ctx);

		await waitUntil(async () => (await peerA.tools.get("coms_get").execute("g1-wait", { msg_id: m1 })).details.status === "complete");
		assert.equal((await peerA.tools.get("coms_get").execute("g1", { msg_id: m1 })).details.response, "reply-one");
		await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === m2));

		const msg2 = receiver.messages.find((m) => m?.details?.msg_id === m2);
		await receiver.handlers.get("message_start")!({ message: { role: "custom", ...msg2 } });
		await receiver.handlers.get("turn_end")!({
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "reply-two" }] },
			toolResults: [],
		}, receiver.ctx);
		await receiver.handlers.get("agent_end")!({ messages: [] }, receiver.ctx);

		await waitUntil(async () => (await peerB.tools.get("coms_get").execute("g2-wait", { msg_id: m2 })).details.status === "complete");
		assert.equal((await peerB.tools.get("coms_get").execute("g2", { msg_id: m2 })).details.response, "reply-two");
		assert.equal(readRegistry(receiver).busy, false);
		assert.equal(readRegistry(receiver).queue_depth, 0);
	});
});
