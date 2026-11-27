/**
 * Supervised COMS RPC peers connect to pidash so all peers appear in the Coms sidebar (#1470).
 * Run with: npx tsx --test tests/node/pidash/coms-rpc-connect.test.ts
 */
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  RPC_PERIODIC_STATUS_INTERVAL_MS,
  TUI_PERIODIC_STATUS_INTERVAL_MS,
  getPeriodicStatusPolicy,
  isPidashConnectableCtx,
  registerPidash,
  resolveComsRegistrationIdentity,
} from "../../../extensions/pidash/pidash.ts";
import { registerPidiff } from "../../../extensions/pidiff/pidiff.ts";
import { setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.ts";
import {
  authorizeSupervisedPeerBrowserAccess,
  handlePidashBrowserMessage,
  handlePidashBrowserWatch,
  registerPidashSession,
  type PiClient,
} from "../../../scripts/pidash-session-state.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";

function createHarness(flags: Record<string, unknown> = {}) {
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
    getThinkingLevel: () => "medium",
    getFlag: (name: string) => flags[name],
  } as unknown as ExtensionAPI;
  const emitPi = (name: string, event: unknown, ctx: unknown) => {
    for (const h of handlers.get(name) ?? []) h(event, ctx);
  };
  return { pi, events, emitPi };
}

function makeCtx(mode: string, overrides: Record<string, unknown> = {}) {
  return {
    mode,
    hasUI: mode === "tui",
    cwd: process.cwd(),
    model: null,
    sessionManager: { getEntries: () => [], getSessionFile: () => "" },
    ...overrides,
  };
}

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

async function listenHttp(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function closeServer(server: Server, sockets?: WebSocketServer): Promise<void> {
  if (sockets) {
    for (const c of sockets.clients) c.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  }
  if (server.listening) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function waitForFrame(
  sockets: WebSocketServer,
  predicate: (parsed: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for frame")), timeoutMs);
    timer.unref();
    const attach = (socket: { on: (ev: string, fn: (raw: Buffer) => void) => void }) => {
      socket.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (predicate(parsed)) {
          clearTimeout(timer);
          resolve(parsed);
        }
      });
    };
    for (const existing of sockets.clients) attach(existing);
    sockets.on("connection", attach);
  });
}

describe("isPidashConnectableCtx (#1470)", () => {
  it("returns true for tui mode", () => {
    assert.equal(isPidashConnectableCtx({ mode: "tui", hasUI: true }, {}), true);
  });

  it("returns true for rpc mode with PI_COMS_SUPERVISED_PEER=1", () => {
    assert.equal(
      isPidashConnectableCtx({ mode: "rpc", hasUI: false }, { PI_COMS_SUPERVISED_PEER: "1" }),
      true,
    );
  });

  it("returns false for unsupervised rpc mode (pi-sidecar)", () => {
    assert.equal(isPidashConnectableCtx({ mode: "rpc", hasUI: false }, {}), false);
  });

  it("returns false for print mode", () => {
    assert.equal(
      isPidashConnectableCtx({ mode: "print", hasUI: false }, { PI_COMS_SUPERVISED_PEER: "1" }),
      false,
    );
  });

  it("returns false for json mode", () => {
    assert.equal(
      isPidashConnectableCtx({ mode: "json", hasUI: false }, { PI_COMS_SUPERVISED_PEER: "1" }),
      false,
    );
  });

  it("returns false when PI_SUBAGENT_CHILD=1 in tui mode", () => {
    assert.equal(
      isPidashConnectableCtx({ mode: "tui", hasUI: true }, { PI_SUBAGENT_CHILD: "1" }),
      false,
    );
  });

  it("returns false when PI_SUBAGENT_CHILD=1 in supervised rpc mode", () => {
    assert.equal(
      isPidashConnectableCtx(
        { mode: "rpc", hasUI: false },
        { PI_COMS_SUPERVISED_PEER: "1", PI_SUBAGENT_CHILD: "1" },
      ),
      false,
    );
  });

  it("returns false for null ctx", () => {
    assert.equal(isPidashConnectableCtx(null, { PI_COMS_SUPERVISED_PEER: "1" }), false);
  });

  it("returns false for stale ctx whose mode getter throws", () => {
    const stale = { get mode(): string { throw new Error("stale ctx"); } };
    assert.equal(isPidashConnectableCtx(stale, { PI_COMS_SUPERVISED_PEER: "1" }), false);
  });
});

describe("pidash supervised COMS RPC registration (#1470)", () => {
  it("populates comsProject from --project flag before pidash:coms-identity fires", async () => {
    const dir = makeTempDir("pidash-coms-rpc-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, emitPi } = createHarness({
      coms: true,
      cname: "worker-1",
      purpose: "reviews PRs",
      project: "pi-config",
    });
    const ctx = makeCtx("rpc");

    try {
      const port = await listenHttp(server);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: port }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      registerPidash(pi);
      const registerFrame = waitForFrame(sockets, (p) => p.type === "register");

      emitPi("session_start", { reason: "startup" }, ctx);
      const reg = await registerFrame;
      assert.equal(reg.comsName, "worker-1");
      assert.equal(reg.comsPurpose, "reviews PRs");
      assert.equal(reg.comsProject, "pi-config");
      assert.equal(reg.supervisedPeer, true);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits default --project flag from register for non-COMS tui sessions", async () => {
    const dir = makeTempDir("pidash-non-coms-tui-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, emitPi } = createHarness({
      coms: false,
      project: "default",
    });
    const ctx = makeCtx("tui");

    try {
      const port = await listenHttp(server);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: port }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      delete process.env.PI_COMS_SUPERVISED_PEER;

      registerPidash(pi);
      const registerFrame = waitForFrame(sockets, (p) => p.type === "register");

      emitPi("session_start", { reason: "startup" }, ctx);
      const reg = await registerFrame;
      assert.equal(reg.comsName, undefined);
      assert.equal(reg.comsProject, undefined);
      assert.equal(reg.supervisedPeer, undefined);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits coms metadata for non-COMS tui session with --cname flag", async () => {
    const dir = makeTempDir("pidash-cname-no-coms-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, emitPi } = createHarness({
      coms: false,
      cname: "named-tui",
      purpose: "local work",
      project: "my-proj",
    });
    const ctx = makeCtx("tui");

    try {
      const port = await listenHttp(server);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: port }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      delete process.env.PI_COMS_SUPERVISED_PEER;

      registerPidash(pi);
      const registerFrame = waitForFrame(sockets, (p) => p.type === "register");

      emitPi("session_start", { reason: "startup" }, ctx);
      const reg = await registerFrame;
      assert.equal(reg.comsName, undefined);
      assert.equal(reg.comsPurpose, undefined);
      assert.equal(reg.comsProject, undefined);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears coms metadata on stop without restoring flags on reconnect", async () => {
    const dir = makeTempDir("pidash-coms-stop-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, events, emitPi } = createHarness({
      coms: true,
      cname: "lead",
      purpose: "coord",
      project: "pi-config",
    });
    const ctx = makeCtx("tui");

    try {
      const port = await listenHttp(server);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: port }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      delete process.env.PI_COMS_SUPERVISED_PEER;

      registerPidash(pi, { reconnectPollIntervalMs: 30 });
      const firstReg = waitForFrame(sockets, (p) => p.type === "register");
      emitPi("session_start", { reason: "startup" }, ctx);
      const reg1 = await firstReg;
      assert.equal(reg1.comsProject, "pi-config");

      const updateAfterStop = waitForFrame(sockets, (p) => p.type === "update_info" && p.comsName === null);
      events.emit("pidash:coms-identity", { name: null, purpose: null });
      const upd = await updateAfterStop;
      assert.equal(upd.comsName, null);
      assert.equal(upd.comsPurpose, null);
      assert.equal(upd.comsProject, null);

      const secondReg = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("peer did not reconnect")), 3000);
        timer.unref();
        sockets.once("connection", (socket) => {
          socket.on("message", (raw) => {
            const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
            if (parsed.type === "register") {
              clearTimeout(timer);
              resolve(parsed);
            }
          });
        });
      });

      for (const c of sockets.clients) c.terminate();
      emitPi("tool_result", { toolName: "read" }, ctx);
      const reg2 = await secondReg;
      assert.equal(reg2.comsName, null);
      assert.equal(reg2.comsPurpose, null);
      assert.equal(reg2.comsProject, null);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves null coms metadata across server reconnect after COMS stop", () => {
    const sessions = new Map<string, PiClient>();
    const ws1 = { send: () => {} };
    registerPidashSession(
      sessions,
      ws1,
      {
        sessionId: "s-coms-1",
        pid: 42,
        cwd: "/repo",
        comsName: "lead",
        comsPurpose: "coord",
        comsProject: "pi-config",
      },
      () => {},
    );
    const ws2 = { send: () => {} };
    const reconnected = registerPidashSession(
      sessions,
      ws2,
      {
        sessionId: "s-coms-1",
        pid: 42,
        cwd: "/repo",
        comsName: null,
        comsPurpose: null,
        comsProject: null,
      },
      () => {},
    );
    assert.equal(reconnected.session.comsName, undefined);
    assert.equal(reconnected.session.comsPurpose, undefined);
    assert.equal(reconnected.session.comsProject, undefined);
  });

  it("resolves coms registration identity strictly from confirmed state or activation flags", () => {
    assert.deepEqual(
      resolveComsRegistrationIdentity({
        comsIdentityKnown: false,
        comsIdentityName: undefined,
        comsIdentityPurpose: undefined,
        comsIdentityProject: undefined,
        comsFlag: false,
        cnameFlag: "foo",
        purposeFlag: "bar",
        projectFlag: "proj",
        env: {},
      }),
      { comsName: undefined, comsPurpose: undefined, comsProject: undefined },
    );
    assert.deepEqual(
      resolveComsRegistrationIdentity({
        comsIdentityKnown: true,
        comsIdentityName: undefined,
        comsIdentityPurpose: undefined,
        comsIdentityProject: undefined,
        comsFlag: true,
        cnameFlag: "foo",
        purposeFlag: "bar",
        projectFlag: "proj",
        env: { PI_COMS_SUPERVISED_PEER: "1" },
      }),
      { comsName: null, comsPurpose: null, comsProject: null },
    );
  });
});

describe("pidash supervised rpc reconnect paths (#1470)", () => {
  it("reconnects supervised rpc peer on tool_result", async () => {
    const dir = makeTempDir("pidash-rpc-tool-result-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, emitPi } = createHarness({ coms: true, cname: "peer-tr", project: "pi-config" });
    const ctx = makeCtx("rpc");

    try {
      const port = await listenHttp(server);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: port }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      registerPidash(pi);
      const registerFrame = waitForFrame(sockets, (p) => p.type === "register");

      emitPi("tool_result", { toolName: "read" }, ctx);
      const reg = await registerFrame;
      assert.equal(reg.comsName, "peer-tr");
      assert.equal(reg.supervisedPeer, true);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("connects supervised rpc peer via periodic reconnect poller", async () => {
    const dir = makeTempDir("pidash-rpc-poller-");
    // Reserve an ephemeral free port, close it so session_start sees daemon offline, then start server later.
    const probeServer = createServer();
    const port = await listenHttp(probeServer);
    await closeServer(probeServer);

    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, emitPi } = createHarness({ coms: true, cname: "peer-poll", project: "pi-config" });
    const ctx = makeCtx("rpc");

    try {
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: port }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      registerPidash(pi, { reconnectPollIntervalMs: 30 });
      emitPi("session_start", { reason: "startup" }, ctx);
      // Let initial session_start health check finish while daemon is offline (shouldAutoSpawn is false for rpc).
      await new Promise((r) => setTimeout(r, 80));

      const registerFrame = waitForFrame(sockets, (p) => p.type === "register");
      await listenHttp(server, port);

      const reg = await registerFrame;
      assert.equal(reg.comsName, "peer-poll");
      assert.equal(reg.supervisedPeer, true);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips connection for supervised rpc when PI_SUBAGENT_CHILD is set", async () => {
    const dir = makeTempDir("pidash-subagent-rpc-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, emitPi } = createHarness({ coms: true, cname: "sub-peer" });
    const ctx = makeCtx("rpc");
    let connections = 0;

    try {
      const port = await listenHttp(server);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: port }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      process.env.PI_SUBAGENT_CHILD = "1";
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      registerPidash(pi, { reconnectPollIntervalMs: 25 });
      sockets.on("connection", () => { connections++; });

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

  it("skips connection for print mode when supervised", async () => {
    const dir = makeTempDir("pidash-print-mode-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, emitPi } = createHarness();
    const ctx = makeCtx("print");
    let connections = 0;

    try {
      const port = await listenHttp(server);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: port }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      registerPidash(pi, { reconnectPollIntervalMs: 25 });
      sockets.on("connection", () => { connections++; });

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

  it("skips connection for json mode when supervised", async () => {
    const dir = makeTempDir("pidash-json-mode-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, emitPi } = createHarness();
    const ctx = makeCtx("json");
    let connections = 0;

    try {
      const port = await listenHttp(server);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: port }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      registerPidash(pi, { reconnectPollIntervalMs: 25 });
      sockets.on("connection", () => { connections++; });

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

  it("does not connect unsupervised rpc sessions across reconnect paths", async () => {
    const dir = makeTempDir("pidash-unsupervised-rpc-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, emitPi } = createHarness();
    const ctx = makeCtx("rpc");
    let connections = 0;

    try {
      const port = await listenHttp(server);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: port }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      delete process.env.PI_COMS_SUPERVISED_PEER;

      registerPidash(pi, { reconnectPollIntervalMs: 25 });
      sockets.on("connection", () => { connections++; });

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

  it("skips pidiff connection for supervised rpc peer", async () => {
    const dir = makeTempDir("pidiff-supervised-rpc-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, emitPi } = createHarness();
    const ctx = makeCtx("rpc", { cwd: dir });
    let connections = 0;

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
      const port = await listenHttp(server);
      mkdirSync(join(dir, ".pi", "run"), { recursive: true });
      writeFileSync(join(dir, ".pi", "run", "pidiff.port"), String(port));
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidiff_enable: true }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      registerPidiff(pi);
      sockets.on("connection", () => { connections++; });

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

describe("supervised peer browser authorization (#1470)", () => {
  function makeServerFixture(supervisedPeer: boolean) {
    const sessions = new Map<string, PiClient>();
    const piSent: Record<string, unknown>[] = [];
    const piWs = { send: (raw: string) => piSent.push(JSON.parse(raw) as Record<string, unknown>) };
    const client = registerPidashSession(
      sessions,
      piWs,
      {
        sessionId: "peer-1",
        pid: 100,
        cwd: "/repo",
        comsName: "worker-1",
        comsProject: "pi-config",
        supervisedPeer,
      },
      () => {},
    );
    const browserSent: Record<string, unknown>[] = [];
    const browserWs = { send: (raw: string) => browserSent.push(JSON.parse(raw) as Record<string, unknown>) };
    return { sessions, client, piSent, browserWs, browserSent };
  }

  it("allows localhost browser to watch supervised peer snapshot", () => {
    const { client, browserWs, browserSent } = makeServerFixture(true);
    const watchId = handlePidashBrowserWatch({
      ws: browserWs,
      watchId: "peer-1",
      client,
      remoteAddress: "127.0.0.1",
    });
    assert.equal(watchId, "peer-1");
    assert.equal(browserSent.length, 1);
    assert.equal(browserSent[0].type, "session_snapshot");
  });

  it("blocks LAN browser from watching supervised peer snapshot", () => {
    const { client, browserWs, browserSent } = makeServerFixture(true);
    const watchId = handlePidashBrowserWatch({
      ws: browserWs,
      watchId: "peer-1",
      client,
      remoteAddress: "192.168.1.42",
    });
    assert.equal(watchId, null);
    assert.equal(browserSent.length, 1);
    assert.equal(browserSent[0].type, "notification");
  });

  it("blocks LAN browser prompts targeting supervised peer", () => {
    const { sessions, piSent, browserWs, browserSent } = makeServerFixture(true);
    const forwarded = handlePidashBrowserMessage({
      ws: browserWs,
      parsed: { type: "prompt", sessionId: "peer-1", text: "run shell" },
      piClients: sessions,
      watchedSessionId: "peer-1",
      remoteAddress: "10.0.0.5",
    });
    assert.equal(forwarded, false);
    assert.equal(piSent.length, 0);
    assert.equal(browserSent[0]?.type, "notification");
  });

  it("blocks LAN browser UI responses targeting supervised peer", () => {
    const { sessions, piSent, browserWs, browserSent } = makeServerFixture(true);
    const forwarded = handlePidashBrowserMessage({
      ws: browserWs,
      parsed: { type: "extension_ui_response", sessionId: "peer-1", id: "req-1", confirmed: true },
      piClients: sessions,
      watchedSessionId: "peer-1",
      remoteAddress: "10.0.0.5",
    });
    assert.equal(forwarded, false);
    assert.equal(piSent.length, 0);
    assert.equal(browserSent[0]?.type, "notification");
  });

  it("blocks LAN browser commands targeting supervised peer", () => {
    const { sessions, piSent, browserWs, browserSent } = makeServerFixture(true);
    const forwarded = handlePidashBrowserMessage({
      ws: browserWs,
      parsed: { type: "pidash-command", sessionId: "peer-1", command: "abort" },
      piClients: sessions,
      watchedSessionId: "peer-1",
      remoteAddress: "10.0.0.5",
    });
    assert.equal(forwarded, false);
    assert.equal(piSent.length, 0);
    assert.equal(browserSent[0]?.type, "notification");
  });

  it("returns explicit worktree error frame when LAN browser queries supervised peer worktrees", () => {
    const { sessions, piSent, browserWs, browserSent } = makeServerFixture(true);
    const forwarded = handlePidashBrowserMessage({
      ws: browserWs,
      parsed: { type: "pidash-command", sessionId: "peer-1", command: "worktrees-list", requestId: "r-1" },
      piClients: sessions,
      watchedSessionId: "peer-1",
      remoteAddress: "192.168.1.99",
    });
    assert.equal(forwarded, false);
    assert.equal(piSent.length, 0);
    assert.equal(browserSent[0]?.type, "worktrees-list");
    assert.equal(browserSent[0]?.requestId, "r-1");
    assert.equal(typeof browserSent[0]?.error, "string");
  });

  it("allows localhost browser prompts targeting supervised peer", () => {
    const { sessions, piSent, browserWs } = makeServerFixture(true);
    const forwarded = handlePidashBrowserMessage({
      ws: browserWs,
      parsed: { type: "prompt", sessionId: "peer-1", text: "status?" },
      piClients: sessions,
      watchedSessionId: "peer-1",
      remoteAddress: "::1",
    });
    assert.equal(forwarded, true);
    assert.equal(piSent.length, 1);
    assert.equal(piSent[0].type, "prompt");
  });

  it("allows LAN browser to watch interactive tui session", () => {
    const { client, browserWs, browserSent } = makeServerFixture(false);
    const watchId = handlePidashBrowserWatch({
      ws: browserWs,
      watchId: "peer-1",
      client,
      remoteAddress: "192.168.1.42",
    });
    assert.equal(watchId, "peer-1");
    assert.equal(browserSent[0]?.type, "session_snapshot");
  });

  it("denies supervised peer browser access when remoteAddress is missing", () => {
    const res = authorizeSupervisedPeerBrowserAccess({
      targetSession: { supervisedPeer: true },
      remoteAddress: undefined,
    });
    assert.equal(res.allowed, false);
  });
});

describe("supervised peer periodic status scaling (#1470)", () => {
  it("uses slower interval without worktree polling for supervised rpc peers", () => {
    const rpcPolicy = getPeriodicStatusPolicy(
      { mode: "rpc", hasUI: false },
      { PI_COMS_SUPERVISED_PEER: "1" },
    );
    const tuiPolicy = getPeriodicStatusPolicy({ mode: "tui", hasUI: true }, {});
    assert.equal(rpcPolicy.intervalMs, RPC_PERIODIC_STATUS_INTERVAL_MS);
    assert.equal(rpcPolicy.pollWorktrees, false);
    assert.equal(rpcPolicy.includeInitialWorktreeDirty, false);
    assert.equal(tuiPolicy.intervalMs, TUI_PERIODIC_STATUS_INTERVAL_MS);
    assert.equal(tuiPolicy.pollWorktrees, true);
    assert.equal(tuiPolicy.includeInitialWorktreeDirty, true);
  });

  it("coalesces shared checkout git status scans across multiple supervised rpc peers", async () => {
    const dir = makeTempDir("pidash-multi-peer-perf-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    let gitStatusCalls = 0;
    let worktreeSummaryCalls = 0;

    const fetchGitStatus = async () => {
      gitStatusCalls++;
      await new Promise((r) => setTimeout(r, 15));
      return { branch: "main", dirty: false, changes: 0 };
    };
    const fetchWorktreeSummary = async () => {
      worktreeSummaryCalls++;
      return { worktreeCount: 2, worktreeDirtyCount: 1, inLinkedWorktree: false };
    };

    const peers = [
      createHarness({ coms: true, cname: "peer-a", project: "pi-config" }),
      createHarness({ coms: true, cname: "peer-b", project: "pi-config" }),
      createHarness({ coms: true, cname: "peer-c", project: "pi-config" }),
    ];
    const sharedCtx = makeCtx("rpc", { cwd: dir });

    try {
      const port = await listenHttp(server);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: port }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      let registeredCount = 0;
      const allRegistered = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("peers did not all register")), 3000);
        timer.unref();
        sockets.on("connection", (socket) => {
          socket.on("message", (raw) => {
            const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
            if (parsed.type === "register") {
              registeredCount++;
              if (registeredCount === peers.length) {
                clearTimeout(timer);
                resolve();
              }
            }
          });
        });
      });

      for (const peer of peers) {
        registerPidash(peer.pi, {
          periodicStatusTickMs: 25,
          rpcStatusIntervalMs: 500,
          fetchGitStatus,
          fetchWorktreeSummary,
        });
      }
      for (const peer of peers) {
        peer.emitPi("session_start", { reason: "startup" }, sharedCtx);
      }

      await allRegistered;
      // Wait across several fast periodic ticks — all 3 peers should still avoid worktree scans and extra git calls.
      await new Promise((r) => setTimeout(r, 120));

      assert.equal(worktreeSummaryCalls, 0);
      assert.equal(gitStatusCalls, 1);
    } finally {
      for (const peer of peers) peer.emitPi("session_shutdown", {}, sharedCtx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throttles supervised rpc periodic status polling until rpcStatusIntervalMs elapses", async () => {
    const dir = makeTempDir("pidash-rpc-throttle-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    let gitStatusCalls = 0;
    let currentDirty = false;

    const fetchGitStatus = async () => {
      gitStatusCalls++;
      return { branch: "main", dirty: currentDirty, changes: currentDirty ? 2 : 0 };
    };

    const { pi, emitPi } = createHarness({ coms: true, cname: "peer-slow", project: "pi-config" });
    const ctx = makeCtx("rpc", { cwd: dir });

    try {
      const port = await listenHttp(server);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: port }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      registerPidash(pi, {
        periodicStatusTickMs: 20,
        rpcStatusIntervalMs: 110,
        fetchGitStatus,
      });

      const registerFrame = waitForFrame(sockets, (p) => p.type === "register");
      emitPi("session_start", { reason: "startup" }, ctx);
      await registerFrame;
      assert.equal(gitStatusCalls, 1);

      currentDirty = true;
      await new Promise((r) => setTimeout(r, 55));
      // Still within rpcStatusIntervalMs (110ms) despite multiple 20ms ticks.
      assert.equal(gitStatusCalls, 1);

      const updateFrame = waitForFrame(sockets, (p) => p.type === "update_info" && p.gitDirty === true, 2000);
      const upd = await updateFrame;
      assert.equal(upd.gitDirty, true);
      assert.equal(upd.gitChanges, 2);
      assert.ok(gitStatusCalls >= 2);
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
