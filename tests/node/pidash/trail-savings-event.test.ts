/**
 * pidash `pidash:trail-savings` handler — validated values must reach the
 * session projection (the InfoBar input), invalid payloads must be dropped,
 * and nothing may go to console (it would leak into the chat text box).
 *
 * The extension never touches the projection directly: it sends a
 * `update_info` frame to the daemon, which applies it via updatePidashSession.
 * So the test captures the real frame and feeds it through the real projection.
 *
 * Run with: npx tsx --test tests/node/pidash/trail-savings-event.test.ts
 */
import { EventEmitter, once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPidash } from "../../../extensions/pidash/pidash.ts";
import { setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.ts";
import { clearLogLevelCache, getPiLogPath, setGlobalSessionId } from "../../../extensions/shared/file-logger.ts";
import { createPidashSessionState, updatePidashSession } from "../../../scripts/pidash-session-state.ts";

const INVALID_PAYLOADS: unknown[] = [
  { tokenSavings: -1 },
  { tokenSavings: 1.5 },
  {},
  { tokenSavings: Number.MAX_SAFE_INTEGER + 1 },
  null,
  undefined,
];

it("forwards validated trail savings to the session projection and drops invalid payloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pidash-trail-savings-"));
  const server = createServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
  const sockets = new WebSocketServer({ server, path: "/ws/pi" });
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const events = new EventEmitter();
  const frames: any[] = [];
  const previous = {
    child: process.env.PI_SUBAGENT_CHILD,
    home: process.env.HOME,
    logLevel: process.env.PI_LOG_PIDASH,
    sessionId: (globalThis as any).__piConfigSessionId,
  };
  const timeout = (label: string) => new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`pidash did not ${label}`)), 3000).unref();
  });
  const waitFor = (predicate: (frame: any) => boolean) => Promise.race([
    (async () => {
      for (;;) {
        const hit = frames.find(predicate);
        if (hit) return hit;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    })(),
    timeout(`send the expected frame`),
  ]);

  const pi = {
    events,
    on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler),
    registerCommand: () => {},
    getThinkingLevel: () => "medium",
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui",
    cwd: process.cwd(),
    model: null,
    sessionManager: { getEntries: () => [], getSessionFile: () => "" },
  };
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    // Keep every log line inside the temp dir so the real ~/.pi/logs/pidash stays untouched.
    process.env.HOME = dir;
    process.env.PI_LOG_PIDASH = "debug";
    clearLogLevelCache();
    setGlobalSessionId(`pidash-trail-savings-${process.pid}`);
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: address.port }));
    setGlobalSettingsPath(join(dir, "settings.json"));
    delete process.env.PI_SUBAGENT_CHILD;
    registerPidash(pi);
    if (previous.child !== undefined) process.env.PI_SUBAGENT_CHILD = previous.child;

    const connection = new Promise<import("ws").WebSocket>((resolve) => {
      sockets.once("connection", (socket) => {
        socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
        resolve(socket);
      });
    });
    handlers.get("session_start")?.({ reason: "startup" }, ctx);
    await Promise.race([connection, timeout("connect")]);

    // Absent savings before the event — the projection starts empty, like a fresh session.
    const state = createPidashSessionState(() => {});
    const client = state.register({}, await waitFor(frame => frame.type === "register"));
    assert.equal(client.session.trailTokenSavings, undefined);
    assert.equal(frames.some(frame => frame.type === "update_info" && "trailTokenSavings" in frame), false);

    const consoleCalls: string[] = [];
    const consoleKeys = ["debug", "log", "info", "warn", "error"] as const;
    const originals = consoleKeys.map(key => console[key]);
    for (const key of consoleKeys) {
      (console as any)[key] = (...args: unknown[]) => { consoleCalls.push(`${key}: ${args.join(" ")}`); };
    }
    try {
      events.emit("pidash:trail-savings", { tokenSavings: 1234 });
      const update = await waitFor(frame => frame.type === "update_info" && "trailTokenSavings" in frame);
      assert.equal(update.trailTokenSavings, 1234);

      updatePidashSession(client.session, update);
      assert.equal(client.session.trailTokenSavings, 1234, "InfoBar receives the new savings");

      for (const invalid of INVALID_PAYLOADS) events.emit("pidash:trail-savings", invalid);
      // Give any (buggy) forward a chance to reach the socket before asserting.
      await new Promise(resolve => setTimeout(resolve, 100));
    } finally {
      consoleKeys.forEach((key, index) => { (console as any)[key] = originals[index]; });
    }

    assert.deepEqual(consoleCalls, [], "the handler must never write to console");
    assert.equal(
      frames.filter(frame => frame.type === "update_info" && "trailTokenSavings" in frame).length,
      1,
      "invalid payloads are not forwarded",
    );
    assert.equal(client.session.trailTokenSavings, 1234, "invalid payloads leave the projection unchanged");

    const logPath = getPiLogPath("pidash");
    assert.ok(logPath && existsSync(logPath), "the handler logs through the pidash logger");
    assert.match(readFileSync(logPath, "utf-8"), /trail_savings_received \{"tokenSavings":1234\}/);
  } finally {
    handlers.get("session_shutdown")?.({}, {});
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    setGlobalSettingsPath(null);
    clearLogLevelCache();
    if (previous.child === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previous.child;
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
    if (previous.logLevel === undefined) delete process.env.PI_LOG_PIDASH;
    else process.env.PI_LOG_PIDASH = previous.logLevel;
    if (previous.sessionId === undefined) {
      delete (globalThis as any).__piConfigSessionId;
      delete process.env.__PI_CONFIG_SESSION_ID;
    } else setGlobalSessionId(previous.sessionId);
    rmSync(dir, { recursive: true, force: true });
  }
});
