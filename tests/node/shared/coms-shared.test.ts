/**
 * Tests for coms-shared formatting helpers (queue depth, response text).
 * Run with: npx tsx --test tests/node/shared/coms-shared.test.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatComsResponseText, formatComsResponseType, formatComsResponseBody, formatComsInboundType, buildInboundContent, formatQueueStr, renderQueuePart, sanitizeComsName, createDeferredProxy, syncComsActiveTools, type DeferredUpstream } from "../../../extensions/coms/coms-shared.js";
import { registerComs } from "../../../extensions/coms/coms-wrapper.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";

describe("formatComsResponseText", () => {
	it("formats error response without queue", () => {
		const result = formatComsResponseText("worker", null, "something failed", []);
		assert.equal(result, "[coms response from worker] Error: something failed");
	});

	it("formats error response with queued IDs", () => {
		const result = formatComsResponseText("worker", null, "something failed", ["msg-aaa", "msg-bbb"]);
		assert.equal(result, "[coms response from worker (2 more queued: msg-aaa, msg-bbb)] Error: something failed");
	});

	it("formats string response without queue", () => {
		const result = formatComsResponseText("peer-a", "task done", null, []);
		assert.equal(result, "[coms response from peer-a] task done");
	});

	it("formats string response with queued IDs", () => {
		const result = formatComsResponseText("peer-a", "task done", null, ["id-1", "id-2", "id-3"]);
		assert.equal(result, "[coms response from peer-a (3 more queued: id-1, id-2, id-3)] task done");
	});

	it("formats object response as JSON", () => {
		const result = formatComsResponseText("peer-b", { status: "ok" }, null, []);
		assert.equal(result, '[coms response from peer-b] {\n  "status": "ok"\n}');
	});

	it("formats object response with single queued ID", () => {
		const result = formatComsResponseText("peer-b", { status: "ok" }, null, ["msg-123"]);
		assert.equal(result, '[coms response from peer-b (1 more queued: msg-123)] {\n  "status": "ok"\n}');
	});

	it("truncates IDs when more than 5 are queued", () => {
		const ids = ["a", "b", "c", "d", "e", "f", "g"];
		const result = formatComsResponseText("peer-x", "done", null, ids);
		assert.equal(result, "[coms response from peer-x (7 more queued: a, b, c, d, e and 2 more)] done");
	});

	it("shows all IDs when exactly 5 are queued", () => {
		const ids = ["a", "b", "c", "d", "e"];
		const result = formatComsResponseText("peer-x", "done", null, ids);
		assert.equal(result, "[coms response from peer-x (5 more queued: a, b, c, d, e)] done");
	});

	it("includes arrow with selfName when provided", () => {
		const result = formatComsResponseText("manager", "task done", null, [], "coder-async");
		assert.equal(result, "[coms response from manager → coder-async] task done");
	});

	it("includes arrow with selfName in error response", () => {
		const result = formatComsResponseText("worker", null, "timeout", [], "orchestrator");
		assert.equal(result, "[coms response from worker → orchestrator] Error: timeout");
	});

	it("includes arrow before queue note", () => {
		const result = formatComsResponseText("peer-a", "ok", null, ["id-1"], "coder");
		assert.equal(result, "[coms response from peer-a → coder (1 more queued: id-1)] ok");
	});

	it("omits arrow when selfName is undefined", () => {
		const result = formatComsResponseText("peer-b", "ok", null, []);
		assert.equal(result, "[coms response from peer-b] ok");
	});
});

describe("formatQueueStr (used by coms_list text output)", () => {
	it("returns empty string for 0", () => {
		assert.equal(formatQueueStr(0), "");
	});

	it("returns empty string for undefined", () => {
		assert.equal(formatQueueStr(undefined), "");
	});

	it("returns empty string for null", () => {
		assert.equal(formatQueueStr(null), "");
	});

	it("returns 📨N for positive depth", () => {
		assert.equal(formatQueueStr(3), " 📨3");
	});

	it("returns 📨1 for depth 1", () => {
		assert.equal(formatQueueStr(1), " 📨1");
	});

	it("produces correct list output line with queue depth", () => {
		// Simulates the text output format used by coms_list
		const name = "peer2";
		const model = "opus";
		const ctxStr = " 42%";
		const queueStr = formatQueueStr(2);
		const purpose = "worker";
		const line = `● ${name} (${model})${ctxStr}${queueStr} — ${purpose}`;
		assert.equal(line, "● peer2 (opus) 42% 📨2 — worker");
	});

	it("produces correct list output line without queue", () => {
		const name = "peer2";
		const model = "opus";
		const ctxStr = " 42%";
		const queueStr = formatQueueStr(0);
		const purpose = "worker";
		const line = `● ${name} (${model})${ctxStr}${queueStr} — ${purpose}`;
		assert.equal(line, "● peer2 (opus) 42% — worker");
	});
});

describe("renderQueuePart", () => {
	const mockTheme = { fg: (_color: string, text: string) => text };

	it("returns empty string for 0", () => {
		assert.equal(renderQueuePart(0, mockTheme), "");
	});

	it("returns formatted part for positive depth", () => {
		const result = renderQueuePart(2, mockTheme);
		assert.equal(result, " 📨2");
	});
});

describe("sanitizeComsName", () => {
	it("passes through clean names unchanged", () => {
		assert.equal(sanitizeComsName("coder-async"), "coder-async");
	});

	it("strips newlines", () => {
		assert.equal(sanitizeComsName("name\ninjection"), "nameinjection");
	});

	it("strips carriage returns", () => {
		assert.equal(sanitizeComsName("name\rinjection"), "nameinjection");
	});

	it("strips tabs", () => {
		assert.equal(sanitizeComsName("name\tinjection"), "nameinjection");
	});

	it("strips brackets", () => {
		assert.equal(sanitizeComsName("name[bad]"), "namebad");
	});

	it("strips C0 control characters", () => {
		assert.equal(sanitizeComsName("name\x00\x01\x1fend"), "nameend");
	});

	it("strips C1 control characters", () => {
		assert.equal(sanitizeComsName("name\x7f\x80\x9fend"), "nameend");
	});

	it("replaces spaces with hyphens", () => {
		assert.equal(sanitizeComsName("my agent"), "my-agent");
	});

	it("collapses multiple spaces into single hyphen", () => {
		assert.equal(sanitizeComsName("my   agent   name"), "my-agent-name");
	});

	it("trims leading plus trailing whitespace", () => {
		assert.equal(sanitizeComsName("  coder  "), "coder");
	});

	it("returns ? for empty string", () => {
		assert.equal(sanitizeComsName(""), "?");
	});

	it("returns ? for string of only control chars", () => {
		assert.equal(sanitizeComsName("\n\r\t"), "?");
	});
});

describe("formatComsInboundType", () => {
	it("formats basic inbound header", () => {
		assert.equal(formatComsInboundType("manager", "coder", "/home/user"), "from manager → coder @ /home/user");
	});

	it("sanitizes sender name with control chars", () => {
		const result = formatComsInboundType("bad\nname", "self", "/cwd");
		assert.ok(!result.includes("\n"));
		assert.equal(result, "from badname → self @ /cwd");
	});

	it("sanitizes sender cwd with control chars", () => {
		const result = formatComsInboundType("peer", "self", "/path\x00inject");
		assert.ok(!result.includes("\x00"));
	});

	it("handles empty sender name", () => {
		const result = formatComsInboundType("", "self", "/cwd");
		assert.equal(result, "from ? → self @ /cwd");
	});
});

describe("formatComsResponseType", () => {
	it("formats basic response type", () => {
		assert.equal(formatComsResponseType("peer-a"), "coms response from peer-a");
	});

	it("includes self name", () => {
		assert.equal(formatComsResponseType("peer-a", "coder"), "coms response from peer-a → coder");
	});

	it("includes queued IDs", () => {
		assert.equal(formatComsResponseType("peer-a", undefined, ["id-1"]), "coms response from peer-a (1 more queued: id-1)");
	});
});

describe("formatComsResponseBody", () => {
	it("formats error", () => {
		assert.equal(formatComsResponseBody(null, "timeout"), "Error: timeout");
	});

	it("formats string response", () => {
		assert.equal(formatComsResponseBody("done", null), "done");
	});

	it("formats object response", () => {
		const result = formatComsResponseBody({ ok: true }, null);
		assert.ok(result.includes('"ok": true'));
	});

	it("handles undefined response", () => {
		assert.equal(formatComsResponseBody(undefined, null), "(no response)");
	});

	it("handles null response", () => {
		assert.equal(formatComsResponseBody(null, null), "(no response)");
	});
});

describe("buildInboundContent", () => {
	it("includes header when provided", () => {
		const result = buildInboundContent("[from peer @ /cwd]", "hello");
		assert.ok(result.startsWith("[from peer @ /cwd]"));
		assert.ok(result.includes("hello"));
	});

	it("omits header when empty string", () => {
		const result = buildInboundContent("", "hello");
		assert.equal(result, "hello");
	});

	it("includes tasks section", () => {
		const result = buildInboundContent("", "prompt", [{ subject: "Task 1", description: "Do thing" }]);
		assert.ok(result.includes("**Task 1**"));
		assert.ok(result.includes("Do thing"));
	});
});

describe("createDeferredProxy registerCommand", () => {
	function makeState(active = false): DeferredUpstream {
		return {
			capturedSessionStart: null,
			capturedSessionShutdown: null,
			flagValues: new Map(),
			active,
		};
	}

	function makePi() {
		const commands = new Map<string, any>();
		return {
			commands,
			registerCommand: (name: string, def: any) => { commands.set(name, def); },
			registerTool: () => {},
			registerFlag: () => {},
			getFlag: () => undefined,
			on: () => {},
			appendEntry: () => {},
		};
	}

	it("swallows wrapper-owned /coms", () => {
		const pi = makePi();
		const state = makeState(true);
		const proxy = createDeferredProxy(pi as any, state, "inactive", "test-key");
		proxy.registerCommand("coms", { description: "upstream", handler: async () => {} });
		assert.equal(pi.commands.has("coms"), false);
	});

	it("registers /coms-queue on real pi", () => {
		const pi = makePi();
		const state = makeState(false);
		const proxy = createDeferredProxy(pi as any, state, "inactive", "test-key");
		let called = false;
		proxy.registerCommand("coms-queue", {
			description: "queue",
			handler: async () => { called = true; },
		});
		assert.ok(pi.commands.has("coms-queue"));
		assert.equal(pi.commands.get("coms-queue").description, "queue");
		assert.equal(called, false);
	});

	it("gates /coms-queue when inactive", async () => {
		const pi = makePi();
		const state = makeState(false);
		const proxy = createDeferredProxy(pi as any, state, "inactive", "test-key");
		let called = false;
		const notifies: string[] = [];
		proxy.registerCommand("coms-queue", {
			description: "queue",
			handler: async () => { called = true; },
		});
		await pi.commands.get("coms-queue").handler("", {
			ui: { notify: (msg: string) => { notifies.push(msg); } },
		});
		assert.equal(called, false);
		assert.ok(notifies.some(m => m.includes("coms not active")));
	});

	it("forwards /coms-queue when active", async () => {
		const pi = makePi();
		const state = makeState(true);
		const proxy = createDeferredProxy(pi as any, state, "inactive", "test-key");
		let called = false;
		proxy.registerCommand("coms-queue", {
			description: "queue",
			handler: async () => { called = true; },
		});
		await pi.commands.get("coms-queue").handler("", { ui: { notify: () => {} } });
		assert.equal(called, true);
	});

	it("sets coms_active flag on reload reactivation", async () => {
		const { setComsActive, isComsActive } = await import("../../../extensions/shared/session-bridge.js");
		setComsActive(false);
		assert.equal(isComsActive(), false);

		const handlers: Array<(evt: any, ctx: any) => Promise<void>> = [];
		const pi = {
			registerCommand: () => {},
			registerTool: () => {},
			registerFlag: () => {},
			getFlag: () => undefined,
			on: (_event: string, handler: any) => {
				handlers.push(handler);
			},
			appendEntry: () => {},
		};
		const state = makeState(false);
		const proxy = createDeferredProxy(pi as any, state, "inactive", "coms-state");
		proxy.on("session_start", async () => {});

		assert.equal(handlers.length, 1);
		await handlers[0](
			{ reason: "reload" },
			{
				sessionManager: {
					getEntries: () => [
						{ type: "custom", customType: "coms-state", data: { active: true, flags: {}, extra: {} } },
					],
				},
			},
		);
		assert.equal(state.active, true);
		assert.equal(isComsActive(), true);
		setComsActive(false);
	});

	it("clears active state on reload reactivation failure, persists", async () => {
		const { setComsActive, isComsActive } = await import("../../../extensions/shared/session-bridge.js");
		setComsActive(true);
		assert.equal(isComsActive(), true);

		const handlers: Array<(evt: any, ctx: any) => Promise<void>> = [];
		const persisted: Array<{ key: string; data: any }> = [];
		const pi = {
			registerCommand: () => {},
			registerTool: () => {},
			registerFlag: () => {},
			getFlag: () => undefined,
			on: (_event: string, handler: any) => {
				handlers.push(handler);
			},
			appendEntry: (key: string, data: any) => {
				persisted.push({ key, data });
			},
		};
		const state = makeState(true);
		const proxy = createDeferredProxy(pi as any, state, "inactive", "coms-state");
		proxy.on("session_start", async () => {
			throw new Error("reactivate boom");
		});

		assert.equal(handlers.length, 1);
		await handlers[0](
			{ reason: "reload" },
			{
				sessionManager: {
					getEntries: () => [
						{ type: "custom", customType: "coms-state", data: { active: true, flags: {}, extra: {} } },
					],
				},
			},
		);
		assert.equal(state.active, false);
		assert.equal(isComsActive(), false);
		assert.ok(persisted.some((p) => p.key === "coms-state" && p.data?.active === false));
		setComsActive(false);
	});

	it("isolates comsActive reload reactivation per session", async () => {
		const { isComsActive, resetSessionBridge } = await import("../../../extensions/shared/session-bridge.js");
		resetSessionBridge();
		try {
			const handlers: Record<string, Array<(...args: any[]) => Promise<void>>> = {};
			const pi = {
				registerCommand: () => {},
				registerTool: () => {},
				registerFlag: () => {},
				getFlag: () => undefined,
				on: (event: string, handler: any) => {
					(handlers[event] ??= []).push(handler);
				},
				appendEntry: () => {},
			};
			const state = makeState(false);
			const proxy = createDeferredProxy(pi as any, state, "not active", "coms-state");
			proxy.on("session_start", async () => {});
			proxy.on("session_shutdown", async () => {});

			await handlers.session_start[0](
				{ reason: "reload" },
				{
					sessionManager: {
						getSessionId: () => "sess-coms-a",
						getEntries: () => [
							{ type: "custom", customType: "coms-state", data: { active: true, flags: {}, extra: {} } },
						],
					},
				},
			);
			assert.equal(isComsActive("sess-coms-a"), true);
			assert.equal(isComsActive("sess-coms-b"), false);

			await handlers.session_shutdown[0]({}, { sessionManager: { getSessionId: () => "sess-coms-a" } });
			assert.equal(isComsActive("sess-coms-a"), false);
		} finally {
			resetSessionBridge();
		}
	});

});

describe("defaultActive gating for COMS tools (#1158)", () => {
	function makeStatefulPi() {
		const tools = new Map<string, any>();
		let activeTools: string[] = ["read", "bash"];
		const events = new Map<string, Array<(...args: any[]) => any>>();
		const commands = new Map<string, any>();
		const pi = {
			tools,
			commands,
			events: {
				emit: () => {},
				on: () => () => {},
			},
			registerCommand: (name: string, def: any) => { commands.set(name, def); },
			registerTool: (tool: any) => {
				tools.set(tool.name, tool);
				if (tool.defaultActive !== false && !activeTools.includes(tool.name)) {
					activeTools.push(tool.name);
				}
			},
			registerFlag: () => {},
			getFlag: () => undefined,
			getActiveTools: () => [...activeTools],
			setActiveTools: (names: string[]) => { activeTools = [...names]; },
			on: (event: string, handler: any) => {
				const list = events.get(event) ?? [];
				list.push(handler);
				events.set(event, list);
			},
			appendEntry: () => {},
		};
		return { pi, tools, events, commands, getActive: () => [...activeTools] };
	}

	it("marks deferred tools defaultActive false", () => {
		const { pi, tools, getActive } = makeStatefulPi();
		const state: DeferredUpstream = {
			capturedSessionStart: null,
			capturedSessionShutdown: null,
			flagValues: new Map(),
			active: false,
			deferredTools: new Set(),
		};
		const proxy = createDeferredProxy(pi as any, state, "inactive", "coms-state");
		proxy.registerTool({
			name: "coms_send",
			description: "send",
			parameters: {},
			execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
		} as any);

		assert.equal(tools.get("coms_send")?.defaultActive, false);
		assert.equal(state.deferredTools?.has("coms_send"), true);
		assert.deepEqual(getActive(), ["read", "bash"]);
	});

	it("blocks execution of inactive deferred tools", async () => {
		const { pi, tools } = makeStatefulPi();
		const state: DeferredUpstream = {
			capturedSessionStart: null,
			capturedSessionShutdown: null,
			flagValues: new Map(),
			active: false,
			deferredTools: new Set(),
		};
		const proxy = createDeferredProxy(pi as any, state, "inactive", "coms-state");
		let executed = false;
		proxy.registerTool({
			name: "coms_send",
			description: "send",
			parameters: {},
			execute: async () => { executed = true; return { content: [{ type: "text", text: "ok" }] }; },
		} as any);

		const res = await tools.get("coms_send").execute("id1", {});
		assert.equal(executed, false);
		assert.equal(res.content[0].text, "inactive");
	});

	it("adds deferred tools via syncComsActiveTools when activated", () => {
		const { pi, getActive } = makeStatefulPi();
		const state: DeferredUpstream = {
			capturedSessionStart: null,
			capturedSessionShutdown: null,
			flagValues: new Map(),
			active: false,
			deferredTools: new Set(),
		};
		const proxy = createDeferredProxy(pi as any, state, "inactive", "coms-state");
		proxy.registerTool({ name: "coms_send", description: "send", parameters: {}, execute: async () => ({ content: [] }) } as any);

		syncComsActiveTools(pi as any, state, true);
		assert.deepEqual(getActive(), ["read", "bash", "coms_send"]);
	});

	it("removes deferred tools via syncComsActiveTools when deactivated", () => {
		const { pi, getActive } = makeStatefulPi();
		const state: DeferredUpstream = {
			capturedSessionStart: null,
			capturedSessionShutdown: null,
			flagValues: new Map(),
			active: true,
			deferredTools: new Set(),
		};
		const proxy = createDeferredProxy(pi as any, state, "inactive", "coms-state");
		proxy.registerTool({ name: "coms_send", description: "send", parameters: {}, execute: async () => ({ content: [] }) } as any);

		syncComsActiveTools(pi as any, state, true);
		syncComsActiveTools(pi as any, state, false);
		assert.deepEqual(getActive(), ["read", "bash"]);
	});

	it("activates deferred tools on reload when previously active", async () => {
		const { setComsActive } = await import("../../../extensions/shared/session-bridge.js");
		setComsActive(false);
		const { pi, events, getActive } = makeStatefulPi();
		const state: DeferredUpstream = {
			capturedSessionStart: null,
			capturedSessionShutdown: null,
			flagValues: new Map(),
			active: false,
			deferredTools: new Set(["coms_stop"]),
		};
		const proxy = createDeferredProxy(pi as any, state, "inactive", "coms-state");
		proxy.registerTool({ name: "coms_list", description: "list", parameters: {}, execute: async () => ({ content: [] }) } as any);
		proxy.on("session_start", async () => {});

		const reloadHandlers = events.get("session_start") ?? [];
		assert.equal(reloadHandlers.length, 1);

		await reloadHandlers[0](
			{ reason: "reload" },
			{ sessionManager: { getEntries: () => [{ type: "custom", customType: "coms-state", data: { active: true } }] } },
		);
		assert.deepEqual(getActive(), ["read", "bash", "coms_stop", "coms_list"]);
		setComsActive(false);
	});

	it("deactivates deferred tools when reload reactivation fails", async () => {
		const { setComsActive } = await import("../../../extensions/shared/session-bridge.js");
		setComsActive(false);
		const { pi, events, getActive } = makeStatefulPi();
		const state: DeferredUpstream = {
			capturedSessionStart: null,
			capturedSessionShutdown: null,
			flagValues: new Map(),
			active: false,
			deferredTools: new Set(["coms_stop"]),
		};
		const proxy = createDeferredProxy(pi as any, state, "inactive", "coms-state");
		proxy.registerTool({ name: "coms_list", description: "list", parameters: {}, execute: async () => ({ content: [] }) } as any);
		syncComsActiveTools(pi as any, state, true);
		proxy.on("session_start", async () => {
			throw new Error("boom");
		});

		const reloadHandlers = events.get("session_start") ?? [];
		await reloadHandlers[0](
			{ reason: "reload" },
			{ sessionManager: { getEntries: () => [{ type: "custom", customType: "coms-state", data: { active: true } }] } },
		);
		assert.deepEqual(getActive(), ["read", "bash"]);
		setComsActive(false);
	});

	it("registerComs gates 16 tools while keeping discovery tools active", async () => {
		const { pi, tools, getActive } = makeStatefulPi();
		withSubagentChildEnv(undefined, () => {
			registerComs(pi as any);
			return undefined;
		});

		const gatedNames = [
			"coms_list", "coms_send", "coms_broadcast", "coms_history", "coms_get",
			"coms_queue_inspect", "coms_queue_delete", "coms_queue_edit", "coms_queue_clear", "coms_queue_prioritize",
			"coms_tasks_create", "coms_task_delete", "coms_task_list", "coms_task_get", "coms_task_update",
			"coms_stop",
		];
		const alwaysActiveNames = ["coms_start", "coms_peers", "coms_peer_spawn", "coms_peer_kill"];

		for (const name of gatedNames) {
			assert.ok(tools.has(name), `expected ${name} to be registered`);
			assert.equal(tools.get(name).defaultActive, false, `${name} must have defaultActive: false`);
			assert.equal(getActive().includes(name), false, `${name} must be inactive before COMS starts`);
		}
		for (const name of alwaysActiveNames) {
			assert.ok(tools.has(name), `expected ${name} to be registered`);
			assert.notEqual(tools.get(name).defaultActive, false, `${name} must remain defaultActive`);
			assert.equal(getActive().includes(name), true, `${name} must be active before COMS starts`);
		}
	});

	async function withComsTempSession(fn: (ctx: {
		pi: ReturnType<typeof makeStatefulPi>["pi"];
		tools: ReturnType<typeof makeStatefulPi>["tools"];
		commands: ReturnType<typeof makeStatefulPi>["commands"];
		getActive: ReturnType<typeof makeStatefulPi>["getActive"];
		sessionCtx: any;
	}) => Promise<void>): Promise<void> {
		const { resetSessionBridge } = await import("../../../extensions/shared/session-bridge.js");
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coms-gate-test-"));
		const prevComsDir = process.env.PI_COMS_DIR;
		process.env.PI_COMS_DIR = tmpRoot;
		const { pi, tools, commands, getActive } = makeStatefulPi();
		withSubagentChildEnv(undefined, () => {
			registerComs(pi as any);
			return undefined;
		});
		const sessionCtx = {
			cwd: tmpRoot,
			hasUI: false,
			ui: { notify: () => {} },
			sessionManager: {
				getSessionId: () => "test-sess-gate",
				getEntries: () => [],
			},
			modelRegistry: {},
			model: undefined,
		};
		try {
			await fn({ pi, tools, commands, getActive, sessionCtx });
		} finally {
			try { await tools.get("coms_stop").execute("cleanup", {}); } catch {}
			resetSessionBridge();
			if (prevComsDir === undefined) delete process.env.PI_COMS_DIR;
			else process.env.PI_COMS_DIR = prevComsDir;
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	}

	const gatedNames = [
		"coms_list", "coms_send", "coms_broadcast", "coms_history", "coms_get",
		"coms_queue_inspect", "coms_queue_delete", "coms_queue_edit", "coms_queue_clear", "coms_queue_prioritize",
		"coms_tasks_create", "coms_task_delete", "coms_task_list", "coms_task_get", "coms_task_update",
		"coms_stop",
	];
	const alwaysActiveNames = ["coms_start", "coms_peers", "coms_peer_spawn", "coms_peer_kill"];

	it("toggles gated tools via coms_start then coms_stop", async () => {
		await withComsTempSession(async ({ tools, getActive, sessionCtx }) => {
			for (const name of gatedNames) assert.equal(getActive().includes(name), false);

			const startRes = await tools.get("coms_start").execute("id-start", { cname: "gate-peer", project: "gate-proj" }, undefined, undefined, sessionCtx);
			assert.equal(startRes.details.ok, true, startRes.content?.[0]?.text);
			assert.equal(startRes.details.active, true);
			for (const name of [...gatedNames, ...alwaysActiveNames]) {
				assert.equal(getActive().includes(name), true, `${name} should be active after coms_start`);
			}

			const stopRes = await tools.get("coms_stop").execute("id-stop", {});
			assert.equal(stopRes.details.active, false);
			for (const name of gatedNames) {
				assert.equal(getActive().includes(name), false, `${name} should be inactive after coms_stop`);
			}
			for (const name of alwaysActiveNames) {
				assert.equal(getActive().includes(name), true, `${name} should stay active after coms_stop`);
			}
		});
	});

	it("toggles gated tools via /coms slash lifecycle", async () => {
		await withComsTempSession(async ({ commands, getActive, sessionCtx }) => {
			const comsCmd = commands.get("coms");
			await comsCmd.handler("start --cname gate-peer2 --project gate-proj", sessionCtx);
			for (const name of gatedNames) {
				assert.equal(getActive().includes(name), true, `${name} should be active after /coms start`);
			}
			await comsCmd.handler("stop", sessionCtx);
			for (const name of gatedNames) {
				assert.equal(getActive().includes(name), false, `${name} should be inactive after /coms stop`);
			}
		});
	});
});
