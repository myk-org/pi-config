import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";

import comsP2p from "../../../extensions/coms/coms-p2p.js";
import { ComsRegistry } from "../../../extensions/coms/coms-registry.js";
import { registerComs } from "../../../extensions/coms/coms-wrapper.js";
import { isComsInboundCustomType, loadPitasks, summarizeTaskList } from "../../../extensions/coms/coms-shared.js";
import { publishTaskStore, publishWorkloadSources, resetSessionBridge } from "../../../extensions/shared/session-bridge.js";
import { TaskStore } from "../../../extensions/pitasks/task-store.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

interface FakePi {
	tools: Map<string, any>;
	commands: Map<string, any>;
	handlers: Map<string, Function>;
	messages: any[];
	sendMessageCalls: Array<{ msg: any; opts?: any }>;
	activeTools: string[];
	flags: Map<string, any>;
	events: {
		on: (channel: string, fn: (data: unknown) => void) => () => void;
		emit: (channel: string, data?: unknown) => void;
	};
	registerFlag: (name: string, opts: any) => void;
	getFlag: (name: string) => any;
	registerTool: (tool: any) => void;
	registerCommand: (name: string, def: any) => void;
	getActiveTools: () => string[];
	setActiveTools: (tools: string[]) => void;
	appendEntry: (key: string, data: unknown) => void;
	on: (event: string, handler: Function) => void;
	sendMessage: (msg: any, opts?: any) => void;
	shutdown: () => Promise<void>;
}

function createFakePi(flagOverrides: Record<string, any> = {}): FakePi {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function>();
	const messages: any[] = [];
	const sendMessageCalls: Array<{ msg: any; opts?: any }> = [];
	const flags = new Map<string, any>(Object.entries(flagOverrides));
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	let activeTools: string[] = [];

	return {
		tools,
		commands,
		handlers,
		messages,
		sendMessageCalls,
		get activeTools() { return activeTools; },
		set activeTools(v: string[]) { activeTools = v; },
		flags,
		events: {
			on(channel: string, fn: (data: unknown) => void) {
				if (!listeners.has(channel)) listeners.set(channel, new Set());
				listeners.get(channel)!.add(fn);
				return () => listeners.get(channel)?.delete(fn);
			},
			emit(channel: string, data?: unknown) {
				for (const fn of listeners.get(channel) ?? []) fn(data);
			},
		},
		registerFlag(name: string, opts: any) {
			if (!flags.has(name) && opts && "default" in opts) flags.set(name, opts.default);
		},
		getFlag(name: string) {
			return flags.get(name);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
			if (tool.defaultActive !== false && !activeTools.includes(tool.name)) {
				activeTools.push(tool.name);
			}
		},
		registerCommand(name: string, def: any) {
			commands.set(name, def);
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(next: string[]) {
			activeTools = [...next];
		},
		appendEntry() {},
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		sendMessage(msg: any, opts?: any) {
			messages.push(msg);
			sendMessageCalls.push({ msg, opts });
		},
		async shutdown() {
			await handlers.get("session_shutdown")?.();
		},
	};
}

function makeWorkspace(): { workspace: string; comsDir: string } {
	const workspace = makeTempDir("coms-wt13-");
	const comsDir = join(workspace, "coms");
	mkdirSync(join(workspace, ".pi"), { recursive: true });
	writeFileSync(join(workspace, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: comsDir }));
	return { workspace, comsDir };
}

function makeCtx(
	cwd: string,
	sessionId: string,
	assistantText?: () => string,
	overrides?: { hasUI?: boolean; mode?: string },
) {
	return {
		cwd,
		model: { id: "test-model" },
		hasUI: overrides?.hasUI ?? false,
		...(overrides?.mode !== undefined ? { mode: overrides.mode } : {}),
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

async function startP2pPeer(opts: {
	name: string;
	sessionId: string;
	project?: string;
	cwd: string;
	piTasks?: string;
	hasUI?: boolean;
	mode?: string;
}): Promise<FakePi> {
	const pi = createFakePi({
		cname: opts.name,
		project: opts.project ?? "default",
	});
	startedPeers.push(pi);
	const prevPiTasks = process.env.PI_TASKS;
	if (opts.piTasks !== undefined) process.env.PI_TASKS = opts.piTasks;
	try {
		withSubagentChildEnv(undefined, () => {
			comsP2p(pi as any);
			assert.ok(pi.tools.get("coms_send"), "coms_send must register");
		});
	} finally {
		if (prevPiTasks === undefined) delete process.env.PI_TASKS;
		else process.env.PI_TASKS = prevPiTasks;
	}
	(globalThis as any).__piConfigSessionId = opts.sessionId;
	await pi.handlers.get("session_start")!(
		{},
		makeCtx(opts.cwd, opts.sessionId, undefined, { hasUI: opts.hasUI, mode: opts.mode }),
	);
	return pi;
}

describe("WT-13 coms & tasks performance/correctness", { concurrency: false }, () => {
	// ── #1239 ────────────────────────────────────────────────────────────────
	it("#1239: staleCheckTimer does not leak intervals across coms_stop -> coms_start cycles", async () => {
		const { workspace } = makeWorkspace();
		const pi = createFakePi();
		startedPeers.push(pi);

		withSubagentChildEnv(undefined, () => {
			registerComs(pi as any);
			assert.ok(pi.commands.get("coms"), "/coms command must register");
		});

		const origSetInterval = globalThis.setInterval;
		const origClearInterval = globalThis.clearInterval;
		const activeStaleTimers = new Set<any>();
		const active60sTimers = new Set<any>();
		let createdStale = 0;
		let clearedStale = 0;

		(globalThis as any).setInterval = (fn: any, ms?: number, ...args: any[]) => {
			const handle = origSetInterval(fn, ms, ...args);
			if (ms === 60_000) {
				active60sTimers.add(handle);
				if (typeof fn === "function" && fn.toString().includes("stale_check")) {
					createdStale++;
					activeStaleTimers.add(handle);
				}
			}
			return handle;
		};
		(globalThis as any).clearInterval = (handle: any) => {
			active60sTimers.delete(handle);
			if (activeStaleTimers.delete(handle)) clearedStale++;
			return origClearInterval(handle);
		};

		try {
			const ctx = makeCtx(workspace, "wrapper-timer-session");
			await pi.handlers.get("session_start")!({ reason: "startup" }, ctx);
			const comsStart = pi.tools.get("coms_start");
			const comsStop = pi.tools.get("coms_stop");

			await comsStart.execute("start-1", { cname: "timer-peer", project: "timer-proj" }, undefined, undefined, ctx);
			assert.equal(activeStaleTimers.size, 1, "first start registers one staleCheckTimer");

			await comsStop.execute("stop-1", {}, undefined, undefined, ctx);
			assert.equal(activeStaleTimers.size, 0, "first stop clears staleCheckTimer");
			assert.equal(active60sTimers.size, 0, "first stop clears all 60s timers");

			await comsStart.execute("start-2", { cname: "timer-peer", project: "timer-proj" }, undefined, undefined, ctx);
			assert.equal(activeStaleTimers.size, 1, "second start registers one staleCheckTimer");

			await comsStop.execute("stop-2", {}, undefined, undefined, ctx);
			assert.equal(activeStaleTimers.size, 0, "second stop clears staleCheckTimer");
			assert.equal(active60sTimers.size, 0, "second stop clears all 60s timers");

			assert.equal(createdStale, 2);
			assert.equal(clearedStale, 2);
		} finally {
			for (const h of active60sTimers) origClearInterval(h);
			globalThis.setInterval = origSetInterval;
			globalThis.clearInterval = origClearInterval;
		}
	});

	it("#1239: resolveTarget resolves a peer in a different project by both coms_session_id and name", async () => {
		const { workspace } = makeWorkspace();
		const alpha = await startP2pPeer({ name: "alpha", sessionId: "sess-alpha", project: "proj-a", cwd: workspace });
		const beta = await startP2pPeer({ name: "beta", sessionId: "sess-beta-other", project: "proj-b", cwd: workspace });

		const byId = await alpha.tools.get("coms_send").execute("send-by-id", {
			target: "sess-beta-other",
			prompt: "ping-by-id",
		});
		assert.equal(byId.details.target_session, "sess-beta-other");

		// Finish beta's first inbound turn before sending the second so each arrives as its own message.
		await waitUntil(() => beta.messages.some((m) => typeof m.content === "string" && m.content.includes("ping-by-id")));
		const firstInbound = beta.messages.find((m) => typeof m.content === "string" && m.content.includes("ping-by-id"));
		await beta.handlers.get("message_start")!({ message: { role: "custom", ...firstInbound } });
		await beta.handlers.get("agent_end")!({}, makeCtx(workspace, "sess-beta-other", () => "ack-id"));

		const byName = await alpha.tools.get("coms_send").execute("send-by-name", {
			target: "beta",
			prompt: "ping-by-name",
		});
		assert.equal(byName.details.target_session, "sess-beta-other");

		await waitUntil(() => beta.messages.filter((m) => isComsInboundCustomType(m.customType) && String(m.details?.header ?? m.customType).startsWith("from alpha")).length >= 2);
		const bodies = beta.messages.map((m) => m.content).join("\n");
		assert.match(bodies, /ping-by-id/);
		assert.match(bodies, /ping-by-name/);
	});

	it("#1392: /coms is a zero-arg TUI command with no argument completions", async () => {
		const { workspace } = makeWorkspace();
		const pi = createFakePi();
		startedPeers.push(pi);

		withSubagentChildEnv(undefined, () => {
			registerComs(pi as any);
			assert.ok(pi.commands.get("coms"), "/coms command must register");
		});
		await pi.handlers.get("session_start")!({ reason: "startup" }, makeCtx(workspace, "comp-session"));

		const comsCmd = pi.commands.get("coms");
		assert.equal(comsCmd.getArgumentCompletions, undefined);
		assert.equal(pi.commands.has("coms-queue"), false, "/coms-queue is folded into /coms");
	});

	// ── #1241 ────────────────────────────────────────────────────────────────
	it("#1241: coms_send schema omits clearPrevious while runtime clearPrevious:true rejects, and pending warning uses queue tools", async () => {
		const { workspace } = makeWorkspace();
		const sender = await startP2pPeer({ name: "sender", sessionId: "s-1241", project: "p-1241", cwd: workspace });
		await startP2pPeer({ name: "receiver", sessionId: "r-1241", project: "p-1241", cwd: workspace });

		const comsSend = sender.tools.get("coms_send");
		assert.equal("clearPrevious" in comsSend.parameters.properties, false, "schema omits clearPrevious");

		await assert.rejects(
			comsSend.execute("reject-clear", { target: "receiver", prompt: "hi", clearPrevious: true }),
			/clearPrevious is no longer allowed/,
		);

		await comsSend.execute("first", { target: "receiver", prompt: "first pending" });
		const second = await comsSend.execute("second", { target: "receiver", prompt: "second pending" });
		const text = second.content[0].text as string;
		assert.match(text, /coms_queue_inspect/);
		assert.match(text, /coms_queue_clear/);
		assert.doesNotMatch(text, /clearPrevious/);
	});

	it("#1241: coms-welcome omits redundant Available tools catalog while keeping identity, auto-capture rule, and connected peers", async () => {
		const { workspace } = makeWorkspace();
		await startP2pPeer({ name: "first-peer", sessionId: "fp-1", project: "p-welcome", cwd: workspace });
		const second = await startP2pPeer({ name: "second-peer", sessionId: "sp-2", project: "p-welcome", cwd: workspace });

		const welcome = second.messages.find((m) => m.customType === "coms-welcome");
		assert.ok(welcome, "coms-welcome message emitted");
		assert.equal(welcome.content.includes("## Available tools"), false);
		assert.match(welcome.content, /You are "second-peer" on project "p-welcome"/);
		assert.match(welcome.content, /auto-captured when your turn ends/);
		assert.match(welcome.content, /## Connected peers/);
		assert.match(welcome.content, /first-peer/);
	});

	it("#1351: coms-welcome always passes display:true and triggerTurn:false on solo boot, multi-peer boot, and reload/reconnect", async () => {
		const { workspace } = makeWorkspace();
		const first = await startP2pPeer({ name: "first-peer", sessionId: "fp-1351", project: "p-1351", cwd: workspace });

		const soloWelcome = first.sendMessageCalls.find((c) => c.msg?.customType === "coms-welcome");
		assert.ok(soloWelcome, "solo peer emits coms-welcome");
		assert.equal(soloWelcome.msg.display, true);
		assert.deepEqual(soloWelcome.opts, { triggerTurn: false });
		assert.match(soloWelcome.msg.content, /You are "first-peer" on project "p-1351"/);
		assert.match(soloWelcome.msg.content, /none yet — you are the first peer/);
		assert.match(soloWelcome.msg.content, /Do not respond to this message\./);

		const second = await startP2pPeer({ name: "second-peer", sessionId: "sp-1351", project: "p-1351", cwd: workspace });

		const multiWelcome = second.sendMessageCalls.find((c) => c.msg?.customType === "coms-welcome");
		assert.ok(multiWelcome, "multi-peer boot emits coms-welcome");
		assert.equal(multiWelcome.msg.display, true);
		assert.deepEqual(multiWelcome.opts, { triggerTurn: false });
		assert.match(multiWelcome.msg.content, /You are "second-peer" on project "p-1351"/);
		assert.match(multiWelcome.msg.content, /auto-captured when your turn ends/);
		assert.match(multiWelcome.msg.content, /## Connected peers/);
		assert.match(multiWelcome.msg.content, /first-peer/);
		assert.match(multiWelcome.msg.content, /Do not respond to this message\./);

		// Simulate reload/reconnect while first-peer is still active
		const beforeReload = second.sendMessageCalls.length;
		await second.shutdown();
		(globalThis as any).__piConfigSessionId = "sp-1351";
		await second.handlers.get("session_start")!({ reason: "reload" }, makeCtx(workspace, "sp-1351"));

		const reloadWelcome = second.sendMessageCalls
			.slice(beforeReload)
			.find((c) => c.msg?.customType === "coms-welcome");
		assert.ok(reloadWelcome, "reloaded peer emits coms-welcome");
		assert.equal(reloadWelcome.msg.display, true);
		assert.deepEqual(reloadWelcome.opts, { triggerTurn: false });
		assert.match(reloadWelcome.msg.content, /first-peer/);
		assert.match(reloadWelcome.msg.content, /Do not respond to this message\./);
	});

	it("#1241: registerComs keeps always-on wrapper tools registered and active", () => {
		const pi = createFakePi();
		withSubagentChildEnv(undefined, () => {
			registerComs(pi as any);
			for (const name of ["coms_start", "coms_peers", "coms_peer_spawn", "coms_peer_kill"]) {
				const tool = pi.tools.get(name);
				assert.ok(tool, `${name} must be registered`);
				assert.notEqual(tool.defaultActive, false, `${name} must stay active by default`);
				assert.ok(pi.activeTools.includes(name), `${name} must be in activeTools`);
			}
			for (const gated of ["coms_send", "coms_stop"]) {
				const tool = pi.tools.get(gated);
				assert.ok(tool, `${gated} must be registered`);
				assert.equal(tool.defaultActive, false, `${gated} must be gated off until start`);
			}
		});
	});

	it("#1241: coms-p2p skips registration when PI_SUBAGENT_CHILD=1", () => {
		const pi = createFakePi();
		withSubagentChildEnv("1", () => {
			comsP2p(pi as any);
			assert.equal(pi.tools.size, 0, "no tools registered for subagent child");
			assert.equal(pi.handlers.size, 0, "no handlers registered for subagent child");
		});
	});

	// ── #1245 ────────────────────────────────────────────────────────────────
	it("#1245: summarizeTaskList handles null, empty, mixed, and non-standard task statuses", () => {
		assert.equal(summarizeTaskList(null), null);
		assert.equal(summarizeTaskList(undefined), null);
		assert.equal(summarizeTaskList([]), null);
		assert.deepEqual(
			summarizeTaskList([
				{ status: "pending" },
				{ status: "in_progress" },
				{ status: "completed" },
				{ status: "completed" },
				{ status: "archived" },
			]),
			{ total: 5, completed: 2, in_progress: 1 },
		);
	});

	it("#1245: writeLiveRegistry reads publishedTaskStore().list() once per registry+card update", async () => {
		const { workspace } = makeWorkspace();
		let listCalls = 0;
		const storeFile = join(workspace, "tasks.json");
		const mockStore = {
			filePath: storeFile,
			list: () => {
				listCalls++;
				return [{ id: "1", status: "pending", subject: "Task", blockedBy: [], assignee: "llm" }];
			},
		};
		for (const sid of ["cp-1", "sp-1"]) {
			publishWorkloadSources({ agents: () => [], crons: () => [] }, sid);
			publishTaskStore(() => mockStore, sid);
		}

		const peer = await startP2pPeer({ name: "card-peer", sessionId: "cp-1", project: "p-1245", cwd: workspace });
		const sender = await startP2pPeer({ name: "sender-peer", sessionId: "sp-1", project: "p-1245", cwd: workspace });

		// Wait for both peers' initial ping worker ready card pushes to settle.
		await waitUntil(() => listCalls >= 2);
		await new Promise((r) => setTimeout(r, 30));
		listCalls = 0;

		// before_agent_start runs before orchestrator/pitasks re-publish for the switched session:
		// it refreshes currentCtx without prematurely writing workload: null or advancing pi_session_id.
		await peer.handlers.get("before_agent_start")!({}, makeCtx(workspace, "changed-pi-session-id"));
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(listCalls, 0, "before_agent_start defers writeLiveRegistry until bridges republish");

		// Once orchestrator/pitasks publish for the new session, agent_start detects the changed
		// pi_session_id and writes the registry with non-null workload exactly once.
		publishWorkloadSources({ agents: () => [], crons: () => [] }, "changed-pi-session-id");
		publishTaskStore(() => mockStore, "changed-pi-session-id");
		await peer.handlers.get("agent_start")!({}, makeCtx(workspace, "changed-pi-session-id"));
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(listCalls, 1, "agent_start writeLiveRegistry reads store.list() only once");

		// Trigger writeLiveRegistry() via busy transition on inbound prompt.
		listCalls = 0;
		await sender.tools.get("coms_send").execute("busy-flip", { target: "card-peer", prompt: "trigger busy" });
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(listCalls, 1, "busy transition writeLiveRegistry reads store.list() only once");
	});

	it("#1245: pruneStaleRegistry removes orphan .sock/.sock.ping files while keeping sockets for surviving entries", async () => {
		const comsDir = makeTempDir("coms-prune-");
		const socketsDir = join(comsDir, "sockets");
		const agentsDir = join(comsDir, "projects", "proj-p", "agents");
		mkdirSync(socketsDir, { recursive: true });
		mkdirSync(agentsDir, { recursive: true });

		const aliveSock = join(socketsDir, "alive.sock");
		const alivePing = `${aliveSock}.ping`;
		const orphanSock = join(socketsDir, "orphan.sock");
		const orphanPing = `${orphanSock}.ping`;
		writeFileSync(aliveSock, "");
		writeFileSync(orphanSock, "");
		writeFileSync(orphanPing, "");

		const pingServer = net.createServer((sock) => sock.destroy());
		await new Promise<void>((resolve) => pingServer.listen(alivePing, resolve));

		const regFile = join(agentsDir, "alive-sess.json");
		writeFileSync(regFile, JSON.stringify({
			coms_session_id: "alive-sess",
			name: "alive",
			pid: process.pid,
			endpoint: aliveSock,
		}));

		try {
			const registry = new ComsRegistry(comsDir);
			await registry.pruneStaleStartup();

			assert.equal(existsSync(orphanSock), false, "orphan .sock removed");
			assert.equal(existsSync(orphanPing), false, "orphan .sock.ping removed");
			assert.equal(existsSync(aliveSock), true, "surviving .sock kept");
			assert.equal(existsSync(alivePing), true, "surviving .sock.ping kept");
			assert.equal(existsSync(regFile), true, "surviving registry entry kept");
		} finally {
			await new Promise<void>((resolve) => pingServer.close(() => resolve()));
		}
	});

	// ── #1246 & #1248 ────────────────────────────────────────────────────────
	it("#1246/#1248: coms_task_list and coms_task_get filter completed blockers, and delete/update enforce creator & in_progress guards", async () => {
		const { workspace } = makeWorkspace();
		const receiverStorePath = join(workspace, "receiver-tasks.json");
		const store = new TaskStore(receiverStorePath);
		const senderCreator = { type: "coms" as const, origin: "sender", session: "sender-1246", project: "" };
		const otherCreator = { type: "coms" as const, origin: "other", session: "other-1246", project: "" };

		const t1 = store.create("Done blocker", "d1", senderCreator);
		store.update(t1.id, { status: "completed" });
		const t2 = store.create("Open blocker", "d2", senderCreator);
		const t3 = store.create("Blocked task", "d3", senderCreator);
		const t4 = store.create("Downstream task", "d4", senderCreator);
		store.update(t3.id, { addBlockedBy: [t1.id, t2.id], addBlocks: [t4.id] });
		const tForeign = store.create("Foreign task", "df", otherCreator);
		const tUser = store.create("User task", "du", senderCreator, undefined, undefined, "user");
		const tActive = store.create("Running own task", "da", senderCreator);
		store.update(tActive.id, { status: "in_progress" });
		store.close();

		const sender = await startP2pPeer({ name: "sender", sessionId: "sender-1246", project: "p-1246", cwd: workspace });
		await startP2pPeer({ name: "receiver", sessionId: "receiver-1246", project: "p-1246", cwd: workspace, piTasks: receiverStorePath });

		const listRes = await sender.tools.get("coms_task_list").execute("list", { target: "receiver" });
		const listText = listRes.content[0].text as string;
		const t3Line = listText.split("\n").find((l) => l.startsWith(`#${t3.id} `));
		assert.ok(t3Line, "task 3 present in list");
		assert.match(t3Line, new RegExp(`\\[blocked by #${t2.id}\\]`));
		assert.doesNotMatch(t3Line, new RegExp(`#${t1.id}\\b`));
		// #1246: coms_task_list preserves status-then-id order (user-assigned tasks do not jump ahead of earlier pending ids).
		assert.deepEqual(
			listRes.details.taskIds,
			[t2.id, t3.id, t4.id, tForeign.id, tUser.id, tActive.id, t1.id],
		);

		const getRes = await sender.tools.get("coms_task_get").execute("get", { target: "receiver", task_id: t3.id });
		const getText = getRes.content[0].text as string;
		assert.match(getText, new RegExp(`Blocked by: #${t2.id}\\n`));
		assert.doesNotMatch(getText, new RegExp(`Blocked by:.*#${t1.id}\\b`));
		assert.match(getText, new RegExp(`Blocks: #${t4.id}`));

		await assert.rejects(
			sender.tools.get("coms_task_delete").execute("del-foreign", { target: "receiver", task_id: tForeign.id }),
			/Ownership denied/,
		);
		await assert.rejects(
			sender.tools.get("coms_task_update").execute("upd-foreign", { target: "receiver", task_id: tForeign.id, subject: "nope" }),
			/Ownership denied/,
		);

		const delInProg = await sender.tools.get("coms_task_delete").execute("del-active", { target: "receiver", task_id: tActive.id });
		assert.deepEqual(delInProg.details, { blocked: true, reason: "in_progress" });
		assert.match(delInProg.content[0].text, /Cannot delete task.*in_progress/);

		const updInProg = await sender.tools.get("coms_task_update").execute("upd-active", { target: "receiver", task_id: tActive.id, subject: "nope" });
		assert.deepEqual(updInProg.details, { blocked: true, reason: "in_progress" });
		assert.match(updInProg.content[0].text, /Cannot update task.*in_progress/);
	});

	it("#1248: loadPitasks() returns the same memoized Promise across calls", async () => {
		const p1 = loadPitasks();
		const p2 = loadPitasks();
		assert.strictEqual(p1, p2);
		const mod = await p1;
		assert.equal(typeof mod.listTasksAtStorePath, "function");
	});

	// ── #1252 ────────────────────────────────────────────────────────────────
	it("#1252: multi-message FIFO bundling + comsSendCalledThisTurn drain + mixed-turn reinjection work end-to-end", async () => {
		const { workspace } = makeWorkspace();
		const blocker = await startP2pPeer({ name: "blocker", sessionId: "b-1252", project: "p-1252", cwd: workspace });
		const sender = await startP2pPeer({ name: "sender", sessionId: "s-1252", project: "p-1252", cwd: workspace });
		const other = await startP2pPeer({ name: "other", sessionId: "o-1252", project: "p-1252", cwd: workspace });
		const receiver = await startP2pPeer({ name: "receiver", sessionId: "r-1252", project: "p-1252", cwd: workspace });

		// Step A: Multi-message FIFO bundling
		const deliverLatestInbound = async (peer: FakePi, msgId?: string) => {
			const msg = [...peer.messages].reverse().find((m) => m.details?.msg_id && (!msgId || m.details.msg_id === msgId));
			assert.ok(msg, `expected injected inbound${msgId ? ` ${msgId}` : ""}`);
			await peer.handlers.get("message_start")!({ message: { role: "custom", ...msg } });
		};
		await blocker.tools.get("coms_send").execute("b0", { target: "receiver", prompt: "initial busy" });
		const r1 = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "bundle one" });
		const r2 = await sender.tools.get("coms_send").execute("s2", { target: "receiver", prompt: "bundle two" });
		const m1 = r1.details.msg_id as string;
		const m2 = r2.details.msg_id as string;

		// Complete blocker's turn -> drains sender's 2 queued messages as one bundle.
		await deliverLatestInbound(receiver);
		await receiver.handlers.get("agent_end")!({}, makeCtx(workspace, "r-1252", () => "reply-blocker"));
		const bundledMsg = receiver.messages.find((m) => Array.isArray(m.details?.bundled_msg_ids));
		assert.ok(bundledMsg, "receiver injects a bundled followUp");
		assert.deepEqual(bundledMsg.details.bundled_msg_ids, [m1, m2]);
		assert.match(bundledMsg.content, /BUNDLED: 2 messages/);

		// Complete bundled turn -> primary gets reply, secondary gets "bundled".
		await deliverLatestInbound(receiver, m1);
		await receiver.handlers.get("agent_end")!({}, makeCtx(workspace, "r-1252", () => "reply-bundle"));
		await waitUntil(async () => {
			const g1 = await sender.tools.get("coms_get").execute("g1", { msg_id: m1 });
			const g2 = await sender.tools.get("coms_get").execute("g2", { msg_id: m2 });
			return g1.details.status === "complete" && g2.details.status === "complete";
		});
		const g1 = await sender.tools.get("coms_get").execute("g1-check", { msg_id: m1 });
		const g2 = await sender.tools.get("coms_get").execute("g2-check", { msg_id: m2 });
		assert.equal(g1.details.response, "reply-bundle");
		assert.equal(g2.details.error, "bundled");

		// Step B: comsSendCalledThisTurn drain
		const r3 = await sender.tools.get("coms_send").execute("s3", { target: "receiver", prompt: "will reply directly" });
		const m3 = r3.details.msg_id as string;
		const r4 = await other.tools.get("coms_send").execute("o4", { target: "receiver", prompt: "queued behind s3" });
		const m4 = r4.details.msg_id as string;

		await receiver.handlers.get("agent_start")!({}, makeCtx(workspace, "r-1252"));
		await deliverLatestInbound(receiver, m3);
		let sendDone = false;
		const offSendResult = receiver.events.on("pidash:coms-send-result", () => { sendDone = true; });
		receiver.events.emit("pidash:coms-send", { target: "sender", prompt: "direct reply via deliverPrompt" });
		await waitUntil(() => sendDone);
		offSendResult();
		await receiver.handlers.get("agent_end")!({}, makeCtx(workspace, "r-1252", () => "should not auto-capture"));

		const g3 = await sender.tools.get("coms_get").execute("g3-check", { msg_id: m3 });
		assert.equal(g3.details.status, "pending", "auto-capture skipped when comsSendCalledThisTurn has sender");
		await waitUntil(() => receiver.messages.some((m) => m.details?.msg_id === m4));

		// Step C: Mixed-turn reinjection
		await deliverLatestInbound(receiver, m4);
		await receiver.handlers.get("message_start")!({ message: { role: "user" } });
		await receiver.handlers.get("agent_end")!({}, makeCtx(workspace, "r-1252", () => "user-directed answer"));

		const g4Mid = await other.tools.get("coms_get").execute("g4-mid", { msg_id: m4 });
		assert.equal(g4Mid.details.status, "pending", "mixed-turn does not leak user-directed answer");
		assert.ok(
			receiver.messages.some((m) => m.details?.msg_id === m4 && typeof m.content === "string" && m.content.includes("re-injection")),
			"receiver re-injects m4 for a dedicated turn",
		);

		await deliverLatestInbound(receiver, m4);
		await receiver.handlers.get("agent_end")!({}, makeCtx(workspace, "r-1252", () => "dedicated peer reply"));
		await waitUntil(async () => (await other.tools.get("coms_get").execute("g4-wait", { msg_id: m4 })).details.status === "complete");
		const g4Done = await other.tools.get("coms_get").execute("g4-done", { msg_id: m4 });
		assert.equal(g4Done.details.response, "dedicated peer reply");

		// Clean up remaining pending entry m3 before shutdown so coms_send/coms_get assertions stay deterministic
		assert.equal(readFileSync(join(workspace, "coms", "history.jsonl"), "utf-8").includes(m3), true);
	});

	// ── #1403 ────────────────────────────────────────────────────────────────
	it("#1403: RPC peers receive ask_user-blocked guidance in welcome and system prompt", async () => {
		const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
		delete process.env.PI_COMS_SUPERVISED_PEER;
		try {
			const { workspace } = makeWorkspace();
			const rpcPeer = await startP2pPeer({
				name: "rpc-peer",
				sessionId: "rpc-1403",
				project: "p-1403-rpc",
				cwd: workspace,
				hasUI: true,
				mode: "rpc",
			});
			const rpcWelcome = rpcPeer.messages.find((m) => m.customType === "coms-welcome");
			assert.ok(rpcWelcome, "rpc peer emits coms-welcome");
			assert.match(rpcWelcome.content, /ask_user/);
			assert.match(rpcWelcome.content, /coms_send/);

			const sections: Record<string, string> = {};
			const sectionRes = await rpcPeer.handlers.get("before_agent_start")!(
				{ systemPrompt: "BASE", systemPromptOptions: { sections } },
				makeCtx(workspace, "rpc-1403", undefined, { hasUI: true, mode: "rpc" }),
			);
			assert.equal(sectionRes, undefined, "section injection mutates sections in place without replacing systemPrompt");
			assert.match(sections.coms_headless_peer ?? "", /ask_user/);
			assert.match(sections.coms_headless_peer ?? "", /coms_send/);

			const fallbackRes = await rpcPeer.handlers.get("before_agent_start")!(
				{ systemPrompt: "BASE" },
				makeCtx(workspace, "rpc-1403", undefined, { hasUI: true, mode: "rpc" }),
			);
			assert.match(fallbackRes?.systemPrompt ?? "", /^BASE\n\n/);
			assert.match(fallbackRes?.systemPrompt ?? "", /ask_user/);
			assert.match(fallbackRes?.systemPrompt ?? "", /coms_send/);
		} finally {
			if (prevSupervised === undefined) delete process.env.PI_COMS_SUPERVISED_PEER;
			else process.env.PI_COMS_SUPERVISED_PEER = prevSupervised;
		}
	});

	it("#1403: interactive TUI peers receive no headless guidance", async () => {
		const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
		delete process.env.PI_COMS_SUPERVISED_PEER;
		try {
			const { workspace } = makeWorkspace();
			const tuiPeer = await startP2pPeer({
				name: "tui-main",
				sessionId: "tui-1403",
				project: "p-1403-tui",
				cwd: workspace,
				hasUI: true,
				mode: "tui",
			});
			const tuiWelcome = tuiPeer.messages.find((m) => m.customType === "coms-welcome");
			assert.ok(tuiWelcome, "tui peer emits coms-welcome");
			assert.doesNotMatch(tuiWelcome.content, /ask_user is blocked/);

			const tuiSections: Record<string, string> = {};
			const tuiBeforeRes = await tuiPeer.handlers.get("before_agent_start")!(
				{ systemPrompt: "BASE", systemPromptOptions: { sections: tuiSections } },
				makeCtx(workspace, "tui-1403", undefined, { hasUI: true, mode: "tui" }),
			);
			assert.equal(tuiBeforeRes, undefined);
			assert.equal(tuiSections.coms_headless_peer, undefined);
		} finally {
			if (prevSupervised === undefined) delete process.env.PI_COMS_SUPERVISED_PEER;
			else process.env.PI_COMS_SUPERVISED_PEER = prevSupervised;
		}
	});

	it("#1403: supervised peers receive headless guidance even when ctx reports TUI", async () => {
		const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
		process.env.PI_COMS_SUPERVISED_PEER = "1";
		try {
			const { workspace } = makeWorkspace();
			const supPeer = await startP2pPeer({
				name: "sup-peer",
				sessionId: "sup-1403",
				project: "p-1403-sup",
				cwd: workspace,
				hasUI: true,
				mode: "tui",
			});
			const supWelcome = supPeer.messages.find((m) => m.customType === "coms-welcome");
			assert.ok(supWelcome, "supervised peer emits coms-welcome");
			assert.match(supWelcome.content, /ask_user/);
			assert.match(supWelcome.content, /coms_send/);

			const supSections: Record<string, string> = {};
			await supPeer.handlers.get("before_agent_start")!(
				{ systemPrompt: "BASE", systemPromptOptions: { sections: supSections } },
				makeCtx(workspace, "sup-1403", undefined, { hasUI: true, mode: "tui" }),
			);
			assert.match(supSections.coms_headless_peer ?? "", /ask_user/);
			assert.match(supSections.coms_headless_peer ?? "", /coms_send/);
		} finally {
			if (prevSupervised === undefined) delete process.env.PI_COMS_SUPERVISED_PEER;
			else process.env.PI_COMS_SUPERVISED_PEER = prevSupervised;
		}
	});
});
