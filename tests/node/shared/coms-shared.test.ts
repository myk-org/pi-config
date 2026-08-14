/**
 * Tests for coms-shared formatting helpers (queue depth, response text).
 * Run with: npx tsx --test tests/node/shared/coms-shared.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatComsResponseText, formatComsResponseType, formatComsResponseBody, formatComsInboundType, buildInboundContent, formatQueueStr, renderQueuePart, sanitizeComsName, createDeferredProxy, type DeferredUpstream } from "../../../extensions/coms/coms-shared.js";

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
		const { setComsActive, isComsActive } = await import("../../../extensions/shared/coms-active.js");
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
		const { setComsActive, isComsActive } = await import("../../../extensions/shared/coms-active.js");
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

});
