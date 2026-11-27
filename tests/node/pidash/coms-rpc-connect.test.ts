/**
 * Supervised COMS RPC peers connect to pidash so all peers appear in the Coms sidebar (#1470).
 * Run with: npx tsx --test tests/node/pidash/coms-rpc-connect.test.ts
 */
import { EventEmitter } from "node:events";
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isPidashConnectableCtx, registerPidash } from "../../../extensions/pidash/pidash.ts";
import { setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.ts";
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
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: address.port }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      registerPidash(pi);

      const registerFrame = new Promise<Record<string, unknown>>((resolve) => {
        sockets.once("connection", (socket) => {
          socket.on("message", (raw) => {
            const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
            if (parsed.type === "register") resolve(parsed);
          });
        });
      });

      emitPi("session_start", { reason: "startup" }, ctx);
      const reg = await Promise.race([
        registerFrame,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("supervised rpc peer did not register")), 3000).unref();
        }),
      ]);
      assert.equal(reg.comsName, "worker-1");
      assert.equal(reg.comsPurpose, "reviews PRs");
      assert.equal(reg.comsProject, "pi-config");
    } finally {
      emitPi("session_shutdown", {}, ctx);
      for (const c of sockets.clients) c.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: address.port }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      delete process.env.PI_COMS_SUPERVISED_PEER;

      registerPidash(pi);

      const registerFrame = new Promise<Record<string, unknown>>((resolve) => {
        sockets.once("connection", (socket) => {
          socket.on("message", (raw) => {
            const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
            if (parsed.type === "register") resolve(parsed);
          });
        });
      });

      emitPi("session_start", { reason: "startup" }, ctx);
      const reg = await Promise.race([
        registerFrame,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("tui session did not register")), 3000).unref();
        }),
      ]);
      assert.equal(reg.comsName, undefined);
      assert.equal(reg.comsProject, undefined);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      for (const c of sockets.clients) c.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not connect unsupervised rpc sessions on session_start", async () => {
    const dir = makeTempDir("pidash-unsupervised-rpc-");
    const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    const { pi, emitPi } = createHarness();
    const ctx = makeCtx("rpc");
    let connections = 0;

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: address.port }));
      setGlobalSettingsPath(join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      delete process.env.PI_COMS_SUPERVISED_PEER;

      registerPidash(pi);
      sockets.on("connection", () => { connections++; });

      emitPi("session_start", { reason: "startup" }, ctx);
      emitPi("tool_result", { toolName: "read" }, ctx);
      await new Promise((r) => setTimeout(r, 150));

      assert.equal(connections, 0);
    } finally {
      emitPi("session_shutdown", {}, ctx);
      for (const c of sockets.clients) c.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      setGlobalSettingsPath(null);
      restoreEnv("PI_SUBAGENT_CHILD", prevChild);
      restoreEnv("PI_COMS_SUPERVISED_PEER", prevSupervised);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
