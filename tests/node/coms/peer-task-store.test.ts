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
}): Promise<FakePeer> {
	mkdirSync(join(opts.cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(opts.cwd, ".pi", "pi-config-settings.json"),
		JSON.stringify({ coms_dir: opts.comsDir }),
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
});
