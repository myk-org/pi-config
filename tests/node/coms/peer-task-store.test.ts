/**
 * Regression tests for #1080 — coms peer task operations must resolve the exact TaskStore
 * file the target peer reads, never guess from `coms_session_id`, and fail explicitly when
 * the write cannot be verified through the read path.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { createComsInboundTasks, resolvePeerTaskStorePath } from "../../../extensions/coms/coms-shared.js";
import { clearLogLevelCache, getPiLogPath, setGlobalSessionId } from "../../../extensions/shared/file-logger.js";
import pitasks, {
	createTasksAtStorePath,
	deleteTaskAtStorePath,
	getTaskAtStorePath,
	listTasksAtStorePath,
	resolveStorePath,
	taskStore,
	updateTaskAtStorePath,
} from "../../../extensions/pitasks/index.js";
import { TaskStore } from "../../../extensions/pitasks/task-store.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

interface FakePeer {
	name: string;
	tools: Map<string, any>;
	handlers: Map<string, any>;
	messages: any[];
	comsSessionId: string;
	endpoint: string;
	cwd: string;
	shutdown: () => Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];
let seq = 0;

afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) {
		await fn();
	}
});

function createFakePi(name: string, project = "test-proj") {
	const tools = new Map<string, any>();
	const handlers = new Map<string, any>();
	const messages: any[] = [];
	return {
		tools,
		handlers,
		messages,
		registerFlag() {},
		getFlag(flag: string) {
			if (flag === "cname") return name;
			if (flag === "project") return project;
			return undefined;
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		on(event: string, handler: any) {
			handlers.set(event, handler);
		},
		sendMessage(message: any) {
			messages.push(message);
		},
		events: { on() {}, emit() {} },
	};
}

/**
 * Boot a coms-p2p peer in its own directory, optionally simulating `--coms` autostart
 * where `coms` runs `session_start` BEFORE `orchestrator` sets `globalThis.__piConfigSessionId`
 * (so `coms_session_id` becomes a random ULID while `ctx.sessionManager.getSessionId()` holds
 * the real `pi_session_id`).
 */
async function startComsPeer(opts: {
	name: string;
	cwd: string;
	comsDir: string;
	piSessionId?: string;
	presetGlobalSessionId?: string | null;
	piTasks?: string;
	piTaskScope?: string;
	probeTimeoutMs?: number;
}): Promise<FakePeer> {
	mkdirSync(join(opts.cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(opts.cwd, ".pi", "pi-config-settings.json"),
		JSON.stringify({
			coms_dir: opts.comsDir,
			...(opts.probeTimeoutMs !== undefined ? { coms_probe_timeout_ms: opts.probeTimeoutMs } : {}),
		}),
	);

	const fakePi = createFakePi(opts.name);
	const tag = `${opts.name}-${++seq}`;
	const init = (await import(`../../../extensions/coms/coms-p2p.ts?peer-task-store=${tag}`)).default;

	const prevSubagent = process.env.PI_SUBAGENT_CHILD;
	const prevOneshot = process.env.PI_ONESHOT;
	const prevPiTasks = process.env.PI_TASKS;
	const prevPiTaskScope = process.env.PI_TASK_SCOPE;
	const prevGlobalSid = (globalThis as any).__piConfigSessionId;

	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_ONESHOT;
	if (opts.piTasks !== undefined) process.env.PI_TASKS = opts.piTasks;
	else delete process.env.PI_TASKS;
	if (opts.piTaskScope !== undefined) process.env.PI_TASK_SCOPE = opts.piTaskScope;
	else delete process.env.PI_TASK_SCOPE;

	if (opts.presetGlobalSessionId === null || opts.presetGlobalSessionId === undefined) {
		delete (globalThis as any).__piConfigSessionId;
	} else {
		(globalThis as any).__piConfigSessionId = opts.presetGlobalSessionId;
	}

	try {
		init(fakePi as any);
		const startHandler = fakePi.handlers.get("session_start");
		const shutdownHandler = fakePi.handlers.get("session_shutdown");
		assert.ok(startHandler, "coms session_start handler must register");
		assert.ok(shutdownHandler, "coms session_shutdown handler must register");
		cleanups.push(() => shutdownHandler());

		await startHandler({}, {
			cwd: opts.cwd,
			model: { id: "test-model" },
			hasUI: false,
			ui: { notify() {} },
			getContextUsage: () => ({ percent: 0 }),
			sessionManager: opts.piSessionId !== undefined
				? { getSessionId: () => opts.piSessionId }
				: undefined,
		});
	} finally {
		if (prevSubagent === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = prevSubagent;
		if (prevOneshot === undefined) delete process.env.PI_ONESHOT;
		else process.env.PI_ONESHOT = prevOneshot;
		if (prevPiTasks === undefined) delete process.env.PI_TASKS;
		else process.env.PI_TASKS = prevPiTasks;
		if (prevPiTaskScope === undefined) delete process.env.PI_TASK_SCOPE;
		else process.env.PI_TASK_SCOPE = prevPiTaskScope;
		if (prevGlobalSid === undefined) delete (globalThis as any).__piConfigSessionId;
		else (globalThis as any).__piConfigSessionId = prevGlobalSid;
	}

	const self = (globalThis as any).__comsSelf as { sessionId: string; endpoint: string } | null;
	assert.ok(self?.sessionId, "peer must publish __comsSelf");
	return {
		name: opts.name,
		tools: fakePi.tools,
		handlers: fakePi.handlers,
		messages: fakePi.messages,
		comsSessionId: self.sessionId,
		endpoint: self.endpoint,
		cwd: opts.cwd,
		shutdown: () => fakePi.handlers.get("session_shutdown")(),
	};
}

/** Boot pitasks for a peer session so `taskStore` reflects what the peer itself reads. */
async function bootPeerPitasks(opts: {
	cwd: string;
	piSessionId?: string;
	piTasks?: string;
	piTaskScope?: string;
}): Promise<TaskStore> {
	const handlers = new Map<string, Function>();
	const prevSubagent = process.env.PI_SUBAGENT_CHILD;
	const prevOneshot = process.env.PI_ONESHOT;
	const prevPiTasks = process.env.PI_TASKS;
	const prevPiTaskScope = process.env.PI_TASK_SCOPE;

	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_ONESHOT;
	if (opts.piTasks !== undefined) process.env.PI_TASKS = opts.piTasks;
	else delete process.env.PI_TASKS;
	if (opts.piTaskScope !== undefined) process.env.PI_TASK_SCOPE = opts.piTaskScope;
	else delete process.env.PI_TASK_SCOPE;

	try {
		pitasks({
			on(name: string, fn: Function) { handlers.set(name, fn); },
			registerTool() {},
			registerCommand() {},
			events: { on() { return () => {}; }, emit() {} },
		} as any);
		cleanups.push(() => handlers.get("session_shutdown")?.());
		await handlers.get("session_start")!(
			{ reason: "startup" },
			{
				cwd: opts.cwd,
				ui: { setWidget() {} },
				sessionManager: opts.piSessionId !== undefined
					? { getSessionId: () => opts.piSessionId }
					: undefined,
			},
		);
		return taskStore;
	} finally {
		if (prevSubagent === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = prevSubagent;
		if (prevOneshot === undefined) delete process.env.PI_ONESHOT;
		else process.env.PI_ONESHOT = prevOneshot;
		if (prevPiTasks === undefined) delete process.env.PI_TASKS;
		else process.env.PI_TASKS = prevPiTasks;
		if (prevPiTaskScope === undefined) delete process.env.PI_TASK_SCOPE;
		else process.env.PI_TASK_SCOPE = prevPiTaskScope;
	}
}

describe("resolveStorePath canonical path rules (#1080)", () => {
	it("resolves session-scoped store file from sessionId under target cwd", () => {
		const resolved = resolveStorePath("pi-sess/01", { cwd: "/work/peer", piTasks: undefined, taskScope: "session" });
		assert.equal(resolved, "/work/peer/.pi/tasks/tasks-pi-sess_01.json");
	});

	it("returns undefined for session scope without a sessionId", () => {
		const resolved = resolveStorePath("", { cwd: "/work/peer", piTasks: undefined, taskScope: "session" });
		assert.equal(resolved, undefined);
	});

	it("resolves project-scoped store file to tasks.json under target cwd", () => {
		const resolved = resolveStorePath(undefined, { cwd: "/work/peer", piTasks: undefined, taskScope: "project" });
		assert.equal(resolved, "/work/peer/.pi/tasks/tasks.json");
	});

	it("returns undefined when PI_TASKS is off", () => {
		const resolved = resolveStorePath("pi-sess-1", { cwd: "/work/peer", piTasks: "off", taskScope: "session" });
		assert.equal(resolved, undefined);
	});

	it("resolves relative PI_TASKS against target cwd", () => {
		const resolved = resolveStorePath("pi-sess-1", { cwd: "/work/peer", piTasks: "./custom/board.json" });
		assert.equal(resolved, "/work/peer/custom/board.json");
	});

	it("resolves bare PI_TASKS list id under ~/.pi/tasks", () => {
		const resolved = resolveStorePath("pi-sess-1", { cwd: "/work/peer", piTasks: "shared-board" });
		assert.equal(resolved, join(homedir(), ".pi", "tasks", "shared-board.json"));
	});

	it("ignores ambient PI_TASKS when piTasks option is explicitly undefined", () => {
		const prev = process.env.PI_TASKS;
		process.env.PI_TASKS = "off";
		try {
			const resolved = resolveStorePath("peer-sid", { cwd: "/work/peer", piTasks: undefined, taskScope: "session" });
			assert.equal(resolved, "/work/peer/.pi/tasks/tasks-peer-sid.json");
		} finally {
			if (prev === undefined) delete process.env.PI_TASKS;
			else process.env.PI_TASKS = prev;
		}
	});
});

describe("store-path task helpers (#1080)", () => {
	it("round-trips create, get, list, update, delete on an explicit store path", () => {
		const dir = makeTempDir("store-path-ops-");
		const storePath = join(dir, ".pi", "tasks", "tasks-peer.json");
		const created = createTasksAtStorePath(storePath, [{
			subject: "first step",
			description: "details",
			createdBy: { type: "coms", origin: "planner", session: "planner-sid", project: "" },
		}]);
		assert.equal(created.length, 1);
		assert.equal(getTaskAtStorePath(storePath, created[0].id)?.subject, "first step");
		assert.equal(listTasksAtStorePath(storePath).length, 1);
		updateTaskAtStorePath(storePath, created[0].id, { subject: "renamed step" });
		assert.equal(getTaskAtStorePath(storePath, created[0].id)?.subject, "renamed step");
		assert.equal(deleteTaskAtStorePath(storePath, created[0].id), true);
		assert.equal(listTasksAtStorePath(storePath).length, 0);
	});

	it("rejects non-absolute store paths instead of creating an ephemeral memory store", () => {
		assert.throws(
			() => createTasksAtStorePath("relative-store.json", [{
				subject: "bad",
				description: "",
				createdBy: { type: "local", origin: "system", session: "", project: "" },
			}]),
			/Valid absolute task store path required/,
		);
	});
});

describe("resolvePeerTaskStorePath (#1080)", () => {
	it("prefers a valid advertised task_store_path from the peer registry entry", () => {
		const resolved = resolvePeerTaskStorePath({
			name: "impl",
			cwd: "/work/peer",
			coms_session_id: "01M76E66PXF600G6FS6FY8G862",
			pi_session_id: "pi-123",
			task_store_path: "/work/peer/.pi/tasks/tasks.json",
		});
		assert.equal(resolved, "/work/peer/.pi/tasks/tasks.json");
	});

	it("returns undefined when the peer advertised task_store_path as null", () => {
		const resolved = resolvePeerTaskStorePath({
			name: "impl",
			cwd: "/work/peer",
			coms_session_id: "01M76E66PXF600G6FS6FY8G862",
			pi_session_id: "pi-123",
			task_store_path: null,
		});
		assert.equal(resolved, undefined);
	});

	it("rejects a non-absolute advertised task_store_path", () => {
		const resolved = resolvePeerTaskStorePath({
			name: "impl",
			cwd: "/work/peer",
			coms_session_id: "01M76E66PXF600G6FS6FY8G862",
			pi_session_id: "pi-123",
			task_store_path: "relative/tasks.json",
		});
		assert.equal(resolved, undefined);
	});

	it("resolves legacy registry entries from pi_session_id under target cwd", () => {
		const resolved = resolvePeerTaskStorePath({
			name: "impl",
			cwd: "/work/peer",
			coms_session_id: "01M76E66PXF600G6FS6FY8G862",
			pi_session_id: "real-pi-session",
		});
		assert.equal(resolved, "/work/peer/.pi/tasks/tasks-real-pi-session.json");
	});

	it("never falls back to coms_session_id when pi_session_id is missing", () => {
		const resolved = resolvePeerTaskStorePath({
			name: "impl-1077",
			cwd: "/work/issue-1077",
			coms_session_id: "01M76E66PXF600G6FS6FY8G862",
			pi_session_id: "",
		});
		assert.equal(resolved, undefined);
	});

	it("skips createComsInboundTasks when neither store path nor sessionId resolves", async () => {
		const dir = makeTempDir("inbound-tasks-unresolved-");
		const count = await createComsInboundTasks(
			[{ subject: "Orphan", description: "Should never write" }],
			{ sender_session: "sender-1", sender_name: "planner" },
			"",
			dir,
		);
		assert.equal(count, 0);
		assert.equal(existsSync(join(dir, ".pi", "tasks")), false);
	});
});

describe("coms peer task lifecycle regression (#1080)", { concurrency: false }, () => {
	it("writes to the peer pi_session_id store when coms_session_id is a distinct ULID", async (t) => {
		if (process.platform === "win32") return t.skip("unix sockets only");
		const root = makeTempDir("c1080-u-");
		const comsDir = join(root, "coms");
		const senderDir = join(root, "sender");
		const peerDir = join(root, "issue-1077");

		// Simulate supervised `pi --mode rpc --coms` where `__piConfigSessionId` is unset when coms starts!
		const peer = await startComsPeer({
			name: "impl-1077",
			cwd: peerDir,
			comsDir,
			piSessionId: "real-pi-uuid-1077",
			presetGlobalSessionId: null,
		});
		const peerLiveStore = await bootPeerPitasks({
			cwd: peerDir,
			piSessionId: "real-pi-uuid-1077",
		});
		const sender = await startComsPeer({
			name: "orchestrator",
			cwd: senderDir,
			comsDir,
			piSessionId: "sender-pi-uuid",
			presetGlobalSessionId: "sender-coms-sid",
		});

		assert.notEqual(peer.comsSessionId, "real-pi-uuid-1077", "peer coms_session_id is a generated ULID");

		const createTool = sender.tools.get("coms_tasks_create");
		const listTool = sender.tools.get("coms_task_list");
		assert.ok(createTool);
		assert.ok(listTool);

		const created = await createTool.execute("c1", {
			target: "impl-1077",
			tasks: [{ subject: "Fix store key", description: "Use pi_session_id" }],
		});
		assert.match(created.content[0].text, /Created 1 tasks on impl-1077/);

		const listed = await listTool.execute("l1", { target: "impl-1077" });
		assert.match(listed.content[0].text, /#1 \[pending\] Fix store key/);
		assert.equal(created.details.storePath, listed.details.storePath);
		assert.equal(created.details.storePath, peerLiveStore.filePath);
		assert.equal(existsSync(join(peerDir, ".pi", "tasks", `tasks-${peer.comsSessionId}.json`)), false);
		assert.equal(peerLiveStore.list().some((task) => task.subject === "Fix store key"), true);
	});

	it("resolves the shared tasks.json store when the peer runs with PI_TASK_SCOPE=project", async (t) => {
		if (process.platform === "win32") return t.skip("unix sockets only");
		const root = makeTempDir("c1080-p-");
		const comsDir = join(root, "coms");
		const senderDir = join(root, "sender");
		const peerDir = join(root, "peer-project");

		await startComsPeer({
			name: "worker",
			cwd: peerDir,
			comsDir,
			piSessionId: "worker-pi-sid",
			presetGlobalSessionId: null,
			piTaskScope: "project",
		});
		const peerLiveStore = await bootPeerPitasks({
			cwd: peerDir,
			piSessionId: "worker-pi-sid",
			piTaskScope: "project",
		});
		const sender = await startComsPeer({
			name: "planner",
			cwd: senderDir,
			comsDir,
			piSessionId: "planner-pi-sid",
		});

		const created = await sender.tools.get("coms_tasks_create").execute("c-proj", {
			target: "worker",
			tasks: [{ subject: "Project-scoped task", description: "Visible in tasks.json" }],
		});
		const listed = await sender.tools.get("coms_task_list").execute("l-proj", { target: "worker" });

		assert.equal(created.details.storePath, join(peerDir, ".pi", "tasks", "tasks.json"));
		assert.equal(listed.details.storePath, created.details.storePath);
		assert.equal(peerLiveStore.filePath, created.details.storePath);
		assert.equal(peerLiveStore.list().some((task) => task.subject === "Project-scoped task"), true);
	});

	it("creates two tasks on a peer, lists them, updates one, then deletes one end to end", async (t) => {
		if (process.platform === "win32") return t.skip("unix sockets only");
		const root = makeTempDir("c1080-e-");
		const comsDir = join(root, "coms");
		const senderDir = join(root, "sender");
		const peerDir = join(root, "peer");

		await startComsPeer({
			name: "impl",
			cwd: peerDir,
			comsDir,
			piSessionId: "impl-pi-session",
			presetGlobalSessionId: null,
		});
		const peerLiveStore = await bootPeerPitasks({
			cwd: peerDir,
			piSessionId: "impl-pi-session",
		});
		const sender = await startComsPeer({
			name: "lead",
			cwd: senderDir,
			comsDir,
			piSessionId: "lead-pi-session",
		});

		const createTool = sender.tools.get("coms_tasks_create");
		const listTool = sender.tools.get("coms_task_list");
		const getTool = sender.tools.get("coms_task_get");
		const updateTool = sender.tools.get("coms_task_update");
		const deleteTool = sender.tools.get("coms_task_delete");
		assert.ok(createTool);
		assert.ok(listTool);
		assert.ok(getTool);
		assert.ok(updateTool);
		assert.ok(deleteTool);

		const created = await createTool.execute("create-two", {
			target: "impl",
			tasks: [
				{ subject: "First task", description: "Implement store fix" },
				{ subject: "Second task", description: "Add regression suite" },
			],
		});
		assert.deepEqual(created.details.taskIds, ["1", "2"]);

		const initialList = await listTool.execute("list-1", { target: "impl" });
		assert.match(initialList.content[0].text, /#1 \[pending\] First task/);
		assert.match(initialList.content[0].text, /#2 \[pending\] Second task/);

		const fetched = await getTool.execute("get-1", { target: "impl", task_id: "1" });
		assert.match(fetched.content[0].text, /Task #1: First task/);

		const updated = await updateTool.execute("upd-1", {
			target: "impl",
			task_id: "1",
			subject: "First task updated",
		});
		assert.match(updated.content[0].text, /Updated task #1 subject/);

		const deleted = await deleteTool.execute("del-2", {
			target: "impl",
			task_id: "2",
		});
		assert.match(deleted.content[0].text, /Task #2 deleted from impl/);

		const finalList = await listTool.execute("list-2", { target: "impl" });
		assert.match(finalList.content[0].text, /#1 \[pending\] First task updated/);
		assert.doesNotMatch(finalList.content[0].text, /Second task/);

		const peerSubjects = peerLiveStore.list().map((task) => task.subject);
		assert.equal(peerSubjects.includes("First task updated"), true);
		assert.equal(peerSubjects.includes("Second task"), false);
	});

	it("reports an explicit failure when the peer has PI_TASKS=off instead of claiming Created N tasks", async (t) => {
		if (process.platform === "win32") return t.skip("unix sockets only");
		const root = makeTempDir("c1080-o-");
		const comsDir = join(root, "coms");

		await startComsPeer({
			name: "no-tasks-peer",
			cwd: join(root, "peer"),
			comsDir,
			piSessionId: "peer-sid",
			piTasks: "off",
		});
		const sender = await startComsPeer({
			name: "sender",
			cwd: join(root, "sender"),
			comsDir,
			piSessionId: "sender-sid",
		});

		await assert.rejects(
			sender.tools.get("coms_tasks_create").execute("fail-off", {
				target: "no-tasks-peer",
				tasks: [{ subject: "Unwritable", description: "Tasks are off" }],
			}),
			/Failed to create tasks on no-tasks-peer.*no addressable task store/,
		);
	});

	it("reports an explicit failure when a legacy registry entry lacks pi_session_id", async (t) => {
		if (process.platform === "win32") return t.skip("unix sockets only");
		const root = makeTempDir("c1080-l-");
		const comsDir = join(root, "coms");
		const peerDir = join(root, "peer");

		const peer = await startComsPeer({
			name: "legacy-peer",
			cwd: peerDir,
			comsDir,
			piSessionId: "temp-sid",
			presetGlobalSessionId: null,
		});
		const sender = await startComsPeer({
			name: "sender",
			cwd: join(root, "sender"),
			comsDir,
			piSessionId: "sender-sid",
		});

		// Rewrite the peer's registry entry to mimic pre-#1080: coms_session_id set, pi_session_id empty, no task_store_path.
		const agentsDir = join(comsDir, "projects", "test-proj", "agents");
		const regPath = join(agentsDir, `${peer.comsSessionId}.json`);
		const rawEntry = JSON.parse(readFileSync(regPath, "utf8"));
		rawEntry.pi_session_id = "";
		delete rawEntry.task_store_path;
		writeFileSync(regPath, JSON.stringify(rawEntry, null, 2));

		await assert.rejects(
			sender.tools.get("coms_tasks_create").execute("fail-legacy", {
				target: "legacy-peer",
				tasks: [{ subject: "Ghost task", description: "Must not write coms_session_id file" }],
			}),
			/Failed to create tasks on legacy-peer.*no addressable task store/,
		);
		assert.equal(existsSync(join(peerDir, ".pi", "tasks")), false);
	});

	it("reports an explicit failure when the peer store directory cannot be written", async (t) => {
		if (process.platform === "win32") return t.skip("unix sockets only");
		const root = makeTempDir("c1080-w-");
		const comsDir = join(root, "coms");
		const peerDir = join(root, "peer");

		await startComsPeer({
			name: "broken-fs-peer",
			cwd: peerDir,
			comsDir,
			piSessionId: "broken-pi-sid",
			presetGlobalSessionId: null,
		});
		const sender = await startComsPeer({
			name: "sender",
			cwd: join(root, "sender"),
			comsDir,
			piSessionId: "sender-sid",
		});

		// Block `.pi/tasks` directory creation by placing a regular file at `.pi/tasks`.
		writeFileSync(join(peerDir, ".pi", "tasks"), "not-a-directory");

		await assert.rejects(
			sender.tools.get("coms_tasks_create").execute("fail-fs", {
				target: "broken-fs-peer",
				tasks: [{ subject: "Disk fail", description: "Must fail" }],
			}),
			/Failed to create tasks on broken-fs-peer/,
		);
	});

	it("attaches task reminders on coms_send from the same peer store coms_send tasks wrote", async (t) => {
		if (process.platform === "win32") return t.skip("unix sockets only");
		const root = makeTempDir("c1080-s-");
		const comsDir = join(root, "coms");
		const peerDir = join(root, "peer");

		const peer = await startComsPeer({
			name: "worker",
			cwd: peerDir,
			comsDir,
			piSessionId: "worker-real-pi-sid",
			presetGlobalSessionId: null,
		});
		const sender = await startComsPeer({
			name: "lead",
			cwd: join(root, "sender"),
			comsDir,
			piSessionId: "lead-pi-sid",
		});

		await sender.tools.get("coms_send").execute("s1", {
			target: "worker",
			prompt: "Initial delegation",
			tasks: [{ subject: "Delegated via coms_send", description: "Check store alignment" }],
		});

		const tasksDir = join(peerDir, ".pi", "tasks");
		assert.deepEqual(readdirSync(tasksDir), ["tasks-worker-real-pi-sid.json"]);

		await sender.tools.get("coms_send").execute("s2", {
			target: "worker",
			prompt: "Status check",
		});

		// Finish the first inbound turn so the queued second prompt delivers with its reminder footer.
		await peer.handlers.get("agent_end")(
			{ messages: [] },
			{
				cwd: peerDir,
				hasUI: false,
				ui: { notify() {} },
				sessionManager: {
					getBranch: () => [{ type: "message", message: { role: "assistant", content: "ack 1" } }],
				},
			},
		);

		const allInjected = peer.messages.map((m) => String(m?.content ?? "")).join("\n");
		assert.match(allInjected, /Reminder - Tasks assigned to you by lead:\n#1 \[pending\] Delegated via coms_send/);
	});

	it("stamps coms createdBy on socket task_manage create so the creator can update it", async (t) => {
		if (process.platform === "win32") return t.skip("unix sockets only");
		const root = makeTempDir("c1080-m-");
		const comsDir = join(root, "coms");
		const peerDir = join(root, "peer");

		await bootPeerPitasks({ cwd: peerDir, piSessionId: "rpc-peer-sid" });
		const peer = await startComsPeer({
			name: "rpc-peer",
			cwd: peerDir,
			comsDir,
			piSessionId: "rpc-peer-sid",
		});

		const sendTaskManage = async (payload: Record<string, any>): Promise<any> => {
			const replySock = join(root, `reply-${++seq}.sock`);
			let server: net.Server | undefined;
			cleanups.push(() => new Promise<void>((resolve) => {
				if (!server) return resolve();
				server.close(() => resolve());
			}));
			const replyPromise = new Promise<any>((resolve) => {
				server = net.createServer((sock) => {
					let buf = "";
					sock.on("data", (chunk) => {
						buf += chunk.toString("utf8");
						const nl = buf.indexOf("\n");
						if (nl < 0) return;
						const parsed = JSON.parse(buf.slice(0, nl));
						sock.write(JSON.stringify({ type: "ack", msg_id: parsed.msg_id }) + "\n");
						sock.end();
						resolve(parsed);
					});
				});
			});
			await new Promise<void>((resolve) => server!.listen(replySock, () => resolve()));
			await new Promise<void>((resolve, reject) => {
				const client = net.createConnection({ path: peer.endpoint }, () => {
					client.write(JSON.stringify({
						type: "task_manage",
						msg_id: `tm-${seq}`,
						sender_session: "creator-session",
						sender_endpoint: replySock,
						sender_name: "creator",
						hops: 0,
						timestamp: new Date().toISOString(),
						...payload,
					}) + "\n");
				});
				client.on("data", () => { client.end(); resolve(); });
				client.once("error", reject);
			});
			return replyPromise;
		};

		const createdReply = await sendTaskManage({
			action: "create",
			subject: "RPC task",
			description: "Created over socket",
			metadata: { tag: "v1" },
		});
		assert.equal(createdReply.error, null);
		assert.equal(createdReply.response.createdBy.type, "coms");
		assert.equal(createdReply.response.createdBy.session, "creator-session");
		assert.equal(createdReply.response.metadata.tag, "v1");

		const updatedReply = await sendTaskManage({
			action: "update",
			task_id: createdReply.response.id,
			fields: { subject: "RPC task updated" },
		});
		assert.equal(updatedReply.error, null);
		assert.equal(taskStore.get(createdReply.response.id)?.subject, "RPC task updated");
	});

	it("keeps advertising the live published TaskStore path after mid-session PI_TASKS changes", async (t) => {
		if (process.platform === "win32") return t.skip("unix sockets only");
		const root = makeTempDir("c1080-env-");
		const comsDir = join(root, "coms");
		const peerDir = join(root, "peer");
		const senderDir = join(root, "sender");

		const peerLiveStore = await bootPeerPitasks({
			cwd: peerDir,
			piSessionId: "stable-live-sid",
		});
		const peer = await startComsPeer({
			name: "live-peer",
			cwd: peerDir,
			comsDir,
			piSessionId: "stable-live-sid",
			presetGlobalSessionId: null,
		});
		const sender = await startComsPeer({
			name: "sender",
			cwd: senderDir,
			comsDir,
			piSessionId: "sender-sid",
		});

		const prevPiTasks = process.env.PI_TASKS;
		const prevScope = process.env.PI_TASK_SCOPE;
		process.env.PI_TASKS = join(root, "misrouted-tasks.json");
		process.env.PI_TASK_SCOPE = "project";
		try {
			// Sending a prompt flips busy state on the peer, forcing writeLiveRegistry() while PI_TASKS is mutated.
			await sender.tools.get("coms_send").execute("s-busy", {
				target: "live-peer",
				prompt: "Trigger live registry refresh",
			});

			const regPath = join(comsDir, "projects", "test-proj", "agents", `${peer.comsSessionId}.json`);
			const refreshed = JSON.parse(readFileSync(regPath, "utf8"));
			assert.equal(refreshed.task_store_path, peerLiveStore.filePath);

			const created = await sender.tools.get("coms_tasks_create").execute("c-live", {
				target: "live-peer",
				tasks: [{ subject: "Routed to live store", description: "Must ignore mid-session env mutation" }],
			});
			assert.equal(created.details.storePath, peerLiveStore.filePath);
			assert.equal(peerLiveStore.list().some((task) => task.subject === "Routed to live store"), true);
			assert.equal(existsSync(join(root, "misrouted-tasks.json")), false);
		} finally {
			if (prevPiTasks === undefined) delete process.env.PI_TASKS;
			else process.env.PI_TASKS = prevPiTasks;
			if (prevScope === undefined) delete process.env.PI_TASK_SCOPE;
			else process.env.PI_TASK_SCOPE = prevScope;
		}
	});

	it("rejects task creation on a legacy peer whose live PI_TASKS store ignores the guessed session file", async (t) => {
		if (process.platform === "win32") return t.skip("unix sockets only");
		const root = makeTempDir("c1080-leg-custom-");
		const comsDir = join(root, "coms");
		const peerDir = join(root, "peer");
		const customBoard = join(root, "custom-board.json");

		const peerLiveStore = await bootPeerPitasks({
			cwd: peerDir,
			piSessionId: "legacy-custom-sid",
			piTasks: customBoard,
		});
		// Populate an unrelated task #1 on the custom board to guard against ID-only false positives.
		peerLiveStore.create("Unrelated local task", "Already on custom board", {
			type: "local",
			origin: "user",
			session: "",
			project: peerDir,
		});

		const peer = await startComsPeer({
			name: "legacy-custom",
			cwd: peerDir,
			comsDir,
			piSessionId: "legacy-custom-sid",
			presetGlobalSessionId: null,
			piTasks: customBoard,
		});
		const sender = await startComsPeer({
			name: "sender",
			cwd: join(root, "sender"),
			comsDir,
			piSessionId: "sender-sid",
		});

		const regPath = join(comsDir, "projects", "test-proj", "agents", `${peer.comsSessionId}.json`);
		const rawEntry = JSON.parse(readFileSync(regPath, "utf8"));
		delete rawEntry.task_store_path;
		writeFileSync(regPath, JSON.stringify(rawEntry, null, 2));

		await assert.rejects(
			sender.tools.get("coms_tasks_create").execute("c-legacy-custom", {
				target: "legacy-custom",
				tasks: [{ subject: "Missed task", description: "Peer reads custom-board.json instead" }],
			}),
			/Failed to create tasks on legacy-custom/,
		);
		const guessedPath = join(peerDir, ".pi", "tasks", "tasks-legacy-custom-sid.json");
		assert.equal(existsSync(guessedPath), false);
	});

	it("succeeds on a legacy peer without task_store_path when live task_manage confirms visibility", async (t) => {
		if (process.platform === "win32") return t.skip("unix sockets only");
		const root = makeTempDir("c1080-leg-ok-");
		const comsDir = join(root, "coms");
		const peerDir = join(root, "peer");

		const peerLiveStore = await bootPeerPitasks({
			cwd: peerDir,
			piSessionId: "legacy-ok-sid",
		});
		const peer = await startComsPeer({
			name: "legacy-ok",
			cwd: peerDir,
			comsDir,
			piSessionId: "legacy-ok-sid",
			presetGlobalSessionId: null,
		});
		const sender = await startComsPeer({
			name: "sender",
			cwd: join(root, "sender"),
			comsDir,
			piSessionId: "sender-sid",
		});

		const regPath = join(comsDir, "projects", "test-proj", "agents", `${peer.comsSessionId}.json`);
		const rawEntry = JSON.parse(readFileSync(regPath, "utf8"));
		delete rawEntry.task_store_path;
		writeFileSync(regPath, JSON.stringify(rawEntry, null, 2));

		const created = await sender.tools.get("coms_tasks_create").execute("c-legacy-ok", {
			target: "legacy-ok",
			tasks: [{ subject: "Confirmed legacy task", description: "Visible via task_manage list" }],
		});
		assert.match(created.content[0].text, /Created 1 tasks on legacy-ok/);
		assert.equal(peerLiveStore.list().some((task) => task.subject === "Confirmed legacy task"), true);
	});

	it("rejects task creation on a legacy peer without task_store_path when task_manage fails", async (t) => {
		if (process.platform === "win32") return t.skip("unix sockets only");
		const root = makeTempDir("c1080-leg-nack-");
		const comsDir = join(root, "coms");
		const peerDir = join(root, "peer");
		const sockPath = join(root, "legacy-nack.sock");

		const server = net.createServer((sock) => {
			let buf = "";
			sock.on("data", (chunk) => {
				buf += chunk.toString("utf8");
				const nl = buf.indexOf("\n");
				if (nl < 0) return;
				const parsed = JSON.parse(buf.slice(0, nl));
				sock.write(JSON.stringify({ type: "nack", msg_id: parsed.msg_id ?? "", error: "task_manage unsupported" }) + "\n");
				sock.end();
			});
			sock.once("error", () => sock.destroy());
		});
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		await new Promise<void>((resolve) => server.listen(sockPath, () => resolve()));

		const sender = await startComsPeer({
			name: "sender",
			cwd: join(root, "sender"),
			comsDir,
			piSessionId: "sender-sid",
		});

		const agentsDir = join(comsDir, "projects", "test-proj", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "legacy-nack-sid.json"),
			JSON.stringify({
				coms_session_id: "legacy-nack-sid",
				name: "legacy-nack",
				purpose: "",
				model: "test-model",
				color: "#36F9F6",
				pid: process.pid,
				endpoint: sockPath,
				cwd: peerDir,
				started_at: new Date().toISOString(),
				heartbeat_at: new Date().toISOString(),
				explicit: false,
				version: 1,
				pi_session_id: "legacy-nack-pi-sid",
			}, null, 2),
		);

		await assert.rejects(
			sender.tools.get("coms_tasks_create").execute("c-legacy-nack", {
				target: "legacy-nack",
				tasks: [{ subject: "Unverifiable task", description: "Should fail closed" }],
			}),
			/Failed to create tasks on legacy-nack/,
		);
		assert.equal(existsSync(join(peerDir, ".pi", "tasks", "tasks-legacy-nack-pi-sid.json")), false);
	});

	it("rejects task creation on a legacy peer when task_manage list times out", async (t) => {
		if (process.platform === "win32") return t.skip("unix sockets only");
		const root = makeTempDir("c1080-leg-to-");
		const comsDir = join(root, "coms");
		const peerDir = join(root, "peer");
		const sockPath = join(root, "legacy-timeout.sock");

		// Ack the inbound socket request late and never send a response envelope back, so the
		// request timeout fires while the send is still in flight (the case that leaked an
		// unhandled rejection instead of the documented timeout error).
		const server = net.createServer((sock) => {
			let buf = "";
			sock.on("data", (chunk) => {
				buf += chunk.toString("utf8");
				const nl = buf.indexOf("\n");
				if (nl < 0) return;
				const parsed = JSON.parse(buf.slice(0, nl));
				setTimeout(() => {
					if (sock.destroyed) return;
					sock.write(JSON.stringify({ type: "ack", msg_id: parsed.msg_id ?? "" }) + "\n");
					sock.end();
				}, 500);
			});
			sock.once("error", () => sock.destroy());
		});
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		await new Promise<void>((resolve) => server.listen(sockPath, () => resolve()));

		const sender = await startComsPeer({
			name: "sender",
			cwd: join(root, "sender"),
			comsDir,
			piSessionId: "sender-sid",
			probeTimeoutMs: 100,
		});

		const agentsDir = join(comsDir, "projects", "test-proj", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "legacy-to-sid.json"),
			JSON.stringify({
				coms_session_id: "legacy-to-sid",
				name: "legacy-timeout",
				purpose: "",
				model: "test-model",
				color: "#36F9F6",
				pid: process.pid,
				endpoint: sockPath,
				cwd: peerDir,
				started_at: new Date().toISOString(),
				heartbeat_at: new Date().toISOString(),
				explicit: false,
				version: 1,
				pi_session_id: "legacy-to-pi-sid",
			}, null, 2),
		);

		await assert.rejects(
			sender.tools.get("coms_tasks_create").execute("c-legacy-to", {
				target: "legacy-timeout",
				tasks: [{ subject: "Timed out task", description: "Must fail closed on RPC timeout" }],
			}),
			/timed out waiting for task_manage list/,
		);
		assert.equal(existsSync(join(peerDir, ".pi", "tasks", "tasks-legacy-to-pi-sid.json")), false);
	});

	it("deletes newly created tasks with a new report task when post-write verification fails", async (t) => {
		if (process.platform === "win32") return t.skip("unix sockets only");
		const root = makeTempDir("c1080-rb-new-");
		const comsDir = join(root, "coms");
		const peerDir = join(root, "peer");
		const sockPath = join(root, "swap-peer.sock");
		const storeA = join(peerDir, ".pi", "tasks", "tasks-store-a.json");
		const storeB = join(peerDir, ".pi", "tasks", "tasks-store-b.json");

		const sender = await startComsPeer({
			name: "sender",
			cwd: join(root, "sender"),
			comsDir,
			piSessionId: "sender-sid",
		});

		const regPath = join(comsDir, "projects", "test-proj", "agents", "swap-peer-sid.json");
		const staleTs = new Date(Date.now() - 60_000).toISOString();
		const writePeerEntry = (storePath: string) => {
			writeFileSync(regPath, JSON.stringify({
				coms_session_id: "swap-peer-sid",
				name: "swap-peer",
				purpose: "",
				model: "test-model",
				color: "#36F9F6",
				pid: process.pid,
				endpoint: sockPath,
				cwd: peerDir,
				started_at: staleTs,
				heartbeat_at: staleTs,
				explicit: false,
				version: 1,
				pi_session_id: "swap-pi-sid",
				task_store_path: storePath,
			}, null, 2));
		};

		let connections = 0;
		const server = net.createServer((sock) => {
			connections++;
			// First probe happens inside resolveTarget() before coms_tasks_create writes to storeA;
			// flipping the registry to storeB here makes post-write listPeerTasksByTarget() disagree.
			if (connections === 1) {
				writePeerEntry(storeB);
			}
			sock.once("error", () => sock.destroy());
		});
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		await new Promise<void>((resolve) => server.listen(sockPath, () => resolve()));
		writePeerEntry(storeA);

		await assert.rejects(
			sender.tools.get("coms_tasks_create").execute("c-rb-new", {
				target: "swap-peer",
				tasks: [{ subject: "Transient task", description: "Must be rolled back" }],
			}),
			/disagreed with read store/,
		);
		assert.equal(existsSync(storeA), false);
	});

	it("restores an existing report task blockedBy list when a subsequent batch fails verification", async (t) => {
		if (process.platform === "win32") return t.skip("unix sockets only");
		const root = makeTempDir("c1080-rb-rep-");
		const comsDir = join(root, "coms");
		const peerDir = join(root, "peer");
		const sockPath = join(root, "swap-rep.sock");
		const storeA = join(peerDir, ".pi", "tasks", "tasks-store-a.json");
		const storeB = join(peerDir, ".pi", "tasks", "tasks-store-b.json");

		const sender = await startComsPeer({
			name: "sender",
			cwd: join(root, "sender"),
			comsDir,
			piSessionId: "sender-sid",
		});

		const regPath = join(comsDir, "projects", "test-proj", "agents", "swap-rep-sid.json");
		const writePeerEntry = (storePath: string, ts: string) => {
			writeFileSync(regPath, JSON.stringify({
				coms_session_id: "swap-rep-sid",
				name: "swap-rep",
				purpose: "",
				model: "test-model",
				color: "#36F9F6",
				pid: process.pid,
				endpoint: sockPath,
				cwd: peerDir,
				started_at: ts,
				heartbeat_at: ts,
				explicit: false,
				version: 1,
				pi_session_id: "swap-rep-pi-sid",
				task_store_path: storePath,
			}, null, 2));
		};

		let swapOnNextProbe = false;
		const server = net.createServer((sock) => {
			if (swapOnNextProbe) {
				swapOnNextProbe = false;
				writePeerEntry(storeB, new Date().toISOString());
			}
			let buf = "";
			sock.on("data", (chunk) => {
				buf += chunk.toString("utf8");
				const nl = buf.indexOf("\n");
				if (nl < 0) return;
				const parsed = JSON.parse(buf.slice(0, nl));
				sock.write(JSON.stringify({ type: "ack", msg_id: parsed.msg_id ?? "" }) + "\n");
				sock.end();
			});
			sock.once("error", () => sock.destroy());
		});
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		await new Promise<void>((resolve) => server.listen(sockPath, () => resolve()));

		writePeerEntry(storeA, new Date().toISOString());
		await sender.tools.get("coms_tasks_create").execute("c-batch-1", {
			target: "swap-rep",
			tasks: [{ subject: "Initial task", description: "Stays intact" }],
		});

		const beforeBatch2 = listTasksAtStorePath(storeA);
		assert.equal(beforeBatch2.length, 2);
		const initialReport = beforeBatch2.find((task: any) => task.subject === "Report completion to sender");
		assert.deepEqual(initialReport?.blockedBy, ["1"]);

		// Arm the store swap for the second batch's initial resolveTarget probe.
		writePeerEntry(storeA, new Date(Date.now() - 60_000).toISOString());
		swapOnNextProbe = true;

		await assert.rejects(
			sender.tools.get("coms_tasks_create").execute("c-batch-2", {
				target: "swap-rep",
				tasks: [{ subject: "Rolled back second task", description: "Must not pollute report task" }],
			}),
			/disagreed with read store/,
		);

		const afterBatch2 = listTasksAtStorePath(storeA);
		assert.deepEqual(afterBatch2.map((task: any) => task.subject), [
			"Initial task",
			"Report completion to sender",
		]);
		const restoredReport = afterBatch2.find((task: any) => task.subject === "Report completion to sender");
		assert.deepEqual(restoredReport?.blockedBy, ["1"]);
	});

	it("preserves a concurrently added blocker when rolling back an existing report task", async (t) => {
		if (process.platform === "win32") return t.skip("unix sockets only");
		const root = makeTempDir("c1080-rb-conc-");
		const comsDir = join(root, "coms");
		const peerDir = join(root, "peer");
		const sockPath = join(root, "swap-conc.sock");
		const storeA = join(peerDir, ".pi", "tasks", "tasks-store-a.json");
		const storeB = join(peerDir, ".pi", "tasks", "tasks-store-b.json");

		const sender = await startComsPeer({
			name: "sender",
			cwd: join(root, "sender"),
			comsDir,
			piSessionId: "sender-sid",
		});

		const regPath = join(comsDir, "projects", "test-proj", "agents", "swap-conc-sid.json");
		const writePeerEntry = (storePath: string, ts: string) => {
			writeFileSync(regPath, JSON.stringify({
				coms_session_id: "swap-conc-sid",
				name: "swap-conc",
				purpose: "",
				model: "test-model",
				color: "#36F9F6",
				pid: process.pid,
				endpoint: sockPath,
				cwd: peerDir,
				started_at: ts,
				heartbeat_at: ts,
				explicit: false,
				version: 1,
				pi_session_id: "swap-conc-pi-sid",
				task_store_path: storePath,
			}, null, 2));
		};

		// A concurrent writer interferes during readback verification (the peer entry is stale, so
		// resolveTarget probes the socket again there): it adds an unrelated blocker to the existing
		// report task and deletes the task this call created, so verification fails after the report
		// task was already extended. Liveness probes send no data; envelopes are acked.
		let interfereOnProbe = false;
		const server = net.createServer((sock) => {
			sock.on("data", (chunk) => {
				const nl = chunk.toString("utf8").indexOf("\n");
				if (nl < 0) return;
				const parsed = JSON.parse(chunk.toString("utf8").slice(0, nl));
				sock.write(JSON.stringify({ type: "ack", msg_id: parsed.msg_id ?? "" }) + "\n");
				sock.end();
			});
			sock.once("error", () => sock.destroy());
			if (!interfereOnProbe) return;
			const tasks = listTasksAtStorePath(storeA) ?? [];
			const report = tasks.find((task: any) => task.subject === "Report completion to sender");
			if (!report || !tasks.some((task: any) => task.id === "3")) return;
			interfereOnProbe = false;
			updateTaskAtStorePath(storeA, report.id, { blockedBy: [...(report.blockedBy ?? []), "999"] });
			deleteTaskAtStorePath(storeA, "3");
			writePeerEntry(storeB, new Date().toISOString());
		});
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		await new Promise<void>((resolve) => server.listen(sockPath, () => resolve()));

		writePeerEntry(storeA, new Date().toISOString());
		await sender.tools.get("coms_tasks_create").execute("c-conc-1", {
			target: "swap-conc",
			tasks: [{ subject: "Initial task", description: "Stays intact" }],
		});

		writePeerEntry(storeA, new Date(Date.now() - 60_000).toISOString());
		interfereOnProbe = true;

		await assert.rejects(
			sender.tools.get("coms_tasks_create").execute("c-conc-2", {
				target: "swap-conc",
				tasks: [{ subject: "Rolled back task", description: "Must not stay in the report blockers" }],
			}),
			/verification failed/,
		);

		const afterRollback = listTasksAtStorePath(storeA);
		assert.deepEqual(afterRollback.map((task: any) => task.subject), [
			"Initial task",
			"Report completion to sender",
		]);
		const reportTask = afterRollback.find((task: any) => task.subject === "Report completion to sender");
		assert.deepEqual(reportTask?.blockedBy, ["1", "999"]);
	});

	it("rejects coms_task_update when the task is concurrently deleted before the store write", async (t) => {
		if (process.platform === "win32") return t.skip("unix sockets only");
		const root = makeTempDir("c1080-race-");
		const comsDir = join(root, "coms");
		const peerDir = join(root, "peer");

		await startComsPeer({
			name: "race-peer",
			cwd: peerDir,
			comsDir,
			piSessionId: "race-pi-sid",
			presetGlobalSessionId: null,
		});
		const sender = await startComsPeer({
			name: "sender",
			cwd: join(root, "sender"),
			comsDir,
			piSessionId: "sender-sid",
		});

		const created = await sender.tools.get("coms_tasks_create").execute("c-race", {
			target: "race-peer",
			tasks: [{ subject: "Ephemeral task", description: "Deleted concurrently" }],
		});
		const storePath = created.details.storePath as string;

		const racingParams: Record<string, any> = {
			target: "race-peer",
			task_id: "1",
		};
		Object.defineProperty(racingParams, "subject", {
			enumerable: true,
			get() {
				deleteTaskAtStorePath(storePath, "1");
				return "Updated after deletion";
			},
		});

		await assert.rejects(
			sender.tools.get("coms_task_update").execute("u-race", racingParams),
			/Task #1 not found on race-peer/,
		);
	});

	it("returns a not-found error on socket task_manage update when the task does not exist", async (t) => {
		if (process.platform === "win32") return t.skip("unix sockets only");
		const root = makeTempDir("c1080-tm-nf-");
		const comsDir = join(root, "coms");
		const peerDir = join(root, "peer");

		await bootPeerPitasks({ cwd: peerDir, piSessionId: "tm-nf-sid" });
		const peer = await startComsPeer({
			name: "tm-nf-peer",
			cwd: peerDir,
			comsDir,
			piSessionId: "tm-nf-sid",
		});

		const replySock = join(root, `reply-${++seq}.sock`);
		let server: net.Server | undefined;
		cleanups.push(() => new Promise<void>((resolve) => {
			if (!server) return resolve();
			server.close(() => resolve());
		}));
		const replyPromise = new Promise<any>((resolve) => {
			server = net.createServer((sock) => {
				let buf = "";
				sock.on("data", (chunk) => {
					buf += chunk.toString("utf8");
					const nl = buf.indexOf("\n");
					if (nl < 0) return;
					const parsed = JSON.parse(buf.slice(0, nl));
					sock.write(JSON.stringify({ type: "ack", msg_id: parsed.msg_id }) + "\n");
					sock.end();
					resolve(parsed);
				});
			});
		});
		await new Promise<void>((resolve) => server!.listen(replySock, () => resolve()));
		await new Promise<void>((resolve, reject) => {
			const client = net.createConnection({ path: peer.endpoint }, () => {
				client.write(JSON.stringify({
					type: "task_manage",
					msg_id: `tm-nf-${seq}`,
					sender_session: "creator-session",
					sender_endpoint: replySock,
					sender_name: "creator",
					hops: 0,
					timestamp: new Date().toISOString(),
					action: "update",
					task_id: "999",
					fields: { subject: "No such task" },
				}) + "\n");
			});
			client.on("data", () => { client.end(); resolve(); });
			client.once("error", reject);
		});
		const reply = await replyPromise;
		assert.match(String(reply.error), /Task #999 not found/);
	});

	it("logs create_coms_inbound_tasks_failed at error level when the batch write fails", async () => {
		const root = makeTempDir("c1080-log-batch-");
		const tmpHome = join(root, "home");
		const peerDir = join(root, "peer");
		mkdirSync(join(peerDir, ".pi"), { recursive: true });
		writeFileSync(join(peerDir, ".pi", "tasks"), "blocking-file");

		const prevHome = process.env.HOME;
		const prevUserProfile = process.env.USERPROFILE;
		const prevSidEnv = process.env.__PI_CONFIG_SESSION_ID;
		const prevGlobalSid = (globalThis as any).__piConfigSessionId;
		process.env.HOME = tmpHome;
		process.env.USERPROFILE = tmpHome;
		setGlobalSessionId("log-batch-error-sid");
		clearLogLevelCache();
		try {
			const count = await createComsInboundTasks(
				[{ subject: "Lost task", description: "Write blocked" }],
				{ sender_session: "sender-1", sender_name: "planner" },
				"peer-sid",
				peerDir,
			);
			assert.equal(count, 0);
			const logPath = getPiLogPath("coms");
			assert.ok(logPath);
			const logContent = readFileSync(logPath, "utf8");
			assert.match(logContent, /\[error\] \[coms\] create_coms_inbound_tasks_failed/);
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
			if (prevUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = prevUserProfile;
			if (prevSidEnv === undefined) delete process.env.__PI_CONFIG_SESSION_ID;
			else process.env.__PI_CONFIG_SESSION_ID = prevSidEnv;
			if (prevGlobalSid === undefined) delete (globalThis as any).__piConfigSessionId;
			else (globalThis as any).__piConfigSessionId = prevGlobalSid;
			clearLogLevelCache();
		}
	});

	it("logs tasks_auto_create_skipped at error level when coms_send drops tasks for an unaddressable peer", async (t) => {
		if (process.platform === "win32") return t.skip("unix sockets only");
		const root = makeTempDir("c1080-log-skip-");
		const tmpHome = join(root, "home");
		const comsDir = join(root, "coms");

		const prevHome = process.env.HOME;
		const prevUserProfile = process.env.USERPROFILE;
		const prevSidEnv = process.env.__PI_CONFIG_SESSION_ID;
		const prevGlobalSid = (globalThis as any).__piConfigSessionId;
		process.env.HOME = tmpHome;
		process.env.USERPROFILE = tmpHome;
		try {
			await startComsPeer({
				name: "tasks-off-peer",
				cwd: join(root, "peer"),
				comsDir,
				piSessionId: "peer-sid",
				piTasks: "off",
			});
			const sender = await startComsPeer({
				name: "sender-log",
				cwd: join(root, "sender"),
				comsDir,
				piSessionId: "sender-sid",
			});
			setGlobalSessionId("log-skip-error-sid");
			clearLogLevelCache();

			await sender.tools.get("coms_send").execute("s-drop", {
				target: "tasks-off-peer",
				prompt: "Work item",
				tasks: [{ subject: "Dropped task", description: "Peer has PI_TASKS=off" }],
			});

			const logPath = getPiLogPath("coms");
			assert.ok(logPath);
			const logContent = readFileSync(logPath, "utf8");
			assert.match(logContent, /\[error\] \[coms\] tasks_auto_create_skipped/);
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
			if (prevUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = prevUserProfile;
			if (prevSidEnv === undefined) delete process.env.__PI_CONFIG_SESSION_ID;
			else process.env.__PI_CONFIG_SESSION_ID = prevSidEnv;
			if (prevGlobalSid === undefined) delete (globalThis as any).__piConfigSessionId;
			else (globalThis as any).__piConfigSessionId = prevGlobalSid;
			clearLogLevelCache();
		}
	});
});
