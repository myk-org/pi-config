/**
 * Focused single-behavior unit tests for #1509:
 * count peers running async subagents (workload.agents > 0) as busy across
 * shared helper, coms_peers / formatPeerTable, coms_list, collapsed pool widget,
 * /coms overlay, drilldown, and PiDash Coms payloads while preserving raw
 * turn-active `busy` semantics for inbound delivery.
 *
 * Run with: npx tsx --test --test-concurrency=4 tests/node/coms/coms-busy-agents.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isPeerBusy, type RegistryRow } from "../../../extensions/coms/coms-registry-core.js";
import { formatPeerDetailLines, formatPeerTable } from "../../../extensions/coms/coms-peers.js";
import { buildPeerInfoRow } from "../../../extensions/coms/coms-drilldown.js";
import { openComsPeersOverlay } from "../../../extensions/coms/coms-peers-ui.js";
import { buildComsPeersPayload, buildPidashComsPeersPayload } from "../../../extensions/coms/coms-shared.js";
import {
	createComsPeerRuntime,
	type ComsPeerRuntime,
	type ComsPeerStopOptions,
} from "../../../extensions/coms/coms-p2p.js";
import { publishTaskStore, publishWorkloadSources, resetSessionBridge } from "../../../extensions/shared/session-bridge.js";
import { makeTempDir } from "../helpers/temp-dirs.js";
import { fakeCommandCtx } from "../helpers/fake-extension-ctx.js";

function makeRow(overrides: Partial<RegistryRow> = {}): RegistryRow {
	return {
		project: "proj-a",
		name: "worker-1",
		pid: 4242,
		cwd: "/repo",
		purpose: "runs tasks",
		endpoint: "/tmp/worker-1.sock",
		busy: false,
		queueDepth: 0,
		contextUsedPct: 18,
		startedAt: "2026-11-28T09:00:00.000Z",
		heartbeatAt: "2026-11-28T09:05:00.000Z",
		origin: "user",
		createdBy: null,
		workload: { agents: 0, tasks: 0, crons: 0 },
		...overrides,
	};
}

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("isPeerBusy (#1509)", () => {
	it("treats a peer with busy false plus workload.agents 1 as busy", () => {
		assert.equal(isPeerBusy({ busy: false, workload: { agents: 1, tasks: 0, crons: 0 } }), true);
	});

	it("keeps a peer with workload.agents 0 plus pending tasks idle", () => {
		assert.equal(isPeerBusy({ busy: false, workload: { agents: 0, tasks: 3, crons: 2 } }), false);
	});

	it("treats a peer with busy true plus workload.agents 0 as busy", () => {
		assert.equal(isPeerBusy({ busy: true, workload: { agents: 0, tasks: 0, crons: 0 } }), true);
	});

	it("keeps a peer with null workload plus busy false idle", () => {
		assert.equal(isPeerBusy({ busy: false, workload: null }), false);
	});

	it("treats non-finite or negative workload.agents as idle", () => {
		assert.equal(isPeerBusy({ busy: false, workload: { agents: -1 } }), false);
		assert.equal(isPeerBusy({ busy: false, workload: { agents: Number.NaN } }), false);
		assert.equal(isPeerBusy({ busy: false, workload: { agents: Number.POSITIVE_INFINITY } }), false);
	});
});

describe("coms_peers formatters (#1509)", () => {
	it("marks a peer with busy false plus workload.agents 1 as busy in formatPeerTable", () => {
		const table = formatPeerTable([makeRow({ name: "runner", busy: false, workload: { agents: 1, tasks: 0, crons: 0 } })]);
		assert.match(table, /● runner · proj-a \(busy ctx:18% pid:4242\) ⏳1/);
	});

	it("counts a peer running async agents in the formatPeerTable header", () => {
		const table = formatPeerTable([
			makeRow({ name: "runner", busy: false, workload: { agents: 2, tasks: 0, crons: 0 } }),
			makeRow({ name: "idle-peer", busy: false, workload: { agents: 0, tasks: 3, crons: 0 } }),
		]);
		assert.match(table, /^2 peer\(s\) \(1 busy\):/);
	});

	it("keeps a peer with only pending tasks idle in formatPeerTable", () => {
		const table = formatPeerTable([makeRow({ name: "planner", busy: false, workload: { agents: 0, tasks: 3, crons: 0 } })]);
		assert.match(table, /^1 peer\(s\):/);
		assert.match(table, /● planner · proj-a \(idle ctx:18% pid:4242\) ☰3/);
	});

	it("reports busy in formatPeerDetailLines when workload.agents is positive", () => {
		const lines = formatPeerDetailLines(makeRow({ busy: false, workload: { agents: 1, tasks: 0, crons: 0 } })).join("\n");
		assert.match(lines, /state\s+busy/);
	});

	it("reports busy in buildPeerInfoRow when workload.agents is positive", () => {
		const info = buildPeerInfoRow(makeRow({ busy: false, workload: { agents: 1, tasks: 0, crons: 0 } }));
		const fields = new Map(info.items[0].detail);
		assert.match(fields.get("State") ?? "", /^busy/);
	});
});

describe("openComsPeersOverlay busy formatting (#1509)", () => {
	it("counts peers with busy false plus workload.agents 1 in borderTitle", async () => {
		let title = "";
		await openComsPeersOverlay(fakeCommandCtx({}), {
			listPeers: () => [
				makeRow({ name: "async-worker", busy: false, workload: { agents: 1, tasks: 0, crons: 0 } }),
				makeRow({ name: "tasks-only", busy: false, workload: { agents: 0, tasks: 3, crons: 0 } }),
			],
			killPeer: () => "",
			killAll: () => "",
			openOverlay: async (_ctx: any, options: any) => {
				const rows = options.listSpec.listItems();
				title = options.listSpec.borderTitle(rows);
			},
		});
		assert.match(title, /1 busy \/ 2/);
	});

	it("renders a busy badge in rowParts when workload.agents is positive", async () => {
		let rightParts: string[] = [];
		let glyph = "";
		await openComsPeersOverlay(fakeCommandCtx({}), {
			listPeers: () => [makeRow({ name: "async-worker", busy: false, workload: { agents: 1, tasks: 0, crons: 0 } })],
			killPeer: () => "",
			killAll: () => "",
			openOverlay: async (_ctx: any, options: any) => {
				const row = options.listSpec.listItems()[0];
				const parts = options.listSpec.rowParts(row, plainTheme);
				glyph = parts.glyph;
				rightParts = parts.rightParts;
			},
		});
		assert.equal(glyph, "◆");
		assert.equal(rightParts[0], "busy");
	});

	it("keeps a peer with only pending tasks idle in rowParts", async () => {
		let rightParts: string[] = [];
		let glyph = "";
		await openComsPeersOverlay(fakeCommandCtx({}), {
			listPeers: () => [makeRow({ name: "tasks-only", busy: false, workload: { agents: 0, tasks: 3, crons: 0 } })],
			killPeer: () => "",
			killAll: () => "",
			openOverlay: async (_ctx: any, options: any) => {
				const row = options.listSpec.listItems()[0];
				const parts = options.listSpec.rowParts(row, plainTheme);
				glyph = parts.glyph;
				rightParts = parts.rightParts;
			},
		});
		assert.equal(glyph, "●");
		assert.equal(rightParts[0], "idle");
	});
});

describe("PiDash COMS payload projections (#1509)", () => {
	it("marks a peer with busy false plus workload.agents 1 as busy in buildPidashComsPeersPayload", () => {
		const payload = buildPidashComsPeersPayload({
			rows: [
				{
					project: "proj-a",
					name: "async-worker",
					cwd: "/repo",
					purpose: "runs subagents",
					model: "m1",
					endpoint: "/tmp/async.sock",
					busy: false,
					queueDepth: 0,
					contextUsedPct: 22,
					workload: { agents: 1, tasks: 0, crons: 0 },
				},
			],
			cards: [],
			supervisedKeys: new Set(),
			self: null,
			scope: "all",
			ownProject: "proj-a",
		});
		assert.equal(payload.peers[0]?.busy, true);
		assert.deepEqual(payload.peers[0]?.workload, { agents: 1, tasks: 0, crons: 0 });
	});

	it("keeps a peer with workload.agents 0 plus pending tasks idle in buildComsPeersPayload", () => {
		const payload = buildComsPeersPayload(
			[
				{
					name: "tasks-only",
					purpose: "plans",
					model: "m1",
					color: "#fff",
					busy: false,
					workload: { agents: 0, tasks: 3, crons: 0 },
					staleCount: 0,
				},
			],
			null,
		);
		assert.equal(payload.peers[0]?.busy, false);
	});
});

describe("createComsPeerRuntime live busy-agent rendering (#1509)", () => {
	const activePeers: Array<{ shutdown: () => Promise<void> }> = [];

	afterEach(async () => {
		while (activePeers.length > 0) {
			const peer = activePeers.pop()!;
			try { await peer.shutdown(); } catch { /* ignore */ }
		}
		resetSessionBridge({ all: true });
		delete (globalThis as any).__piConfigSessionId;
	});

	async function bootPeer(opts: {
		name: string;
		sessionId: string;
		project: string;
		cwd: string;
		comsDir: string;
		hasUI?: boolean;
		onWidget?: (id: string, factory: any) => void;
	}) {
		const tools = new Map<string, any>();
		const handlers = new Map<string, Function>();
		const flags: Record<string, any> = { cname: opts.name, project: opts.project };
		const listeners = new Map<string, Set<(data?: any) => void>>();
		const pi: any = {
			registerFlag() {},
			getFlag(name: string) { return flags[name]; },
			registerTool(tool: any) { tools.set(tool.name, tool); },
			registerCommand() {},
			registerShortcut() {},
			registerMessageRenderer() {},
			getAllTools() { return [...tools.values()]; },
			on(name: string, fn: Function) { handlers.set(name, fn); },
			sendMessage() {},
			appendEntry() {},
			getActiveTools() { return [...tools.keys()]; },
			setActiveTools() {},
			events: {
				emit(event: string, data?: any) {
					for (const fn of [...(listeners.get(event) ?? [])]) fn(data);
				},
				on(event: string, fn: (data?: any) => void) {
					if (!listeners.has(event)) listeners.set(event, new Set());
					listeners.get(event)!.add(fn);
					return () => { listeners.get(event)?.delete(fn); };
				},
			},
		};

		const runtime: ComsPeerRuntime = createComsPeerRuntime(pi, {
			deferred: true,
			comsDir: opts.comsDir,
			sessionId: opts.sessionId,
			allowSubagentChild: true,
		});
		let idle = true;
		const ctx: any = {
			cwd: opts.cwd,
			mode: "tui",
			hasUI: opts.hasUI ?? false,
			model: { id: "test-model" },
			isIdle: () => idle,
			ui: {
				notify: () => {},
				setStatus: () => {},
				setWidget: (id: string, factory: any) => { opts.onWidget?.(id, factory); },
				setTheme: () => ({ success: true }),
				setTitle: () => {},
			},
			sessionManager: {
				getSessionId: () => opts.sessionId,
				getEntries: () => [],
				getBranch: () => [],
			},
		};
		const self = await runtime.start(ctx, { origin: "tool" });
		assert.ok(self, `peer ${opts.name} must start`);
		const shutdown = async (stopOpts?: ComsPeerStopOptions) => { await runtime.stop(stopOpts); };
		activePeers.push({ shutdown });
		const completeTurn = async () => {
			idle = false;
			await handlers.get("agent_start")?.({}, ctx);
			idle = true;
			await handlers.get("agent_end")?.({ messages: [] }, ctx);
		};
		return { self, tools, handlers, runtime, ctx, completeTurn };
	}

	it("keeps raw registry busy false when peer is idle with a running async agent", async () => {
		const workspace = makeTempDir("coms-busy-1509-raw-");
		const comsDir = join(workspace, "coms");
		mkdirSync(join(workspace, ".pi"), { recursive: true });
		writeFileSync(join(workspace, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: comsDir }));

		const sessionId = "sess-raw-1509";
		publishTaskStore(() => ({ list: () => [] }), sessionId);
		publishWorkloadSources(
			{
				agents: () => [{ id: "a1", agent: "ts-expert", name: "build", task: "fix", status: "running", startedAt: Date.now() }],
				crons: () => [],
			},
			sessionId,
		);
		const peer = await bootPeer({ name: "worker", sessionId, project: "p1509", cwd: workspace, comsDir });
		await peer.completeTurn();
		const entry = JSON.parse(readFileSync(peer.self.registryFile, "utf-8"));
		assert.equal(entry.busy, false, "raw protocol busy must stay false so inbound COMS messages can still deliver");
		assert.equal(entry.workload?.agents, 1);
	});

	it("reports a peer with busy false plus workload.agents 1 as busy in coms_list", async () => {
		const workspace = makeTempDir("coms-busy-1509-list-");
		const comsDir = join(workspace, "coms");
		mkdirSync(join(workspace, ".pi"), { recursive: true });
		writeFileSync(join(workspace, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: comsDir }));

		const workerSid = "sess-worker-1509";
		publishTaskStore(() => ({ list: () => [] }), workerSid);
		publishWorkloadSources(
			{
				agents: () => [{ id: "a1", agent: "ts-expert", name: "build", task: "fix", status: "running", startedAt: Date.now() }],
				crons: () => [],
			},
			workerSid,
		);
		const worker = await bootPeer({ name: "async-worker", sessionId: workerSid, project: "p1509", cwd: workspace, comsDir });
		await worker.completeTurn();

		const viewer = await bootPeer({ name: "viewer", sessionId: "sess-viewer-1509", project: "p1509", cwd: workspace, comsDir });
		const res = await viewer.tools.get("coms_list").execute("c1", {});
		const text = res.content[0]?.text ?? "";
		assert.match(text, /^1 peer\(s\) \(1 busy\):/);
		assert.match(text, /async-worker .*⚙busy ⏳1/);
		assert.equal(res.details.agents[0]?.busy, true);
	});

	it("counts a peer with busy false plus workload.agents 1 in the collapsed pool widget header", async () => {
		const workspace = makeTempDir("coms-busy-1509-widget-");
		const comsDir = join(workspace, "coms");
		mkdirSync(join(workspace, ".pi"), { recursive: true });
		writeFileSync(
			join(workspace, ".pi", "pi-config-settings.json"),
			JSON.stringify({ coms_dir: comsDir, widgets_default_mode: "collapsed" }),
		);

		const workerSid = "sess-worker-widget-1509";
		publishTaskStore(() => ({ list: () => [] }), workerSid);
		publishWorkloadSources(
			{
				agents: () => [{ id: "a1", agent: "git-expert", name: "git", task: "push", status: "running", startedAt: Date.now() }],
				crons: () => [],
			},
			workerSid,
		);
		const worker = await bootPeer({ name: "async-worker", sessionId: workerSid, project: "p1509", cwd: workspace, comsDir });
		await worker.completeTurn();

		let widgetFactory: any = null;
		await bootPeer({
			name: "viewer",
			sessionId: "sess-viewer-widget-1509",
			project: "p1509",
			cwd: workspace,
			comsDir,
			hasUI: true,
			onWidget: (id, factory) => {
				if (id === "coms-pool") widgetFactory = factory;
			},
		});
		assert.ok(typeof widgetFactory === "function", "coms-pool widget factory must be installed");
		const component = widgetFactory(null, plainTheme);
		const lines: string[] = component.render(120);
		assert.match(lines[0] ?? "", /1 peer \(1 busy\)/);
	});

	it("keeps a peer with busy false plus workload.agents 0 idle in coms_list", async () => {
		const workspace = makeTempDir("coms-busy-1509-idle-");
		const comsDir = join(workspace, "coms");
		mkdirSync(join(workspace, ".pi"), { recursive: true });
		writeFileSync(join(workspace, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: comsDir }));

		const workerSid = "sess-idle-worker-1509";
		publishTaskStore(() => ({ list: () => [] }), workerSid);
		publishWorkloadSources({ agents: () => [], crons: () => [] }, workerSid);
		await bootPeer({ name: "idle-worker", sessionId: workerSid, project: "p1509", cwd: workspace, comsDir });

		const viewer = await bootPeer({ name: "viewer", sessionId: "sess-idle-viewer-1509", project: "p1509", cwd: workspace, comsDir });
		const res = await viewer.tools.get("coms_list").execute("c1", {});
		const text = res.content[0]?.text ?? "";
		assert.match(text, /^1 peer\(s\):/);
		assert.doesNotMatch(text, /⚙busy/);
		assert.equal(res.details.agents[0]?.busy, false);
	});
});
