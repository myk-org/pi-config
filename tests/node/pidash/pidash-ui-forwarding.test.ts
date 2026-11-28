/**
 * Verify pidash extension UI request/dismiss forwarding, reconnect resend after
 * replay_complete, and session lifecycle clearing (#1331).
 */
import { EventEmitter } from "node:events";
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, type WebSocket } from "ws";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPidash } from "../../../extensions/pidash/pidash.ts";
import { setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";

function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (predicate()) { resolve(); return; }
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${label}`));
      }
    }, 5);
    timer.unref();
  });
}

async function withPidashHarness(
  run: (h: {
    events: EventEmitter;
    emitPi: (name: string, event: unknown, ctx?: unknown) => void;
    ctx: Record<string, unknown>;
    frames: Array<Record<string, unknown>>;
    connectionCount: () => number;
    dropActiveSocket: () => Promise<void>;
    waitForReplayComplete: (count: number) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const dir = makeTempDir("pidash-ui-fwd-");
  const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
  const sockets = new WebSocketServer({ server, path: "/ws/pi" });
  const previousChild = process.env.PI_SUBAGENT_CHILD;
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
  const events = new EventEmitter();
  const frames: Array<Record<string, unknown>> = [];
  let activeSocket: WebSocket | null = null;
  let connections = 0;

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

  const ctx = {
    mode: "tui",
    cwd: process.cwd(),
    model: null,
    sessionManager: { getEntries: () => [], getSessionFile: () => "" },
  };
  const emitPi = (name: string, event: unknown, overrideCtx: unknown = ctx) => {
    for (const h of handlers.get(name) ?? []) h(event, overrideCtx);
  };

  sockets.on("connection", (socket) => {
    connections++;
    activeSocket = socket;
    socket.on("message", (raw) => {
      frames.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });

  const waitForReplayComplete = (count: number) =>
    waitFor(() => frames.filter((f) => f.type === "replay_complete").length >= count, `replay_complete #${count}`);

  const dropActiveSocket = async () => {
    const target = activeSocket;
    assert.ok(target, "expected active websocket before drop");
    const closed = new Promise<void>((resolve) => target.once("close", () => resolve()));
    target.close(1012, "restart");
    await closed;
    // Allow client close handler to update connected=false before triggering reconnect
    await new Promise((r) => setTimeout(r, 25));
  };

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: address.port }));
    setGlobalSettingsPath(join(dir, "settings.json"));
    delete process.env.PI_SUBAGENT_CHILD;
    registerPidash(pi);

    emitPi("session_start", { reason: "startup" }, ctx);
    await waitForReplayComplete(1);

    await run({
      events,
      emitPi,
      ctx,
      frames,
      connectionCount: () => connections,
      dropActiveSocket,
      waitForReplayComplete,
    });
  } finally {
    emitPi("session_shutdown", {}, ctx);
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setGlobalSettingsPath(null);
    if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousChild;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("pidash extension UI forwarding (#1331)", () => {
  it("forwards pidash:ui-request payloads over the active websocket", async () => {
    await withPidashHarness(async ({ events, frames }) => {
      const req = {
        type: "extension_ui_request",
        id: "ask-fwd-1",
        method: "select",
        title: "Deploy?",
        options: ["Yes", "No"],
      };
      events.emit("pidash:ui-request", req);
      await waitFor(() => frames.some((f) => f.id === "ask-fwd-1"), "forwarded ui-request");

      assert.deepEqual(frames.find((f) => f.id === "ask-fwd-1"), req);
    });
  });

  it("forwards pidash:ui-dismiss payloads over the active websocket", async () => {
    await withPidashHarness(async ({ events, frames }) => {
      const dismiss = { type: "ui-dismiss", id: "ask-dismiss-1" };
      events.emit("pidash:ui-dismiss", dismiss);
      await waitFor(() => frames.some((f) => f.type === "ui-dismiss" && f.id === "ask-dismiss-1"), "forwarded ui-dismiss");

      assert.deepEqual(frames.find((f) => f.type === "ui-dismiss" && f.id === "ask-dismiss-1"), dismiss);
    });
  });

  it("resends still-open interactive prompts after replay_complete on reconnect", async () => {
    await withPidashHarness(async ({ events, emitPi, frames, dropActiveSocket, waitForReplayComplete }) => {
      const req = {
        type: "extension_ui_request",
        id: "ask-reconnect-1",
        method: "confirm",
        title: "Proceed?",
      };
      events.emit("pidash:ui-request", req);
      await waitFor(() => frames.some((f) => f.id === "ask-reconnect-1"), "initial ui-request");

      await dropActiveSocket();
      const beforeReconnect = frames.length;
      emitPi("tool_result", { toolName: "read" });
      await waitForReplayComplete(2);
      await waitFor(
        () => frames.slice(beforeReconnect).some((f) => f.type === "extension_ui_request" && f.id === "ask-reconnect-1"),
        "resent pending ui-request",
      );

      const reconnectFrames = frames.slice(beforeReconnect);
      const replayCompleteIdx = reconnectFrames.findIndex((f) => f.type === "replay_complete");
      const resentIdx = reconnectFrames.findIndex((f) => f.type === "extension_ui_request" && f.id === "ask-reconnect-1");
      assert.ok(replayCompleteIdx >= 0);
      assert.ok(resentIdx > replayCompleteIdx);
      assert.deepEqual(reconnectFrames[resentIdx], req);
    });
  });

  it("omits prompts dismissed before reconnect from post-replay_complete resend", async () => {
    await withPidashHarness(async ({ events, emitPi, frames, dropActiveSocket, waitForReplayComplete }) => {
      events.emit("pidash:ui-request", {
        type: "extension_ui_request",
        id: "ask-resolved",
        method: "input",
        title: "Name?",
      });
      events.emit("pidash:ui-dismiss", { type: "ui-dismiss", id: "ask-resolved" });
      await waitFor(() => frames.some((f) => f.type === "ui-dismiss" && f.id === "ask-resolved"), "initial ui-dismiss");

      await dropActiveSocket();
      const beforeReconnect = frames.length;
      emitPi("tool_result", { toolName: "read" });
      await waitForReplayComplete(2);
      await new Promise((r) => setTimeout(r, 30));

      const resent = frames.slice(beforeReconnect).filter((f) => f.type === "extension_ui_request");
      assert.deepEqual(resent, []);
    });
  });

  it("omits prompts dismissed while disconnected from post-replay_complete resend", async () => {
    await withPidashHarness(async ({ events, emitPi, frames, dropActiveSocket, waitForReplayComplete }) => {
      events.emit("pidash:ui-request", {
        type: "extension_ui_request",
        id: "ask-offline-dismiss",
        method: "select",
        title: "Choose?",
        options: ["A"],
      });
      await waitFor(() => frames.some((f) => f.id === "ask-offline-dismiss"), "initial ui-request");

      await dropActiveSocket();
      events.emit("pidash:ui-dismiss", { type: "ui-dismiss", id: "ask-offline-dismiss" });

      const beforeReconnect = frames.length;
      emitPi("tool_result", { toolName: "read" });
      await waitForReplayComplete(2);
      await new Promise((r) => setTimeout(r, 30));

      const resent = frames.slice(beforeReconnect).filter((f) => f.type === "extension_ui_request");
      assert.deepEqual(resent, []);
    });
  });

  it("omits non-interactive ui-request payloads from post-replay_complete resend", async () => {
    await withPidashHarness(async ({ events, emitPi, frames, dropActiveSocket, waitForReplayComplete }) => {
      events.emit("pidash:ui-request", {
        type: "extension_ui_request",
        id: "ask-notify",
        method: "notify",
        title: "Info",
      });
      await waitFor(() => frames.some((f) => f.id === "ask-notify"), "initial notify ui-request");

      await dropActiveSocket();
      const beforeReconnect = frames.length;
      emitPi("tool_result", { toolName: "read" });
      await waitForReplayComplete(2);
      await new Promise((r) => setTimeout(r, 30));

      const resent = frames.slice(beforeReconnect).filter((f) => f.type === "extension_ui_request");
      assert.deepEqual(resent, []);
    });
  });

  it("delivers interactive prompts emitted while disconnected after reconnect", async () => {
    await withPidashHarness(async ({ events, emitPi, frames, dropActiveSocket, waitForReplayComplete }) => {
      await dropActiveSocket();
      const queuedReq = {
        type: "extension_ui_request",
        id: "ask-queued-offline",
        method: "select",
        title: "Queued while offline",
        options: ["One", "Two"],
      };
      events.emit("pidash:ui-request", queuedReq);

      const beforeReconnect = frames.length;
      emitPi("tool_result", { toolName: "read" });
      await waitForReplayComplete(2);
      await waitFor(
        () => frames.slice(beforeReconnect).some((f) => f.id === "ask-queued-offline"),
        "replayed offline ui-request",
      );

      assert.deepEqual(frames.slice(beforeReconnect).find((f) => f.id === "ask-queued-offline"), queuedReq);
    });
  });

  it("clears tracked pending prompts on session switch", async () => {
    await withPidashHarness(async ({ events, emitPi, ctx, frames, dropActiveSocket, waitForReplayComplete }) => {
      events.emit("pidash:ui-request", {
        type: "extension_ui_request",
        id: "ask-before-switch",
        method: "select",
        title: "Old session question",
        options: ["A"],
      });
      await waitFor(() => frames.some((f) => f.id === "ask-before-switch"), "initial ui-request");

      emitPi("session_start", { reason: "resume" }, ctx);
      await waitFor(() => frames.some((f) => f.type === "session_switch"), "session_switch frame");

      await dropActiveSocket();
      const beforeReconnect = frames.length;
      emitPi("tool_result", { toolName: "read" });
      await waitForReplayComplete(2);
      await new Promise((r) => setTimeout(r, 30));

      const resent = frames.slice(beforeReconnect).filter((f) => f.type === "extension_ui_request");
      assert.deepEqual(resent, []);
    });
  });

  it("stops forwarding pending prompts after session_shutdown", async () => {
    await withPidashHarness(async ({ events, emitPi, frames, connectionCount }) => {
      events.emit("pidash:ui-request", {
        type: "extension_ui_request",
        id: "ask-before-shutdown",
        method: "confirm",
        title: "Open before shutdown",
      });
      await waitFor(() => frames.some((f) => f.id === "ask-before-shutdown"), "initial ui-request");

      emitPi("session_shutdown", { reason: "exit" });
      await waitFor(() => frames.some((f) => f.type === "session_shutdown"), "session_shutdown frame");

      const beforeAttempt = frames.length;
      emitPi("tool_result", { toolName: "read" });
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(connectionCount(), 1);
      assert.deepEqual(frames.slice(beforeAttempt), []);
    });
  });

  it("replays running sync subagent status after replay_complete on reconnect", async () => {
    await withPidashHarness(async ({ events, emitPi, frames, dropActiveSocket, waitForReplayComplete }) => {
      const runningSyncJob = {
        id: "sync-reconnect-1",
        name: "python-expert",
        agent: "python-expert",
        mode: "sync",
        status: "running",
        startedAt: Date.now() - 2_000,
        cwd: process.cwd(),
      };
      events.on("pidash:request-async-status", () => {
        events.emit("pidash:async-status", { count: 1, agents: "python-expert", jobs: [runningSyncJob] });
      });

      await dropActiveSocket();
      const beforeReconnect = frames.length;
      emitPi("tool_result", { toolName: "read" });
      await waitForReplayComplete(2);
      await waitFor(
        () =>
          frames
            .slice(beforeReconnect)
            .some((f) => f.type === "async-status" && Array.isArray(f.jobs) && f.jobs.some((j: any) => j.id === "sync-reconnect-1")),
        "replayed sync async-status after reconnect",
      );

      const reconnectFrames = frames.slice(beforeReconnect);
      const replayCompleteIdx = reconnectFrames.findIndex((f) => f.type === "replay_complete");
      const syncIdx = reconnectFrames.findIndex((f) => f.type === "async-status");
      assert.ok(replayCompleteIdx >= 0);
      assert.ok(syncIdx > replayCompleteIdx);
    });
  });
});
