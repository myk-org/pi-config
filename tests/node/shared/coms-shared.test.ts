/**
 * Tests for coms-shared formatting helpers (queue depth, response text).
 * Run with: npx tsx --test tests/node/shared/coms-shared.test.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatComsResponseText, formatComsResponseType, formatComsResponseBody, formatComsInboundType, buildInboundContent, formatQueueStr, renderQueuePart, sanitizeComsName, syncComsActiveTools } from "../../../extensions/coms/coms-shared.js";
import { createComsPeerRuntime } from "../../../extensions/coms/coms-p2p.js";
import { registerComs } from "../../../extensions/coms/coms-wrapper.js";
import { setComsActive, isComsActive, resetSessionBridge } from "../../../extensions/shared/session-bridge.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

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

describe("registerComs lifecycle, /coms-queue gating, and reload reactivation", () => {
	function makeStatefulPi() {
		const tools = new Map<string, any>();
		let activeTools: string[] = ["read", "bash"];
		const events = new Map<string, Array<(...args: any[]) => any>>();
		const commands = new Map<string, any>();
		const persisted: Array<{ key: string; data: any }> = [];
		const busListeners = new Map<string, Array<(data: unknown) => void>>();
		const emittedBus: Array<{ channel: string; data: unknown }> = [];
		const pi = {
			tools,
			commands,
			persisted,
			busListeners,
			emittedBus,
			events: {
				emit: (channel: string, data: unknown) => {
					emittedBus.push({ channel, data });
					for (const fn of [...(busListeners.get(channel) ?? [])]) fn(data);
				},
				on: (channel: string, fn: (data: unknown) => void) => {
					const list = busListeners.get(channel) ?? [];
					list.push(fn);
					busListeners.set(channel, list);
					return () => {
						const cur = busListeners.get(channel);
						if (!cur) return;
						const idx = cur.indexOf(fn);
						if (idx >= 0) cur.splice(idx, 1);
					};
				},
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
			appendEntry: (key: string, data: any) => {
				persisted.push({ key, data });
			},
			sendMessage: () => {},
		};
		return { pi, tools, events, commands, persisted, busListeners, emittedBus, getActive: () => [...activeTools] };
	}

	it("registers zero-arg /coms without a separate /coms-queue command", () => {
		const { pi, commands } = makeStatefulPi();
		registerComs(pi as any, { allowSubagentChild: true, registerSignalHandlers: false });
		assert.ok(commands.has("coms"));
		assert.equal(commands.has("coms-queue"), false);
		assert.equal(commands.get("coms").getArgumentCompletions, undefined);
	});

	it("gates inbound queue overlay when COMS runtime is inactive", async () => {
		const { pi } = makeStatefulPi();
		const { runtime } = registerComs(pi as any, { allowSubagentChild: true, registerSignalHandlers: false });
		const notifies: string[] = [];
		await runtime.openQueueOverlay("", {
			hasUI: false,
			ui: { notify: (msg: string) => { notifies.push(msg); } },
		});
		assert.ok(notifies.some((m) => m.includes("coms not active")));
	});

	it("registers one pidash:request-commands listener covering /coms", async () => {
		const { pi, events, busListeners, emittedBus } = makeStatefulPi();
		registerComs(pi as any, { allowSubagentChild: true, registerSignalHandlers: false });

		const listeners = busListeners.get("pidash:request-commands") ?? [];
		assert.equal(listeners.length, 1);

		emittedBus.length = 0;
		pi.events.emit("pidash:request-commands", undefined);
		const registered = emittedBus
			.filter((e) => e.channel === "pidash:register-command")
			.map((e) => (e.data as any)?.name);
		assert.deepEqual(registered, ["coms"]);

		for (const handler of events.get("session_shutdown") ?? []) await handler();
		assert.equal((busListeners.get("pidash:request-commands") ?? []).length, 0);
	});

	it("reactivates COMS on reload when previously active", async () => {
		resetSessionBridge({ all: true });
		const tmpRoot = makeTempDir("coms-reload-ok-");
		const comsDir = path.join(tmpRoot, "coms");
		const { pi, events, getActive } = makeStatefulPi();
		const registered = registerComs(pi as any, {
			comsDir,
			sessionId: "reload-ok-sess",
			allowSubagentChild: true,
			registerSignalHandlers: false,
		});
		try {
			const startHandlers = events.get("session_start") ?? [];
			assert.equal(startHandlers.length, 1);
			await startHandlers[0](
				{ reason: "reload" },
				{
					cwd: tmpRoot,
					hasUI: false,
					ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
					sessionManager: {
						getSessionId: () => "reload-ok-sess",
						getEntries: () => [
							{
								type: "custom",
								customType: "coms-state",
								data: { active: true, flags: { cname: "reload-peer", project: "reload-proj" }, extra: { origin: "tool" } },
							},
						],
					},
				},
			);
			assert.equal(isComsActive("reload-ok-sess"), true);
			assert.equal(registered.runtime.isActive(), true);
			assert.equal(registered.runtime.getSelf()?.origin, "tool");
			assert.equal(getActive().includes("coms_send"), true);
			assert.equal(getActive().includes("coms_stop"), true);
		} finally {
			await registered.runtime.stop();
			resetSessionBridge({ all: true });
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("isolates comsActive reload reactivation per session", async () => {
		resetSessionBridge({ all: true });
		const tmpRoot = makeTempDir("coms-reload-iso-");
		const comsDir = path.join(tmpRoot, "coms");
		const { pi, events } = makeStatefulPi();
		const registered = registerComs(pi as any, {
			comsDir,
			sessionId: "sess-coms-a",
			allowSubagentChild: true,
			registerSignalHandlers: false,
		});
		try {
			const ctxA = {
				cwd: tmpRoot,
				hasUI: false,
				ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
				sessionManager: {
					getSessionId: () => "sess-coms-a",
					getEntries: () => [
						{
							type: "custom",
							customType: "coms-state",
							data: { active: true, flags: { cname: "iso-peer", project: "iso-proj" }, extra: {} },
						},
					],
				},
			};
			await (events.get("session_start") ?? [])[0]({ reason: "reload" }, ctxA);
			assert.equal(isComsActive("sess-coms-a"), true);
			assert.equal(isComsActive("sess-coms-b"), false);

			await (events.get("session_shutdown") ?? [])[0]({}, ctxA);
			assert.equal(isComsActive("sess-coms-a"), false);
		} finally {
			await registered.runtime.stop();
			resetSessionBridge({ all: true });
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("clears persisted active state when reload reactivation fails", async () => {
		resetSessionBridge({ all: true });
		setComsActive(true, "reload-fail-sess");
		const tmpRoot = makeTempDir("coms-reload-fail-");
		// Place a regular file where comsDir is expected so ensureProjectDirs throws/fails.
		const blockedComsDir = path.join(tmpRoot, "not-a-dir");
		fs.writeFileSync(blockedComsDir, "blocker");
		const { pi, events, persisted, getActive } = makeStatefulPi();
		const registered = registerComs(pi as any, {
			comsDir: blockedComsDir,
			sessionId: "reload-fail-sess",
			allowSubagentChild: true,
			registerSignalHandlers: false,
		});
		try {
			syncComsActiveTools(pi as any, new Set(["coms_list", "coms_stop"]), true);
			const startHandlers = events.get("session_start") ?? [];
			await startHandlers[0](
				{ reason: "reload" },
				{
					cwd: tmpRoot,
					hasUI: false,
					ui: { notify: () => {} },
					sessionManager: {
						getSessionId: () => "reload-fail-sess",
						getEntries: () => [
							{
								type: "custom",
								customType: "coms-state",
								data: { active: true, flags: { cname: "fail-peer", project: "fail-proj" }, extra: {} },
							},
						],
					},
				},
			);
			assert.equal(isComsActive("reload-fail-sess"), false);
			assert.equal(registered.runtime.isActive(), false);
			assert.equal(getActive().includes("coms_list"), false);
			assert.equal(getActive().includes("coms_stop"), false);
			assert.ok(persisted.some((p) => p.key === "coms-state" && p.data?.active === false));
		} finally {
			await registered.runtime.stop();
			resetSessionBridge({ all: true });
			fs.rmSync(tmpRoot, { recursive: true, force: true });
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

	it("marks deferred peer runtime tools defaultActive false", () => {
		const { pi, tools, getActive } = makeStatefulPi();
		const runtime = createComsPeerRuntime(pi as any, {
			deferred: true,
			inactiveMessage: "inactive",
			allowSubagentChild: true,
			registerSignalHandlers: false,
		});

		assert.equal(tools.get("coms_send")?.defaultActive, false);
		assert.equal(runtime.gatedToolNames.has("coms_send"), true);
		assert.deepEqual(getActive(), ["read", "bash"]);
	});

	it("blocks execution of inactive deferred peer runtime tools", async () => {
		const { pi, tools } = makeStatefulPi();
		createComsPeerRuntime(pi as any, {
			deferred: true,
			inactiveMessage: "inactive",
			allowSubagentChild: true,
			registerSignalHandlers: false,
		});

		const res = await tools.get("coms_send").execute("id1", { target: "nobody", prompt: "hi" });
		assert.equal(res.content[0].text, "inactive");
	});

	it("adds gated tools via syncComsActiveTools when activated", () => {
		const { pi, getActive } = makeStatefulPi();
		syncComsActiveTools(pi as any, new Set(["coms_send"]), true);
		assert.deepEqual(getActive(), ["read", "bash", "coms_send"]);
	});

	it("removes gated tools via syncComsActiveTools when deactivated", () => {
		const { pi, getActive } = makeStatefulPi();
		const gated = new Set(["coms_send"]);
		syncComsActiveTools(pi as any, gated, true);
		syncComsActiveTools(pi as any, gated, false);
		assert.deepEqual(getActive(), ["read", "bash"]);
	});

	it("includes anti-loop reply warning directly in coms_send description", () => {
		const { pi, tools } = makeStatefulPi();
		createComsPeerRuntime(pi as any, {
			deferred: true,
			allowSubagentChild: true,
			registerSignalHandlers: false,
		});
		assert.match(tools.get("coms_send")?.description ?? "", /DO NOT call this to REPLY/);
	});

	it("registerComs gates 17 tools while keeping discovery tools active", async () => {
		const { pi, tools, getActive } = makeStatefulPi();
		withSubagentChildEnv(undefined, () => {
			registerComs(pi as any);
			return undefined;
		});

		const gatedNames = [
			"coms_list", "coms_send", "coms_broadcast", "coms_history", "coms_get",
			"coms_queue_inspect", "coms_queue_delete", "coms_queue_edit", "coms_queue_clear", "coms_queue_prioritize",
			"coms_local_queue",
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
			resetSessionBridge({ all: true });
			if (prevComsDir === undefined) delete process.env.PI_COMS_DIR;
			else process.env.PI_COMS_DIR = prevComsDir;
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	}

	const gatedNames = [
		"coms_list", "coms_send", "coms_broadcast", "coms_history", "coms_get",
		"coms_queue_inspect", "coms_queue_delete", "coms_queue_edit", "coms_queue_clear", "coms_queue_prioritize",
		"coms_local_queue",
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

	it("renders plain-text peer list when /coms runs without UI", async () => {
		await withComsTempSession(async ({ commands, sessionCtx }) => {
			const notices: string[] = [];
			const comsCmd = commands.get("coms");
			await comsCmd.handler("", { ...sessionCtx, hasUI: false, ui: { notify: (msg: string) => notices.push(msg) } });
			assert.equal(notices.length, 1);
			assert.match(notices[0], /No peers in project/);
		});
	});
});
