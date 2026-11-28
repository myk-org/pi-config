/**
 * Focused single-behavior unit tests for `coms_auto_start` (#1503).
 *
 * Run with: npx tsx --test tests/node/coms/coms-auto-start.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { describePeerOrigin } from "../../../extensions/coms/coms-peers.js";
import { ComsRegistry } from "../../../extensions/coms/coms-registry.js";
import {
	deriveAutoStartBaseName,
	registerComs,
	type RegisteredComs,
} from "../../../extensions/coms/coms-wrapper.js";
import { clearSettingsCache, getSetting } from "../../../extensions/orchestrator/project-settings.js";
import { isComsActive, resetSessionBridge } from "../../../extensions/shared/session-bridge.js";
import { useSupportedPiVersion } from "../helpers/pi-version-env.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

useSupportedPiVersion();

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
	const root = makeTempDir("coms-autostart-");
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

function createFakePi(flags: Record<string, unknown> = {}) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function>();
	const customEntries: any[] = [];
	const listeners = new Map<string, Set<(data?: any) => void>>();
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
		registerFlag() {},
		getFlag(name: string) {
			return flags[name];
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

describe("coms_auto_start interactive lifecycle (#1503)", { concurrency: false }, () => {
	it("auto-starts on interactive TUI startup with repo-basename cname", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("rootcoz");
		const fake = createFakePi();
		const reg = registerIsolatedComs(fake.pi, comsDir, "sess-auto-1");
		const ctx = makeSessionCtx(workspace, "sess-auto-1", { entries: fake.customEntries });

		await fake.handlers.get("session_start")!({ reason: "startup" }, ctx);

		assert.equal(reg.runtime.isActive(), true);
		assert.equal(reg.runtime.getSelf()?.name, "rootcoz");
		assert.equal(reg.runtime.getSelf()?.origin, "auto");
		assert.equal(isComsActive("sess-auto-1"), true);
		assert.equal(fake.getActiveTools().includes("coms_send"), true);
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
	});

	it("reclaims repo basename when existing registry entry is stale", async () => {
		resetAmbientComsEnv();
		const { workspace, comsDir } = makeNamedWorkspace("stale-repo");
		const project = workspace.replace(/^[\\/]+/, "").replace(/[\\/]+/g, "__");
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

		// Fire session_shutdown without awaiting it first, then immediately fire /new session_start.
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
});
