import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface FakePi {
	tools: Map<string, any>;
	start: (event: any, ctx: any) => Promise<void>;
	shutdown?: () => Promise<void>;
}

let workspace: string | undefined;
const peers: FakePi[] = [];

afterEach(async () => {
	for (const peer of peers.splice(0)) await peer.shutdown?.();
	if (workspace) rmSync(workspace, { recursive: true, force: true });
	workspace = undefined;
});

function createPi(name: string): FakePi {
	const tools = new Map<string, any>();
	let start: ((event: any, ctx: any) => Promise<void>) | undefined;
	let shutdown: (() => Promise<void>) | undefined;
	return {
		tools,
		get start() {
			if (!start) throw new Error("session_start handler was not registered");
			return start;
		},
		get shutdown() { return shutdown; },
		registerFlag: () => {},
		getFlag: (flag: string) => flag === "cname" ? name : undefined,
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: (event: string, handler: any) => {
			if (event === "session_start") start = handler;
			if (event === "session_shutdown") shutdown = handler;
		},
		sendMessage: () => {},
		events: { on: () => {}, emit: () => {} },
	} as FakePi;
}

async function startPeer(name: string, sessionId: string): Promise<FakePi> {
	const pi = createPi(name);
	peers.push(pi);
	const init = (await import(`../../../extensions/coms/coms-p2p.ts?queue-inspect=${sessionId}`)).default;
	const subagentChild = process.env.PI_SUBAGENT_CHILD;
	try {
		// This suite exercises the P2P extension itself, not its child-process guard.
		process.env.PI_SUBAGENT_CHILD = "0";
		init(pi as any);
	} finally {
		if (subagentChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = subagentChild;
	}
	(globalThis as any).__piConfigSessionId = sessionId;
	await pi.start({}, {
		cwd: workspace,
		model: { id: "test-model" },
		hasUI: false,
		ui: { notify: () => {} },
		sessionManager: { getSessionId: () => sessionId },
	});
	return pi;
}

async function startQueuedPeers() {
	workspace = mkdtempSync(join(tmpdir(), "coms-queue-inspect-"));
	mkdirSync(join(workspace, ".pi"));
	writeFileSync(join(workspace, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: join(workspace, "coms") }));
	const sender = await startPeer("sender", "sender-session");
	const receiver = await startPeer("receiver", "receiver-session");
	const blocker = await startPeer("blocker", "blocker-session");
	await blocker.tools.get("coms_send").execute("send-blocker", { target: "receiver", prompt: "active inbound body" });
	await sender.tools.get("coms_send").execute("send-1", { target: "receiver", prompt: "secret queued body" });
	return { sender, receiver };
}

describe("coms_queue_inspect execute result", { concurrency: false }, () => {
	it("gracefully stops the ping worker and removes its socket", async () => {
		workspace = mkdtempSync(join(tmpdir(), "coms-queue-inspect-"));
		mkdirSync(join(workspace, ".pi"));
		writeFileSync(join(workspace, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: join(workspace, "coms") }));
		const peer = await startPeer("shutdown", "shutdown-session");
		const sockets = join(workspace, "coms", "sockets");
		for (let attempt = 0; attempt < 20 && !readdirSync(sockets).some((file) => file.endsWith(".ping")); attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.ok(readdirSync(sockets).some((file) => file.endsWith(".ping")));
		await peer.shutdown?.();
		assert.equal(readdirSync(sockets).some((file) => file.endsWith(".ping")), false);
	});

	it("renders body-free preview metadata", async () => {
		const { sender } = await startQueuedPeers();
		const inspect = await sender.tools.get("coms_queue_inspect").execute("inspect-1", { target: "receiver" });
		const text = inspect.content[0].text;
		assert.match(text, /preview_id:/);
		assert.match(text, /id:/);
		assert.match(text, /sender:/);
		assert.match(text, /target:/);
		assert.match(text, /age_ms:/);
		assert.match(text, /position:/);
		assert.match(text, /delivery_state:/);
		assert.equal(text.includes("secret queued body"), false);
		assert.equal(JSON.stringify(inspect.details).includes("secret queued body"), false);
	});

	it("clears messages selected by an inspect preview", async () => {
		const { sender } = await startQueuedPeers();
		const inspect = await sender.tools.get("coms_queue_inspect").execute("inspect-1", { target: "receiver" });
		const clear = await sender.tools.get("coms_queue_clear").execute("clear-1", { target: "receiver", preview_id: inspect.details.previewId });
		assert.match(clear.content[0].text, /cleared: 1/);
	});

	it("rejects an invalid inspect preview", async () => {
		const { sender } = await startQueuedPeers();
		await assert.rejects(
			sender.tools.get("coms_queue_clear").execute("clear-invalid", { target: "receiver", preview_id: "not-a-preview" }),
			/invalid_preview/,
		);
	});

	it("rejects clearPrevious without clearing queued messages", async () => {
		const { sender } = await startQueuedPeers();
		await assert.rejects(
			sender.tools.get("coms_send").execute("send-rejected", { target: "receiver", prompt: "must not deliver", clearPrevious: true }),
			/clearPrevious is no longer allowed/,
		);
		const inspect = await sender.tools.get("coms_queue_inspect").execute("inspect-after-rejection", { target: "receiver" });
		assert.equal(inspect.details.items.length, 1);
	});

	it("leaves queued messages intact when a clear preview is stale", async () => {
		const { sender } = await startQueuedPeers();
		const stalePreview = await sender.tools.get("coms_queue_inspect").execute("inspect-stale", { target: "receiver" });
		await sender.tools.get("coms_send").execute("send-second", { target: "receiver", prompt: "second queued body" });
		const currentPreview = await sender.tools.get("coms_queue_inspect").execute("inspect-current", { target: "receiver" });
		await sender.tools.get("coms_queue_delete").execute("delete-first", { target: "receiver", msg_id: stalePreview.details.items[0].id, preview_id: currentPreview.details.previewId });
		await assert.rejects(
			sender.tools.get("coms_queue_clear").execute("clear-stale", { target: "receiver", preview_id: stalePreview.details.previewId }),
			/preview_stale/,
		);
		const remaining = await sender.tools.get("coms_queue_inspect").execute("inspect-remaining", { target: "receiver" });
		assert.equal(remaining.details.items.length, 1);
	});

	it("rejects a preview after its expiry", async () => {
		const { sender } = await startQueuedPeers();
		const originalNow = Date.now;
		try {
			const inspect = await sender.tools.get("coms_queue_inspect").execute("inspect-expiring", { target: "receiver" });
			Date.now = () => originalNow() + 5 * 60 * 1000 + 1;
			await assert.rejects(
				sender.tools.get("coms_queue_clear").execute("clear-expired", { target: "receiver", preview_id: inspect.details.previewId }),
				/invalid_preview/,
			);
		} finally {
			Date.now = originalNow;
		}
	});

	it("expires the oldest preview after reaching the session limit", async () => {
		const { sender } = await startQueuedPeers();
		const previews = [];
		for (let index = 0; index < 21; index++) {
			previews.push(await sender.tools.get("coms_queue_inspect").execute(`inspect-${index}`, { target: "receiver" }));
		}
		await assert.rejects(
			sender.tools.get("coms_queue_clear").execute("clear-expired", { target: "receiver", preview_id: previews[0].details.previewId }),
			/invalid_preview/,
		);
	});
});
