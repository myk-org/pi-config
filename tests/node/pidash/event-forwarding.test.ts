/**
 * Verify pidash drops unconsumed events (turn_start, tool_result, provider_response)
 * while still forwarding consumed events (tool_execution_end, turn_end) and keeping
 * the tool_result reconnect fallback (#1179).
 */
import { EventEmitter } from "node:events";
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { it } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPidash } from "../../../extensions/pidash/pidash.ts";
import { setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.ts";
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
    getThinkingLevel: () => "medium",
  } as unknown as ExtensionAPI;
  const emitPi = (name: string, event: unknown, ctx: unknown) => {
    for (const h of handlers.get(name) ?? []) h(event, ctx);
  };
  return { pi, handlers, emitPi };
}

it("drops turn_start, tool_result, and after_provider_response while forwarding consumed events", async () => {
  const dir = makeTempDir("pidash-fwd-");
  const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
  const sockets = new WebSocketServer({ server, path: "/ws/pi" });
  const frames: Array<Record<string, unknown>> = [];
  const previousChild = process.env.PI_SUBAGENT_CHILD;
  const { pi, emitPi } = createHarness();
  const ctx = {
    mode: "tui",
    cwd: process.cwd(),
    model: null,
    sessionManager: { getEntries: () => [], getSessionFile: () => "" },
  };
  const timeout = (label: string) => new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`pidash did not ${label}`)), 3000).unref();
  });

  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: address.port }));
    setGlobalSettingsPath(join(dir, "settings.json"));
    delete process.env.PI_SUBAGENT_CHILD;
    registerPidash(pi);

    const connected = new Promise<void>((resolve) => {
      sockets.once("connection", (socket) => {
        socket.on("message", (raw) => {
          const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
          frames.push(parsed);
          if (parsed.type === "replay_complete") resolve();
        });
      });
    });

    emitPi("session_start", { reason: "startup" }, ctx);
    await Promise.race([connected, timeout("connect")]);

    const beforeCount = frames.length;
    emitPi("turn_start", { turnIndex: 0 }, ctx);
    emitPi("tool_result", { toolName: "bash", content: [{ type: "text", text: "50KB payload" }] }, ctx);
    emitPi("after_provider_response", { status: 200, headers: { "x-request-id": "req-1" } }, ctx);
    emitPi("tool_execution_end", { toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false }, ctx);
    emitPi("turn_end", { message: { role: "assistant", model: "test-model" } }, ctx);

    await Promise.race([
      (async () => {
        while (!frames.slice(beforeCount).some(f => f.type === "turn_end")) {
          await new Promise(r => setTimeout(r, 5));
        }
      })(),
      timeout("forward turn_end"),
    ]);
    await new Promise(r => setTimeout(r, 30));

    const forwarded = frames.slice(beforeCount).map(f => f.type);
    assert.equal(forwarded.includes("turn_start"), false);
    assert.equal(forwarded.includes("tool_result"), false);
    assert.equal(forwarded.includes("provider_response"), false);
    assert.equal(forwarded.includes("tool_execution_end"), true);
    assert.equal(forwarded.includes("turn_end"), true);
  } finally {
    emitPi("session_shutdown", {}, ctx);
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    setGlobalSettingsPath(null);
    if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousChild;
    rmSync(dir, { recursive: true, force: true });
  }
});

it("retains tool_result reconnect fallback when disconnected", async () => {
  const dir = makeTempDir("pidash-reconnect-");
  const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
  const sockets = new WebSocketServer({ server, path: "/ws/pi" });
  const previousChild = process.env.PI_SUBAGENT_CHILD;
  const { pi, emitPi } = createHarness();
  const ctx = {
    mode: "tui",
    cwd: process.cwd(),
    model: null,
    sessionManager: { getEntries: () => [], getSessionFile: () => "" },
  };
  const timeout = (label: string) => new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`pidash did not ${label}`)), 3000).unref();
  });

  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: address.port }));
    setGlobalSettingsPath(join(dir, "settings.json"));
    delete process.env.PI_SUBAGENT_CHILD;
    registerPidash(pi);

    const connected = new Promise<void>((resolve) => {
      sockets.once("connection", () => resolve());
    });
    // Do NOT call session_start — simulate /reload where tool_result triggers connect.
    emitPi("tool_result", { toolName: "read" }, ctx);
    await Promise.race([connected, timeout("reconnect on tool_result")]);
  } finally {
    emitPi("session_shutdown", {}, ctx);
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    setGlobalSettingsPath(null);
    if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousChild;
    rmSync(dir, { recursive: true, force: true });
  }
});
