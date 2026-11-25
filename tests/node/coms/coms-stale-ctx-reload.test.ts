/**
 * Regression tests for coms-p2p stale-ctx reload safety and cleanup timers (#1404).
 *
 * In Pi 1.6+, reading `.mode` or `.hasUI` on an extension `ctx` captured before `/reload`
 * or session replacement throws `This extension ctx is stale after session replacement or reload`.
 * These tests verify observable behavior under stale contexts and shutdown using fake timers.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import comsP2p, { PENDING_REPLY_CLEANUP_DELAY_MS } from "../../../extensions/coms/coms-p2p.js";
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
}

function makeSwitchableCtx(
	cwd: string,
	sessionId: string,
	assistantText?: () => string,
): SwitchableCtx {
	let stale = false;

	const ctx: any = {
		cwd,
		model: { id: "test-model" },
		get mode() {
			if (stale) throw new Error(STALE_CTX_ERROR);
			return "tui";
		},
		get hasUI() {
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
	};
}

/** Poll using setImmediate so fake setTimeout timers do not block socket I/O completion. */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
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

describe("coms-p2p stale-ctx reload safety and cleanup timers", { concurrency: false }, () => {
	it("cancels pending reply cleanup timers on cleanShutdown so no post-shutdown refresh fires", async (t) => {
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

		t.mock.timers.enable({ apis: ["setTimeout"] });
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
			await waitUntil(() => sender.messages.some((m) => m.details?.msg_id === msgId));

			await sender.shutdown();

			let postShutdownWidgetCalls = 0;
			let postShutdownPeerEmits = 0;
			senderCtx.ctx.ui.setWidget = () => { postShutdownWidgetCalls++; };
			sender.events.on("pidash:coms-peers", () => { postShutdownPeerEmits++; });

			assert.doesNotThrow(() => {
				t.mock.timers.tick(PENDING_REPLY_CLEANUP_DELAY_MS + 1_000);
			});
			assert.equal(postShutdownWidgetCalls, 0, "no post-shutdown widget refresh may fire");
			assert.equal(postShutdownPeerEmits, 0, "no post-shutdown peer refresh may emit");
		} finally {
			t.mock.timers.reset();
		}
	});

	it("does not throw when pending reply cleanup fires after ctx becomes stale", async (t) => {
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

		t.mock.timers.enable({ apis: ["setTimeout"] });
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
			await waitUntil(() => sender.messages.some((m) => m.details?.msg_id === msgId));

			// Simulate /reload marking the captured ctx stale before the delayed cleanup fires.
			senderCtx.makeStale();
			assert.doesNotThrow(() => {
				t.mock.timers.tick(PENDING_REPLY_CLEANUP_DELAY_MS + 1_000);
			});
		} finally {
			t.mock.timers.reset();
		}
	});

	it("installPoolWidget skips widget setup without throwing on a stale ctx", async () => {
		const workspace = makeWorkspace();
		const staleProbe = makeSwitchableCtx(workspace, "stale-install-probe");
		let setWidgetCalls = 0;

		// Flip ctx stale inside setStatus — right before installPoolWidget(ctx) in startPeer —
		// so installPoolWidget receives a stale ctx directly.
		staleProbe.ctx.ui.setStatus = () => {
			staleProbe.makeStale();
		};
		staleProbe.ctx.ui.setWidget = () => {
			setWidgetCalls++;
		};

		await assert.doesNotReject(() =>
			startPeer({
				name: "probe-peer",
				sessionId: "stale-install-probe",
				project: "p-stale-install",
				cwd: workspace,
				ctx: staleProbe.ctx,
			}),
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
