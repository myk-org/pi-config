/**
 * Focused single-behavior unit and real-entrypoint subprocess tests for `coms_auto_start` (#1503).
 *
 * Run with: npx tsx --test tests/node/coms/coms-auto-start.test.ts
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describePeerOrigin } from "../../../extensions/coms/coms-peers.js";
import { ComsRegistry } from "../../../extensions/coms/coms-registry.js";
import {
	deriveAutoStartBaseName,
	registerComs,
	resolveAutoStartName,
	type RegisteredComs,
} from "../../../extensions/coms/coms-wrapper.js";
import { clearSettingsCache, getSetting } from "../../../extensions/orchestrator/project-settings.js";
import { acquireTokenFileLock } from "../../../extensions/shared/file-lock.js";
import { isComsActive, resetSessionBridge } from "../../../extensions/shared/session-bridge.js";
import { useSupportedPiVersion } from "../helpers/pi-version-env.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

useSupportedPiVersion();

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const settingsKeys = JSON.parse(readFileSync(join(REPO_ROOT, "settings-keys.json"), "utf8"));
const exampleSettings = JSON.parse(readFileSync(join(REPO_ROOT, "pi-config-settings.example.json"), "utf8"));

const cleanupFns: Array<() => Promise<void> | void> = [];
const savedEnv: Record<string, string | undefined> = {};

function setTestEnv(key: string, value: string | undefined): void {
	if (!(key in savedEnv)) savedEnv[key] = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function resetAmbientComsEnv(): void {
	setTestEnv("PI_SUBAGENT_CHILD", undefined);
	setTestEnv("PI_COMS_SUPERVISED_PEER", undefined);
	setTestEnv("PI_COMS_AUTO_START", undefined);
}

function expectedCwdProject(cwd: string): string {
	return cwd.replace(/^[\\/]+/, "").replace(/[\\/]+/g, "__");
}

afterEach(async () => {
	while (cleanupFns.length > 0) {
		const fn = cleanupFns.pop()!;
		try {
			await fn();
		} catch {
			/* ignore */
		}
	}
	for (const [key, val] of Object.entries(savedEnv)) {
		if (val === undefined) delete process.env[key];
		else process.env[key] = val;
		delete savedEnv[key];
	}
	clearSettingsCache();
	resetSessionBridge({ all: true });
	delete (globalThis as any).__piConfigSessionId;
});

function makeNamedWorkspace(dirName: string, extraSettings: Record<string, unknown> = {}): {
	workspace: string;
	comsDir: string;
} {
	const root = makeTempDir("ca-");
	cleanupFns.push(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, dirName);
	const comsDir = join(root, "coms");
	mkdirSync(join(workspace, ".pi"), { recursive: true });
	writeFileSync(
		join(workspace, ".pi", "pi-config-settings.json"),
		JSON.stringify({ coms_dir: comsDir, ...extraSettings }),
	);
	clearSettingsCache();
	return { workspace, comsDir };
}

function writeWorkspaceSettings(workspace: string, comsDir: string, extraSettings: Record<string, unknown> = {}): void {
	writeFileSync(
		join(workspace, ".pi", "pi-config-settings.json"),
		JSON.stringify({ coms_dir: comsDir, ...extraSettings }),
	);
	clearSettingsCache();
}

function createFakePi(flags: Record<string, unknown> = {}) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function>();
	const customEntries: any[] = [];
	const listeners = new Map<string, Set<(data?: any) => void>>();
	// Mirror real Pi ExtensionAPI: registerFlag stores defaults that getFlag returns when unset.
	const flagStore = new Map<string, unknown>(Object.entries(flags));
	let activeTools: string[] = ["read", "bash"];

	const events = {
		emit(event: string, data?: any) {
			for (const fn of [...(listeners.get(event) ?? [])]) fn(data);
		},
		on(event: string, fn: (data?: any) => void) {
			if (!listeners.has(event)) listeners.set(event, new Set());
			listeners.get(event)!.add(fn);
			return () => {
				listeners.get(event)?.delete(fn);
			};
		},
	};

	const pi: any = {
		registerFlag(name: string, opts?: { default?: unknown }) {
			if (!flagStore.has(name) && opts && "default" in opts) {
				flagStore.set(name, opts.default);
			}
		},
		getFlag(name: string) {
			return flagStore.get(name);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
			if (tool.defaultActive !== false && !activeTools.includes(tool.name)) {
				activeTools.push(tool.name);
			}
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		getAllTools: () => [...tools.values()],
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => {
			activeTools = [...next];
		},
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		appendEntry(customType: string, data: any) {
			customEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
		events,
	};

	return {
		pi,
		tools,
		handlers,
		customEntries,
		getActiveTools: () => [...activeTools],
	};
}

function makeSessionCtx(
	cwd: string,
	sessionId: string,
	opts: { mode?: string; hasUI?: boolean; entries?: any[] } = {},
) {
	return {
		cwd,
		mode: opts.mode ?? "tui",
		hasUI: opts.hasUI ?? true,
		model: { id: "test-model" },
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setTheme: () => ({ success: true }),
			setTitle: () => {},
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => opts.entries ?? [],
			getBranch: () => [],
		},
	};
}

function registerIsolatedComs(
	pi: any,
	comsDir: string,
	sessionId?: string,
): RegisteredComs {
	const reg = registerComs(pi, {
		comsDir,
		...(sessionId ? { sessionId } : {}),
		registerSignalHandlers: false,
	});
	cleanupFns.push(() => reg.runtime.stop({ reason: "test_cleanup" }));
	return reg;
}

async function startDummyListeningSocket(socketPath: string): Promise<net.Server> {
	return await new Promise<net.Server>((resolveServer, reject) => {
		const srv = net.createServer((sock) => {
			sock.end();
		});
		srv.once("error", reject);
		srv.listen(socketPath, () => {
			srv.removeListener("error", reject);
			cleanupFns.push(
				() =>
					new Promise<void>((res) => {
						try {
							srv.close(() => res());
						} catch {
							res();
						}
					}),
			);
			resolveServer(srv);
		});
	});
}

describe("coms_auto_start settings schema (#1503)", { concurrency: false }, () => {
	it("defines coms_auto_start with default true in Coms group", () => {
		const def = settingsKeys.coms_auto_start;
		assert.ok(def, "coms_auto_start key must exist in settings-keys.json");
		assert.equal(def.type, "bool");
		assert.equal(def.env, "PI_COMS_AUTO_START");
		assert.equal(def.default, true);
		assert.equal(def.group, "Coms");
	});

	it("declares coms_auto_start true in pi-config-settings.example.json", () => {
		assert.equal(exampleSettings.coms_auto_start, true);
	});

	it("resolves getSetting coms_auto_start to false when PI_COMS_AUTO_START is 0", () => {
		const { workspace } = makeNamedWorkspace("env-override-repo");
		setTestEnv("PI_COMS_AUTO_START", "0");
		clearSettingsCache();
		assert.equal(getSetting(workspace, "coms_auto_start"), false);
	});
});

describe("deriveAutoStartBaseName (#1503)", () => {
	it("returns clean repo basename unchanged", () => {
		assert.equal(deriveAutoStartBaseName("/home/user/git/pi-config"), "pi-config");
	});

	it("sanitizes spaces or punctuation into hyphens", () => {
		assert.equal(deriveAutoStartBaseName("/tmp/my repo (v2)"), "my-repo-v2");
	});

	it("strips leading non-alphanumeric characters", () => {
		assert.equal(deriveAutoStartBaseName("/tmp/.hidden-repo"), "hidden-repo");
	});

	it("falls back to session when basename has no valid characters", () => {
		assert.equal(deriveAutoStartBaseName("/tmp/..."), "session");
	});
});

describe("describePeerOrigin auto entry (#1503)", () => {
	it("describes auto activation origin as coms_auto_start", () => {
		const origin = describePeerOrigin({
			project: "proj",
			name: "pi-config",
			pid: 123,
			cwd: "/tmp/pi-config",
			purpose: "",
			model: "test",
			endpoint: "/tmp/s.sock",
			busy: false,
			queueDepth: 0,
			contextUsedPct: null,
			startedAt: null,
			heartbeatAt: null,
			origin: "auto",
			createdBy: null,
			piSessionId: null,
			workload: null,
		});
		assert.deepEqual(origin, { by: "auto", via: "coms_auto_start" });
	});
});

describe("resolveAutoStartName capacity (#1503)", { concurrency: false }, () => {
	it("advances past suffix 51 when earlier candidates are live", async () => {
		const { workspace, comsDir } = makeNamedWorkspace("crowded-repo");
		const project = expectedCwdProject(workspace);
		const registry = new ComsRegistry(comsDir);
		registry.ensureProjectDirs(project);
		const sharedSock = join(comsDir, "sockets", "shared-live.sock");
		await startDummyListeningSocket(sharedSock);

		for (let i = 1; i <= 51; i++) {
			const name = i === 1 ? "crowded-repo" : `crowded-repo-${i}`;
			registry.writeEntryAtomic(
				{
					coms_session_id: `live-peer-${i}`,
					name,
					purpose: "",
					model: "test",
					color: "#72F1B8",
					pid: process.pid,
					endpoint: sharedSock,
					cwd: workspace,
					started_at: new Date().toISOString(),
					explicit: false,
					version: 1,
				},
				project,
			);
		}

		const picked = await resolveAutoStartName(registry, project, "crowded-repo");
		assert.equal(picked, "crowded-repo-52");
	});

	it("returns null when all candidates within maxAttempts are live", async () => {
		const { workspace, comsDir } = makeNamedWorkspace("full-repo");
		const project = expectedCwdProject(workspace);
		const registry = new ComsRegistry(comsDir);
		registry.ensureProjectDirs(project);
		const sharedSock = join(comsDir, "sockets", "full-live.sock");
		await startDummyListeningSocket(sharedSock);

		for (let i = 1; i <= 3; i++) {
			const name = i === 1 ? "full-repo" : `full-repo-${i}`;
			registry.writeEntryAtomic(
				{
					coms_session_id: `full-peer-${i}`,
					name,
					purpose: "",
					model: "test",
					color: "#72F1B8",
					pid: process.pid,
					endpoint: sharedSock,
					cwd: workspace,
					started_at: new Date().toISOString(),
					explicit: false,
					version: 1,
				},
				project,
			);
		}

		const picked = await resolveAutoStartName(registry, project, "full-repo", undefined, undefined, 3);
		assert.equal(picked, null);
	});
});

describe("ComsRegistry.pruneStaleStartup main-socket fallback (#1503)", { concurrency: false }, () => {
	it("keeps registry entry when .ping socket is absent while main socket listens", async () => {
		const { workspace, comsDir } = makeNamedWorkspace("prune-live-main");
		const project = expectedCwdProject(workspace);
		const registry = new ComsRegistry(comsDir);
		registry.ensureProjectDirs(project);
		const mainSock = join(comsDir, "sockets", "booting-peer.sock");
		await startDummyListeningSocket(mainSock);
		const entryFile = registry.writeEntryAtomic(
			{
				coms_session_id: "booting-peer",
				name: "prune-live-main",
				purpose: "",
				model: "test",
				color: "#72F1B8",
				pid: process.pid,
				endpoint: mainSock,
				cwd: workspace,
				started_at: new Date().toISOString(),
				explicit: false,
				version: 1,
			},
			project,
		);

		assert.equal(existsSync(`${mainSock}.ping`), false, ".ping socket is not yet bound");
		await registry.pruneStaleStartup();

		assert.equal(existsSync(entryFile), true, "live main socket must keep registry entry intact");
	});

	it("unlinks registry entry when neither .ping nor main socket listens", async () => {
		const { workspace, comsDir } = makeNamedWorkspace("prune-dead-both");
		const project = expectedCwdProject(workspace);
		const registry = new ComsRegistry(comsDir);
		registry.ensureProjectDirs(project);
		const deadSock = join(comsDir, "sockets", "dead-both-peer.sock");
		// Create a stale non-listening file at the socket path so fs.existsSync passes and probes run.
		writeFileSync(deadSock, "");
		const entryFile = registry.writeEntryAtomic(
			{
				coms_session_id: "dead-both-peer",
				name: "prune-dead-both",
				purpose: "",
				model: "test",
				color: "#72F1B8",
				pid: process.pid,
				endpoint: deadSock,
				cwd: workspace,
				started_at: new Date().toISOString(),
				explicit: false,
				version: 1,
			},
			project,
		);

		await registry.pruneStaleStartup();

		assert.equal(existsSync(entryFile), false, "dead entry with dead sockets must be unlinked");
	});
});

describe("coms_auto_start interactive lifecycle (#1503)", { concurrency: false }, () => {
	it("auto-starts on interactive TUI startup in cwd-derived project despite default project flag", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("rootcoz");
		const fake = createFakePi();
		const reg = registerIsolatedComs(fake.pi, comsDir, "sess-auto-1");
		const ctx = makeSessionCtx(workspace, "sess-auto-1", { entries: fake.customEntries });

		assert.equal(fake.pi.getFlag("project"), "default", "fake Pi exposes registered --project default");
		await fake.handlers.get("session_start")!({ reason: "startup" }, ctx);

		assert.equal(reg.runtime.isActive(), true);
		assert.equal(reg.runtime.getSelf()?.name, "rootcoz");
		assert.equal(reg.runtime.getSelf()?.project, expectedCwdProject(workspace));
		assert.equal(reg.runtime.getSelf()?.origin, "auto");
		assert.equal(isComsActive("sess-auto-1"), true);
		assert.equal(fake.getActiveTools().includes("coms_send"), true);
	});

	it("keeps cwd-derived project when explicit --cname is passed without --project", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("named-repo");
		const fake = createFakePi({ cname: "custom-tui" });
		const reg = registerIsolatedComs(fake.pi, comsDir, "sess-custom-cname");
		const ctx = makeSessionCtx(workspace, "sess-custom-cname", { entries: fake.customEntries });

		await fake.handlers.get("session_start")!({ reason: "startup" }, ctx);

		assert.equal(reg.runtime.isActive(), true);
		assert.equal(reg.runtime.getSelf()?.name, "custom-tui");
		assert.equal(reg.runtime.getSelf()?.project, expectedCwdProject(workspace));
		assert.equal(reg.runtime.getSelf()?.origin, "auto");
	});

	it("suffixes cname with -2 when another live peer holds repo basename", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("pi-config");

		const first = createFakePi();
		const reg1 = registerIsolatedComs(first.pi, comsDir, "sess-live-1");
		const ctx1 = makeSessionCtx(workspace, "sess-live-1", { entries: first.customEntries });
		await first.handlers.get("session_start")!({ reason: "startup" }, ctx1);
		assert.equal(reg1.runtime.getSelf()?.name, "pi-config");

		const second = createFakePi();
		const reg2 = registerIsolatedComs(second.pi, comsDir, "sess-live-2");
		const ctx2 = makeSessionCtx(workspace, "sess-live-2", { entries: second.customEntries });
		await second.handlers.get("session_start")!({ reason: "startup" }, ctx2);

		assert.equal(reg2.runtime.isActive(), true);
		assert.equal(reg2.runtime.getSelf()?.name, "pi-config-2");
		assert.equal(reg2.runtime.getSelf()?.project, expectedCwdProject(workspace));
	});

	it("assigns distinct names to simultaneous startups in the same project", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("concurrent-repo");

		const first = createFakePi();
		const second = createFakePi();
		const reg1 = registerIsolatedComs(first.pi, comsDir, "sess-conc-1");
		const reg2 = registerIsolatedComs(second.pi, comsDir, "sess-conc-2");
		const ctx1 = makeSessionCtx(workspace, "sess-conc-1", { entries: first.customEntries });
		const ctx2 = makeSessionCtx(workspace, "sess-conc-2", { entries: second.customEntries });

		await Promise.all([
			first.handlers.get("session_start")!({ reason: "startup" }, ctx1),
			second.handlers.get("session_start")!({ reason: "startup" }, ctx2),
		]);

		const names = [reg1.runtime.getSelf()?.name, reg2.runtime.getSelf()?.name].sort();
		assert.deepEqual(names, ["concurrent-repo", "concurrent-repo-2"]);
	});

	it("skips auto-start without racing when project lock stays contended", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("locked-repo");
		const project = expectedCwdProject(workspace);
		const registry = new ComsRegistry(comsDir);
		registry.ensureProjectDirs(project);
		const lockPath = join(registry.projectsDir(), project, ".autostart.lock");
		const releaseExternal = acquireTokenFileLock(lockPath, { attempts: 1, uniqueClaim: true });
		assert.ok(releaseExternal, "external test lock acquired");
		cleanupFns.push(() => releaseExternal());

		const fake = createFakePi();
		const reg = registerComs(fake.pi, {
			comsDir,
			sessionId: "sess-locked",
			registerSignalHandlers: false,
			autoStartLockTimeoutMs: 60,
		});
		cleanupFns.push(() => reg.runtime.stop({ reason: "test_cleanup" }));
		const ctx = makeSessionCtx(workspace, "sess-locked", { entries: fake.customEntries });

		await fake.handlers.get("session_start")!({ reason: "startup" }, ctx);

		assert.equal(reg.runtime.isActive(), false);
		assert.equal(isComsActive("sess-locked"), false);
	});

	it("reclaims repo basename when existing registry entry is stale", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("stale-repo");
		const project = expectedCwdProject(workspace);
		const registry = new ComsRegistry(comsDir);
		registry.ensureProjectDirs(project);
		registry.writeEntryAtomic(
			{
				coms_session_id: "dead-peer-sess",
				name: "stale-repo",
				purpose: "",
				model: "test",
				color: "#72F1B8",
				pid: 999999,
				endpoint: join(comsDir, "sockets", "dead-peer-sess.sock"),
				cwd: workspace,
				started_at: new Date().toISOString(),
				explicit: false,
				version: 1,
			},
			project,
		);

		const fake = createFakePi();
		const reg = registerIsolatedComs(fake.pi, comsDir, "sess-reclaim");
		const ctx = makeSessionCtx(workspace, "sess-reclaim", { entries: fake.customEntries });
		await fake.handlers.get("session_start")!({ reason: "startup" }, ctx);

		assert.equal(reg.runtime.isActive(), true);
		assert.equal(reg.runtime.getSelf()?.name, "stale-repo");
	});

	it("keeps clean repo basename on /new without self-colliding to -2", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("clean-new-repo");
		const fake = createFakePi();
		const reg = registerIsolatedComs(fake.pi, comsDir);

		(globalThis as any).__piConfigSessionId = "sess-before-new";
		const ctx1 = makeSessionCtx(workspace, "sess-before-new", { entries: fake.customEntries });
		await fake.handlers.get("session_start")!({ reason: "startup" }, ctx1);
		const firstEndpoint = reg.runtime.getSelf()?.endpoint;
		assert.equal(reg.runtime.getSelf()?.name, "clean-new-repo");
		assert.ok(firstEndpoint && existsSync(firstEndpoint));

		await fake.handlers.get("session_shutdown")!({ reason: "new" }, ctx1);
		assert.equal(existsSync(firstEndpoint), false, "prior socket removed during shutdown");

		(globalThis as any).__piConfigSessionId = "sess-after-new";
		const ctx2 = makeSessionCtx(workspace, "sess-after-new", { entries: [] });
		await fake.handlers.get("session_start")!({ reason: "new" }, ctx2);

		assert.equal(reg.runtime.isActive(), true);
		assert.equal(reg.runtime.getSelf()?.name, "clean-new-repo");
		assert.equal(reg.runtime.getSelf()?.sessionId, "sess-after-new");
	});

	it("awaits in-flight shutdown teardown on /new before collision check", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("race-new-repo");
		const fake = createFakePi();
		const reg = registerIsolatedComs(fake.pi, comsDir);

		(globalThis as any).__piConfigSessionId = "sess-race-1";
		const ctx1 = makeSessionCtx(workspace, "sess-race-1", { entries: fake.customEntries });
		await fake.handlers.get("session_start")!({ reason: "startup" }, ctx1);
		assert.equal(reg.runtime.getSelf()?.name, "race-new-repo");

		const shutdownPromise = fake.handlers.get("session_shutdown")!({ reason: "new" }, ctx1);
		(globalThis as any).__piConfigSessionId = "sess-race-2";
		const ctx2 = makeSessionCtx(workspace, "sess-race-2", { entries: [] });
		await Promise.all([
			shutdownPromise,
			fake.handlers.get("session_start")!({ reason: "new" }, ctx2),
		]);

		assert.equal(reg.runtime.isActive(), true);
		assert.equal(reg.runtime.getSelf()?.name, "race-new-repo");
	});

	it("auto-starts on /resume session transition", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("resume-repo");
		const fake = createFakePi();
		const reg = registerIsolatedComs(fake.pi, comsDir, "sess-resume");
		const ctx = makeSessionCtx(workspace, "sess-resume", { entries: fake.customEntries });

		await fake.handlers.get("session_start")!({ reason: "resume" }, ctx);

		assert.equal(reg.runtime.isActive(), true);
		assert.equal(reg.runtime.getSelf()?.name, "resume-repo");
	});

	it("auto-starts on /fork session transition", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("fork-repo");
		const fake = createFakePi();
		const reg = registerIsolatedComs(fake.pi, comsDir, "sess-fork");
		const ctx = makeSessionCtx(workspace, "sess-fork", { entries: fake.customEntries });

		await fake.handlers.get("session_start")!({ reason: "fork" }, ctx);

		assert.equal(reg.runtime.isActive(), true);
		assert.equal(reg.runtime.getSelf()?.name, "fork-repo");
	});

	it("keeps COMS stopped on /resume after explicit coms_stop", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("stop-resume-repo");

		const w1 = createFakePi();
		const reg1 = registerIsolatedComs(w1.pi, comsDir, "sess-stop-resume");
		const ctx1 = makeSessionCtx(workspace, "sess-stop-resume", { entries: w1.customEntries });
		await w1.handlers.get("session_start")!({ reason: "startup" }, ctx1);
		assert.equal(reg1.runtime.isActive(), true);

		await w1.tools.get("coms_stop").execute("stop-1", {}, undefined, undefined, ctx1);
		await w1.handlers.get("session_shutdown")!({ reason: "resume" }, ctx1);

		const w2 = createFakePi();
		const reg2 = registerIsolatedComs(w2.pi, comsDir, "sess-stop-resume");
		const ctx2 = makeSessionCtx(workspace, "sess-stop-resume", { entries: w1.customEntries });
		await w2.handlers.get("session_start")!({ reason: "resume" }, ctx2);

		assert.equal(reg2.runtime.isActive(), false);
		assert.equal(isComsActive("sess-stop-resume"), false);
	});

	it("keeps COMS stopped on /fork after explicit coms_stop", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("stop-fork-repo");

		const w1 = createFakePi();
		const reg1 = registerIsolatedComs(w1.pi, comsDir, "sess-stop-fork-1");
		const ctx1 = makeSessionCtx(workspace, "sess-stop-fork-1", { entries: w1.customEntries });
		await w1.handlers.get("session_start")!({ reason: "startup" }, ctx1);
		await w1.tools.get("coms_stop").execute("stop-1", {}, undefined, undefined, ctx1);
		await w1.handlers.get("session_shutdown")!({ reason: "fork" }, ctx1);

		const w2 = createFakePi();
		const reg2 = registerIsolatedComs(w2.pi, comsDir, "sess-stop-fork-2");
		const ctx2 = makeSessionCtx(workspace, "sess-stop-fork-2", { entries: w1.customEntries });
		await w2.handlers.get("session_start")!({ reason: "fork" }, ctx2);

		assert.equal(reg2.runtime.isActive(), false);
		assert.equal(isComsActive("sess-stop-fork-2"), false);
	});

	it("skips auto-start when coms_auto_start setting is false", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("disabled-repo", { coms_auto_start: false });
		const fake = createFakePi();
		const reg = registerIsolatedComs(fake.pi, comsDir, "sess-disabled");
		const ctx = makeSessionCtx(workspace, "sess-disabled", { entries: fake.customEntries });

		await fake.handlers.get("session_start")!({ reason: "startup" }, ctx);

		assert.equal(reg.runtime.isActive(), false);
		assert.equal(isComsActive("sess-disabled"), false);
	});

	it("skips auto-start when PI_COMS_AUTO_START env is 0", async () => {
		resetAmbientComsEnv();
		setTestEnv("PI_COMS_AUTO_START", "0");
		const { workspace, comsDir } = makeNamedWorkspace("env-disabled-repo");
		const fake = createFakePi();
		const reg = registerIsolatedComs(fake.pi, comsDir, "sess-env-off");
		const ctx = makeSessionCtx(workspace, "sess-env-off", { entries: fake.customEntries });

		await fake.handlers.get("session_start")!({ reason: "startup" }, ctx);

		assert.equal(reg.runtime.isActive(), false);
	});

	it("skips auto-start when PI_SUBAGENT_CHILD is 1", async () => {
		resetAmbientComsEnv();
		setTestEnv("PI_SUBAGENT_CHILD", "1");
		const { workspace, comsDir } = makeNamedWorkspace("subagent-repo");
		const fake = createFakePi();
		const reg = registerComs(fake.pi, {
			comsDir,
			sessionId: "sess-subagent",
			allowSubagentChild: true,
			registerSignalHandlers: false,
		});
		cleanupFns.push(() => reg.runtime.stop({ reason: "test_cleanup" }));
		const ctx = makeSessionCtx(workspace, "sess-subagent", { entries: fake.customEntries });

		await fake.handlers.get("session_start")!({ reason: "startup" }, ctx);

		assert.equal(reg.runtime.isActive(), false);
	});

	it("skips auto-start when PI_COMS_SUPERVISED_PEER is 1", async () => {
		resetAmbientComsEnv();
		setTestEnv("PI_COMS_SUPERVISED_PEER", "1");
		const { workspace, comsDir } = makeNamedWorkspace("supervised-repo");
		const fake = createFakePi();
		const reg = registerIsolatedComs(fake.pi, comsDir, "sess-supervised");
		const ctx = makeSessionCtx(workspace, "sess-supervised", {
			mode: "tui",
			hasUI: true,
			entries: fake.customEntries,
		});

		await fake.handlers.get("session_start")!({ reason: "startup" }, ctx);

		assert.equal(reg.runtime.isActive(), false);
	});

	it("skips auto-start for rpc mode sessions", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("rpc-repo");
		const fake = createFakePi();
		const reg = registerIsolatedComs(fake.pi, comsDir, "sess-rpc");
		const ctx = makeSessionCtx(workspace, "sess-rpc", {
			mode: "rpc",
			hasUI: true,
			entries: fake.customEntries,
		});

		await fake.handlers.get("session_start")!({ reason: "startup" }, ctx);

		assert.equal(reg.runtime.isActive(), false);
	});

	it("skips auto-start for print oneshot sessions", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("print-repo");
		const fake = createFakePi();
		const reg = registerIsolatedComs(fake.pi, comsDir, "sess-print");
		const ctx = makeSessionCtx(workspace, "sess-print", {
			mode: "print",
			hasUI: false,
			entries: fake.customEntries,
		});

		await fake.handlers.get("session_start")!({ reason: "startup" }, ctx);

		assert.equal(reg.runtime.isActive(), false);
	});

	it("skips auto-start for json oneshot sessions", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("json-repo");
		const fake = createFakePi();
		const reg = registerIsolatedComs(fake.pi, comsDir, "sess-json");
		const ctx = makeSessionCtx(workspace, "sess-json", {
			mode: "json",
			hasUI: false,
			entries: fake.customEntries,
		});

		await fake.handlers.get("session_start")!({ reason: "startup" }, ctx);

		assert.equal(reg.runtime.isActive(), false);
	});

	it("keeps explicit --coms cli origin when --coms flag is set", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("cli-flag-repo");
		const fake = createFakePi({ coms: true, cname: "explicit-cli-peer" });
		const reg = registerIsolatedComs(fake.pi, comsDir, "sess-cli-flag");
		const ctx = makeSessionCtx(workspace, "sess-cli-flag", { entries: fake.customEntries });

		await fake.handlers.get("session_start")!({ reason: "startup" }, ctx);

		assert.equal(reg.runtime.isActive(), true);
		assert.equal(reg.runtime.getSelf()?.name, "explicit-cli-peer");
		assert.equal(reg.runtime.getSelf()?.origin, "cli");
	});

	it("keeps COMS stopped across /reload after explicit coms_stop", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("stop-reload-repo");

		const w1 = createFakePi();
		const reg1 = registerIsolatedComs(w1.pi, comsDir, "sess-stop-reload");
		const ctx1 = makeSessionCtx(workspace, "sess-stop-reload", { entries: w1.customEntries });
		await w1.handlers.get("session_start")!({ reason: "startup" }, ctx1);
		assert.equal(reg1.runtime.isActive(), true);

		await w1.tools.get("coms_stop").execute("stop-1", {}, undefined, undefined, ctx1);
		assert.equal(reg1.runtime.isActive(), false);
		await w1.handlers.get("session_shutdown")!({ reason: "reload" }, ctx1);

		const w2 = createFakePi();
		const reg2 = registerIsolatedComs(w2.pi, comsDir, "sess-stop-reload");
		const ctx2 = makeSessionCtx(workspace, "sess-stop-reload", { entries: w1.customEntries });
		await w2.handlers.get("session_start")!({ reason: "reload" }, ctx2);

		assert.equal(reg2.runtime.isActive(), false);
		assert.equal(isComsActive("sess-stop-reload"), false);
	});

	it("stops auto-started COMS on /reload after setting coms_auto_start to false", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("disable-reload-repo");

		const w1 = createFakePi();
		const reg1 = registerIsolatedComs(w1.pi, comsDir, "sess-disable-reload");
		const ctx1 = makeSessionCtx(workspace, "sess-disable-reload", { entries: w1.customEntries });
		await w1.handlers.get("session_start")!({ reason: "startup" }, ctx1);
		assert.equal(reg1.runtime.isActive(), true);
		await w1.handlers.get("session_shutdown")!({ reason: "reload" }, ctx1);

		writeWorkspaceSettings(workspace, comsDir, { coms_auto_start: false });

		const w2 = createFakePi();
		const reg2 = registerIsolatedComs(w2.pi, comsDir, "sess-disable-reload");
		const ctx2 = makeSessionCtx(workspace, "sess-disable-reload", { entries: w1.customEntries });
		await w2.handlers.get("session_start")!({ reason: "reload" }, ctx2);

		assert.equal(reg2.runtime.isActive(), false);
		assert.equal(isComsActive("sess-disable-reload"), false);
	});

	it("reactivates auto-started COMS on /reload preserving auto origin", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("keep-reload-repo");

		const w1 = createFakePi();
		const reg1 = registerIsolatedComs(w1.pi, comsDir, "sess-keep-reload");
		const ctx1 = makeSessionCtx(workspace, "sess-keep-reload", { entries: w1.customEntries });
		await w1.handlers.get("session_start")!({ reason: "startup" }, ctx1);
		assert.equal(reg1.runtime.getSelf()?.name, "keep-reload-repo");
		await w1.handlers.get("session_shutdown")!({ reason: "reload" }, ctx1);

		const w2 = createFakePi();
		const reg2 = registerIsolatedComs(w2.pi, comsDir, "sess-keep-reload");
		const ctx2 = makeSessionCtx(workspace, "sess-keep-reload", { entries: w1.customEntries });
		await w2.handlers.get("session_start")!({ reason: "reload" }, ctx2);

		assert.equal(reg2.runtime.isActive(), true);
		assert.equal(reg2.runtime.getSelf()?.name, "keep-reload-repo");
		assert.equal(reg2.runtime.getSelf()?.origin, "auto");
	});

	it("discovers auto-started peers across separate repos via coms_peers project wildcard", async () => {
		resetAmbientComsEnv();
		const root = makeTempDir("coms-cross-repo-");
		cleanupFns.push(() => rmSync(root, { recursive: true, force: true }));
		const comsDir = join(root, "coms");
		const repoA = join(root, "pi-config");
		const repoB = join(root, "rootcoz");
		mkdirSync(join(repoA, ".pi"), { recursive: true });
		mkdirSync(join(repoB, ".pi"), { recursive: true });
		writeWorkspaceSettings(repoA, comsDir);
		writeWorkspaceSettings(repoB, comsDir);

		const a = createFakePi();
		const b = createFakePi();
		const regA = registerIsolatedComs(a.pi, comsDir, "sess-cross-a");
		const regB = registerIsolatedComs(b.pi, comsDir, "sess-cross-b");
		const ctxA = makeSessionCtx(repoA, "sess-cross-a", { entries: a.customEntries });
		const ctxB = makeSessionCtx(repoB, "sess-cross-b", { entries: b.customEntries });

		await a.handlers.get("session_start")!({ reason: "startup" }, ctxA);
		await b.handlers.get("session_start")!({ reason: "startup" }, ctxB);

		assert.equal(regA.runtime.getSelf()?.project, expectedCwdProject(repoA));
		assert.equal(regB.runtime.getSelf()?.project, expectedCwdProject(repoB));
		assert.notEqual(regA.runtime.getSelf()?.project, regB.runtime.getSelf()?.project);

		const allPeersRes = await a.tools.get("coms_peers").execute("call-peers", { project: "*" });
		const text = String(allPeersRes.content?.[0]?.text ?? "");
		assert.match(text, /\bpi-config\b/);
		assert.match(text, /\brootcoz\b/);
	});
});

describe("coms_auto_start real-entrypoint subprocess (#1503)", { concurrency: false }, () => {
	const comsIndexUrl = pathToFileURL(join(REPO_ROOT, "extensions", "coms", "index.ts")).href;
	const piVersionUrl = pathToFileURL(join(REPO_ROOT, "extensions", "shared", "pi-version.ts")).href;
	const tsxBin = join(REPO_ROOT, "node_modules", ".bin", "tsx");

	async function runEntrypointProbe(
		workspace: string,
		comsDir: string,
		envOverrides: Record<string, string | undefined>,
	): Promise<{ activeCount: number; names: string[]; projects: string[] }> {
		const script = `
			import { MIN_PI_VERSION, setPiVersionResolverForTests } from ${JSON.stringify(piVersionUrl)};
			setPiVersionResolverForTests(() => MIN_PI_VERSION);
			import comsExt from ${JSON.stringify(comsIndexUrl)};
			import { ComsRegistry } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, "extensions", "coms", "coms-registry.ts")).href)};
			const handlers = new Map();
			const flags = new Map();
			const pi = {
				registerFlag(n, o) { if (!flags.has(n) && o && "default" in o) flags.set(n, o.default); },
				getFlag(n) { return flags.get(n); },
				registerTool() {},
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer() {},
				getAllTools() { return []; },
				getActiveTools() { return []; },
				setActiveTools() {},
				on(e, h) { handlers.set(e, h); },
				appendEntry() {},
				sendMessage() {},
				events: { emit() {}, on() { return () => {}; } },
			};
			comsExt(pi);
			const ctx = {
				cwd: ${JSON.stringify(workspace)},
				mode: "tui",
				hasUI: true,
				model: { id: "probe-model" },
				ui: { notify() {}, setStatus() {}, setWidget() {}, setTheme() { return { success: true }; }, setTitle() {} },
				sessionManager: { getSessionId() { return "probe-sess"; }, getEntries() { return []; }, getBranch() { return []; } },
			};
			await handlers.get("session_start")({ reason: "startup" }, ctx);
			const reg = new ComsRegistry(${JSON.stringify(comsDir)});
			const rows = reg.readRows();
			await handlers.get("session_shutdown")({ reason: "quit" }, ctx);
			process.stdout.write(JSON.stringify({
				activeCount: rows.length,
				names: rows.map((r) => r.name),
				projects: rows.map((r) => r.project),
			}));
		`;
		const env: NodeJS.ProcessEnv = { ...process.env, PI_COMS_DIR: comsDir };
		delete env.PI_SUBAGENT_CHILD;
		delete env.PI_COMS_SUPERVISED_PEER;
		delete env.PI_COMS_AUTO_START;
		delete env.__PI_CONFIG_SESSION_ID;
		for (const [k, v] of Object.entries(envOverrides)) {
			if (v === undefined) delete env[k];
			else env[k] = v;
		}
		const { stdout } = await execFileAsync(tsxBin, ["--input-type=module", "-e", script], {
			cwd: workspace,
			env,
			timeout: 20_000,
		});
		return JSON.parse(stdout.trim());
	}

	it("registers real socket entry when loaded through extensions/coms/index.ts with default env", async () => {
		const { workspace, comsDir } = makeNamedWorkspace("subproc-on");
		const result = await runEntrypointProbe(workspace, comsDir, {});
		assert.equal(result.activeCount, 1);
		assert.deepEqual(result.names, ["subproc-on"]);
		assert.deepEqual(result.projects, [expectedCwdProject(workspace)]);
	});

	it("skips registration in child process when PI_COMS_AUTO_START is 0", async () => {
		const { workspace, comsDir } = makeNamedWorkspace("subproc-off");
		const result = await runEntrypointProbe(workspace, comsDir, { PI_COMS_AUTO_START: "0" });
		assert.equal(result.activeCount, 0);
		assert.deepEqual(result.names, []);
	});
});
