import { EventEmitter, once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPidash } from "../../../extensions/pidash/pidash.ts";
import { setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.ts";

it("reports the effective thinking level after a dashboard set-thinking command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pidash-thinking-"));
  const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
  const sockets = new WebSocketServer({ server, path: "/ws/pi" });
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const events = new EventEmitter();
  let level = "medium";
  const previousChild = process.env.PI_SUBAGENT_CHILD;
  const timeout = (label: string) => new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`pidash did not ${label}`)), 3000).unref();
  });
  const pi = {
    events,
    on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler),
    registerCommand: () => {},
    setThinkingLevel: (_requested: string) => { level = "high"; }, // Simulate Pi clamping "max".
    getThinkingLevel: () => level,
  } as unknown as ExtensionAPI;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: address.port }));
    setGlobalSettingsPath(join(dir, "settings.json"));
    delete process.env.PI_SUBAGENT_CHILD;
    registerPidash(pi);
    if (previousChild !== undefined) process.env.PI_SUBAGENT_CHILD = previousChild;
    const connection = new Promise<import("ws").WebSocket>((resolve) => {
      sockets.once("connection", (socket) => {
        socket.once("message", () => resolve(socket));
      });
    });
    handlers.get("session_start")?.({ reason: "startup" }, { mode: "tui", cwd: process.cwd(), model: null });
    const socket = await Promise.race([connection, timeout("connect")]);
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", function onMessage(raw) {
        const message = JSON.parse(raw.toString());
        if (message.type === "update_info" && "thinkingLevel" in message) {
          socket.off("message", onMessage);
          resolve(message);
        }
      });
    });
    socket.send(JSON.stringify({ type: "pidash-command", command: "set-thinking", level: "max" }));
    assert.deepEqual(await Promise.race([response, timeout("respond")]), { type: "update_info", thinkingLevel: "high" });
  } finally {
    handlers.get("session_shutdown")?.({}, {});
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousChild;
    setGlobalSettingsPath(null);
    rmSync(dir, { recursive: true, force: true });
  }
});
