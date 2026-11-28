/**
 * Unit tests for #1488: graceful in-process supervised COMS RPC peer shutdown
 * using Pi 1.7.0 `ctx.shutdown()` before external `SIGTERM` / `SIGKILL` escalation.
 *
 * Run with: npx tsx --test --test-concurrency=4 tests/node/coms/coms-rpc-shutdown.test.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";

import {
	createComsPeerRuntime,
	isSupervisedRpcShutdownCtx,
	type ComsPeerRuntime,
} from "../../../extensions/coms/coms-p2p.js";
import { requestPeerShutdown } from "../../../extensions/coms/coms-shutdown-client.mjs";
import { executePeerKillEntry } from "../../../extensions/coms/coms-wrapper.js";
import { resetSessionBridge } from "../../../extensions/shared/session-bridge.js";
import { buildPeerContainerName } from "../../../scripts/podman-peer-image.mjs";
import { makeTempDir } from "../helpers/temp-dirs.js";

const SUPERVISOR_SCRIPT = join(process.cwd(), "scripts", "coms-peer-supervisor.mjs");

const activeRuntimes: ComsPeerRuntime[] = [];
const spawnedChildren: ChildProcess[] = [];
const tempDirs: string[] = [];

function createTmp(prefix: string): string {
	const dir = makeTempDir(prefix);
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (activeRuntimes.length > 0) {
		const rt = activeRuntimes.pop()!;
		try {
			await rt.stop({ reason: "test_cleanup" });
		} catch {
			/* ignore */
		}
	}
	resetSessionBridge({ all: true });
	delete (globalThis as any).__piConfigSessionId;
});

after(() => {
	for (const child of spawnedChildren) {
		try {
			child.kill("SIGKILL");
		} catch {
			/* ignore */
		}
	}
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

function withSupervisedEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
	const prev = process.env.PI_COMS_SUPERVISED_PEER;
	if (value === undefined) delete process.env.PI_COMS_SUPERVISED_PEER;
	else process.env.PI_COMS_SUPERVISED_PEER = value;
	return fn().finally(() => {
		if (prev === undefined) delete process.env.PI_COMS_SUPERVISED_PEER;
		else process.env.PI_COMS_SUPERVISED_PEER = prev;
	});
}

function makeWorkspace(prefix: string): { workspace: string; comsDir: string } {
	const workspace = createTmp(prefix);
	const comsDir = join(workspace, "coms");
	mkdirSync(join(workspace, ".pi"), { recursive: true });
	writeFileSync(join(workspace, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: comsDir }));
	return { workspace, comsDir };
}

async function bootRuntime(opts: {
	name: string;
	project: string;
	sessionId: string;
	piSessionId?: string;
	mode: "rpc" | "tui";
	isIdle?: () => boolean;
	onShutdown?: () => void;
}) {
	const { workspace, comsDir } = makeWorkspace(`coms-rpc-shutdown-${opts.name}-`);
	const handlers = new Map<string, Function[]>();
	const flags: Record<string, unknown> = { cname: opts.name, project: opts.project };
	let shutdownCalls = 0;
	let sessionShutdownEvents = 0;

	const pi: any = {
		registerFlag() {},
		getFlag(name: string) {
			return flags[name];
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		getAllTools() {
			return [];
		},
		on(name: string, fn: Function) {
			const list = handlers.get(name) ?? [];
			list.push(fn);
			handlers.set(name, list);
		},
		sendMessage() {},
		appendEntry() {},
		getActiveTools() {
			return [];
		},
		setActiveTools() {},
		events: {
			emit() {},
			on() {
				return () => {};
			},
		},
	};

	const ctx: any = {
		cwd: workspace,
		mode: opts.mode,
		hasUI: opts.mode === "tui",
		model: { id: "test-model" },
		isIdle: opts.isIdle ?? (() => true),
		shutdown: () => {
			shutdownCalls++;
			opts.onShutdown?.();
			for (const fn of handlers.get("session_shutdown") ?? []) {
				sessionShutdownEvents++;
				void fn({ reason: "shutdown" }, ctx);
			}
		},
		ui: {
			notify() {},
			setStatus() {},
			setWidget() {},
			setTheme: () => ({ success: true }),
			setTitle() {},
		},
		sessionManager: {
			getSessionId: () => opts.piSessionId ?? opts.sessionId,
			getEntries: () => [],
			getBranch: () => [],
		},
	};

	const runtime = createComsPeerRuntime(pi, {
		deferred: true,
		comsDir,
		sessionId: opts.sessionId,
		allowSubagentChild: true,
		registerSignalHandlers: false,
	});
	activeRuntimes.push(runtime);
	const self = await runtime.start(ctx, { flags: { cname: opts.name, project: opts.project }, origin: "cli" });
	assert.ok(self, "peer runtime must start");

	const registryFile = join(comsDir, "projects", opts.project, "agents", `${opts.sessionId}.json`);
	return {
		workspace,
		comsDir,
		runtime,
		self,
		ctx,
		registryFile,
		getShutdownCalls: () => shutdownCalls,
		getSessionShutdownEvents: () => sessionShutdownEvents,
	};
}

describe("isSupervisedRpcShutdownCtx", () => {
	it("returns true for supervised rpc context with shutdown callback", () => {
		const ctx = { mode: "rpc", shutdown: () => {} };
		assert.equal(isSupervisedRpcShutdownCtx(ctx, { PI_COMS_SUPERVISED_PEER: "1" }), true);
	});

	it("returns false for interactive tui context", () => {
		const ctx = { mode: "tui", shutdown: () => {} };
		assert.equal(isSupervisedRpcShutdownCtx(ctx, { PI_COMS_SUPERVISED_PEER: "1" }), false);
	});

	it("returns false when PI_COMS_SUPERVISED_PEER is unset", () => {
		const ctx = { mode: "rpc", shutdown: () => {} };
		assert.equal(isSupervisedRpcShutdownCtx(ctx, {}), false);
	});
});

describe("COMS RPC peer graceful shutdown protocol (#1488)", { concurrency: false }, () => {
	it("invokes ctx.shutdown after cleanup on idle supervised rpc peer", async () => {
		await withSupervisedEnv("1", async () => {
			let runtimeActiveDuringShutdown = true;
			const peer = await bootRuntime({
				name: "idle-rpc",
				project: "proj-rpc",
				sessionId: "sid-idle-rpc-1",
				mode: "rpc",
				isIdle: () => true,
				onShutdown: () => {
					runtimeActiveDuringShutdown = existsSync(peer.registryFile);
				},
			});

			assert.equal(existsSync(peer.registryFile), true);
			const res = await requestPeerShutdown(peer.self.endpoint, { reason: "test_idle", timeoutMs: 3_000 });
			assert.equal(res.ok, true, `expected graceful shutdown ack, got ${JSON.stringify(res)}`);
			if (res.ok) {
				assert.equal(res.busy, false);
				assert.equal(res.alreadyShuttingDown, false);
			}

			assert.equal(await waitFor(() => peer.getShutdownCalls() === 1, 3_000), true);
			assert.equal(runtimeActiveDuringShutdown, false, "registry entry must be removed before ctx.shutdown()");
			assert.equal(existsSync(peer.self.endpoint), false, "peer socket must be unlinked");
			assert.equal(peer.runtime.isActive(), false);
		});
	});

	it("persists piSessionId into matching native supervisor record on graceful shutdown", async () => {
		await withSupervisedEnv("1", async () => {
			const peer = await bootRuntime({
				name: "revive-rpc",
				project: "proj-revive",
				sessionId: "sid-revive-rpc-1",
				piSessionId: "pi-session-abc-123",
				mode: "rpc",
			});

			const peersDir = join(peer.comsDir, "peers");
			mkdirSync(peersDir, { recursive: true });
			const statePath = join(peersDir, "revive-rpc@proj-revive.json");
			writeFileSync(
				statePath,
				JSON.stringify({ cname: "revive-rpc", project: "proj-revive", pid: 99991, childPid: process.pid }),
			);

			const res = await requestPeerShutdown(peer.self.endpoint, { timeoutMs: 3_000 });
			assert.equal(res.ok, true, `expected graceful shutdown ack, got ${JSON.stringify(res)}`);
			assert.equal(await waitFor(() => peer.getShutdownCalls() === 1, 3_000), true);

			const saved = JSON.parse(readFileSync(statePath, "utf-8"));
			assert.equal(saved.piSessionId, "pi-session-abc-123");
		});
	});

	it("rejects shutdown envelope on interactive tui peer", async () => {
		await withSupervisedEnv(undefined, async () => {
			const peer = await bootRuntime({
				name: "tui-peer",
				project: "proj-tui",
				sessionId: "sid-tui-1",
				mode: "tui",
			});

			const res = await requestPeerShutdown(peer.self.endpoint, { timeoutMs: 3_000 });
			assert.equal(res.ok, false);
			if (!res.ok) assert.equal(res.reason, "nack");
			assert.equal(peer.getShutdownCalls(), 0);
			assert.equal(peer.runtime.isActive(), true);
		});
	});

	it("reports busy flag in ack when peer turn is active", async () => {
		await withSupervisedEnv("1", async () => {
			const peer = await bootRuntime({
				name: "busy-rpc",
				project: "proj-busy",
				sessionId: "sid-busy-rpc-1",
				mode: "rpc",
				isIdle: () => false,
			});

			const res = await requestPeerShutdown(peer.self.endpoint, { timeoutMs: 3_000 });
			assert.equal(res.ok, true, `expected busy graceful shutdown ack, got ${JSON.stringify(res)}`);
			if (res.ok) assert.equal(res.busy, true);
			assert.equal(await waitFor(() => peer.getShutdownCalls() === 1, 3_000), true);
		});
	});

	it("deduplicates concurrent socket shutdown requests", async () => {
		await withSupervisedEnv("1", async () => {
			const peer = await bootRuntime({
				name: "dup-rpc",
				project: "proj-dup",
				sessionId: "sid-dup-rpc-1",
				mode: "rpc",
			});

			const [r1, r2] = await Promise.all([
				requestPeerShutdown(peer.self.endpoint, { msgId: "dup-1", timeoutMs: 3_000 }),
				requestPeerShutdown(peer.self.endpoint, { msgId: "dup-2", timeoutMs: 3_000 }),
			]);
			assert.equal(r1.ok || r2.ok, true, "at least one concurrent request must be acknowledged");
			assert.equal(await waitFor(() => peer.getShutdownCalls() === 1, 3_000), true);
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(peer.getShutdownCalls(), 1, "ctx.shutdown() must run strictly once");
		});
	});

	it("makes repeated runtime.requestGracefulRpcShutdown calls idempotent", async () => {
		await withSupervisedEnv("1", async () => {
			const peer = await bootRuntime({
				name: "idem-rpc",
				project: "proj-idem",
				sessionId: "sid-idem-rpc-1",
				mode: "rpc",
			});

			const [ok1, ok2] = await Promise.all([
				peer.runtime.requestGracefulRpcShutdown("first"),
				peer.runtime.requestGracefulRpcShutdown("second"),
			]);
			assert.equal(ok1, true);
			assert.equal(ok2, true);
			assert.equal(peer.getShutdownCalls(), 1);
		});
	});
});

describe("executePeerKillEntry direct graceful shutdown", () => {
	it("skips sigterm when direct peer exits before grace timeout", async () => {
		const killed: Array<[number, string]> = [];
		let alive = true;
		const ok = executePeerKillEntry(
			{ name: "orphan", project: "proj", signalPid: 4242, reason: "peer" },
			{
				endpoint: "/tmp/fake-peer.sock",
				graceTimeoutMs: 60,
				requestShutdown: async () => {
					alive = false;
					return { ok: true, busy: false, alreadyShuttingDown: false };
				},
				isPidAlive: () => alive,
				killPid: (pid, sig) => killed.push([pid, sig]),
			},
		);
		assert.equal(ok, true);
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.deepEqual(killed, []);
	});

	it("escalates to sigterm when direct peer stays alive past grace timeout", async () => {
		const killed: Array<[number, string]> = [];
		const ok = executePeerKillEntry(
			{ name: "stuck", project: "proj", signalPid: 4243, reason: "peer" },
			{
				endpoint: "/tmp/fake-peer.sock",
				graceTimeoutMs: 50,
				requestShutdown: async () => ({ ok: true, busy: true, alreadyShuttingDown: false }),
				isPidAlive: () => true,
				killPid: (pid, sig) => killed.push([pid, sig]),
			},
		);
		assert.equal(ok, true);
		assert.equal(await waitFor(() => killed.length === 1, 1_500), true);
		assert.deepEqual(killed, [[4243, "SIGTERM"]]);
	});

	it("falls back immediately to sigterm when direct peer rejects graceful shutdown", async () => {
		const killed: Array<[number, string]> = [];
		const ok = executePeerKillEntry(
			{ name: "legacy", project: "proj", signalPid: 4244, reason: "peer" },
			{
				endpoint: "/tmp/fake-peer.sock",
				graceTimeoutMs: 500,
				requestShutdown: async () => ({ ok: false, reason: "nack", error: "unsupported" }),
				isPidAlive: () => true,
				killPid: (pid, sig) => killed.push([pid, sig]),
			},
		);
		assert.equal(ok, true);
		assert.equal(await waitFor(() => killed.length === 1, 500), true);
		assert.deepEqual(killed, [[4244, "SIGTERM"]]);
	});
});

interface RpcStubHarness {
	root: string;
	home: string;
	bin: string;
	coms: string;
	readyFile: string;
	sigtermMarker: string;
	shutdownMarker: string;
	registryFile: string;
}

function makeRpcStubHarness(opts: {
	exitOnShutdown: boolean;
	ignoreSigterm?: boolean;
	piSessionId?: string;
}): RpcStubHarness {
	const root = createTmp("coms-sup-rpc-");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const coms = join(root, "coms");
	const readyFile = join(root, "ready");
	const sigtermMarker = join(root, "saw-sigterm");
	const shutdownMarker = join(root, "saw-rpc-shutdown");
	const agentsDir = join(coms, "projects", "proj", "agents");
	const socketsDir = join(coms, "sockets");
	const registryFile = join(agentsDir, "stub-sid.json");
	const socketPath = join(socketsDir, "stub-sid.sock");
	mkdirSync(home, { recursive: true });
	mkdirSync(bin, { recursive: true });
	mkdirSync(agentsDir, { recursive: true });
	mkdirSync(socketsDir, { recursive: true });

	const stubScript = join(root, "stub-pi.mjs");
	writeFileSync(
		stubScript,
		`import fs from "node:fs";
import net from "node:net";

const exitOnShutdown = ${JSON.stringify(opts.exitOnShutdown)};
const ignoreSigterm = ${JSON.stringify(Boolean(opts.ignoreSigterm))};
const registryFile = ${JSON.stringify(registryFile)};
const socketPath = ${JSON.stringify(socketPath)};
const readyFile = ${JSON.stringify(readyFile)};
const sigtermMarker = ${JSON.stringify(sigtermMarker)};
const shutdownMarker = ${JSON.stringify(shutdownMarker)};
const piSessionId = ${JSON.stringify(opts.piSessionId ?? "pi-sess-graceful-1")};

process.on("SIGTERM", () => {
  fs.writeFileSync(sigtermMarker, "1");
  if (!ignoreSigterm) process.exit(143);
});

const server = net.createServer((sock) => {
  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    const nl = buf.indexOf("\\n");
    if (nl < 0) return;
    const msg = JSON.parse(buf.slice(0, nl));
    if (msg.type === "shutdown") {
      fs.writeFileSync(shutdownMarker, "1");
      sock.end(JSON.stringify({ type: "ack", msg_id: msg.msg_id, busy: !exitOnShutdown }) + "\\n", () => {
        if (exitOnShutdown) {
          try { fs.unlinkSync(registryFile); } catch {}
          server.close(() => {
            try { fs.unlinkSync(socketPath); } catch {}
            process.exit(0);
          });
        }
      });
    }
  });
});

server.listen(socketPath, () => {
  fs.writeFileSync(registryFile, JSON.stringify({
    coms_session_id: "stub-sid",
    name: "peer1",
    pid: process.pid,
    endpoint: socketPath,
    pi_session_id: piSessionId,
  }));
  fs.writeFileSync(readyFile, "1");
});
setInterval(() => {}, 1000);
`,
	);

	const piWrapper = join(bin, "pi");
	writeFileSync(piWrapper, `#!/bin/sh\nexec "${process.execPath}" "${stubScript}" "$@"\n`);
	chmodSync(piWrapper, 0o755);

	return { root, home, bin, coms, readyFile, sigtermMarker, shutdownMarker, registryFile };
}

function spawnSupervisor(h: RpcStubHarness, timeoutMs: number): ChildProcess {
	const child = spawn(
		process.execPath,
		[SUPERVISOR_SCRIPT, "peer1", "--project", "proj", "--cwd", h.root],
		{
			env: {
				...process.env,
				HOME: h.home,
				PI_COMS_DIR: h.coms,
				PATH: `${h.bin}:${process.env.PATH}`,
				PI_COMS_STOP_TIMEOUT_MS: String(timeoutMs),
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	spawnedChildren.push(child);
	return child;
}

describe("coms-peer-supervisor graceful RPC shutdown (#1488)", { concurrency: false }, () => {
	it("exits with code 0 via graceful rpc shutdown before sigterm on cooperative peer", async () => {
		const h = makeRpcStubHarness({ exitOnShutdown: true, piSessionId: "pi-sess-clean-0" });
		const sup = spawnSupervisor(h, 5_000);
		const recordPath = join(h.coms, "peers", "peer1@proj.json");
		assert.equal(await waitFor(() => existsSync(recordPath) && existsSync(h.readyFile)), true);

		const exitCode = await new Promise<number | null>((resolve) => {
			sup.on("exit", (code: number | null) => resolve(code));
			sup.kill("SIGTERM");
		});
		assert.equal(exitCode, 0);
		assert.equal(existsSync(h.shutdownMarker), true, "supervisor must send graceful shutdown envelope");
		assert.equal(existsSync(h.sigtermMarker), false, "cooperative peer must exit cleanly before SIGTERM");
		assert.equal(existsSync(h.registryFile), false, "registry entry must be removed");

		const record = JSON.parse(readFileSync(recordPath, "utf-8"));
		assert.equal(record.exitCode, 0);
		assert.equal(record.exitSignal, null);
		assert.equal(record.shutdownMode, "rpc-graceful");
		assert.equal(record.forced, undefined);
		assert.equal(record.piSessionId, "pi-sess-clean-0");
	});

	it("escalates to sigterm when supervised peer stays wedged past grace timeout", async () => {
		const h = makeRpcStubHarness({ exitOnShutdown: false, ignoreSigterm: false });
		const sup = spawnSupervisor(h, 600);
		const recordPath = join(h.coms, "peers", "peer1@proj.json");
		assert.equal(await waitFor(() => existsSync(recordPath) && existsSync(h.readyFile)), true);

		const exitCode = await new Promise<number | null>((resolve) => {
			sup.on("exit", (code: number | null) => resolve(code));
			sup.kill("SIGTERM");
		});
		assert.equal(exitCode, 0);
		assert.equal(existsSync(h.shutdownMarker), true);
		assert.equal(existsSync(h.sigtermMarker), true, "wedged peer must receive SIGTERM escalation");
		assert.equal(existsSync(h.registryFile), false, "supervisor must clean stale registry entry");

		const record = JSON.parse(readFileSync(recordPath, "utf-8"));
		assert.equal(record.shutdownMode, "signal");
		assert.equal(record.forced, undefined);
	});

	it("escalates to sigkill when wedged peer ignores graceful shutdown plus sigterm", async () => {
		const h = makeRpcStubHarness({ exitOnShutdown: false, ignoreSigterm: true });
		const sup = spawnSupervisor(h, 500);
		const recordPath = join(h.coms, "peers", "peer1@proj.json");
		assert.equal(await waitFor(() => existsSync(recordPath) && existsSync(h.readyFile)), true);

		const exitCode = await new Promise<number | null>((resolve) => {
			sup.on("exit", (code: number | null) => resolve(code));
			sup.kill("SIGTERM");
		});
		assert.equal(exitCode, 0);
		assert.equal(existsSync(h.shutdownMarker), true);
		assert.equal(existsSync(h.sigtermMarker), true);
		assert.equal(existsSync(h.registryFile), false, "supervisor must clean stale registry after SIGKILL");

		const record = JSON.parse(readFileSync(recordPath, "utf-8"));
		assert.equal(record.exitSignal, "SIGKILL");
		assert.equal(record.forced, true);
	});

	it("uses graceful rpc shutdown for podman peer when container socket acks", async () => {
		const tmpHome = createTmp("pi-podman-rpc-home-");
		const repoDir = createTmp("pi-podman-rpc-repo-");
		const binDir = createTmp("pi-podman-rpc-bin-");
		const comsDir = join(tmpHome, ".pi", "coms");
		const podmanLog = join(tmpHome, "podman-rpc.log");
		const waitRelease = join(tmpHome, "release-wait");
		const shutdownMarker = join(tmpHome, "podman-saw-shutdown");
		const cname = "ctr-rpc";
		const project = "demo";
		const containerName = buildPeerContainerName(project, cname);
		const fakeCid = "abcd1234".repeat(8);

		// Minimal git repo for prepareSandboxWorkspace
		const { execFileSync } = await import("node:child_process");
		execFileSync("git", ["init", "-q"], { cwd: repoDir });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
		writeFileSync(join(repoDir, "README.md"), "hi\n");
		execFileSync("git", ["add", "README.md"], { cwd: repoDir });
		execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });

		// Start a host-side mock socket matching the containerized peer's registry entry
		const agentsDir = join(comsDir, "projects", project, "agents");
		const socketsDir = join(comsDir, "sockets");
		mkdirSync(agentsDir, { recursive: true });
		mkdirSync(socketsDir, { recursive: true });
		const socketPath = join(socketsDir, "ctr-sid.sock");
		const registryFile = join(agentsDir, "ctr-sid.json");

		const net = await import("node:net");
		const server = net.createServer((sock) => {
			let buf = "";
			sock.on("data", (chunk) => {
				buf += chunk.toString("utf-8");
				const nl = buf.indexOf("\n");
				if (nl < 0) return;
				const msg = JSON.parse(buf.slice(0, nl));
				if (msg.type === "shutdown") {
					writeFileSync(shutdownMarker, "1");
					sock.end(`${JSON.stringify({ type: "ack", msg_id: msg.msg_id, busy: false })}\n`, () => {
						try {
							rmSync(registryFile, { force: true });
						} catch {
							/* ignore */
						}
						writeFileSync(waitRelease, "0");
					});
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));

		try {
			writeFileSync(
				registryFile,
				JSON.stringify({
					coms_session_id: "ctr-sid",
					name: cname,
					pid: 1,
					container: containerName,
					endpoint: socketPath,
					pi_session_id: "pi-podman-sess-1",
				}),
			);

			const fakePodman = join(binDir, "podman");
			writeFileSync(
				fakePodman,
				`#!/usr/bin/env bash
echo "$@" >> "${podmanLog}"
if [ "$1" = "run" ]; then
  echo "${fakeCid}"
  exit 0
fi
if [ "$1" = "inspect" ]; then
  echo "${process.pid}"
  exit 0
fi
if [ "$1" = "wait" ]; then
  while [ ! -f "${waitRelease}" ]; do sleep 0.05; done
  cat "${waitRelease}"
  exit 0
fi
exit 0
`,
				{ mode: 0o755 },
			);

			const sup = spawn(
				process.execPath,
				[
					SUPERVISOR_SCRIPT,
					cname,
					"--project",
					project,
					"--cwd",
					repoDir,
					"--sandbox",
					"podman",
					"--image",
					"localhost/pi-peer:111122223333",
				],
				{
					env: {
						...process.env,
						HOME: tmpHome,
						PI_COMS_DIR: comsDir,
						PATH: `${binDir}:${process.env.PATH}`,
						PI_COMS_STOP_TIMEOUT_MS: "4000",
					},
					stdio: "ignore",
				},
			);
			spawnedChildren.push(sup);

			const statePath = join(comsDir, "peers", `${cname}@${project}.json`);
			assert.equal(await waitFor(() => existsSync(statePath)), true);

			const exitCode = await new Promise<number | null>((resolve) => {
				sup.on("exit", (code: number | null) => resolve(code));
				sup.kill("SIGTERM");
			});
			assert.equal(exitCode, 0);
			assert.equal(existsSync(shutdownMarker), true, "podman supervisor must send graceful shutdown envelope");

			const calls = readFileSync(podmanLog, "utf-8");
			assert.doesNotMatch(calls, /^stop /m, "podman stop is skipped when peer exits via graceful rpc shutdown");
			assert.match(calls, new RegExp(`rm -f -- ${fakeCid}`));

			const state = JSON.parse(readFileSync(statePath, "utf-8"));
			assert.equal(state.exitCode, 0);
			assert.equal(state.shutdownMode, "rpc-graceful");
			assert.equal(state.piSessionId, "pi-podman-sess-1");
			assert.equal(state.forced, undefined);
		} finally {
			server.close();
		}
	});

	it("keeps podman stop fallback intact when container socket is absent", async () => {
		const tmpHome = createTmp("pi-podman-fb-home-");
		const repoDir = createTmp("pi-podman-fb-repo-");
		const binDir = createTmp("pi-podman-fb-bin-");
		const comsDir = join(tmpHome, ".pi", "coms");
		const podmanLog = join(tmpHome, "podman-fb.log");
		const cname = "ctr-fb";
		const project = "demo";
		const fakeCid = "beef5678".repeat(8);

		const { execFileSync } = await import("node:child_process");
		execFileSync("git", ["init", "-q"], { cwd: repoDir });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
		writeFileSync(join(repoDir, "README.md"), "hi\n");
		execFileSync("git", ["add", "README.md"], { cwd: repoDir });
		execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });

		const fakePodman = join(binDir, "podman");
		writeFileSync(
			fakePodman,
			`#!/usr/bin/env bash
echo "$@" >> "${podmanLog}"
if [ "$1" = "run" ]; then
  echo "${fakeCid}"
  exit 0
fi
if [ "$1" = "inspect" ]; then
  echo "${process.pid}"
  exit 0
fi
if [ "$1" = "wait" ]; then
  sleep 30
  exit 0
fi
exit 0
`,
			{ mode: 0o755 },
		);

		const sup = spawn(
			process.execPath,
			[
				SUPERVISOR_SCRIPT,
				cname,
				"--project",
				project,
				"--cwd",
				repoDir,
				"--sandbox",
				"podman",
				"--image",
				"localhost/pi-peer:111122223333",
			],
			{
				env: {
					...process.env,
					HOME: tmpHome,
					PI_COMS_DIR: comsDir,
					PATH: `${binDir}:${process.env.PATH}`,
					PI_COMS_STOP_TIMEOUT_MS: "2000",
				},
				stdio: "ignore",
			},
		);
		spawnedChildren.push(sup);

		const statePath = join(comsDir, "peers", `${cname}@${project}.json`);
		assert.equal(await waitFor(() => existsSync(statePath)), true);

		const exitCode = await new Promise<number | null>((resolve) => {
			sup.on("exit", (code: number | null) => resolve(code));
			sup.kill("SIGTERM");
		});
		assert.equal(exitCode, 0);

		const calls = readFileSync(podmanLog, "utf-8");
		assert.match(calls, new RegExp(`stop -t \\d+ -- ${fakeCid}`));
		assert.match(calls, new RegExp(`rm -f -- ${fakeCid}`));

		const state = JSON.parse(readFileSync(statePath, "utf-8"));
		assert.equal(state.shutdownMode, "signal");
		assert.equal(state.forced, undefined);
	});
});
