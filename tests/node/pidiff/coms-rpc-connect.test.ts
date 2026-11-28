/**
 * Supervised COMS RPC peer attach-only pidiff connection and shared-repo lockfile resolution (#1501).
 * Run with: npx tsx --test tests/node/pidiff/coms-rpc-connect.test.ts
 */
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isPidiffConnectableCtx, registerPidiff } from "../../../extensions/pidiff/pidiff.ts";
import { setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.ts";
import { isSameGitRepoCheckout } from "../../../scripts/pidiff-git-diff.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";

function createHarness() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
  const events = new EventEmitter();
  const pi = {
    events,
    on: (name: string, handler: (event: unknown, ctx: unknown) => void) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  const emitPi = (name: string, event: unknown, ctx: unknown) => {
    for (const h of handlers.get(name) ?? []) h(event, ctx);
  };
  return { pi, events, emitPi };
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
