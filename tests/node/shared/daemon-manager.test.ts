/**
 * Tests for shared daemon-manager primitives and the deep `createDaemonClient` lifecycle.
 * Run with: npx tsx --test tests/node/shared/daemon-manager.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createDaemonClient,
  findJitiPath,
  findJitiUnder,
  getGitBranch,
  parseHealth,
  registerDaemonCommand,
  spawnDaemon,
  waitForDaemon,
  type DaemonClient,
  type DaemonClientAdapter,
} from "../../../extensions/shared/daemon-manager.js";
import { createLogger } from "../../../extensions/shared/logger.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const testLog = createLogger("daemon-manager-test");

class FakeWebSocket extends EventEmitter {
  readyState = 0; // CONNECTING
  sent: string[] = [];
  pings = 0;
  pongs = 0;
  closed = false;
  terminated = false;
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  send(data: string): void {
    this.sent.push(data);
  }

  ping(): void {
    this.pings++;
  }

  pong(): void {
    this.pongs++;
  }

  close(code = 1000, reason = ""): void {
    this.closed = true;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit("close", 1006, Buffer.from("terminated"));
  }
}

function createFakePi() {
  const listeners = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
  const commands = new Map<string, any>();
  const pi = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => void) => {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
    },
    registerCommand: (name: string, opts: any) => {
      commands.set(name, opts);
    },
  } as unknown as ExtensionAPI;

  const emit = (name: string, event: unknown, ctx?: unknown) => {
    for (const fn of listeners.get(name) ?? []) fn(event, ctx);
  };

  return { pi, commands, emit };
}

function createFakeCtx(overrides: Record<string, unknown> = {}) {
  const notifications: Array<{ msg: string; level?: string }> = [];
  const statuses: Array<{ key: string; value: unknown }> = [];
  const ctx = {
    mode: "tui",
    cwd: "/tmp/test-project",
    hasUI: true,
    ui: {
      notify: (msg: string, level?: string) => notifications.push({ msg, level }),
      setStatus: (key: string, value: unknown) => statuses.push({ key, value }),
    },
    ...overrides,
  };
  return { ctx, notifications, statuses };
}

describe("waitForDaemon (#1269)", () => {
  it("polls at 200ms initially for faster warm attach", async () => {
    let checks = 0;
    const start = Date.now();
    const ok = await waitForDaemon(19999, 2, () => {}, async () => {
      checks++;
      return checks >= 2;
    });
    const elapsed = Date.now() - start;
    assert.equal(ok, true);
    assert.equal(checks, 2);
    assert.ok(elapsed < 900, `expected fast poll <900ms, got ${elapsed}ms`);
  });

  it("returns false immediately when budget is zero", async () => {
    let checks = 0;
    const ok = await waitForDaemon(19999, 0, () => {}, async () => {
      checks++;
      return true;
    });
    assert.equal(ok, false);
    assert.equal(checks, 0);
  });
});

describe("findJitiUnder", () => {
  it("walks up from a nested dir to jiti-cli.mjs", () => {
    const root = makeTempDir("jiti-walk-");
    try {
      const cli = join(root, "node_modules", "jiti", "lib", "jiti-cli.mjs");
      mkdirSync(join(root, "node_modules", "jiti", "lib"), { recursive: true });
      writeFileSync(cli, "// stub\n");
      const nested = join(root, "dist", "bundle");
      mkdirSync(nested, { recursive: true });
      assert.strictEqual(findJitiUnder(nested), cli);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns undefined when jiti is absent", () => {
    const root = makeTempDir("jiti-miss-");
    try {
      assert.strictEqual(findJitiUnder(root), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("findJitiPath uses argv1 walk, not execPath-adjacent global", () => {
    const root = makeTempDir("jiti-argv-");
    try {
      const cli = join(root, "node_modules", "jiti", "lib", "jiti-cli.mjs");
      mkdirSync(join(root, "node_modules", "jiti", "lib"), { recursive: true });
      writeFileSync(cli, "// stub\n");
      const argv1 = join(root, "dist", "bundle", "cli.js");
      mkdirSync(join(root, "dist", "bundle"), { recursive: true });
      writeFileSync(argv1, "// fake pi\n");
      assert.strictEqual(findJitiPath({ argv1, moduleDir: join(root, "nowhere") }), cli);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("spawnDaemon", () => {
  it("refuses to spawn when jiti cannot be resolved", () => {
    const logs: string[] = [];
    spawnDaemon({
      serverScript: "pidash-server.ts",
      logFile: join(tmpdir(), "pidash-spawn-test.log"),
      log: (msg) => logs.push(msg),
      resolveJiti: () => undefined,
    });
    assert.ok(logs.some((m) => m.includes("jiti-cli.mjs not found")));
    assert.ok(!logs.some((m) => m.startsWith("spawning daemon:")));
  });
});

describe("parseHealth", () => {
  it("treats a degraded daemon as running", () => {
    const health = parseHealth(JSON.stringify({ status: "degraded", startupError: "discord setup failed", port: 19190 }));
    assert.equal(health.running, true);
    assert.equal(health.degraded, true);
    assert.match(String(health.startupError), /discord setup failed/);
  });

  it("accepts a healthy daemon", () => {
    assert.deepEqual(parseHealth(JSON.stringify({ status: "ok", port: 19190 })), { running: true, degraded: false, startupError: null });
  });

  it("rejects anything that is not a health response", () => {
    assert.equal(parseHealth("not json").running, false);
    assert.equal(parseHealth(JSON.stringify({ status: "stopped" })).running, false);
    assert.equal(parseHealth(JSON.stringify({})).running, false);
  });
});

describe("getGitBranch (#1172)", () => {
  it("returns the branch name in a git repo", () => {
    const repo = makeTempDir("dm-branch-");
    try {
      execFileSync("git", ["init", "-b", "feat/test-branch"], { cwd: repo, stdio: "ignore" });
      assert.equal(getGitBranch(repo), "feat/test-branch");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns empty string outside a git repo", () => {
    const nonRepo = makeTempDir("dm-nobranch-");
    try {
      assert.equal(getGitBranch(nonRepo), "");
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

describe("registerDaemonCommand (#1172)", () => {
  it("registers completions for a disabled command", () => {
    const { pi, commands } = createFakePi();
    registerDaemonCommand(pi, "pidash", false, "pidash_enable");
    const cmd = commands.get("pidash");
    assert.equal(cmd.description, "Manage pidash server — /pidash start|stop|restart|status");
    assert.deepEqual(
      cmd.getArgumentCompletions("st").map((c: any) => c.value),
      ["start", "stop", "status"],
    );
  });

  it("notifies when invoking a disabled daemon command", async () => {
    const { pi, commands } = createFakePi();
    const { ctx, notifications } = createFakeCtx();

    registerDaemonCommand(pi, "pidash", false, "pidash_enable");
    await commands.get("pidash").handler("", ctx);
    assert.deepEqual(
      notifications.map((n) => n.msg),
      ["pidash is disabled (pidash_enable=false in pi-config-settings.json or PI_PIDASH_ENABLE=false)."],
    );
  });

  it("delegates to the provided handler when enabled", async () => {
    const { pi, commands } = createFakePi();
    const calls: string[] = [];

    registerDaemonCommand(pi, "pidiff", true, "pidiff_enable", (args) => { calls.push(args); });
    await commands.get("pidiff").handler("status", {});
    assert.deepEqual(calls, ["status"]);
  });
});

describe("createDaemonClient lifecycle (#1358)", () => {
  const clients: DaemonClient[] = [];

  afterEach(() => {
    for (const c of clients.splice(0)) c.shutdown();
  });

  function makeClient<T = void>(
    overrides: Partial<DaemonClientAdapter<T>> = {},
  ) {
    const fakePi = createFakePi();
    const sockets: FakeWebSocket[] = [];
    const opened: Array<{ port: number; ctx: any; data: T | undefined }> = [];
    const messages: string[] = [];
    let disconnects = 0;
    let stops = 0;
    const spawns: Array<{ mode: string; preferredPort: number | null | undefined }> = [];
    const resolvedPorts: number[] = [];

    const client = createDaemonClient<T>(fakePi.pi, {
      name: "testd",
      settingKey: "testd_enable",
      statusKey: "9-testd",
      log: testLog,
      port: 19500,
      onOpen: (_ws, ctx, port, data) => { opened.push({ port, ctx, data }); },
      onMessage: (data) => { messages.push(data.toString()); },
      onDisconnect: () => { disconnects++; },
      stopDaemon: () => { stops++; },
      spawn: (_ctx, { mode, preferredPort }) => {
        spawns.push({ mode, preferredPort });
        return preferredPort ?? 19501;
      },
      onPortResolved: (port) => { resolvedPorts.push(port); },
      getStartupTimeoutSeconds: () => 5,
      reconnectDelayMs: 30,
      heartbeatDeadReconnectDelayMs: 15,
      reconnectPollIntervalMs: 1000,
      heartbeatIntervalMs: 1000,
      restartWaitMs: 0,
      sleep: async () => {},
      probeHealth: async () => true,
      waitReady: async () => true,
      createWebSocket: (url) => {
        const ws = new FakeWebSocket(url);
        sockets.push(ws);
        return ws;
      },
      ...overrides,
    });
    clients.push(client);
    return {
      client,
      ...fakePi,
      sockets,
      opened,
      messages,
      getDisconnects: () => disconnects,
      getStops: () => stops,
      spawns,
      resolvedPorts,
    };
  }

  it("connects via WebSocket with beforeOpen data when daemon is already healthy", async () => {
    const h = makeClient<{ tag: string }>({
      beforeOpen: async () => ({ data: { tag: "ready" } }),
    });
    const { ctx } = createFakeCtx();

    await h.client.connect(ctx);
    assert.equal(h.spawns.length, 0, "must not spawn when health probe is already ok");
    assert.equal(h.client.connecting, true);
    assert.equal(h.client.connected, false);
    assert.equal(h.sockets.length, 1);
    assert.equal(h.sockets[0].url, "ws://127.0.0.1:19500/ws/pi");

    h.sockets[0].open();
    assert.equal(h.client.connected, true);
    assert.equal(h.client.connecting, false);
    assert.deepEqual(h.opened.map(({ port, data }) => ({ port, data })), [{ port: 19500, data: { tag: "ready" } }]);
  });

  it("owns health-probe, spawn, waitReady lifecycle during connect", async () => {
    let sawSpawningTrue = false;
    const h = makeClient({
      probeHealth: async () => false,
      waitReady: async () => {
        sawSpawningTrue = h.client.spawning;
        return true;
      },
    });
    const { ctx } = createFakeCtx();

    await h.client.connect(ctx);
    assert.equal(sawSpawningTrue, true);
    assert.equal(h.client.spawning, false);
    assert.deepEqual(h.spawns, [{ mode: "connect", preferredPort: undefined }]);
    assert.deepEqual(h.resolvedPorts, [19501]);
    assert.equal(h.sockets.length, 1);
    assert.equal(h.sockets[0].url, "ws://127.0.0.1:19501/ws/pi");
  });

  it("releases cross-process spawn lock after spawn finishes", async () => {
    let released = 0;
    const h = makeClient({
      probeHealth: async () => false,
      acquireSpawnLock: async () => ({ acquired: true, release: () => { released++; } }),
    });
    const { ctx } = createFakeCtx();

    await h.client.connect(ctx);
    assert.equal(released, 1);
    assert.equal(h.sockets.length, 1);
  });

  it("connects directly to port resolved by contended spawn lock without spawning", async () => {
    const h = makeClient({
      probeHealth: async () => false,
      acquireSpawnLock: async () => ({ acquired: false, port: 19520 }),
    });
    const { ctx } = createFakeCtx();

    await h.client.connect(ctx);
    assert.equal(h.spawns.length, 0);
    assert.deepEqual(h.resolvedPorts, [19520]);
    assert.equal(h.sockets.length, 1);
    assert.equal(h.sockets[0].url, "ws://127.0.0.1:19520/ws/pi");
  });

  it("retries connect when contended spawn lock returns retryAfterMs", async () => {
    let lockCalls = 0;
    const h = makeClient({
      probeHealth: async () => false,
      acquireSpawnLock: async () => {
        lockCalls++;
        return lockCalls === 1
          ? { acquired: false, port: null, retryAfterMs: 15 }
          : { acquired: false, port: 19522 };
      },
    });
    const { ctx } = createFakeCtx();

    await h.client.connect(ctx);
    assert.equal(h.sockets.length, 0);
    await new Promise((r) => setTimeout(r, 45));
    assert.equal(h.sockets.length, 1);
    assert.equal(h.sockets[0].url, "ws://127.0.0.1:19522/ws/pi");
  });

  it("still schedules retryAfterMs when the same ctx re-calls connect during contended spawn lock", async () => {
    let lockCalls = 0;
    let releaseFirstLock!: () => void;
    const firstLockGate = new Promise<void>((r) => { releaseFirstLock = r; });

    const h = makeClient({
      probeHealth: async () => false,
      reconnectPollIntervalMs: 60_000,
      acquireSpawnLock: async () => {
        lockCalls++;
        if (lockCalls === 1) {
          await firstLockGate;
          return { acquired: false, port: null, retryAfterMs: 15 };
        }
        return { acquired: false, port: 19523 };
      },
    });
    const { ctx } = createFakeCtx();

    const first = h.client.connect(ctx);
    // Same ctx triggers connect again while first lock check is pending
    await h.client.connect(ctx);
    releaseFirstLock();
    await first;

    await new Promise((r) => setTimeout(r, 45));
    assert.equal(h.sockets.length, 1);
    assert.equal(h.sockets[0].url, "ws://127.0.0.1:19523/ws/pi");
  });

  it("still schedules retryAfterMs when a queued newer ctx goes stale before contended lock resolves", async () => {
    let lockCalls = 0;
    let staleQueued = false;
    let releaseFirstLock!: () => void;
    const firstLockGate = new Promise<void>((r) => { releaseFirstLock = r; });

    const { ctx } = createFakeCtx();
    const queuedCtx = {
      get mode(): string {
        if (staleQueued) throw new Error("stale");
        return "tui";
      },
      cwd: "/tmp/transient-project",
    };

    const h = makeClient({
      probeHealth: async () => false,
      reconnectPollIntervalMs: 60_000,
      acquireSpawnLock: async () => {
        lockCalls++;
        if (lockCalls === 1) {
          await firstLockGate;
          return { acquired: false, port: null, retryAfterMs: 15 };
        }
        return { acquired: false, port: 19524 };
      },
    });

    const first = h.client.connect(ctx);
    await h.client.connect(queuedCtx);
    staleQueued = true;
    releaseFirstLock();
    await first;

    await new Promise((r) => setTimeout(r, 45));
    assert.equal(h.sockets.length, 1);
    assert.equal(h.sockets[0].url, "ws://127.0.0.1:19524/ws/pi");
  });

  it("immediately retries a newer live ctx when the earlier ctx goes stale mid-connect", async () => {
    let staleOld = false;
    let releaseFirstProbe!: () => void;
    const firstProbeGate = new Promise<void>((r) => { releaseFirstProbe = r; });
    let probeCalls = 0;

    const oldCtx = {
      get mode(): string {
        if (staleOld) throw new Error("stale");
        return "tui";
      },
      cwd: "/tmp/old-project",
    };
    const { ctx: newCtx } = createFakeCtx({ cwd: "/tmp/new-project" });

    const h = makeClient({
      reconnectPollIntervalMs: 60_000, // prove retry does not wait for the 15s poller
      findRunningPort: async () => {
        probeCalls++;
        if (probeCalls === 1) await firstProbeGate;
        return 19530;
      },
    });

    const firstConnect = h.client.connect(oldCtx);
    // Session switches while first connect is awaiting daemon startup
    staleOld = true;
    await h.client.connect(newCtx);
    releaseFirstProbe();
    await firstConnect;

    // Wait a tick for the queued retry to reach createWebSocket
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.sockets.length, 1, "newer ctx must connect immediately without waiting for poller");
    h.sockets[0].open();
    assert.equal(h.opened.length, 1);
    assert.equal(h.opened[0].ctx, newCtx);
  });

  it("forwards outbound send payloads while connected", async () => {
    const h = makeClient();
    const { ctx } = createFakeCtx();

    assert.equal(h.client.send({ type: "dropped" }), false);
    await h.client.connect(ctx);
    h.sockets[0].open();

    assert.equal(h.client.send({ type: "ping-test" }), true);
    assert.deepEqual(h.sockets[0].sent, [JSON.stringify({ type: "ping-test" })]);
  });

  it("delivers inbound WebSocket frames to adapter onMessage", async () => {
    const h = makeClient();
    const { ctx } = createFakeCtx();

    await h.client.connect(ctx);
    h.sockets[0].open();
    h.sockets[0].emit("message", Buffer.from("hello"));
    assert.deepEqual(h.messages, ["hello"]);
  });

  it("aborts connection cleanly when beforeOpen signals abort", async () => {
    const h = makeClient({
      beforeOpen: async () => ({ abort: true }),
    });
    const { ctx } = createFakeCtx();

    await h.client.connect(ctx);
    assert.equal(h.client.connecting, false);
    assert.equal(h.client.connected, false);
    assert.equal(h.sockets.length, 0);
  });

  it("skips connect when ctx is stale", async () => {
    const h = makeClient();
    const staleCtx = { get mode(): string { throw new Error("stale"); } };

    await h.client.connect(staleCtx);
    assert.equal(h.sockets.length, 0);
    assert.equal(h.client.connecting, false);
  });

  it("terminates dead socket on missed heartbeat pong to force reconnect", async () => {
    const h = makeClient({
      heartbeatIntervalMs: 15,
      heartbeatDeadReconnectDelayMs: 15,
    });
    const { ctx } = createFakeCtx();

    await h.client.connect(ctx);
    const first = h.sockets[0];
    first.open();
    first.emit("ping");
    assert.equal(first.pongs, 1);

    await new Promise((r) => setTimeout(r, 75));
    assert.equal(first.terminated, true);
    assert.equal(h.getDisconnects(), 1);
    assert.ok(h.sockets.length >= 2, "expected reconnect socket after heartbeat death");
  });

  it("reconnects after unexpected socket close", async () => {
    const h = makeClient({ reconnectDelayMs: 20 });
    const { ctx } = createFakeCtx();

    await h.client.connect(ctx);
    h.sockets[0].open();
    h.sockets[0].close(1006, "drop");

    assert.equal(h.client.connected, false);
    assert.equal(h.getDisconnects(), 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.sockets.length, 2);
  });

  it("reconnects on tool_result when disconnected in tui mode", async () => {
    const h = makeClient();
    const { ctx } = createFakeCtx();

    h.emit("tool_result", {}, ctx);
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(h.sockets.length, 1);
  });

  it("clears stale lastCtx on periodic reconnect poll", async () => {
    const h = makeClient({ reconnectPollIntervalMs: 15 });
    const staleCtx = { get mode(): string { throw new Error("stale"); } };
    h.client.setLastCtx(staleCtx);

    await new Promise((r) => setTimeout(r, 45));
    assert.equal(h.client.lastCtx, null);
    assert.equal(h.sockets.length, 0);
  });

  it("invokes onBeforeShutdown before closing socket on session_shutdown", async () => {
    let sawConnectedDuringBeforeShutdown = false;
    const h = makeClient({
      reconnectDelayMs: 15,
      onBeforeShutdown: (_ev, ws, isConnected) => {
        sawConnectedDuringBeforeShutdown = Boolean(ws && isConnected);
        ws?.send(JSON.stringify({ type: "bye" }));
      },
    });
    const { ctx } = createFakeCtx();

    await h.client.connect(ctx);
    h.sockets[0].open();
    h.emit("session_shutdown", { reason: "exit" }, ctx);

    assert.equal(sawConnectedDuringBeforeShutdown, true);
    assert.equal(h.client.shuttingDown, true);
    assert.equal(h.client.connected, false);
    assert.equal(h.sockets[0].closed, true);
    assert.ok(h.sockets[0].sent.includes(JSON.stringify({ type: "bye" })));

    await new Promise((r) => setTimeout(r, 40));
    h.emit("tool_result", {}, ctx);
    assert.equal(h.sockets.length, 1, "must not reconnect after shutdown");
  });

  it("handles /<name> stop without triggering a delayed reconnect", async () => {
    const h = makeClient({ reconnectDelayMs: 15 });
    const { ctx, notifications, statuses } = createFakeCtx();

    await h.client.connect(ctx);
    h.sockets[0].open();
    await h.commands.get("testd").handler("stop", ctx);

    assert.equal(h.client.connected, false);
    assert.equal(h.getStops(), 1);
    assert.deepEqual(statuses, [{ key: "9-testd", value: undefined }]);
    assert.deepEqual(notifications.map((n) => n.msg), ["testd server stopped"]);

    await new Promise((r) => setTimeout(r, 40));
    assert.equal(h.sockets.length, 1, "intentional stop must not trigger close reconnect timer");
  });

  it("handles /<name> start when daemon is already running", async () => {
    const h = makeClient({
      findRunningPort: async () => 19510,
    });
    const { ctx, notifications } = createFakeCtx();

    await h.commands.get("testd").handler("start", ctx);
    assert.equal(h.spawns.length, 0);
    assert.deepEqual(h.resolvedPorts, [19510]);
    assert.deepEqual(notifications.map((n) => n.msg), ["testd already running at http://localhost:19510"]);
  });

  it("handles /<name> start when spawning succeeds", async () => {
    const h = makeClient({
      probeHealth: async () => false,
    });
    const { ctx, notifications } = createFakeCtx();

    await h.commands.get("testd").handler("start", ctx);
    assert.deepEqual(h.spawns, [{ mode: "start", preferredPort: null }]);
    assert.deepEqual(h.resolvedPorts, [19501]);
    assert.deepEqual(notifications.map((n) => n.msg), [
      "Starting testd server...",
      "testd started at http://localhost:19501",
    ]);
  });

  it("notifies warning with startFailureHint when /<name> start fails", async () => {
    const h = makeClient({
      probeHealth: async () => false,
      waitReady: async () => false,
      startFailureHint: " — check logs",
    });
    const { ctx, notifications } = createFakeCtx();

    await h.commands.get("testd").handler("start", ctx);
    assert.deepEqual(notifications, [
      { msg: "Starting testd server...", level: "info" },
      { msg: "testd failed to start — check logs", level: "warning" },
    ]);
  });

  it("handles /<name> restart passing prepareRestart port to spawn", async () => {
    const h = makeClient({
      prepareRestart: () => 19555,
    });
    const { ctx, notifications } = createFakeCtx();

    await h.commands.get("testd").handler("restart", ctx);
    assert.equal(h.getStops(), 1);
    assert.deepEqual(h.spawns, [{ mode: "restart", preferredPort: 19555 }]);
    assert.deepEqual(h.resolvedPorts, [19555]);
    assert.deepEqual(notifications.map((n) => n.msg), [
      "Restarting testd server...",
      "testd restarted at http://localhost:19555",
    ]);
  });

  it("handles /<name> status showing server health", async () => {
    const h = makeClient({
      port: 19500,
      probeHealth: async () => true,
    });
    const { ctx, notifications } = createFakeCtx();

    await h.commands.get("testd").handler("status", ctx);
    assert.equal(
      notifications[0].msg,
      "Server: running\nPort: 19500\nExtension: disconnected\nURL: http://localhost:19500",
    );
  });

  it("shows usage for unknown subcommand when strictCommandUsage is enabled", async () => {
    const h = makeClient({ strictCommandUsage: true });
    const { ctx, notifications } = createFakeCtx();

    await h.commands.get("testd").handler("bogus", ctx);
    assert.deepEqual(notifications.map((n) => n.msg), ["Usage: /testd start|stop|restart|status"]);
  });

  it("aborts command when beforeCommand returns false", async () => {
    const h = makeClient({ beforeCommand: () => false });
    const { ctx, notifications } = createFakeCtx();

    await h.commands.get("testd").handler("stop", ctx);
    assert.equal(h.getStops(), 0);
    assert.deepEqual(notifications, []);
  });
});
