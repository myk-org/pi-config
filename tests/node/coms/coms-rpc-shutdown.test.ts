/**
 * Unit tests for #1488: authenticated graceful in-process supervised COMS RPC peer shutdown
 * using Pi 1.7.0 `ctx.shutdown()` before external `SIGTERM` / `SIGKILL` escalation.
 *
 * Run with: npx tsx --test --test-concurrency=4 tests/node/coms/coms-rpc-shutdown.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";

import {
	createComsPeerRuntime,
	isAuthorizedShutdownToken,
	isSupervisedRpcShutdownCtx,
	type ComsPeerRuntime,
} from "../../../extensions/coms/coms-p2p.js";
import { requestPeerShutdown } from "../../../extensions/coms/coms-shutdown-client.mjs";
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

function withPeerEnv<T>(
	overrides: Record<string, string | undefined>,
	fn: () => Promise<T>,
): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(overrides)) {
		saved[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	return fn().finally(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}

function makeWorkspace(prefix: string): { workspace: string; comsDir: string } {
	const workspace = createTmp(prefix);
	const comsDir = join(workspace, "c");
	mkdirSync(join(workspace, ".pi"), { recursive: true });
	writeFileSync(join(workspace, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: comsDir }));
	return { workspace, comsDir };
}

function initTempGitRepo(repoDir: string): void {
	execFileSync("git", ["init", "-q"], { cwd: repoDir });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
	writeFileSync(join(repoDir, "README.md"), "hi\n");
	execFileSync("git", ["add", "README.md"], { cwd: repoDir });
	execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
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
	const { workspace, comsDir } = makeWorkspace("rpc-");
	const handlers = new Map<string, Function[]>();
	const flags: Record<string, unknown> = { cname: opts.name, project: opts.project };
	let shutdownCalls = 0;

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

describe("isAuthorizedShutdownToken", () => {
	it("accepts matching shutdown capability token", () => {
		assert.equal(isAuthorizedShutdownToken("tok-abc-123", "tok-abc-123"), true);
	});

	it("rejects mismatched shutdown capability token", () => {
		assert.equal(isAuthorizedShutdownToken("tok-wrong", "tok-abc-123"), false);
	});

	it("rejects missing shutdown capability token", () => {
		assert.equal(isAuthorizedShutdownToken(undefined, "tok-abc-123"), false);
		assert.equal(isAuthorizedShutdownToken("tok-abc-123", undefined), false);
	});
});

describe("COMS RPC peer graceful shutdown protocol (#1488)", { concurrency: false }, () => {
	it("invokes ctx.shutdown after cleanup on idle supervised rpc peer", async () => {
		const token = "cap-token-idle-01";
		const instanceId = "inst-idle-01";
		await withPeerEnv(
			{ PI_COMS_SUPERVISED_PEER: "1", PI_COMS_SHUTDOWN_TOKEN: token, PI_COMS_INSTANCE_ID: instanceId },
			async () => {
				let registryPresentDuringShutdown = true;
				const peer = await bootRuntime({
					name: "idle-rpc",
					project: "p1",
					sessionId: "s-idle-1",
					mode: "rpc",
					isIdle: () => true,
					onShutdown: () => {
						registryPresentDuringShutdown = existsSync(peer.registryFile);
					},
				});

				const reg = JSON.parse(readFileSync(peer.registryFile, "utf-8"));
				assert.equal(reg.instance_id, instanceId, "registry entry records PI_COMS_INSTANCE_ID");

				const res = await requestPeerShutdown(peer.self.endpoint, {
					reason: "test_idle",
					shutdownToken: token,
					timeoutMs: 3_000,
				});
				assert.equal(res.ok, true, `expected graceful shutdown ack, got ${JSON.stringify(res)}`);
				if (res.ok) {
					assert.equal(res.busy, false);
					assert.equal(res.alreadyShuttingDown, false);
				}

				assert.equal(await waitFor(() => peer.getShutdownCalls() === 1, 3_000), true);
				assert.equal(registryPresentDuringShutdown, false, "registry entry must be removed before ctx.shutdown()");
				assert.equal(existsSync(peer.self.endpoint), false, "peer socket must be unlinked");
				assert.equal(peer.runtime.isActive(), false);
			},
		);
	});

	it("rejects shutdown envelope when capability token is missing", async () => {
		await withPeerEnv(
			{ PI_COMS_SUPERVISED_PEER: "1", PI_COMS_SHUTDOWN_TOKEN: "expected-secret-token" },
			async () => {
				const peer = await bootRuntime({
					name: "auth-miss",
					project: "p1",
					sessionId: "s-auth-1",
					mode: "rpc",
				});

				const res = await requestPeerShutdown(peer.self.endpoint, { timeoutMs: 3_000 });
				assert.equal(res.ok, false);
				if (!res.ok) {
					assert.equal(res.reason, "nack");
					assert.match(res.error ?? "", /unauthorized/i);
				}
				assert.equal(peer.getShutdownCalls(), 0);
				assert.equal(peer.runtime.isActive(), true);
			},
		);
	});

	it("rejects shutdown envelope when capability token mismatches", async () => {
		await withPeerEnv(
			{ PI_COMS_SUPERVISED_PEER: "1", PI_COMS_SHUTDOWN_TOKEN: "expected-secret-token" },
			async () => {
				const peer = await bootRuntime({
					name: "auth-bad",
					project: "p1",
					sessionId: "s-auth-2",
					mode: "rpc",
				});

				const res = await requestPeerShutdown(peer.self.endpoint, {
					shutdownToken: "wrong-peer-token",
					timeoutMs: 3_000,
				});
				assert.equal(res.ok, false);
				if (!res.ok) {
					assert.equal(res.reason, "nack");
					assert.match(res.error ?? "", /unauthorized/i);
				}
				assert.equal(peer.getShutdownCalls(), 0);
				assert.equal(peer.runtime.isActive(), true);
			},
		);
	});

	it("persists piSessionId into matching native supervisor record on graceful shutdown", async () => {
		const token = "cap-token-revive-01";
		await withPeerEnv(
			{ PI_COMS_SUPERVISED_PEER: "1", PI_COMS_SHUTDOWN_TOKEN: token },
			async () => {
				const peer = await bootRuntime({
					name: "revive-rpc",
					project: "p1",
					sessionId: "s-rev-1",
					piSessionId: "pi-session-abc-123",
					mode: "rpc",
				});

				const peersDir = join(peer.comsDir, "peers");
				mkdirSync(peersDir, { recursive: true });
				const statePath = join(peersDir, "revive-rpc@p1.json");
				writeFileSync(
					statePath,
					JSON.stringify({ cname: "revive-rpc", project: "p1", pid: 99991, childPid: process.pid }),
				);

				const res = await requestPeerShutdown(peer.self.endpoint, { shutdownToken: token, timeoutMs: 3_000 });
				assert.equal(res.ok, true, `expected graceful shutdown ack, got ${JSON.stringify(res)}`);
				assert.equal(await waitFor(() => peer.getShutdownCalls() === 1, 3_000), true);

				const saved = JSON.parse(readFileSync(statePath, "utf-8"));
				assert.equal(saved.piSessionId, "pi-session-abc-123");
			},
		);
	});

	it("rejects shutdown envelope on interactive tui peer", async () => {
		await withPeerEnv(
			{ PI_COMS_SUPERVISED_PEER: undefined, PI_COMS_SHUTDOWN_TOKEN: "tok-ignored" },
			async () => {
				const peer = await bootRuntime({
					name: "tui-peer",
					project: "p1",
					sessionId: "s-tui-1",
					mode: "tui",
				});

				const res = await requestPeerShutdown(peer.self.endpoint, {
					shutdownToken: "tok-ignored",
					timeoutMs: 3_000,
				});
				assert.equal(res.ok, false);
				if (!res.ok) assert.equal(res.reason, "nack");
				assert.equal(peer.getShutdownCalls(), 0);
				assert.equal(peer.runtime.isActive(), true);
			},
		);
	});

	it("reports busy flag in ack when peer turn is active", async () => {
		const token = "cap-token-busy-01";
		await withPeerEnv(
			{ PI_COMS_SUPERVISED_PEER: "1", PI_COMS_SHUTDOWN_TOKEN: token },
			async () => {
				const peer = await bootRuntime({
					name: "busy-rpc",
					project: "p1",
					sessionId: "s-busy-1",
					mode: "rpc",
					isIdle: () => false,
				});

				const res = await requestPeerShutdown(peer.self.endpoint, { shutdownToken: token, timeoutMs: 3_000 });
				assert.equal(res.ok, true, `expected busy graceful shutdown ack, got ${JSON.stringify(res)}`);
				if (res.ok) assert.equal(res.busy, true);
				assert.equal(await waitFor(() => peer.getShutdownCalls() === 1, 3_000), true);
			},
		);
	});

	it("acknowledges both concurrent socket shutdown requests while invoking ctx.shutdown once", async () => {
		const token = "cap-token-dup-01";
		await withPeerEnv(
			{ PI_COMS_SUPERVISED_PEER: "1", PI_COMS_SHUTDOWN_TOKEN: token },
			async () => {
				const peer = await bootRuntime({
					name: "dup-rpc",
					project: "p1",
					sessionId: "s-dup-1",
					mode: "rpc",
				});

				const [r1, r2] = await Promise.all([
					requestPeerShutdown(peer.self.endpoint, { msgId: "dup-1", shutdownToken: token, timeoutMs: 3_000 }),
					requestPeerShutdown(peer.self.endpoint, { msgId: "dup-2", shutdownToken: token, timeoutMs: 3_000 }),
				]);
				assert.equal(r1.ok, true, `first concurrent request must receive ack, got ${JSON.stringify(r1)}`);
				assert.equal(r2.ok, true, `second concurrent request must receive ack, got ${JSON.stringify(r2)}`);
				assert.equal(
					(r1.ok && r1.alreadyShuttingDown) || (r2.ok && r2.alreadyShuttingDown),
					true,
					"one concurrent caller must observe alreadyShuttingDown",
				);
				assert.equal(await waitFor(() => peer.getShutdownCalls() === 1, 3_000), true);
				await new Promise((resolve) => setTimeout(resolve, 100));
				assert.equal(peer.getShutdownCalls(), 1, "ctx.shutdown() must run strictly once");
			},
		);
	});
});

describe("requestPeerShutdown real socket client", () => {
	it("delivers shutdown token over a real unix socket", async () => {
		const dir = createTmp("rpc-cli-");
		const sockPath = join(dir, "p.sock");
		let received: any = null;
		const server = net.createServer((sock) => {
			let buf = "";
			sock.on("data", (chunk) => {
				buf += chunk.toString("utf-8");
				const nl = buf.indexOf("\n");
				if (nl < 0) return;
				received = JSON.parse(buf.slice(0, nl));
				sock.end(`${JSON.stringify({ type: "ack", msg_id: received.msg_id, busy: false })}\n`);
			});
		});
		await new Promise<void>((resolve) => server.listen(sockPath, resolve));
		try {
			const res = await requestPeerShutdown(sockPath, {
				msgId: "m-1",
				shutdownToken: "secret-wire-token",
				reason: "supervisor_SIGTERM",
				timeoutMs: 2_000,
			});
			assert.equal(res.ok, true);
			assert.equal(received?.type, "shutdown");
			assert.equal(received?.shutdown_token, "secret-wire-token");
			assert.equal(received?.reason, "supervisor_SIGTERM");
		} finally {
			server.close();
		}
	});

	it("returns nack result from a real unix socket", async () => {
		const dir = createTmp("rpc-nack-");
		const sockPath = join(dir, "p.sock");
		const server = net.createServer((sock) => {
			sock.once("data", () => {
				sock.end(`${JSON.stringify({ type: "nack", msg_id: "m-2", error: "unauthorized shutdown" })}\n`);
			});
		});
		await new Promise<void>((resolve) => server.listen(sockPath, resolve));
		try {
			const res = await requestPeerShutdown(sockPath, { msgId: "m-2", timeoutMs: 2_000 });
			assert.equal(res.ok, false);
			if (!res.ok) {
				assert.equal(res.reason, "nack");
				assert.equal(res.error, "unauthorized shutdown");
			}
		} finally {
			server.close();
		}
	});

	it("returns timeout when real unix socket stays silent", async () => {
		const dir = createTmp("rpc-to-");
		const sockPath = join(dir, "p.sock");
		const server = net.createServer(() => {
			// intentionally never replies
		});
		await new Promise<void>((resolve) => server.listen(sockPath, resolve));
		try {
			const res = await requestPeerShutdown(sockPath, { timeoutMs: 80 });
			assert.equal(res.ok, false);
			if (!res.ok) assert.equal(res.reason, "timeout");
		} finally {
			server.close();
		}
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
	tokenMismatchMarker: string;
	registryFile: string;
	socketPath: string;
}

function makeRpcStubHarness(opts: {
	exitOnShutdown: boolean;
	ignoreSigterm?: boolean;
	piSessionId?: string;
}): RpcStubHarness {
	const root = createTmp("sup-rpc-");
	const home = join(root, "h");
	const bin = join(root, "b");
	const coms = join(root, "c");
	const readyFile = join(root, "ready");
	const sigtermMarker = join(root, "saw-sigterm");
	const shutdownMarker = join(root, "saw-rpc-shutdown");
	const tokenMismatchMarker = join(root, "token-mismatch");
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
const tokenMismatchMarker = ${JSON.stringify(tokenMismatchMarker)};
const piSessionId = ${JSON.stringify(opts.piSessionId ?? "pi-sess-graceful-1")};
const expectedToken = process.env.PI_COMS_SHUTDOWN_TOKEN || "";
const instanceId = process.env.PI_COMS_INSTANCE_ID || "";

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
      if (!expectedToken || msg.shutdown_token !== expectedToken) {
        fs.writeFileSync(tokenMismatchMarker, "1");
        sock.end(JSON.stringify({ type: "nack", msg_id: msg.msg_id, error: "unauthorized shutdown" }) + "\\n");
        return;
      }
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
    instance_id: instanceId,
  }));
  fs.writeFileSync(readyFile, "1");
});
setInterval(() => {}, 1000);
`,
	);

	const piWrapper = join(bin, "pi");
	writeFileSync(piWrapper, `#!/bin/sh\nexec "${process.execPath}" "${stubScript}" "$@"\n`);
	chmodSync(piWrapper, 0o755);

	return {
		root,
		home,
		bin,
		coms,
		readyFile,
		sigtermMarker,
		shutdownMarker,
		tokenMismatchMarker,
		registryFile,
		socketPath,
	};
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
		assert.equal(existsSync(h.tokenMismatchMarker), false, "supervisor must send matching shutdown_token");
		assert.equal(existsSync(h.shutdownMarker), true, "supervisor must send graceful shutdown envelope");
		assert.equal(existsSync(h.sigtermMarker), false, "cooperative peer must exit cleanly before SIGTERM");
		assert.equal(existsSync(h.registryFile), false, "registry entry must be removed");

		const record = JSON.parse(readFileSync(recordPath, "utf-8"));
		assert.equal(record.exitCode, 0);
		assert.equal(record.exitSignal, null);
		assert.equal(record.shutdownMode, "rpc-graceful");
		assert.equal(record.forced, undefined);
		assert.equal(record.piSessionId, "pi-sess-clean-0");
		assert.equal("shutdownToken" in record, false, "shutdown token must never be persisted to disk");
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

	it("skips cleanup of replacement peer registry entry when native supervisor loses ownership", async () => {
		const h = makeRpcStubHarness({ exitOnShutdown: false, ignoreSigterm: false });
		const sup = spawnSupervisor(h, 600);
		const recordPath = join(h.coms, "peers", "peer1@proj.json");
		assert.equal(await waitFor(() => existsSync(recordPath) && existsSync(h.readyFile)), true);

		// Simulate a replacement supervisor claiming ownership + a replacement peer entry reusing the PID
		const originalRecord = JSON.parse(readFileSync(recordPath, "utf-8"));
		writeFileSync(
			recordPath,
			JSON.stringify({ cname: "peer1", project: "proj", pid: 999999, childPid: originalRecord.childPid }),
		);
		const originalReg = JSON.parse(readFileSync(h.registryFile, "utf-8"));
		writeFileSync(
			h.registryFile,
			JSON.stringify({ ...originalReg, instance_id: "replacement-instance-id" }),
		);

		const exitCode = await new Promise<number | null>((resolve) => {
			sup.on("exit", (code: number | null) => resolve(code));
			sup.kill("SIGTERM");
		});
		assert.equal(exitCode, 0);
		assert.equal(existsSync(h.registryFile), true, "replacement peer registry entry must survive old supervisor exit");
		assert.equal(existsSync(h.socketPath), true, "replacement peer socket must survive old supervisor exit");
	});

	it("uses graceful rpc shutdown for podman peer when container socket acks", async () => {
		const tmpHome = createTmp("pod-rpc-h-");
		const repoDir = createTmp("pod-rpc-r-");
		const binDir = createTmp("pod-rpc-b-");
		const comsDir = join(tmpHome, ".pi", "coms");
		const podmanLog = join(tmpHome, "podman-rpc.log");
		const waitRelease = join(tmpHome, "release-wait");
		const shutdownMarker = join(tmpHome, "podman-saw-shutdown");
		const envCapture = join(tmpHome, "podman-env.json");
		const cname = "ctr-rpc";
		const project = "demo";
		const containerName = buildPeerContainerName(project, cname);
		const fakeCid = "abcd1234".repeat(8);

		initTempGitRepo(repoDir);

		const agentsDir = join(comsDir, "projects", project, "agents");
		const socketsDir = join(comsDir, "sockets");
		mkdirSync(agentsDir, { recursive: true });
		mkdirSync(socketsDir, { recursive: true });
		const socketPath = join(socketsDir, "ctr-sid.sock");
		const registryFile = join(agentsDir, "ctr-sid.json");

		let expectedToken = "";
		const server = net.createServer((sock) => {
			let buf = "";
			sock.on("data", (chunk) => {
				buf += chunk.toString("utf-8");
				const nl = buf.indexOf("\n");
				if (nl < 0) return;
				const msg = JSON.parse(buf.slice(0, nl));
				if (msg.type === "shutdown") {
					if (!expectedToken || msg.shutdown_token !== expectedToken) {
						sock.end(`${JSON.stringify({ type: "nack", msg_id: msg.msg_id, error: "unauthorized shutdown" })}\n`);
						return;
					}
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
			const fakePodman = join(binDir, "podman");
			writeFileSync(
				fakePodman,
				`#!/usr/bin/env bash
echo "$@" >> "${podmanLog}"
if [ "$1" = "run" ]; then
  printf '{"instanceId":"%s","shutdownToken":"%s"}' "$PI_COMS_INSTANCE_ID" "$PI_COMS_SHUTDOWN_TOKEN" > "${envCapture}"
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
			assert.equal(await waitFor(() => existsSync(statePath) && existsSync(envCapture)), true);
			const captured = JSON.parse(readFileSync(envCapture, "utf-8"));
			assert.ok(captured.instanceId, "podman run must receive PI_COMS_INSTANCE_ID via env");
			assert.ok(captured.shutdownToken, "podman run must receive PI_COMS_SHUTDOWN_TOKEN via env");
			expectedToken = captured.shutdownToken;

			// Verify shutdown token was passed by env key only, never exposed in podman argv
			const runLine = readFileSync(podmanLog, "utf-8");
			assert.equal(runLine.includes(expectedToken), false, "shutdown token value must never appear in podman argv");

			writeFileSync(
				registryFile,
				JSON.stringify({
					coms_session_id: "ctr-sid",
					name: cname,
					pid: 1,
					container: containerName,
					endpoint: socketPath,
					pi_session_id: "pi-podman-sess-1",
					instance_id: captured.instanceId,
				}),
			);

			const exitCode = await new Promise<number | null>((resolve) => {
				sup.on("exit", (code: number | null) => resolve(code));
				sup.kill("SIGTERM");
			});
			assert.equal(exitCode, 0);
			assert.equal(existsSync(shutdownMarker), true, "podman supervisor must send authenticated shutdown envelope");

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

	it("ignores replacement podman peer entry with different instance_id during stop", async () => {
		const tmpHome = createTmp("pod-iso-h-");
		const repoDir = createTmp("pod-iso-r-");
		const binDir = createTmp("pod-iso-b-");
		const comsDir = join(tmpHome, ".pi", "coms");
		const podmanLog = join(tmpHome, "podman-iso.log");
		const replacementHit = join(tmpHome, "replacement-hit");
		const cname = "ctr-iso";
		const project = "demo";
		const containerName = buildPeerContainerName(project, cname);
		const fakeCid = "1234abcd".repeat(8);

		initTempGitRepo(repoDir);

		const agentsDir = join(comsDir, "projects", project, "agents");
		const socketsDir = join(comsDir, "sockets");
		mkdirSync(agentsDir, { recursive: true });
		mkdirSync(socketsDir, { recursive: true });
		const socketPath = join(socketsDir, "repl-sid.sock");
		const registryFile = join(agentsDir, "repl-sid.json");

		const server = net.createServer((sock) => {
			sock.once("data", () => {
				writeFileSync(replacementHit, "1");
				sock.end(`${JSON.stringify({ type: "nack", msg_id: "x", error: "wrong target" })}\n`);
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));

		try {
			// A replacement peer sharing the deterministic containerName but with a DIFFERENT instance_id
			writeFileSync(
				registryFile,
				JSON.stringify({
					coms_session_id: "repl-sid",
					name: cname,
					pid: 1,
					container: containerName,
					endpoint: socketPath,
					instance_id: "brand-new-replacement-instance",
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
			assert.equal(existsSync(replacementHit), false, "old supervisor must never connect to replacement peer socket");
			assert.equal(existsSync(registryFile), true, "old supervisor must never unlink replacement peer registry");
		} finally {
			server.close();
		}
	});

	it("keeps podman stop fallback intact when container socket is absent", async () => {
		const tmpHome = createTmp("pod-fb-h-");
		const repoDir = createTmp("pod-fb-r-");
		const binDir = createTmp("pod-fb-b-");
		const comsDir = join(tmpHome, ".pi", "coms");
		const podmanLog = join(tmpHome, "podman-fb.log");
		const cname = "ctr-fb";
		const project = "demo";
		const fakeCid = "beef5678".repeat(8);

		initTempGitRepo(repoDir);

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

describe("real Pi 1.7.0 supervised RPC peer shutdown E2E (#1488)", { skip: process.env.PI_RPC_SHUTDOWN_E2E !== "1" }, () => {
	it("exits with code 0 running session_shutdown hooks on real Pi 1.7.0", async () => {
		const root = createTmp("pi170-e2e-");
		const workDir = join(root, "w");
		const agentDir = join(root, "a");
		const comsDir = join(root, "c");
		const extDir = join(agentDir, "extensions");
		const probeFile = join(root, "session-shutdown.json");
		mkdirSync(join(workDir, ".pi"), { recursive: true });
		mkdirSync(extDir, { recursive: true });
		mkdirSync(comsDir, { recursive: true });

		writeFileSync(join(workDir, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: comsDir }, null, 2));
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ enableInstallTelemetry: false, packages: [process.cwd()] }, null, 2),
		);
		writeFileSync(
			join(extDir, "shutdown-probe.ts"),
			`import fs from "node:fs";
export default function (pi: any) {
  pi.on("session_shutdown", (evt: any) => {
    fs.writeFileSync(${JSON.stringify(probeFile)}, JSON.stringify({ fired: true, reason: evt?.reason ?? null }));
  });
}
`,
		);

		const sup = spawn(
			process.execPath,
			[SUPERVISOR_SCRIPT, "real-pi-1488", "--project", "e2e1488", "--cwd", workDir, "--agent-dir", agentDir],
			{
				env: { ...process.env, PI_COMS_DIR: comsDir, PI_LOG_COMS: "debug" },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		spawnedChildren.push(sup);

		const agentsDir = join(comsDir, "projects", "e2e1488", "agents");
		const statePath = join(comsDir, "peers", "real-pi-1488@e2e1488.json");
		let regEntry: { file: string; entry: any } | null = null;
		const registered = await waitFor(() => {
			if (!existsSync(agentsDir)) return false;
			for (const file of readdirSync(agentsDir)) {
				if (!file.endsWith(".json")) continue;
				try {
					const parsed = JSON.parse(readFileSync(join(agentsDir, file), "utf-8"));
					if (parsed?.name === "real-pi-1488") {
						regEntry = { file: join(agentsDir, file), entry: parsed };
						return true;
					}
				} catch {
					/* transient write */
				}
			}
			return false;
		}, 30_000);
		assert.equal(registered, true, "real Pi 1.7.0 peer must register");
		assert.ok(regEntry);
		const entry = (regEntry as { file: string; entry: any }).entry;
		const regFile = (regEntry as { file: string; entry: any }).file;
		assert.ok(entry.instance_id, "registry entry must carry PI_COMS_INSTANCE_ID");

		const unauth = await requestPeerShutdown(entry.endpoint, { reason: "spoof", timeoutMs: 3_000 });
		assert.equal(unauth.ok, false);
		if (!unauth.ok) assert.equal(unauth.reason, "nack");

		const supExitCode = await new Promise<number | null>((resolve) => {
			sup.on("exit", (code: number | null) => resolve(code));
			sup.kill("SIGTERM");
		});
		assert.equal(supExitCode, 0);

		const finalState = JSON.parse(readFileSync(statePath, "utf-8"));
		assert.equal(finalState.exitCode, 0);
		assert.equal(finalState.exitSignal, null);
		assert.equal(finalState.shutdownMode, "rpc-graceful");
		assert.equal(finalState.forced, undefined);
		assert.ok(finalState.piSessionId, "piSessionId must be preserved for /coms revive");
		assert.equal(existsSync(regFile), false, "registry entry must be removed");
		assert.equal(existsSync(entry.endpoint), false, "peer socket must be unlinked");
		assert.equal(existsSync(probeFile), true, "session_shutdown hook must fire");
		assert.equal(JSON.parse(readFileSync(probeFile, "utf-8")).fired, true);
	});
});
