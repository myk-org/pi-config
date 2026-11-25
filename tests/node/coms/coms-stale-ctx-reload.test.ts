/**
 * Regression tests for coms-p2p stale-ctx reload crash & untracked 60s cleanup timers (#1404).
 *
 * In Pi 1.6+, reading `.mode` or `.hasUI` on an extension `ctx` captured before `/reload`
 * or session replacement throws `This extension ctx is stale after session replacement or reload`.
 * These tests verify that widget refreshes, 60s pendingReplies cleanup timers, `installPoolWidget`,
 * and `cleanShutdown` all guard against stale contexts and cancel pending cleanup timers on shutdown.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import comsP2p from "../../../extensions/coms/coms-p2p.js";
import { resetSessionBridge } from "../../../extensions/shared/session-bridge.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const STALE_CTX_ERROR = "This extension ctx is stale after session replacement or reload";

interface FakePi {
	tools: Map<string, any>;
	handlers: Map<string, Function>;
	messages: any[];
	events: {
		emit: (event: string, data?: any) => void;
		on: (event: string, fn: (data?: any) => void) => () => void;
	};
	shutdown: () => Promise<void>;
}

function createFakePi(flags: Record<string, any>): FakePi {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function>();
	const messages: any[] = [];
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

	return {
		tools,
		handlers,
		messages,
		events,
		registerFlag() {},
		getFlag(name: string) {
			return flags[name];
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		on(name: string, fn: Function) {
			handlers.set(name, fn);
		},
		sendMessage(msg: any) {
			messages.push(msg);
		},
		async shutdown() {
			await handlers.get("session_shutdown")?.();
		},
	} as any;
}

function makeWorkspace(): string {
	const workspace = makeTempDir("coms-stale-ctx-");
	const comsDir = join(workspace, "coms");
	mkdirSync(join(workspace, ".pi"), { recursive: true });
	writeFileSync(join(workspace, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: comsDir }));
	return workspace;
}

interface SwitchableCtx {
	ctx: any;
	makeStale: () => void;
	getHasUIReads: () => number;
	getModeReads: () => number;
}

function makeSwitchableCtx(
	cwd: string,
	sessionId: string,
	assistantText?: () => string,
): SwitchableCtx {
	let stale = false;
	let hasUIReads = 0;
	let modeReads = 0;

	const ctx: any = {
		cwd,
		model: { id: "test-model" },
		get mode() {
			modeReads++;
			if (stale) throw new Error(STALE_CTX_ERROR);
			return "tui";
		},
		get hasUI() {
			hasUIReads++;
			if (stale) throw new Error(STALE_CTX_ERROR);
			return true;
		},
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
			getBranch: () =>
				assistantText
					? [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: assistantText() }] } }]
					: [],
		},
	};

	return {
		ctx,
		makeStale: () => { stale = true; },
		getHasUIReads: () => hasUIReads,
		getModeReads: () => modeReads,
	};
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

const startedPeers: FakePi[] = [];

afterEach(async () => {
	for (const peer of startedPeers.splice(0)) {
		await peer.shutdown();
	}
	resetSessionBridge({ all: true });
	delete (globalThis as any).__piConfigSessionId;
});

async function startPeer(opts: {
	name: string;
	sessionId: string;
	project: string;
	cwd: string;
	ctx: any;
}): Promise<FakePi> {
	const pi = createFakePi({ cname: opts.name, project: opts.project });
	startedPeers.push(pi);
	withSubagentChildEnv(undefined, () => {
		comsP2p(pi as any);
	});
	(globalThis as any).__piConfigSessionId = opts.sessionId;
	await pi.handlers.get("session_start")!({}, opts.ctx);
	return pi;
}

describe("coms-p2p stale-ctx reload safety and 60s cleanup timers", { concurrency: false }, () => {
	it("clears tracked 60s pendingReplies cleanup timers on cleanShutdown", async () => {
		const workspace = makeWorkspace();
		const senderCtx = makeSwitchableCtx(workspace, "sender-timer-clear");
		const receiverCtx = makeSwitchableCtx(workspace, "receiver-timer-clear", () => "done");

		const sender = await startPeer({
			name: "sender",
			sessionId: "sender-timer-clear",
			project: "p-stale-timers",
			cwd: workspace,
			ctx: senderCtx.ctx,
		});
		const receiver = await startPeer({
			name: "receiver",
			sessionId: "receiver-timer-clear",
			project: "p-stale-timers",
			cwd: workspace,
			ctx: receiverCtx.ctx,
		});

		const origSetTimeout = globalThis.setTimeout;
		const origClearTimeout = globalThis.clearTimeout;
		const cleanupTimers = new Set<NodeJS.Timeout>();
		const clearedTimers = new Set<NodeJS.Timeout>();

		(globalThis as any).setTimeout = ((fn: (...args: any[]) => void, delay?: number, ...args: any[]) => {
			const handle = origSetTimeout(fn, delay, ...args);
			if (delay === 60_000) cleanupTimers.add(handle);
			return handle;
		}) as typeof setTimeout;
		(globalThis as any).clearTimeout = ((handle?: NodeJS.Timeout) => {
			if (handle) clearedTimers.add(handle);
			return origClearTimeout(handle);
		}) as typeof clearTimeout;

		try {
			const sendRes = await sender.tools.get("coms_send").execute("s1", {
				target: "receiver",
				prompt: "ping",
			});
			const msgId = sendRes.details.msg_id as string;

			await waitUntil(() => receiver.messages.some((m) => m.details?.msg_id === msgId));
			await receiver.handlers.get("message_start")!({
				message: { role: "custom", details: { msg_id: msgId } },
			});
			await receiver.handlers.get("agent_end")!({}, receiverCtx.ctx);

			await waitUntil(() => cleanupTimers.size > 0);
			assert.equal(cleanupTimers.size, 1, "expected one 60s pendingReplies cleanup timer");

			await sender.shutdown();
			for (const timer of cleanupTimers) {
				assert.ok(clearedTimers.has(timer), "cleanShutdown must clear every tracked 60s cleanup timer");
			}
		} finally {
			globalThis.setTimeout = origSetTimeout;
			globalThis.clearTimeout = origClearTimeout;
		}
	});

	it("does not throw when a 60s pendingReplies cleanup timer triggers maybeRefreshWidget on a stale ctx", async () => {
		const workspace = makeWorkspace();
		const senderCtx = makeSwitchableCtx(workspace, "sender-stale-refresh");
		const receiverCtx = makeSwitchableCtx(workspace, "receiver-stale-refresh", () => "reply");

		const sender = await startPeer({
			name: "sender",
			sessionId: "sender-stale-refresh",
			project: "p-stale-refresh",
			cwd: workspace,
			ctx: senderCtx.ctx,
		});
		const receiver = await startPeer({
			name: "receiver",
			sessionId: "receiver-stale-refresh",
			project: "p-stale-refresh",
			cwd: workspace,
			ctx: receiverCtx.ctx,
		});

		const origSetTimeout = globalThis.setTimeout;
		const capturedCallbacks: Array<() => void> = [];
		const capturedHandles: NodeJS.Timeout[] = [];

		(globalThis as any).setTimeout = ((fn: (...args: any[]) => void, delay?: number, ...args: any[]) => {
			const handle = origSetTimeout(fn, delay, ...args);
			if (delay === 60_000) {
				capturedCallbacks.push(() => fn(...args));
				capturedHandles.push(handle);
			}
			return handle;
		}) as typeof setTimeout;

		try {
			const sendRes = await sender.tools.get("coms_send").execute("s2", {
				target: "receiver",
				prompt: "hello",
			});
			const msgId = sendRes.details.msg_id as string;

			await waitUntil(() => receiver.messages.some((m) => m.details?.msg_id === msgId));
			await receiver.handlers.get("message_start")!({
				message: { role: "custom", details: { msg_id: msgId } },
			});
			await receiver.handlers.get("agent_end")!({}, receiverCtx.ctx);

			await waitUntil(() => capturedCallbacks.length > 0);

			// Simulate /reload marking the captured ctx stale before the 60s cleanup fires.
			senderCtx.makeStale();
			assert.doesNotThrow(() => {
				for (const cb of capturedCallbacks) cb();
			});
		} finally {
			globalThis.setTimeout = origSetTimeout;
			for (const h of capturedHandles) clearTimeout(h);
		}
	});

	it("installPoolWidget checks isLiveExtensionCtx before reading ctx.hasUI", async () => {
		const workspace = makeWorkspace();
		const staleProbe = makeSwitchableCtx(workspace, "stale-install-probe");
		let hasUIReadsAtInstall = 0;
		let modeReadsAtInstall = 0;
		let setWidgetCalls = 0;

		// Flip ctx stale inside setStatus — the exact line immediately before installPoolWidget(ctx)
		// in startPeer — so installPoolWidget receives a stale ctx directly.
		staleProbe.ctx.ui.setStatus = () => {
			staleProbe.makeStale();
			hasUIReadsAtInstall = staleProbe.getHasUIReads();
			modeReadsAtInstall = staleProbe.getModeReads();
		};
		staleProbe.ctx.ui.setWidget = () => {
			setWidgetCalls++;
		};

		await startPeer({
			name: "probe-peer",
			sessionId: "stale-install-probe",
			project: "p-stale-install",
			cwd: workspace,
			ctx: staleProbe.ctx,
		});

		assert.ok(staleProbe.getModeReads() > modeReadsAtInstall, "isLiveExtensionCtx must probe ctx.mode first");
		assert.equal(
			staleProbe.getHasUIReads(),
			hasUIReadsAtInstall,
			"ctx.hasUI must not be read once isLiveExtensionCtx detects a stale ctx",
		);
		assert.equal(setWidgetCalls, 0, "stale ctx must never install the coms-pool widget");
	});

	it("cleanShutdown does not throw when shutdownCtx becomes stale", async () => {
		const workspace = makeWorkspace();
		const peerCtx = makeSwitchableCtx(workspace, "stale-shutdown-peer");
		const peer = await startPeer({
			name: "shutdown-peer",
			sessionId: "stale-shutdown-peer",
			project: "p-stale-shutdown",
			cwd: workspace,
			ctx: peerCtx.ctx,
		});

		peerCtx.makeStale();
		await assert.doesNotReject(() => peer.shutdown());
	});
});
