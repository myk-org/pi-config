import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	clearAsyncAgentCachesForTests,
	registerAsyncAgents,
	setPrBaseRunnerForTests,
} from "../../../extensions/orchestrator/async-agents.js";
import { fakeAgent, fakeSpawnProcess } from "../helpers/fake-async-runtime.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const tempDirs: string[] = [];

afterEach(() => {
	setPrBaseRunnerForTests(null);
	clearAsyncAgentCachesForTests();
	for (const d of tempDirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
});

function createHarness() {
	const cwd = makeTempDir("async-perf-");
	tempDirs.push(cwd);
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => void>>();
	const commands = new Map<string, unknown>();
	const spawnCalls: Array<{ command: string; args: string[]; env: Record<string, string | undefined> }> = [];
	const previousSetInterval = global.setInterval;
	global.setInterval = (() => ({ unref() {}, [Symbol.toPrimitive]: () => 0 })) as unknown as typeof setInterval;

	const pi = {
		on(event: string, handler: (event: unknown, ctx: any) => void) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name: string, def: unknown) {
			commands.set(name, def);
		},
		sendMessage() {},
		events: new EventEmitter(),
	};

	const fakeSpawn = fakeSpawnProcess();
	let api!: ReturnType<typeof registerAsyncAgents>;
	withSubagentChildEnv(undefined, () => {
		api = registerAsyncAgents(pi as any, () => {}, {
			spawnProcess: ((command: string, args: string[], options: any) => {
				spawnCalls.push({ command, args, env: options.env });
				return fakeSpawn(command, args, options);
			}) as any,
			discoverAgents: () => ({ agents: [fakeAgent("worker")] }),
		});
	});
	assert.ok(handlers.get("session_start")?.length);

	const ctx = {
		cwd,
		hasUI: false,
		ui: { theme: { fg: (_: string, s: string) => s }, notify() {}, setStatus() {} },
		sessionManager: { getCwd: () => cwd, getSessionId: () => "perf-test" },
	};

	return {
		cwd,
		api,
		handlers,
		commands,
		spawnCalls,
		startSession: () => {
			for (const h of handlers.get("session_start") ?? []) h({}, ctx);
		},
		shutdown: () => {
			for (const h of handlers.get("session_shutdown") ?? []) h({}, ctx);
			global.setInterval = previousSetInterval;
		},
	};
}

describe("async-agents optimizations (#1206)", () => {
	it("returns no-op stubs and registers nothing when PI_SUBAGENT_CHILD=1", () => {
		const events: string[] = [];
		const commands: string[] = [];
		const pi = {
			on(event: string) {
				events.push(event);
			},
			registerCommand(name: string) {
				commands.push(name);
			},
			events: new EventEmitter(),
		};

		let api!: ReturnType<typeof registerAsyncAgents>;
		withSubagentChildEnv("1", () => {
			api = registerAsyncAgents(pi as any, () => {});
		});

		assert.deepEqual(events, []);
		assert.deepEqual(commands, []);
		assert.deepEqual(api.getAsyncJobs(), []);
		assert.deepEqual(api.killAsyncAgent("all"), { killed: [], errors: [] });
		const spawned = api.spawnAsyncAgent("worker", "task", process.cwd(), [fakeAgent("worker")]);
		assert.equal(spawned.id, "");
		assert.ok(spawned.error);
	});

	it("caches gh pr view baseRefName across parallel reviewer spawns for the same cwd", () => {
		const h = createHarness();
		let ghCalls = 0;
		setPrBaseRunnerForTests((dir) => {
			ghCalls++;
			return { status: 0, stdout: dir.includes("other") ? "develop\n" : "main\n", stderr: "" };
		});

		try {
			h.startSession();
			const reviewers = [
				"code-reviewer-quality",
				"code-reviewer-guidelines",
				"code-reviewer-security",
				"code-reviewer-docs",
				"code-reviewer-spec",
			];
			const agents = reviewers.map((name) => fakeAgent(name));
			for (const name of reviewers) {
				const res = h.api.spawnAsyncAgent(name, "review", h.cwd, agents);
				assert.equal(res.error, undefined);
			}
			assert.equal(ghCalls, 1);
			for (const call of h.spawnCalls) {
				assert.equal(call.env.PI_REVIEW_BASE_BRANCH, "main");
				assert.equal(call.env.PI_HAS_PR, "true");
			}

			// Different cwd performs its own lookup
			const otherDir = makeTempDir("async-perf-other-");
			tempDirs.push(otherDir);
			h.api.spawnAsyncAgent("test-runner", "test", otherDir, [fakeAgent("test-runner")]);
			assert.equal(ghCalls, 2);
			assert.equal(h.spawnCalls.at(-1)?.env.PI_REVIEW_BASE_BRANCH, "develop");

			// Branch change in .git/HEAD invalidates cached base branch immediately
			const gitRepo = makeTempDir("async-perf-branch-");
			tempDirs.push(gitRepo);
			mkdirSync(join(gitRepo, ".git"), { recursive: true });
			writeFileSync(join(gitRepo, ".git", "HEAD"), "ref: refs/heads/feat-a\n");
			h.api.spawnAsyncAgent("code-reviewer-quality", "r1", gitRepo, agents);
			assert.equal(ghCalls, 3);
			writeFileSync(join(gitRepo, ".git", "HEAD"), "ref: refs/heads/feat-b\n");
			h.api.spawnAsyncAgent("code-reviewer-quality", "r2", gitRepo, agents);
			assert.equal(ghCalls, 4);
		} finally {
			h.shutdown();
		}
	});

	it("caches jiti-cli.mjs path resolution across repeated async spawns", () => {
		const h = createHarness();
		clearAsyncAgentCachesForTests();
		try {
			h.startSession();
			const worker = [fakeAgent("worker")];
			h.api.spawnAsyncAgent("worker", "one", h.cwd, worker);
			h.api.spawnAsyncAgent("worker", "two", h.cwd, worker);
			h.api.spawnAsyncAgent("worker", "three", h.cwd, worker);

			assert.equal(h.spawnCalls.length, 3);
			const firstJiti = h.spawnCalls[0].args[0];
			assert.match(firstJiti, /jiti-cli\.mjs$/);
			assert.equal(h.spawnCalls[1].args[0], firstJiti);
			assert.equal(h.spawnCalls[2].args[0], firstJiti);
		} finally {
			h.shutdown();
		}
	});

	it("performs zombie cleanup, stale result dir cleanup, delivered scan, and job restore in single session_start pass", () => {
		const h = createHarness();
		const tmpDir = join(h.cwd, ".pi", "tmp");
		mkdirSync(tmpDir, { recursive: true });

		// 1. Dead-parent zombie dir
		const zombieDir = join(tmpDir, "worker-zombie");
		mkdirSync(zombieDir, { recursive: true });
		writeFileSync(
			join(zombieDir, "session.json"),
			JSON.stringify({ resultsDir: join(tmpDir, "async-results-pid-99999999-1"), parentPid: 99999999, parentStartTime: "1" }),
		);

		// 2. Stale async-results-pid dir for dead PID
		const staleResultsDir = join(tmpDir, "async-results-pid-99999999-1");
		mkdirSync(staleResultsDir, { recursive: true });
		writeFileSync(join(staleResultsDir, "old.json"), "{}");

		// 3. Delivered worker dir for current session (should be cleaned and runId tracked)
		let procStart = "";
		try {
			const stat = readFileSync(`/proc/${process.pid}/stat`, "utf-8");
			const rp = stat.lastIndexOf(")");
			procStart = stat.slice(rp + 2).trim().split(/\s+/)[19] || "";
		} catch {}
		const ownResultsDir = join(
			tmpDir,
			procStart ? `async-results-pid-${process.pid}-${procStart}` : `async-results-pid-${process.pid}`,
		);
		const deliveredDir = join(tmpDir, "worker-delivered");
		mkdirSync(deliveredDir, { recursive: true });
		writeFileSync(join(deliveredDir, "session.json"), JSON.stringify({ resultsDir: ownResultsDir }));
		writeFileSync(
			join(deliveredDir, "status.json"),
			JSON.stringify({ runId: "worker-delivered", state: "complete", delivered: true, agent: "worker" }),
		);

		// 4. Undelivered job for current session (should be restored)
		const pendingDir = join(tmpDir, "worker-pending");
		mkdirSync(pendingDir, { recursive: true });
		writeFileSync(join(pendingDir, "session.json"), JSON.stringify({ resultsDir: ownResultsDir, cwd: h.cwd }));
		writeFileSync(
			join(pendingDir, "status.json"),
			JSON.stringify({ runId: "worker-pending", state: "running", pid: process.pid, agent: "worker", task: "running task" }),
		);

		try {
			h.startSession();
			assert.equal(existsSync(zombieDir), false);
			assert.equal(existsSync(staleResultsDir), false);
			assert.equal(existsSync(deliveredDir), false);
			assert.equal(existsSync(pendingDir), true);
			const restored = h.api.getAsyncJobs();
			assert.equal(restored.length, 1);
			assert.equal(restored[0].id, "worker-pending");
		} finally {
			h.shutdown();
		}
	});

	it("evaluates {{IF:...}} conditionals and substitutes {{SETTINGS:...}} in async agent system-prompt.md (#1255)", () => {
		const h = createHarness();
		try {
			h.startSession();
			const conditionalAgent = {
				...fakeAgent("git-expert"),
				systemPrompt: "{{IF:review_loop_enforcement}}REVIEW_ON{{/IF}}\n{{IFNOT:allow_push_to_protected_branches}}NO_MAIN{{/IFNOT}}\n{{SETTINGS:dco}}",
			};
			const res = h.api.spawnAsyncAgent("git-expert", "check status", h.cwd, [conditionalAgent]);
			assert.equal(res.error, undefined);
			const configPath = h.spawnCalls[0].args.find((a) => a.endsWith(".json"));
			assert.ok(configPath);
			const config = JSON.parse(readFileSync(configPath, "utf-8"));
			const promptArgIdx = config.piArgs.indexOf("--append-system-prompt");
			assert.ok(promptArgIdx >= 0);
			const writtenPrompt = readFileSync(config.piArgs[promptArgIdx + 1], "utf-8");
			assert.doesNotMatch(writtenPrompt, /REVIEW_ON/);
			assert.match(writtenPrompt, /NO_MAIN/);
			assert.match(writtenPrompt, /\{"dco":false\}/);
		} finally {
			h.shutdown();
		}
	});
});
