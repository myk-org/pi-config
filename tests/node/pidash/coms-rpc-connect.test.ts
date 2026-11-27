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
  shouldPublishPeriodicGitStatus,
} from "../../../extensions/pidash/pidash.ts";
import { registerPidiff } from "../../../extensions/pidiff/pidiff.ts";
import { setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.ts";
import {
  authorizeSupervisedPeerBrowserAccess,
  buildSessionUpdatedBroadcast,
  handlePidashBrowserMessage,
  handlePidashBrowserWatch,
  registerPidashSession,
  shouldDeliverSupervisedPeerBroadcast,
  type PiClient,
} from "../../../scripts/pidash-session-state.ts";
import { act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { createRoot } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import { useMessageHandler } from "../../../extensions/pidash/pidash-ui/src/hooks/useMessageHandler.ts";
import { mergeSessionUpdate } from "../../../extensions/pidash/pidash-ui/src/hooks/useSessions.ts";
import type { ChatMessage } from "../../../extensions/pidash/pidash-ui/src/types.ts";
import type { SessionInfo } from "../../../extensions/shared/types.ts";
import { installReactDomShim } from "./react-dom-shim.mjs";
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
    assert.equal(browserSent[0].type, "watch_denied");
    assert.equal(browserSent[0].sessionId, "peer-1");
    assert.equal(typeof browserSent[0].reason, "string");
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

  it("allows loopback browser to receive supervised peer broadcasts", () => {
    assert.equal(
      shouldDeliverSupervisedPeerBroadcast({
        session: { supervisedPeer: true },
        remoteAddress: "127.0.0.1",
      }),
      true,
    );
  });

  it("blocks LAN browser from receiving supervised peer broadcasts", () => {
    assert.equal(
      shouldDeliverSupervisedPeerBroadcast({
        session: { supervisedPeer: true },
        remoteAddress: "192.168.1.42",
      }),
      false,
    );
  });

  it("blocks supervised peer broadcasts when remoteAddress is missing", () => {
    assert.equal(
      shouldDeliverSupervisedPeerBroadcast({
        session: { supervisedPeer: true },
        remoteAddress: undefined,
      }),
      false,
    );
  });

  it("allows LAN browser to receive interactive tui broadcasts", () => {
    assert.equal(
      shouldDeliverSupervisedPeerBroadcast({
        session: { supervisedPeer: undefined },
        remoteAddress: "192.168.1.42",
      }),
      true,
    );
  });

  it("serializes explicit null COMS fields in session_updated broadcast on stop", () => {
    const session: SessionInfo = {
      sessionId: "s-1",
      pid: 1,
      cwd: "/repo",
      branch: "main",
      model: "m",
      startedAt: "now",
      lastActivity: 0,
      active: true,
    };
    const wire = JSON.parse(
      JSON.stringify(
        buildSessionUpdatedBroadcast(session, { comsName: null, comsPurpose: null, comsProject: null }),
      ),
    ) as { type: string; session: Record<string, unknown> };
    assert.equal(wire.type, "session_updated");
    assert.equal(wire.session.comsName, null);
    assert.equal(wire.session.comsPurpose, null);
    assert.equal(wire.session.comsProject, null);
  });

  it("removes COMS metadata from browser session state when session_updated sends null", () => {
    const prev: SessionInfo = {
      sessionId: "s-1",
      pid: 1,
      cwd: "/repo",
      branch: "main",
      model: "m",
      startedAt: "now",
      lastActivity: 0,
      active: true,
      comsName: "lead",
      comsPurpose: "coord",
      comsProject: "pi-config",
    };
    const next = mergeSessionUpdate(prev, {
      sessionId: "s-1",
      comsName: null as unknown as string,
      comsPurpose: null as unknown as string,
      comsProject: null as unknown as string,
    });
    assert.equal(next.comsName, undefined);
    assert.equal(next.comsPurpose, undefined);
    assert.equal(next.comsProject, undefined);
    assert.equal("comsProject" in next, false);
  });

  it("renders read-only notice in useMessageHandler on matching watch_denied", async () => {
    const { container } = installReactDomShim();
    let emit: (ev: Record<string, unknown>) => void = () => {};
    let latestMessages: ChatMessage[] = [];
    const peerSession: SessionInfo = {
      sessionId: "peer-1",
      pid: 1,
      cwd: "/repo",
      branch: "main",
      model: "m",
      startedAt: "now",
      lastActivity: 0,
      active: true,
      supervisedPeer: true,
    };
    const notifications = {
      permission: "denied" as NotificationPermission,
      supported: false,
      preferences: { enabled: false, sound: false, sessionEnd: false, awaitingInput: false },
      setPreference: () => {},
      requestPermission: () => {},
    } as any;

    function Probe() {
      const state = useMessageHandler(
        (handler) => { emit = handler as any; return () => {}; },
        peerSession,
        notifications,
        () => {},
      );
      latestMessages = state.messages;
      return null;
    }

    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(Probe)));
      await act(async () => {
        emit({
          type: "watch_denied",
          sessionId: "peer-1",
          reason: "Supervised headless peers can only be watched or controlled from localhost clients.",
        });
      });
      assert.equal(latestMessages.length, 1);
      assert.equal(latestMessages[0].role, "system");
      assert.match(latestMessages[0].text, /localhost clients/);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("ignores watch_denied frame for a different sessionId", async () => {
    const { container } = installReactDomShim();
    let emit: (ev: Record<string, unknown>) => void = () => {};
    let latestMessages: ChatMessage[] = [];
    const tuiSession: SessionInfo = {
      sessionId: "tui-1",
      pid: 1,
      cwd: "/repo",
      branch: "main",
      model: "m",
      startedAt: "now",
      lastActivity: 0,
      active: true,
    };
    const notifications = {
      permission: "denied" as NotificationPermission,
      supported: false,
      preferences: { enabled: false, sound: false, sessionEnd: false, awaitingInput: false },
      setPreference: () => {},
      requestPermission: () => {},
    } as any;

    function Probe() {
      const state = useMessageHandler(
        (handler) => { emit = handler as any; return () => {}; },
        tuiSession,
        notifications,
        () => {},
      );
      latestMessages = state.messages;
      return null;
    }

    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(Probe)));
      await act(async () => {
        emit({
          type: "watch_denied",
          sessionId: "peer-other",
          reason: "Denied for peer-other",
        });
      });
      assert.equal(latestMessages.length, 0);
    } finally {
      await act(async () => root.unmount());
    }
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

  it("fetches fresh git status on consecutive supervised rpc polls with slow git fetch", async () => {
    const dir = makeTempDir("pidash-rpc-cadence-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    let gitStatusCalls = 0;

    // Simulate a slow git fetch (25ms) so completion time is meaningfully after poll start.
    const fetchGitStatus = async () => {
      const callNum = ++gitStatusCalls;
      await new Promise((r) => setTimeout(r, 25));
      return { branch: "main", dirty: callNum > 1, changes: callNum - 1 };
    };

    const { pi, emitPi } = createHarness({ coms: true, cname: "peer-cadence", project: "pi-config" });
    const ctx = makeCtx("rpc", { cwd: dir });

    try {
      const port = await listenHttp(server);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: port }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      registerPidash(pi, {
        periodicStatusTickMs: 20,
        rpcStatusIntervalMs: 80,
        fetchGitStatus,
      });

      const registerFrame = waitForFrame(sockets, (p) => p.type === "register");
      emitPi("session_start", { reason: "startup" }, ctx);
      await registerFrame;

      // Expect BOTH the first periodic update (changes: 1) AND the very next cadence update (changes: 2)
      // within ~260ms, proving the second poll is not served from a stale completion-time cache.
      const secondUpdate = waitForFrame(sockets, (p) => p.type === "update_info" && p.gitChanges === 2, 600);
      const upd = await secondUpdate;
      assert.equal(upd.gitChanges, 2);
      assert.ok(gitStatusCalls >= 3);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips worktree summary scan on supervised rpc session switch", async () => {
    const dir = makeTempDir("pidash-rpc-switch-wt-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    let worktreeSummaryCalls = 0;

    const fetchGitStatus = async () => ({ branch: "main", dirty: false, changes: 0 });
    const fetchWorktreeSummary = async () => {
      worktreeSummaryCalls++;
      return { worktreeCount: 2, worktreeDirtyCount: 1, inLinkedWorktree: false };
    };

    const { pi, emitPi } = createHarness({ coms: true, cname: "peer-switch", project: "pi-config" });
    const ctx = makeCtx("rpc", { cwd: dir });

    try {
      const port = await listenHttp(server);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: port }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      registerPidash(pi, {
        periodicStatusTickMs: 25,
        rpcStatusIntervalMs: 500,
        fetchGitStatus,
        fetchWorktreeSummary,
      });

      const registerFrame = waitForFrame(sockets, (p) => p.type === "register");
      emitPi("session_start", { reason: "startup" }, ctx);
      await registerFrame;

      const switchFrame = waitForFrame(sockets, (p) => p.type === "session_switch");
      emitPi("session_start", { reason: "new" }, ctx);
      await switchFrame;
      await new Promise((r) => setTimeout(r, 80));

      assert.equal(worktreeSummaryCalls, 0);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invalidates cached git status on supervised rpc session switch", async () => {
    const dir = makeTempDir("pidash-rpc-switch-git-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    let currentChanges = 0;

    const fetchGitStatus = async () => ({
      branch: "main",
      dirty: currentChanges > 0,
      changes: currentChanges,
    });

    const { pi, emitPi } = createHarness({ coms: true, cname: "peer-switch-git", project: "pi-config" });
    const ctx = makeCtx("rpc", { cwd: dir });

    try {
      const port = await listenHttp(server);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: port }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      registerPidash(pi, {
        periodicStatusTickMs: 25,
        rpcStatusIntervalMs: 5000,
        fetchGitStatus,
      });

      const registerFrame = waitForFrame(sockets, (p) => p.type === "register");
      emitPi("session_start", { reason: "startup" }, ctx);
      const reg = await registerFrame;
      assert.equal(reg.gitDirty, false);

      // Mutate repo state while shared cache TTL (2500ms) is still warm, then switch sessions.
      currentChanges = 3;
      const freshUpdate = waitForFrame(sockets, (p) => p.type === "update_info" && p.gitChanges === 3, 2000);
      emitPi("session_start", { reason: "resume" }, ctx);
      const upd = await freshUpdate;
      assert.equal(upd.gitDirty, true);
      assert.equal(upd.gitChanges, 3);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops superseded git status scan when scanSeq is older than currentScanSeq", () => {
    assert.equal(
      shouldPublishPeriodicGitStatus({
        shuttingDown: false,
        connected: true,
        sameSocket: true,
        startEpoch: 2,
        currentEpoch: 2,
        scanSeq: 3,
        currentScanSeq: 4,
        lastGitStatus: { branch: "main", dirty: true, changes: 5 },
        nextGitStatus: { branch: "main", dirty: false, changes: 0 },
      }),
      false,
    );
    assert.equal(
      shouldPublishPeriodicGitStatus({
        shuttingDown: false,
        connected: true,
        sameSocket: true,
        startEpoch: 2,
        currentEpoch: 2,
        scanSeq: 4,
        currentScanSeq: 4,
        lastGitStatus: { branch: "main", dirty: false, changes: 0 },
        nextGitStatus: { branch: "main", dirty: true, changes: 5 },
      }),
      true,
    );
  });

  it("ignores slow switch git status scan after newer periodic scan completes", async () => {
    const dir = makeTempDir("pidash-overlap-git-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    let callCount = 0;
    let resolveSwitchScan!: (v: { branch: string; dirty: boolean; changes: number }) => void;

    const fetchGitStatus = async () => {
      callCount++;
      if (callCount === 1) {
        return { branch: "main", dirty: false, changes: 0 };
      }
      if (callCount === 2) {
        // Slow switch-time scan that resolves AFTER a newer periodic scan finishes.
        return await new Promise<{ branch: string; dirty: boolean; changes: number }>((resolve) => {
          resolveSwitchScan = resolve;
        });
      }
      return { branch: "feat/newer", dirty: true, changes: 7 };
    };

    const { pi, emitPi } = createHarness();
    const ctx = makeCtx("tui", { cwd: dir });

    try {
      const port = await listenHttp(server);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: port }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      delete process.env.PI_COMS_SUPERVISED_PEER;

      const updateFrames: Record<string, unknown>[] = [];
      sockets.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (parsed.type === "update_info" && parsed.branch !== undefined) {
            updateFrames.push(parsed);
          }
        });
      });

      registerPidash(pi, {
        periodicStatusTickMs: 25,
        fetchGitStatus,
        fetchWorktreeSummary: async () => null,
      });

      const registerFrame = waitForFrame(sockets, (p) => p.type === "register");
      emitPi("session_start", { reason: "startup" }, ctx);
      await registerFrame;

      const newerUpdate = waitForFrame(sockets, (p) => p.type === "update_info" && p.branch === "feat/newer", 2000);
      emitPi("session_start", { reason: "new" }, ctx);
      await newerUpdate;

      // Now complete the older switch-time scan with stale data — it must be dropped.
      resolveSwitchScan({ branch: "stale-old", dirty: false, changes: 0 });
      await new Promise((r) => setTimeout(r, 40));

      assert.equal(updateFrames.some((f) => f.branch === "stale-old"), false);
      assert.equal(updateFrames[updateFrames.length - 1]?.branch, "feat/newer");
    } finally {
      emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invalidates shared git status cache on reconnect after session_shutdown with reason new", async () => {
    const dir = makeTempDir("pidash-rpc-new-after-shutdown-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    let currentChanges = 0;

    // Shared fetcher reference across extension reload in the same process (mirrors module-level getGitStatus).
    const fetchGitStatus = async () => ({
      branch: "main",
      dirty: currentChanges > 0,
      changes: currentChanges,
    });

    const first = createHarness({ coms: true, cname: "peer-new", project: "pi-config" });
    const second = createHarness({ coms: true, cname: "peer-new", project: "pi-config" });
    const ctx = makeCtx("rpc", { cwd: dir });

    try {
      const port = await listenHttp(server);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: port }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      registerPidash(first.pi, {
        periodicStatusTickMs: 25,
        rpcStatusIntervalMs: 60_000,
        fetchGitStatus,
      });

      const reg1Promise = waitForFrame(sockets, (p) => p.type === "register");
      first.emitPi("session_start", { reason: "startup" }, ctx);
      const reg1 = await reg1Promise;
      assert.equal(reg1.gitDirty, false);
      assert.equal(reg1.gitChanges, 0);

      // Mutate repo while the 30s shared cache entry is still warm, then simulate Pi 1.6.1 RPC new_session:
      // session_shutdown disconnects the old instance before session_start({ reason: "new" }) reconnects.
      currentChanges = 1;
      first.emitPi("session_shutdown", { reason: "new" }, ctx);
      for (const c of sockets.clients) c.terminate();

      registerPidash(second.pi, {
        periodicStatusTickMs: 25,
        rpcStatusIntervalMs: 60_000,
        fetchGitStatus,
      });

      const reg2Promise = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("reconnected peer did not register")), 3000);
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

      second.emitPi("session_start", { reason: "new" }, ctx);
      const reg2 = await reg2Promise;
      assert.equal(reg2.gitDirty, true);
      assert.equal(reg2.gitChanges, 1);
    } finally {
      first.emitPi("session_shutdown", {}, ctx);
      second.emitPi("session_shutdown", {}, ctx);
      await closeServer(server, sockets);
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
