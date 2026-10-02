import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerAsyncAgents } from "../../../extensions/orchestrator/async-agents.js";
import { createLogger } from "../../../extensions/shared/logger.js";

const log = createLogger("async-kill-origin-test");

/** Agent-written: minimal registerAsyncAgents harness capturing commands, events and deliveries. */
function harness() {
  log.debug("create_harness");
  const cwd = mkdtempSync(join(tmpdir(), "async-kill-origin-"));
  const handlers = new Map<string, Array<(event: unknown, ctx: any) => void>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const events = new EventEmitter();
  const messages: any[] = [];
  const previousSetInterval = global.setInterval;
  global.setInterval = (() => ({ unref() {}, [Symbol.toPrimitive]: () => 0 })) as typeof setInterval;
  const pi = {
    on(event: string, handler: (event: unknown, ctx: any) => void) {
      const list = handlers.get(event);
      if (list) list.push(handler); else handlers.set(event, [handler]);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, command); },
    sendMessage(message: any) { messages.push(message); },
    events,
  };
  const api = registerAsyncAgents(pi as any, () => {}, {
    spawnProcess: () => Object.assign(new EventEmitter(), { stderr: { pipe() {} } }),
    discoverAgents: () => ({ agents: [{ name: "worker" }], sources: [] }),
  });
  const ctx = {
    cwd,
    hasUI: true,
    ui: { theme: { fg: (_: string, value: string) => value }, custom: async () => null, notify() {} },
    sessionManager: { getCwd: () => cwd, getSessionId: () => "test" },
  };
  handlers.get("session_start")![0]({}, ctx);
  const spawn = (options: Record<string, unknown> = {}) => api.spawnAsyncAgent("worker", "do the thing", cwd, [{ name: "worker" } as any], options);
  const statusJson = (id: string) => JSON.parse(readFileSync(join(cwd, ".pi", "tmp", id, "status.json"), "utf8"));
  const writeStatus = (id: string, patch: Record<string, unknown>) => {
    const path = join(cwd, ".pi", "tmp", id, "status.json");
    const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    writeFileSync(path, JSON.stringify({ ...existing, ...patch }), { mode: 0o600 });
  };
  return { cwd, api, commands, ctx, events, messages, spawn, statusJson, writeStatus, restore: () => { global.setInterval = previousSetInterval; rmSync(cwd, { recursive: true, force: true }); } };
}

describe("async kill origin attribution (issue #816)", () => {
  it("attributes a user kill to the user in status.json and delivery", () => {
    const h = harness();
    try {
      const job = h.spawn();
      const res = h.api.killAsyncAgent(job.id, "user");
      log.debug("kill_origin_case", { origin: "user", killed: res.killed });
      assert.deepEqual(res.killed, ["worker"]);
      assert.equal(h.statusJson(job.id).killOrigin, "user");
      assert.equal(h.statusJson(job.id).output, "Killed by user");
      assert.match(h.messages[0].content, /Killed by user/);
    } finally { h.restore(); }
  });

  it("attributes an orchestrator (subagent tool) kill to the orchestrator", () => {
    const h = harness();
    try {
      const job = h.spawn();
      h.api.killAsyncAgent(job.id, "orchestrator");
      log.debug("kill_origin_case", { origin: "orchestrator" });
      assert.equal(h.statusJson(job.id).killOrigin, "orchestrator");
      assert.equal(h.statusJson(job.id).output, "Killed by orchestrator");
      assert.match(h.messages[0].content, /Killed by orchestrator/);
      assert.doesNotMatch(h.messages[0].content, /Killed by user/);
    } finally { h.restore(); }
  });

  it("attributes a pitasks RPC stop to the task system", async () => {
    const h = harness();
    try {
      const job = h.spawn();
      const reply = new Promise<any>((resolve) => h.events.once("subagents:rpc:stop:reply:stop-1", resolve));
      h.events.emit("subagents:rpc:stop", { requestId: "stop-1", agentId: job.id });
      assert.equal((await reply).success, true);
      log.debug("kill_origin_case", { origin: "task-system", via: "subagents:rpc:stop" });
      assert.equal(h.statusJson(job.id).killOrigin, "task-system");
      assert.equal(h.statusJson(job.id).output, "Killed by task system");
      assert.match(h.messages[0].content, /Killed by task system/);
    } finally { h.restore(); }
  });

  it("attributes a pidash browser kill to the user", () => {
    const h = harness();
    try {
      const job = h.spawn();
      h.events.emit("pidash:async-kill", job.id);
      log.debug("kill_origin_case", { origin: "user", via: "pidash:async-kill" });
      assert.equal(h.statusJson(job.id).killOrigin, "user");
      assert.equal(h.statusJson(job.id).output, "Killed by user");
    } finally { h.restore(); }
  });

  it("attributes a /async-kill command kill to the user", async () => {
    const h = harness();
    try {
      const job = h.spawn();
      await h.commands.get("async-kill")!.handler(job.id, h.ctx);
      log.debug("kill_origin_case", { origin: "user", via: "/async-kill" });
      assert.equal(h.statusJson(job.id).killOrigin, "user");
    } finally { h.restore(); }
  });

  it("keeps the kill label in the delivery even when the agent produced output", () => {
    const h = harness();
    try {
      const job = h.spawn();
      h.api.killAsyncAgent(job.id, "orchestrator");
      log.debug("kill_origin_case", { origin: "orchestrator", withPriorOutput: true });
      assert.match(h.messages[0].content, /Killed by orchestrator/);
    } finally { h.restore(); }
  });

  it("preserves prior agent output below the kill label", () => {
    const h = harness();
    try {
      const job = h.spawn();
      // Real prior output — the earlier test never set any, so nothing proved the label
      // was prepended rather than replacing what the agent had already produced.
      h.writeStatus(job.id, { output: "partial findings from the agent" });
      h.api.killAsyncAgent(job.id, "task-system");
      const status = h.statusJson(job.id);
      assert.equal(status.output, "Killed by task system\npartial findings from the agent");
      assert.ok(
        status.output.indexOf("Killed by task system") < status.output.indexOf("partial findings from the agent"),
        "the label comes first, with prior output below it",
      );
      assert.equal(status.killOrigin, "task-system");
      // The delivery must carry the agent's text too, not just the label — an earlier
      // version preserved it on disk while the in-memory output stayed empty, so the AI
      // received the kill label alone.
      assert.match(h.messages[0].content, /Killed by task system/);
      assert.match(
        h.messages[0].content,
        /partial findings from the agent/,
        "the delivery must include the partial output preserved in status.json",
      );
    } finally { h.restore(); }
  });

  it("keeps the kill label on grouped jobs so group delivery carries attribution", () => {
    const h = harness();
    try {
      const job = h.spawn({ groupId: "group-886" });
      h.api.killAsyncAgent(job.id, "orchestrator");
      log.debug("kill_origin_case", { origin: "orchestrator", grouped: true });
      // Group delivery reads the in-memory job output, not status.json, so the label
      // has to live there too or the AI and pitasks lose attribution entirely.
      assert.ok(h.messages.length > 0, "a completed group delivers its results");
      assert.match(
        h.messages.map((m: any) => String(m.content)).join("\n"),
        /Killed by orchestrator/,
        "group delivery carries the kill origin",
      );
    } finally { h.restore(); }
  });

  it("falls back to user attribution for an unrecognised runtime origin", () => {
    const h = harness();
    try {
      const job = h.spawn();
      h.api.killAsyncAgent(job.id, "definitely-not-an-origin" as any);
      log.debug("kill_origin_case", { origin: "invalid" });
      assert.equal(h.statusJson(job.id).killOrigin, "user");
      assert.equal(h.statusJson(job.id).output, "Killed by user");
    } finally { h.restore(); }
  });

  it("falls back to user attribution for an Object.prototype key", () => {
    const h = harness();
    try {
      const job = h.spawn();
      // `toString` and friends are truthy on a plain object literal, so a naive
      // lookup accepted them and made the label a function rather than a string.
      h.api.killAsyncAgent(job.id, "toString" as any);
      log.debug("kill_origin_case", { origin: "prototype-key" });
      const status = h.statusJson(job.id);
      assert.equal(status.killOrigin, "user");
      assert.equal(status.output, "Killed by user");
      assert.equal(typeof status.output, "string", "the label must never be a function's source");
    } finally { h.restore(); }
  });
});
