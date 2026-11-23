/**
 * Unit and boundary tests for ComsRegistry and isolated ComsPeerRuntime instances (#1356).
 *
 * Run with: npx tsx --test tests/node/coms/coms-registry.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	ComsRegistry,
	isRegistryRowAlive,
	parseRegistryWorkload,
	probeAlive,
	type RegistryEntry,
} from "../../../extensions/coms/coms-registry.js";
import { createComsPeerRuntime, type ComsPeerRuntime } from "../../../extensions/coms/coms-p2p.js";
import { clearSettingsCache } from "../../../extensions/orchestrator/project-settings.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const cleanupDirs: string[] = [];
const activeServers: net.Server[] = [];
const activeRuntimes: ComsPeerRuntime[] = [];

function createTempDir(prefix: string): string {
	const dir = makeTempDir(prefix);
	cleanupDirs.push(dir);
	return dir;
}

async function listenSocket(socketPath: string): Promise<net.Server> {
	const srv = net.createServer((sock) => sock.destroy());
	await new Promise<void>((resolve) => srv.listen(socketPath, resolve));
	activeServers.push(srv);
	return srv;
}

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
	return {
		coms_session_id: "sess-1",
		name: "alpha",
		purpose: "test peer",
		model: "test-model",
		color: "#72F1B8",
		pid: process.pid,
		endpoint: "/tmp/nonexistent.sock",
		cwd: "/tmp",
		started_at: new Date().toISOString(),
		heartbeat_at: new Date().toISOString(),
		explicit: false,
		version: 1,
		...overrides,
	};
}

function makeFakePi(flags: Record<string, unknown> = {}) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const pi = {
		tools,
		commands,
		handlers,
		registerFlag: () => {},
		getFlag: (name: string) => flags[name],
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, def: any) => commands.set(name, def),
		on: (event: string, fn: Function) => {
			const list = handlers.get(event) ?? [];
			list.push(fn);
			handlers.set(event, list);
		},
		sendMessage: () => {},
		appendEntry: () => {},
		events: { on: () => () => {}, emit: () => {} },
	};
	return pi;
}

afterEach(async () => {
	for (const rt of activeRuntimes.splice(0)) {
		try { await rt.stop(); } catch { /* ignore */ }
	}
	for (const srv of activeServers.splice(0)) {
		await new Promise<void>((resolve) => srv.close(() => resolve())).catch(() => {});
	}
	clearSettingsCache();
	for (const dir of cleanupDirs.splice(0)) {
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
});

describe("ComsRegistry", () => {
	it("writes entries atomically without leaving .tmp files behind", () => {
		const comsDir = createTempDir("coms-reg-atomic-");
		const registry = new ComsRegistry(comsDir);
		const filePath = registry.writeEntryAtomic(makeEntry({ coms_session_id: "s-atomic", name: "atomic-peer" }), "proj-a");

		assert.equal(existsSync(filePath), true);
		assert.equal(existsSync(`${filePath}.tmp`), false);
		const entries = registry.readEntries("proj-a");
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.name, "atomic-peer");
	});

	it("rejects session IDs containing path traversal characters", () => {
		const comsDir = createTempDir("coms-reg-traversal-");
		const registry = new ComsRegistry(comsDir);

		assert.throws(() => registry.registryFilePath("proj-a", "../escape"), /Invalid session_id/);
		assert.throws(() => registry.registryFilePath("proj-a", "a/b"), /Invalid session_id/);
		assert.throws(() => registry.registryFilePath("proj-a", "a\\b"), /Invalid session_id/);
	});

	it("isolates separate ComsRegistry instances across independent temp directories", () => {
		const dirA = createTempDir("coms-reg-iso-a-");
		const dirB = createTempDir("coms-reg-iso-b-");
		const regA = new ComsRegistry(dirA);
		const regB = new ComsRegistry(dirB);

		regA.writeEntryAtomic(makeEntry({ coms_session_id: "sid-a", name: "peer-a" }), "shared-proj");
		regB.writeEntryAtomic(makeEntry({ coms_session_id: "sid-b", name: "peer-b" }), "shared-proj");

		assert.deepEqual(regA.readEntries("shared-proj").map((e) => e.name), ["peer-a"]);
		assert.deepEqual(regB.readEntries("shared-proj").map((e) => e.name), ["peer-b"]);
	});

	it("returns null from parseRegistryWorkload for malformed or negative counts", () => {
		assert.equal(parseRegistryWorkload(null), null);
		assert.equal(parseRegistryWorkload({ agents: 1, tasks: -1, crons: 0 }), null);
		assert.equal(parseRegistryWorkload({ agents: 1, tasks: Number.NaN, crons: 0 }), null);
		assert.deepEqual(parseRegistryWorkload({ agents: 2, tasks: 3, crons: 1 }), { agents: 2, tasks: 3, crons: 1 });
	});

	it("filters live inventory rows by heartbeat freshness, socket existence, and PID", () => {
		const comsDir = createTempDir("coms-reg-live-");
		const registry = new ComsRegistry(comsDir);
		registry.ensureProjectDirs("proj-live");

		const liveSock = registry.makeEndpoint("live-sid");
		writeFileSync(liveSock, "");
		const staleSock = registry.makeEndpoint("stale-sid");
		writeFileSync(staleSock, "");

		const now = Date.now();
		registry.writeEntryAtomic(
			makeEntry({
				coms_session_id: "live-sid",
				name: "live-peer",
				endpoint: liveSock,
				heartbeat_at: new Date(now - 5_000).toISOString(),
				workload: { agents: 1, tasks: 2, crons: 0 },
			}),
			"proj-live",
		);
		registry.writeEntryAtomic(
			makeEntry({
				coms_session_id: "stale-sid",
				name: "stale-peer",
				endpoint: staleSock,
				heartbeat_at: new Date(now - 300_000).toISOString(),
			}),
			"proj-live",
		);
		registry.writeEntryAtomic(
			makeEntry({
				coms_session_id: "nosock-sid",
				name: "nosock-peer",
				endpoint: registry.makeEndpoint("missing-sid"),
				heartbeat_at: new Date(now - 1_000).toISOString(),
			}),
			"proj-live",
		);

		const liveRows = registry.readLiveRows(now);
		assert.deepEqual(liveRows.map((r) => r.name), ["live-peer"]);
		assert.deepEqual(liveRows[0]?.workload, { agents: 1, tasks: 2, crons: 0 });
	});

	it("falls back to startedAt in isRegistryRowAlive before first heartbeat", () => {
		const comsDir = createTempDir("coms-reg-first-write-");
		const sock = join(comsDir, "first.sock");
		writeFileSync(sock, "");
		const now = Date.now();
		const alive = isRegistryRowAlive({
			project: "p",
			name: "fresh-boot",
			pid: process.pid,
			cwd: comsDir,
			purpose: "",
			endpoint: sock,
			busy: false,
			queueDepth: 0,
			contextUsedPct: null,
			startedAt: new Date(now - 2_000).toISOString(),
			heartbeatAt: null,
		}, now);
		assert.equal(alive, true);
	});

	it("prunes stale socket entries in pruneDeadEntries while keeping listening peers", async () => {
		const workspace = createTempDir("coms-reg-prune-");
		const comsDir = join(workspace, "coms");
		mkdirSync(join(workspace, ".pi"), { recursive: true });
		writeFileSync(
			join(workspace, ".pi", "pi-config-settings.json"),
			JSON.stringify({ coms_dir: comsDir, coms_entry_grace_period_ms: 0, coms_probe_timeout_ms: 150 }),
		);
		clearSettingsCache();

		const registry = new ComsRegistry(comsDir);
		registry.ensureProjectDirs("proj-p");

		const liveSock = registry.makeEndpoint("live-probe");
		await listenSocket(liveSock);
		const deadSock = registry.makeEndpoint("dead-probe");
		writeFileSync(deadSock, "");

		const oldIso = new Date(Date.now() - 60_000).toISOString();
		registry.writeEntryAtomic(
			makeEntry({ coms_session_id: "live-probe", name: "alive", endpoint: liveSock, started_at: oldIso, heartbeat_at: oldIso }),
			"proj-p",
		);
		registry.writeEntryAtomic(
			makeEntry({ coms_session_id: "dead-probe", name: "dead", endpoint: deadSock, started_at: oldIso, heartbeat_at: oldIso }),
			"proj-p",
		);

		const survivors = await registry.pruneDeadEntries("proj-p", workspace);
		assert.deepEqual(survivors.map((e) => e.name), ["alive"]);
		assert.equal(existsSync(registry.registryFilePath("proj-p", "dead-probe")), false);
		assert.equal(existsSync(deadSock), true, "pruneDeadEntries must not delete socket files");
	});

	it("probes listening sockets as alive with probeAlive", async () => {
		const dir = createTempDir("coms-probe-alive-");
		const sock = join(dir, "live.sock");
		await listenSocket(sock);
		assert.equal(await probeAlive(sock, 200), true);
		assert.equal(await probeAlive(join(dir, "missing.sock"), 200), false);
	});

	it("runs pruneStaleStartup independently per registry instance", async () => {
		const dirA = createTempDir("coms-startup-a-");
		const dirB = createTempDir("coms-startup-b-");
		const regA = new ComsRegistry(dirA);
		const regB = new ComsRegistry(dirB);
		regA.ensureProjectDirs("proj");
		regB.ensureProjectDirs("proj");

		const orphanA = join(regA.socketsDir(), "orphan-a.sock");
		const orphanB = join(regB.socketsDir(), "orphan-b.sock");
		writeFileSync(orphanA, "");
		writeFileSync(orphanB, "");

		await regA.pruneStaleStartup();
		assert.equal(existsSync(orphanA), false);
		assert.equal(existsSync(orphanB), true);

		await regB.pruneStaleStartup();
		assert.equal(existsSync(orphanB), false);
	});
});

describe("createComsPeerRuntime isolation", () => {
	it("runs two peer runtimes in separate comsDir roots concurrently without cross-contamination", async () => {
		const workspaceA = createTempDir("coms-rt-a-");
		const workspaceB = createTempDir("coms-rt-b-");
		const comsDirA = join(workspaceA, "coms");
		const comsDirB = join(workspaceB, "coms");

		const piA = makeFakePi({ cname: "same-name", project: "same-proj" });
		const piB = makeFakePi({ cname: "same-name", project: "same-proj" });

		const rtA = createComsPeerRuntime(piA as any, {
			deferred: true,
			comsDir: comsDirA,
			sessionId: "sess-iso-a",
			allowSubagentChild: true,
			registerSignalHandlers: false,
		});
		const rtB = createComsPeerRuntime(piB as any, {
			deferred: true,
			comsDir: comsDirB,
			sessionId: "sess-iso-b",
			allowSubagentChild: true,
			registerSignalHandlers: false,
		});
		activeRuntimes.push(rtA, rtB);

		const [selfA, selfB] = await Promise.all([
			rtA.start({
				cwd: workspaceA,
				model: { id: "model-a" },
				hasUI: false,
				ui: { notify: () => {} },
				sessionManager: { getSessionId: () => "sess-iso-a" },
			} as any, { origin: "tool" }),
			rtB.start({
				cwd: workspaceB,
				model: { id: "model-b" },
				hasUI: false,
				ui: { notify: () => {} },
				sessionManager: { getSessionId: () => "sess-iso-b" },
			} as any, { origin: "cli" }),
		]);

		assert.ok(selfA && selfB);
		assert.equal(selfA.origin, "tool");
		assert.equal(selfB.origin, "cli");
		assert.notEqual(selfA.endpoint, selfB.endpoint);
		assert.equal(existsSync(selfA.registryFile), true);
		assert.equal(existsSync(selfB.registryFile), true);
		assert.equal(new ComsRegistry(comsDirA).readEntries("same-proj").length, 1);
		assert.equal(new ComsRegistry(comsDirB).readEntries("same-proj").length, 1);
	});

	it("never writes globalThis.__coms* side channels during runtime lifecycle", async () => {
		const workspace = createTempDir("coms-rt-no-globals-");
		const comsDir = join(workspace, "coms");
		const pi = makeFakePi({ cname: "clean-peer", project: "clean-proj" });

		const rt = createComsPeerRuntime(pi as any, {
			deferred: true,
			comsDir,
			sessionId: "sess-clean",
			allowSubagentChild: true,
			registerSignalHandlers: false,
		});
		activeRuntimes.push(rt);

		const self = await rt.start({
			cwd: workspace,
			model: { id: "test-model" },
			hasUI: false,
			ui: { notify: () => {} },
			sessionManager: { getSessionId: () => "sess-clean" },
		} as any, { origin: "tool" });

		assert.ok(self);
		assert.equal("__comsSelf" in globalThis, false);
		assert.equal("__comsSelfOrigin" in globalThis, false);
		assert.equal("__comsUserSend" in globalThis, false);
		assert.equal("__coms_pidash_listener" in globalThis, false);
		assert.equal("__coms_p2p_pidash_listener" in globalThis, false);
	});
});
