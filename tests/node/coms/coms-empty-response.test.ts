/**
 * Regression tests for #1442: non-empty COMS response/message guard so empty
 * or whitespace-only assistant replies never trigger Gemini HTTP 400
 * ("Requests ending with a model turn are not supported.").
 *
 * Run with: npx tsx --test tests/node/coms/coms-empty-response.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";

import comsP2p from "../../../extensions/coms/coms-p2p.js";
import {
	formatComsResponseBody,
	formatComsResponseText,
} from "../../../extensions/coms/coms-shared.js";
import { ComsRegistry } from "../../../extensions/coms/coms-registry.js";
import { resetSessionBridge } from "../../../extensions/shared/session-bridge.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { makeTempDir } from "../helpers/temp-dirs.js";
import { useSupportedPiVersion } from "../helpers/pi-version-env.js";

useSupportedPiVersion();

type Handler = (...args: any[]) => any;

interface CapturedSend {
	msg: any;
	opts: any;
}

interface PeerHarness {
	tools: Map<string, any>;
	handlers: Map<string, Handler[]>;
	sent: CapturedSend[];
	ctx: any;
	sessionId: string;
	emit: (event: string, payload?: any, ctx?: any) => Promise<void>;
	shutdown: () => Promise<void>;
}

const cleanupDirs: string[] = [];
const startedPeers: PeerHarness[] = [];

afterEach(async () => {
	for (const peer of startedPeers.splice(0)) {
		try { await peer.shutdown(); } catch { /* ignore */ }
	}
	resetSessionBridge({ all: true });
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
	const workspace = makeTempDir("coms-empty-response-");
	cleanupDirs.push(workspace);
	const comsDir = join(workspace, "coms");
	mkdirSync(join(workspace, ".pi"), { recursive: true });
	writeFileSync(join(workspace, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: comsDir }));
	return { workspace, comsDir };
}

function makeCtx(cwd: string, sessionId: string) {
	return {
		cwd,
		model: { id: "test-model" },
		hasUI: false,
		ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {} },
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => [],
		},
	};
}

async function startPeer(opts: {
	name: string;
	sessionId: string;
	project: string;
	cwd: string;
}): Promise<PeerHarness> {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Handler[]>();
	const sent: CapturedSend[] = [];
	const flags = new Map<string, any>([
		["cname", opts.name],
		["project", opts.project],
	]);

	const fakePi: any = {
		registerFlag: () => {},
		getFlag: (name: string) => flags.get(name),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		getAllTools: () => [...tools.values()],
		getActiveTools: () => [...tools.keys()],
		setActiveTools: () => {},
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		sendMessage: (msg: any, sendOpts?: any) => {
			sent.push({ msg, opts: sendOpts });
		},
		events: { on: () => () => {}, emit: () => {} },
	};

	withSubagentChildEnv(undefined, () => {
		comsP2p(fakePi);
	});

	const emit = async (event: string, payload?: any, ctx?: any) => {
		for (const handler of handlers.get(event) ?? []) {
			await handler(payload, ctx ?? peer.ctx);
		}
	};

	(globalThis as any).__piConfigSessionId = opts.sessionId;
	const ctx = makeCtx(opts.cwd, opts.sessionId);
	const peer: PeerHarness = {
		tools,
		handlers,
		sent,
		ctx,
		sessionId: opts.sessionId,
		emit,
		shutdown: async () => {
			await emit("session_shutdown", {}, ctx);
		},
	};

	startedPeers.push(peer);
	await emit("session_start", {}, ctx);
	return peer;
}

async function deliverInbound(peer: PeerHarness, msgId: string): Promise<any> {
	await waitUntil(() => peer.sent.some((s) => s.msg?.details?.msg_id === msgId));
	const entry = [...peer.sent].reverse().find((s) => s.msg?.details?.msg_id === msgId);
	assert.ok(entry, `expected injected inbound ${msgId}`);
	await peer.emit("message_start", { message: { role: "custom", ...entry.msg } });
	return entry;
}

function sendRawEnvelope(endpoint: string, envelope: Record<string, unknown>): Promise<void> {
	return new Promise((resolve, reject) => {
		const sock = net.createConnection(endpoint, () => {
			sock.write(`${JSON.stringify(envelope)}\n`);
		});
		let buf = "";
		sock.on("data", (chunk) => {
			buf += chunk.toString();
			if (buf.includes("\n")) {
				sock.end();
				resolve();
			}
		});
		sock.on("error", reject);
		sock.setTimeout(2_000, () => {
			sock.destroy();
			reject(new Error("raw envelope timed out"));
		});
	});
}

describe("formatComsResponseBody empty/whitespace normalization (#1442)", () => {
	it("returns (no response) for empty string", () => {
		assert.equal(formatComsResponseBody("", null), "(no response)");
	});

	it("returns (no response) for whitespace-only string", () => {
		assert.equal(formatComsResponseBody("   \n\t ", null), "(no response)");
	});

	it("returns (no response) for null response", () => {
		assert.equal(formatComsResponseBody(null, null), "(no response)");
	});

	it("returns (no response) for undefined response", () => {
		assert.equal(formatComsResponseBody(undefined, null), "(no response)");
	});

	it("preserves exact text for non-empty strings", () => {
		assert.equal(formatComsResponseBody("done", null), "done");
		assert.equal(formatComsResponseBody("  padded reply  ", null), "  padded reply  ");
	});

	it("ignores whitespace-only error strings cleanly", () => {
		assert.equal(formatComsResponseBody(null, "   \n\t "), "(no response)");
		assert.equal(formatComsResponseBody("done", "   "), "done");
		assert.equal(formatComsResponseBody(null, "timeout"), "Error: timeout");
	});

	it("returns (no response) when non-string serialization is empty or whitespace", () => {
		const blankSerializable = { toJSON: () => undefined, toString: () => "   \t" };
		assert.equal(formatComsResponseBody(blankSerializable, null), "(no response)");
	});

	it("falls back to String(response) when JSON.stringify throws on a circular object", () => {
		const circular: Record<string, unknown> = {
			toString: () => "[circular-reply]",
		};
		circular.self = circular;
		assert.equal(formatComsResponseBody(circular, null), "[circular-reply]");
	});

	it("returns (no response) when JSON.stringify throws with a blank String(response)", () => {
		const throwingBlank = {
			toJSON: () => { throw new Error("unserializable"); },
			toString: () => "   \n\t ",
		};
		assert.equal(formatComsResponseBody(throwingBlank, null), "(no response)");
	});

	it("preserves falsy non-nullish primitives", () => {
		assert.equal(formatComsResponseBody(0, null), "0");
		assert.equal(formatComsResponseBody(false, null), "false");
	});
});

describe("formatComsResponseText empty/whitespace normalization (#1442)", () => {
	it("returns (no response) for empty string in formatComsResponseText", () => {
		assert.equal(formatComsResponseText("worker", "", null, []), "[coms response from worker] (no response)");
	});

	it("returns (no response) for whitespace-only text in formatComsResponseText", () => {
		assert.equal(formatComsResponseText("worker", "   \n\t ", null, []), "[coms response from worker] (no response)");
	});

	it("returns (no response) for null response in formatComsResponseText", () => {
		assert.equal(formatComsResponseText("worker", null, null, []), "[coms response from worker] (no response)");
	});

	it("returns (no response) for undefined response in formatComsResponseText", () => {
		assert.equal(formatComsResponseText("worker", undefined, null, []), "[coms response from worker] (no response)");
	});

	it("preserves non-empty string responses", () => {
		assert.equal(formatComsResponseText("worker", "task done", null, []), "[coms response from worker] task done");
	});
});

describe("COMS peer runtime non-empty triggerTurn delivery (#1442)", { concurrency: false }, () => {
	it("delivers (no response) with triggerTurn: true when peer ends turn with empty assistant text", async () => {
		const { workspace } = makeWorkspace();
		const sender = await startPeer({ name: "sender", sessionId: "s-1442-empty", project: "p-1442-1", cwd: workspace });
		const receiver = await startPeer({ name: "receiver", sessionId: "r-1442-empty", project: "p-1442-1", cwd: workspace });

		const sent = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "spawn async and stop" });
		const msgId = sent.details.msg_id as string;

		await receiver.emit("agent_start", {});
		await deliverInbound(receiver, msgId);

		const emptyAssistantMsg = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "" }],
		};
		await receiver.emit("turn_end", { type: "turn_end", turnIndex: 0, message: emptyAssistantMsg, toolResults: [] });
		await receiver.emit("agent_end", { messages: [emptyAssistantMsg] });

		await waitUntil(() => sender.sent.some((s) => s.msg?.details?.msg_id === msgId));
		const delivered = sender.sent.find((s) => s.msg?.details?.msg_id === msgId);
		assert.ok(delivered, "sender should receive auto-delivered response message");
		assert.equal(delivered.msg.content, "(no response)");
		assert.deepEqual(delivered.opts, { deliverAs: "followUp", triggerTurn: true });
	});

	it("delivers (no response) with triggerTurn: true when peer ends turn with whitespace-only assistant text", async () => {
		const { workspace } = makeWorkspace();
		const sender = await startPeer({ name: "sender", sessionId: "s-1442-ws", project: "p-1442-2", cwd: workspace });
		const receiver = await startPeer({ name: "receiver", sessionId: "r-1442-ws", project: "p-1442-2", cwd: workspace });

		const sent = await sender.tools.get("coms_send").execute("s2", { target: "receiver", prompt: "status?" });
		const msgId = sent.details.msg_id as string;

		await receiver.emit("agent_start", {});
		await deliverInbound(receiver, msgId);

		const wsAssistantMsg = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "   \n\t  " }],
		};
		await receiver.emit("turn_end", { type: "turn_end", turnIndex: 0, message: wsAssistantMsg, toolResults: [] });
		await receiver.emit("agent_end", { messages: [wsAssistantMsg] });

		await waitUntil(() => sender.sent.some((s) => s.msg?.details?.msg_id === msgId));
		const delivered = sender.sent.find((s) => s.msg?.details?.msg_id === msgId);
		assert.ok(delivered, "sender should receive auto-delivered response message");
		assert.equal(delivered.msg.content, "(no response)");
		assert.deepEqual(delivered.opts, { deliverAs: "followUp", triggerTurn: true });
	});

	it("guards inbound prompt injection with (empty message) when raw envelope produces empty content", async () => {
		const { workspace, comsDir } = makeWorkspace();
		const receiver = await startPeer({ name: "receiver", sessionId: "r-1442-in", project: "p-1442-3", cwd: workspace });

		const registry = new ComsRegistry(comsDir);
		const regEntry = registry.readEntries("p-1442-3").find((e) => e.name === "receiver");
		assert.ok(regEntry?.endpoint, "receiver should have a registered socket endpoint");

		await sendRawEnvelope(regEntry.endpoint, {
			type: "prompt",
			msg_id: "msg-empty-inbound-1442",
			sender_session: "",
			sender_endpoint: "",
			sender_name: "",
			sender_cwd: "",
			hops: 0,
			timestamp: new Date().toISOString(),
			prompt: "   \n\t ",
		});

		await waitUntil(() => receiver.sent.some((s) => s.msg?.details?.msg_id === "msg-empty-inbound-1442"));
		const delivered = receiver.sent.find((s) => s.msg?.details?.msg_id === "msg-empty-inbound-1442");
		assert.ok(delivered, "receiver should receive guarded inbound message");
		assert.equal(delivered.msg.content, "(empty message)");
		assert.deepEqual(delivered.opts, { deliverAs: "followUp", triggerTurn: true });
	});
});
