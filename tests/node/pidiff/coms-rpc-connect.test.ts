/**
 * Supervised COMS RPC peer attach-only pidiff connection and shared-repo lockfile resolution (#1501).
 * Run with: npx tsx --test tests/node/pidiff/coms-rpc-connect.test.ts
 */
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isPidiffConnectableCtx, registerPidiff } from "../../../extensions/pidiff/pidiff.ts";
import { setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.ts";
import { createRepoCheckoutMatcher, isSameGitRepoCheckout } from "../../../scripts/pidiff-git-diff.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";

function createHarness() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void> | void>();
  const events = new EventEmitter();
  const pi = {
    events,
    on: (name: string, handler: (event: unknown, ctx: unknown) => void) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> | void }) => {
      commands.set(name, opts.handler);
    },
  } as unknown as ExtensionAPI;
  const emitPi = (name: string, event: unknown, ctx: unknown) => {
    for (const h of handlers.get(name) ?? []) h(event, ctx);
  };
  return { pi, events, emitPi, commands };
}

function makeCtx(mode: string, cwd: string, overrides: Record<string, unknown> = {}) {
  return {
    mode,
    hasUI: mode === "tui",
    cwd,
    model: null,
    sessionManager: { getEntries: () => [], getSessionFile: () => "" },
    ...overrides,
  };
}

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

async function listenHttp(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("expected tcp address");
  return addr.port;
}

async function closeServer(server: Server, sockets: WebSocketServer): Promise<void> {
  for (const client of sockets.clients) {
    try { client.terminate(); } catch {}
  }
  await new Promise<void>((resolve) => sockets.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function initGitRepo(dir: string, branch = "main"): void {
  execFileSync("git", ["init", "-b", branch], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

describe("isPidiffConnectableCtx (#1501)", () => {
  it("accepts interactive tui context", () => {
    assert.equal(isPidiffConnectableCtx(makeCtx("tui", "/repo"), {}), true);
  });

  it("accepts supervised rpc peer context", () => {
    assert.equal(
      isPidiffConnectableCtx(makeCtx("rpc", "/repo"), { PI_COMS_SUPERVISED_PEER: "1" }),
      true,
    );
  });

  it("rejects unsupervised rpc context", () => {
    assert.equal(isPidiffConnectableCtx(makeCtx("rpc", "/repo"), {}), false);
  });

  it("rejects subagent child context", () => {
    assert.equal(
      isPidiffConnectableCtx(makeCtx("rpc", "/repo"), {
        PI_SUBAGENT_CHILD: "1",
        PI_COMS_SUPERVISED_PEER: "1",
      }),
      false,
    );
  });

  it("rejects print mode context", () => {
    assert.equal(
      isPidiffConnectableCtx(makeCtx("print", "/repo"), { PI_COMS_SUPERVISED_PEER: "1" }),
      false,
    );
  });

  it("rejects json mode context", () => {
    assert.equal(
      isPidiffConnectableCtx(makeCtx("json", "/repo"), { PI_COMS_SUPERVISED_PEER: "1" }),
      false,
    );
  });

  it("rejects stale context", () => {
    const staleCtx = {
      get mode() {
        throw new Error("Context is no longer active");
      },
    };
    assert.equal(isPidiffConnectableCtx(null, { PI_COMS_SUPERVISED_PEER: "1" }), false);
    assert.equal(isPidiffConnectableCtx(staleCtx, { PI_COMS_SUPERVISED_PEER: "1" }), false);
  });
});

describe("registerPidiff supervised COMS RPC attach-only lifecycle (#1501)", () => {
  it("attaches supervised rpc peer to running pidiff server", async () => {
    const dir = makeTempDir("pidiff-rpc-attach-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, emitPi } = createHarness();
    const ctx = makeCtx("rpc", dir);

    try {
      initGitRepo(dir, "feat/peer-branch");
      const port = await listenHttp(server);
      mkdirSync(join(dir, ".pi", "run"), { recursive: true });
      writeFileSync(join(dir, ".pi", "run", "pidiff.port"), String(port));
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidiff_enable: true }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      const registered = new Promise<Record<string, unknown>>((resolve) => {
        sockets.on("connection", (ws) => {
          ws.once("message", (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
        });
      });

      registerPidiff(pi, { reconnectPollIntervalMs: 50 });
      emitPi("session_start", { reason: "startup" }, ctx);

      const payload = await registered;
      assert.equal(payload.type, "register");
      assert.equal(payload.cwd, dir);
      assert.equal(payload.branch, "feat/peer-branch");
      assert.equal(payload.sessionId, `${process.pid}:${dir}`);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits diff-viewer:port when supervised rpc peer attaches", async () => {
    const dir = makeTempDir("pidiff-rpc-port-emit-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, events, emitPi } = createHarness();
    const ctx = makeCtx("rpc", dir);

    try {
      initGitRepo(dir, "main");
      const port = await listenHttp(server);
      mkdirSync(join(dir, ".pi", "run"), { recursive: true });
      writeFileSync(join(dir, ".pi", "run", "pidiff.port"), String(port));
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidiff_enable: true }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      const emittedPort = new Promise<unknown>((resolve) => {
        events.once("diff-viewer:port", (p) => resolve(p));
      });

      registerPidiff(pi, { reconnectPollIntervalMs: 50 });
      emitPi("session_start", { reason: "startup" }, ctx);

      assert.equal(await emittedPort, port);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves shared repo root lockfile for linked worktree peer", async () => {
    const dir = makeTempDir("pidiff-rpc-wt-");
    const repoDir = join(dir, "repo");
    const wtDir = join(dir, "wt-peer");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, events, emitPi } = createHarness();
    const ctx = makeCtx("rpc", wtDir);

    try {
      mkdirSync(repoDir, { recursive: true });
      initGitRepo(repoDir, "main");
      execFileSync("git", ["worktree", "add", "-b", "feat/wt-peer", wtDir], { cwd: repoDir, stdio: "ignore" });

      const port = await listenHttp(server);
      mkdirSync(join(repoDir, ".pi", "run"), { recursive: true });
      writeFileSync(join(repoDir, ".pi", "run", "pidiff.port"), String(port));
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidiff_enable: true }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      const registered = new Promise<Record<string, unknown>>((resolve) => {
        sockets.on("connection", (ws) => {
          ws.once("message", (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
        });
      });
      const emittedPort = new Promise<unknown>((resolve) => {
        events.once("diff-viewer:port", (p) => resolve(p));
      });

      registerPidiff(pi, { reconnectPollIntervalMs: 50 });
      emitPi("session_start", { reason: "startup" }, ctx);

      const [payload, reportedPort] = await Promise.all([registered, emittedPort]);
      assert.equal(reportedPort, port);
      assert.equal(payload.cwd, wtDir);
      assert.equal(payload.branch, "feat/wt-peer");
      assert.equal(existsSync(join(wtDir, ".pi", "run")), false, "attach-only worktree peer should not create .pi/run");
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rebinds supervised rpc peer to new repository hub on session_start repo change", async () => {
    const dir = makeTempDir("pidiff-rpc-repo-switch-");
    const repoA = join(dir, "repo-a");
    const repoB = join(dir, "repo-b");
    const serverA = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const socketsA = new WebSocketServer({ server: serverA, path: "/ws/pi" });
    const serverB = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const socketsB = new WebSocketServer({ server: serverB, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, events, emitPi } = createHarness();
    const ctxA = makeCtx("rpc", repoA);
    const ctxB = makeCtx("rpc", repoB);
    const emittedPorts: number[] = [];

    try {
      mkdirSync(repoA, { recursive: true });
      mkdirSync(repoB, { recursive: true });
      initGitRepo(repoA, "branch-a");
      initGitRepo(repoB, "branch-b");

      const portA = await listenHttp(serverA);
      const portB = await listenHttp(serverB);
      mkdirSync(join(repoA, ".pi", "run"), { recursive: true });
      writeFileSync(join(repoA, ".pi", "run", "pidiff.port"), String(portA));
      mkdirSync(join(repoB, ".pi", "run"), { recursive: true });
      writeFileSync(join(repoB, ".pi", "run", "pidiff.port"), String(portB));
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidiff_enable: true }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      events.on("diff-viewer:port", (p: unknown) => {
        if (typeof p === "number") emittedPorts.push(p);
      });

      const regA = new Promise<Record<string, unknown>>((resolve) => {
        socketsA.on("connection", (ws) => {
          ws.once("message", (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
        });
      });
      const regB = new Promise<Record<string, unknown>>((resolve) => {
        socketsB.on("connection", (ws) => {
          ws.once("message", (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
        });
      });

      registerPidiff(pi, { reconnectPollIntervalMs: 50 });
      emitPi("session_start", { reason: "startup" }, ctxA);
      const firstReg = await regA;
      assert.equal(firstReg.cwd, repoA);

      emitPi("session_start", { reason: "resume" }, ctxB);
      const secondReg = await regB;
      assert.equal(secondReg.cwd, repoB);
      assert.equal(secondReg.branch, "branch-b");
      assert.deepEqual(emittedPorts.slice(-2), [portA, portB]);
    } finally {
      emitPi("session_shutdown", {}, ctxB);
      await closeServer(serverA, socketsA);
      await closeServer(serverB, socketsB);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips auto-spawn when daemon is not running for supervised rpc peer", async () => {
    const dir = makeTempDir("pidiff-rpc-no-spawn-");
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, events, emitPi } = createHarness();
    const ctx = makeCtx("rpc", dir);
    let emitted = 0;

    try {
      initGitRepo(dir, "main");
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidiff_enable: true }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      events.on("diff-viewer:port", () => { emitted++; });
      registerPidiff(pi, { reconnectPollIntervalMs: 50 });
      emitPi("session_start", { reason: "startup" }, ctx);
      emitPi("tool_result", { toolName: "read" }, ctx);
      await new Promise((r) => setTimeout(r, 150));

      assert.equal(emitted, 0);
      assert.equal(existsSync(join(dir, ".pi", "run", "pidiff.port")), false);
      assert.equal(existsSync(join(dir, ".pi", "run", "pidiff.spawning")), false);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes subagent child from pidiff connection", async () => {
    const dir = makeTempDir("pidiff-subagent-excl-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, emitPi } = createHarness();
    const ctx = makeCtx("rpc", dir);
    let connections = 0;

    try {
      initGitRepo(dir, "main");
      const port = await listenHttp(server);
      mkdirSync(join(dir, ".pi", "run"), { recursive: true });
      writeFileSync(join(dir, ".pi", "run", "pidiff.port"), String(port));
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidiff_enable: true }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      process.env.PI_SUBAGENT_CHILD = "1";
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      sockets.on("connection", () => { connections++; });
      registerPidiff(pi, { reconnectPollIntervalMs: 25 });
      emitPi("session_start", { reason: "startup" }, ctx);
      emitPi("tool_result", { toolName: "read" }, ctx);
      await new Promise((r) => setTimeout(r, 120));

      assert.equal(connections, 0);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes print mode from pidiff connection", async () => {
    const dir = makeTempDir("pidiff-print-excl-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, emitPi } = createHarness();
    const ctx = makeCtx("print", dir);
    let connections = 0;

    try {
      initGitRepo(dir, "main");
      const port = await listenHttp(server);
      mkdirSync(join(dir, ".pi", "run"), { recursive: true });
      writeFileSync(join(dir, ".pi", "run", "pidiff.port"), String(port));
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidiff_enable: true }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      sockets.on("connection", () => { connections++; });
      registerPidiff(pi, { reconnectPollIntervalMs: 25 });
      emitPi("session_start", { reason: "startup" }, ctx);
      emitPi("tool_result", { toolName: "read" }, ctx);
      await new Promise((r) => setTimeout(r, 120));

      assert.equal(connections, 0);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes json mode from pidiff connection", async () => {
    const dir = makeTempDir("pidiff-json-excl-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, emitPi } = createHarness();
    const ctx = makeCtx("json", dir);
    let connections = 0;

    try {
      initGitRepo(dir, "main");
      const port = await listenHttp(server);
      mkdirSync(join(dir, ".pi", "run"), { recursive: true });
      writeFileSync(join(dir, ".pi", "run", "pidiff.port"), String(port));
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidiff_enable: true }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      sockets.on("connection", () => { connections++; });
      registerPidiff(pi, { reconnectPollIntervalMs: 25 });
      emitPi("session_start", { reason: "startup" }, ctx);
      emitPi("tool_result", { toolName: "read" }, ctx);
      await new Promise((r) => setTimeout(r, 120));

      assert.equal(connections, 0);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes plain unsupervised rpc from pidiff connection", async () => {
    const dir = makeTempDir("pidiff-plain-rpc-excl-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, emitPi } = createHarness();
    const ctx = makeCtx("rpc", dir);
    let connections = 0;

    try {
      initGitRepo(dir, "main");
      const port = await listenHttp(server);
      mkdirSync(join(dir, ".pi", "run"), { recursive: true });
      writeFileSync(join(dir, ".pi", "run", "pidiff.port"), String(port));
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidiff_enable: true }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      delete process.env.PI_COMS_SUPERVISED_PEER;

      sockets.on("connection", () => { connections++; });
      registerPidiff(pi, { reconnectPollIntervalMs: 25 });
      emitPi("session_start", { reason: "startup" }, ctx);
      emitPi("tool_result", { toolName: "read" }, ctx);
      await new Promise((r) => setTimeout(r, 120));

      assert.equal(connections, 0);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isSameGitRepoCheckout (#1501)", () => {
  it("accepts exact project checkout path", () => {
    const dir = makeTempDir("pidiff-same-repo-");
    try {
      initGitRepo(dir, "main");
      assert.equal(isSameGitRepoCheckout(dir, dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts linked worktree belonging to same repository", () => {
    const dir = makeTempDir("pidiff-same-wt-");
    const repoDir = join(dir, "repo");
    const wtDir = join(dir, "wt-1");
    try {
      mkdirSync(repoDir, { recursive: true });
      initGitRepo(repoDir, "main");
      execFileSync("git", ["worktree", "add", "-b", "feat/wt-1", wtDir], { cwd: repoDir, stdio: "ignore" });
      assert.equal(isSameGitRepoCheckout(repoDir, wtDir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unrelated git repository checkout", () => {
    const dir = makeTempDir("pidiff-other-repo-");
    const repoA = join(dir, "repo-a");
    const repoB = join(dir, "repo-b");
    try {
      mkdirSync(repoA, { recursive: true });
      mkdirSync(repoB, { recursive: true });
      initGitRepo(repoA, "main");
      initGitRepo(repoB, "main");
      assert.equal(isSameGitRepoCheckout(repoA, repoB), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("supervised RPC daemon management guards (#1501)", () => {
  type PidiffActionExec = (
    action: string,
    c: unknown,
  ) => Promise<{ ok: boolean; abortedByGuard?: boolean; port?: number | null; running?: boolean }>;

  function capturePidiffExecutor(events: EventEmitter): { current: PidiffActionExec | null } {
    const holder: { current: PidiffActionExec | null } = { current: null };
    events.on("daemon:register-handler", (data: any) => {
      if (data?.name === "pidiff") holder.current = data.execute as PidiffActionExec;
    });
    return holder;
  }

  async function setupSupervisedWorktreePeer() {
    const dir = makeTempDir("pidiff-rpc-guard-");
    const repoDir = join(dir, "repo");
    const wtDir = join(dir, "wt-peer");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    mkdirSync(repoDir, { recursive: true });
    initGitRepo(repoDir, "main");
    execFileSync("git", ["worktree", "add", "-b", "feat/wt-guard", wtDir], { cwd: repoDir, stdio: "ignore" });
    const port = await listenHttp(server);
    mkdirSync(join(repoDir, ".pi", "run"), { recursive: true });
    writeFileSync(join(repoDir, ".pi", "run", "pidiff.port"), String(port));
    writeFileSync(join(repoDir, ".pi", "run", "pidiff.pid"), "999999");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidiff_enable: true }));
    return { dir, repoDir, wtDir, server, sockets, port };
  }

  it("blocks stop action from supervised rpc peer without removing shared hub lockfiles", async () => {
    const { dir, repoDir, wtDir, server, sockets } = await setupSupervisedWorktreePeer();
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, events, emitPi } = createHarness();
    const ctx = makeCtx("rpc", wtDir);
    const executor = capturePidiffExecutor(events);

    try {
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      registerPidiff(pi, { reconnectPollIntervalMs: 50 });
      emitPi("session_start", { reason: "startup" }, ctx);
      assert.ok(executor.current, "pidiff daemon handler should register");

      const res = await executor.current("stop", ctx);
      assert.equal(res.ok, false);
      assert.equal(res.abortedByGuard, true);
      assert.equal(existsSync(join(repoDir, ".pi", "run", "pidiff.port")), true);
      assert.equal(existsSync(join(repoDir, ".pi", "run", "pidiff.pid")), true);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks start action from supervised rpc peer", async () => {
    const { dir, wtDir, server, sockets } = await setupSupervisedWorktreePeer();
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, events, emitPi } = createHarness();
    const ctx = makeCtx("rpc", wtDir);
    const executor = capturePidiffExecutor(events);

    try {
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      registerPidiff(pi, { reconnectPollIntervalMs: 50 });
      emitPi("session_start", { reason: "startup" }, ctx);
      assert.ok(executor.current, "pidiff daemon handler should register");
      const res = await executor.current("start", ctx);
      assert.equal(res.ok, false);
      assert.equal(res.abortedByGuard, true);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks restart action from supervised rpc peer", async () => {
    const { dir, repoDir, wtDir, server, sockets } = await setupSupervisedWorktreePeer();
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, events, emitPi } = createHarness();
    const ctx = makeCtx("rpc", wtDir);
    const executor = capturePidiffExecutor(events);

    try {
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      registerPidiff(pi, { reconnectPollIntervalMs: 50 });
      emitPi("session_start", { reason: "startup" }, ctx);
      assert.ok(executor.current, "pidiff daemon handler should register");
      const res = await executor.current("restart", ctx);
      assert.equal(res.ok, false);
      assert.equal(res.abortedByGuard, true);
      assert.equal(existsSync(join(repoDir, ".pi", "run", "pidiff.port")), true);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows status action from supervised rpc peer", async () => {
    const { dir, wtDir, server, sockets, port } = await setupSupervisedWorktreePeer();
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, events, emitPi } = createHarness();
    const ctx = makeCtx("rpc", wtDir);
    const executor = capturePidiffExecutor(events);

    try {
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      registerPidiff(pi, { reconnectPollIntervalMs: 50 });
      emitPi("session_start", { reason: "startup" }, ctx);
      assert.ok(executor.current, "pidiff daemon handler should register");
      const res = await executor.current("status", ctx);
      assert.equal(res.ok, true);
      assert.equal(res.port, port);
      assert.equal(res.running, true);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createRepoCheckoutMatcher (#1501)", () => {
  it("accepts linked worktree asynchronously", async () => {
    const dir = makeTempDir("pidiff-matcher-wt-");
    const repoDir = join(dir, "repo");
    const wtDir = join(dir, "wt-1");
    try {
      mkdirSync(repoDir, { recursive: true });
      initGitRepo(repoDir, "main");
      execFileSync("git", ["worktree", "add", "-b", "feat/wt-async", wtDir], { cwd: repoDir, stdio: "ignore" });
      const matcher = createRepoCheckoutMatcher(repoDir);
      assert.equal(matcher.isExactMatch(repoDir), true);
      assert.equal(matcher.isExactMatch(wtDir), false);
      assert.equal(await matcher.matchesAsync(wtDir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("revalidates candidate checkout after path is replaced by an unrelated repo", async () => {
    const calls: string[] = [];
    let currentCandidateCommon = "/repo/main/.git";
    const matcher = createRepoCheckoutMatcher("/repo/main", () => "git", async (_bin, cwd) => {
      calls.push(cwd);
      return cwd === "/repo/main" ? "/repo/main/.git" : currentCandidateCommon;
    });

    assert.equal(await matcher.matchesAsync("/repo/wt-1"), true);
    currentCandidateCommon = "/unrelated/repo/.git";
    assert.equal(await matcher.matchesAsync("/repo/wt-1"), false);
    assert.deepEqual(calls, ["/repo/main", "/repo/wt-1", "/repo/wt-1"]);
  });

  it("deduplicates concurrent in-flight lookups for the same candidate path", async () => {
    let candidateCalls = 0;
    const matcher = createRepoCheckoutMatcher("/repo/main", () => "git", async (_bin, cwd) => {
      if (cwd === "/repo/main") return "/repo/main/.git";
      candidateCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return "/repo/main/.git";
    });

    const [a, b] = await Promise.all([
      matcher.matchesAsync("/repo/wt-1"),
      matcher.matchesAsync("/repo/wt-1"),
    ]);
    assert.equal(a, true);
    assert.equal(b, true);
    assert.equal(candidateCalls, 1);
  });

  it("rejects unrelated repository asynchronously", async () => {
    const matcher = createRepoCheckoutMatcher("/repo/a", () => "git", async (_bin, cwd) => {
      return cwd.startsWith("/repo/a") ? "/repo/a/.git" : "/repo/b/.git";
    });
    assert.equal(await matcher.matchesAsync("/repo/b"), false);
  });
});

describe("repository switch during in-flight pidiff spawn (#1501)", () => {
  it("isolates pending tui spawn when switching repositories before port resolves", async () => {
    const dir = makeTempDir("pidiff-switch-prespawn-");
    const repoA = join(dir, "repo-a");
    const repoB = join(dir, "repo-b");
    const serverB = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const socketsB = new WebSocketServer({ server: serverB, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, events, emitPi } = createHarness();
    const ctxA = makeCtx("tui", repoA, { ui: { setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } });
    const ctxB = makeCtx("tui", repoB, { ui: { setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } });

    let resolvePortA!: (port: number) => void;
    const portAPending = new Promise<number>((resolve) => { resolvePortA = resolve; });
    const spawnedCwds: string[] = [];
    const emittedPorts: number[] = [];

    try {
      mkdirSync(repoA, { recursive: true });
      mkdirSync(repoB, { recursive: true });
      initGitRepo(repoA, "branch-a");
      initGitRepo(repoB, "branch-b");

      const portB = await listenHttp(serverB);
      mkdirSync(join(repoB, ".pi", "run"), { recursive: true });
      writeFileSync(join(repoB, ".pi", "run", "pidiff.port"), String(portB));
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidiff_enable: true }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      delete process.env.PI_COMS_SUPERVISED_PEER;

      events.on("diff-viewer:port", (p: unknown) => {
        if (typeof p === "number") emittedPorts.push(p);
      });

      const regB = new Promise<Record<string, unknown>>((resolve) => {
        socketsB.on("connection", (ws) => {
          ws.once("message", (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
        });
      });

      registerPidiff(pi, {
        reconnectPollIntervalMs: 50,
        resolveSpawnPortFn: () => portAPending,
        spawnServerFn: (_port, cwd) => { spawnedCwds.push(cwd); },
        waitReadyFn: async () => true,
      });

      emitPi("session_start", { reason: "startup" }, ctxA);
      await new Promise((r) => setTimeout(r, 30));

      // Switch to Repo B while Repo A's spawn port allocation is still pending.
      emitPi("session_start", { reason: "resume" }, ctxB);
      const registeredB = await regB;
      assert.equal(registeredB.cwd, repoB);
      assert.equal(registeredB.branch, "branch-b");

      // Now let Repo A's stale spawn promise settle — must neither spawn nor clobber Repo B's lockfile.
      resolvePortA(49991);
      await new Promise((r) => setTimeout(r, 50));

      assert.deepEqual(spawnedCwds, []);
      assert.equal(readFileSync(join(repoB, ".pi", "run", "pidiff.port"), "utf-8").trim(), String(portB));
      assert.deepEqual(emittedPorts, [portB]);
    } finally {
      emitPi("session_shutdown", {}, ctxB);
      await closeServer(serverB, socketsB);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not adopt superseded tui spawn port when switching repositories during waitReady", async () => {
    const dir = makeTempDir("pidiff-switch-waitready-");
    const repoA = join(dir, "repo-a");
    const repoB = join(dir, "repo-b");
    const serverB = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const socketsB = new WebSocketServer({ server: serverB, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, events, emitPi } = createHarness();
    const ctxA = makeCtx("tui", repoA, { ui: { setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } });
    const ctxB = makeCtx("tui", repoB, { ui: { setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } });

    let finishWaitA!: (ready: boolean) => void;
    const waitReadyA = new Promise<boolean>((resolve) => { finishWaitA = resolve; });
    let resolveWaitEntered!: () => void;
    const waitStartedA = new Promise<void>((resolve) => {
      resolveWaitEntered = resolve;
    });
    const emittedPorts: number[] = [];

    try {
      mkdirSync(repoA, { recursive: true });
      mkdirSync(repoB, { recursive: true });
      initGitRepo(repoA, "branch-a");
      initGitRepo(repoB, "branch-b");

      const portB = await listenHttp(serverB);
      mkdirSync(join(repoB, ".pi", "run"), { recursive: true });
      writeFileSync(join(repoB, ".pi", "run", "pidiff.port"), String(portB));
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidiff_enable: true }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      delete process.env.PI_COMS_SUPERVISED_PEER;

      events.on("diff-viewer:port", (p: unknown) => {
        if (typeof p === "number") emittedPorts.push(p);
      });

      const regB = new Promise<Record<string, unknown>>((resolve) => {
        socketsB.on("connection", (ws) => {
          ws.once("message", (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
        });
      });

      registerPidiff(pi, {
        reconnectPollIntervalMs: 50,
        resolveSpawnPortFn: async () => 49992,
        spawnServerFn: () => {},
        waitReadyFn: async (port) => {
          if (port === 49992) {
            resolveWaitEntered();
            return waitReadyA;
          }
          return true;
        },
      });

      emitPi("session_start", { reason: "startup" }, ctxA);
      await waitStartedA;

      // Switch to Repo B while Repo A's daemon is still waiting to become ready.
      emitPi("session_start", { reason: "resume" }, ctxB);
      const registeredB = await regB;
      assert.equal(registeredB.cwd, repoB);

      // Repo A's stale waitReady resolves — must not overwrite Repo B's lockfile or active port.
      finishWaitA(true);
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(readFileSync(join(repoA, ".pi", "run", "pidiff.port"), "utf-8").trim(), "49992");
      assert.equal(readFileSync(join(repoB, ".pi", "run", "pidiff.port"), "utf-8").trim(), String(portB));
      assert.deepEqual(emittedPorts, [portB]);
    } finally {
      emitPi("session_shutdown", {}, ctxB);
      await closeServer(serverB, socketsB);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
