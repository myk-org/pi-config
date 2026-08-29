import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

interface FakePi {
	tools: Map<string, any>;
	start: (event: any, ctx: any) => Promise<void>;
	shutdown?: () => Promise<void>;
}

let workspace: string | undefined;
const peers: FakePi[] = [];

afterEach(async () => {
	for (const peer of peers.splice(0)) await peer.shutdown?.();
	for (const worker of (process as any)._getActiveHandles().filter((handle: unknown) => handle instanceof Worker)) {
		await worker.terminate();
	}
	await new Promise(resolve => setTimeout(resolve, 25));
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
	init(pi as any);
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

describe("coms_queue_inspect execute result", () => {
	it("returns a body-free preview that can be passed to clear", async () => {
		workspace = mkdtempSync(join(tmpdir(), "coms-queue-inspect-"));
		mkdirSync(join(workspace, ".pi"));
		writeFileSync(join(workspace, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: join(workspace, "coms") }));

		const sender = await startPeer("sender", "sender-session");
		const receiver = await startPeer("receiver", "receiver-session");
		const blocker = await startPeer("blocker", "blocker-session");
		await blocker.tools.get("coms_send").execute("send-blocker", { target: "receiver", prompt: "active inbound body" });
		await sender.tools.get("coms_send").execute("send-1", { target: "receiver", prompt: "secret queued body" });

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
		assert.ok(inspect.details.previewId);

		const clear = await sender.tools.get("coms_queue_clear").execute("clear-1", { target: "receiver", preview_id: inspect.details.previewId });
		assert.match(clear.content[0].text, /cleared: 1/);

		await assert.rejects(
			sender.tools.get("coms_queue_clear").execute("clear-invalid", { target: "receiver", preview_id: "not-a-preview" }),
			/invalid_preview/,
		);
	});
});
