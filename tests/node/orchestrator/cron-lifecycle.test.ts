import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { registerCron } from "../../../extensions/orchestrator/cron.js";
import { readDurableCronStore } from "../../../extensions/orchestrator/cron-store.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function makeCron() {
  delete process.env.PI_SUBAGENT_CHILD;
  const handlers = new Map<string, Function[]>();
  let tool: any;
  const intervals: any[] = [];
  const emitted: Array<{ event: string; data: any }> = [];
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  (global as any).setInterval = (fn: Function, delay: number) => { const timer = { fn, delay, unref() {} }; intervals.push(timer); return timer; };
  (global as any).setTimeout = (fn: Function, delay: number) => ({ fn, delay, unref() {} });
  (global as any).clearInterval = (timer: any) => { timer.cleared = true; };
  (global as any).clearTimeout = (timer: any) => { timer.cleared = true; };
  const pi: any = {
    events: { emit(event: string, data: any) { emitted.push({ event, data }); }, on() {} },
    on(event: string, fn: Function) { const list = handlers.get(event) || []; list.push(fn); handlers.set(event, list); },
    eventHandler(event: string, fn: Function) { const list = handlers.get(event) || []; list.push(fn); handlers.set(event, list); },
    registerTool(value: any) { tool = value; }, registerCommand() {}, sendUserMessage() {},
  };
  return {
    pi, handlers, intervals, emitted, tool: () => tool,
    restore() { global.setInterval = originalSetInterval; global.clearInterval = originalClearInterval; global.setTimeout = originalSetTimeout; global.clearTimeout = originalClearTimeout; },
  };
}

function context(cwd: string, sessionId = "session-one") { return { cwd, mode: "interactive", hasUI: false, model: {}, sessionManager: { getSessionId: () => sessionId } }; }

describe("cron lifecycle", () => {
  it("skips malformed durable records before scheduling timers", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-project-")); dirs.push(cwd);
    const store = path.join(cwd, ".pi", "cron", "crons.json");
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify({ version: 1, tasks: [
      { id: "valid", scope: "project", cwd, description: "valid", task: "check", intervalMs: 10_000, createdAt: 1 },
      { id: "nan", scope: "project", cwd, description: "bad", task: "check", intervalMs: null, createdAt: 1 },
      { id: "missing-cwd", scope: "project", description: "bad", task: "check", intervalMs: 10_000, createdAt: 1 },
      { id: "scope", scope: "session", cwd, description: "bad", task: "check", intervalMs: 10_000, createdAt: 1 },
      { id: "schedule", scope: "project", cwd, description: "bad", task: "check", createdAt: 1 },
    ] }));
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd));
      // One 10s task timer plus the 10s project-leadership health check.
      assert.equal(h.intervals.filter((timer) => timer.delay === 10_000).length, 2);
      assert.equal(h.intervals.some((timer) => !Number.isFinite(timer.delay)), false);
    } finally { h.restore(); }
  });

  it("notifies the user when persisted project crons load", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-project-")); dirs.push(cwd);
    const store = path.join(cwd, ".pi", "cron", "crons.json");
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify({ version: 1, tasks: [{ id: "project-job", scope: "project", cwd, description: "check", task: "check", intervalMs: 10_000, createdAt: 1 }] }));
    const h = makeCron();
    const notifications: Array<{ text: string; level: string }> = [];
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      const ctx: any = { ...context(cwd), hasUI: true, ui: { notify: (text: string, level: string) => notifications.push({ text, level }), theme: { fg: (_: string, text: string) => text } } };
      h.handlers.get("session_start")![0]({}, ctx);
      assert.deepEqual(notifications, [{ text: "Loaded 1 project cron (executing).", level: "info" }]);
    } finally { h.restore(); }
  });

  it("starts a newly added durable task immediately when this process is leader", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-project-")); dirs.push(cwd);
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd));
      await h.tool().execute("id", { action: "add", persist: true, task: "check", interval_seconds: 10 });
      assert.ok(h.intervals.some((timer) => timer.delay === 10_000), "the leader schedules the new durable task without waiting for fs.watch");
    } finally { h.restore(); }
  });

  it("publishes cron status changes even when the task count is unchanged", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-project-")); dirs.push(cwd);
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd));
      await h.tool().execute("id", { action: "add", task: "/status", interval_seconds: 10 });
      const before = h.emitted.filter((event) => event.event === "pidash:cron-status").at(-1)!.data;
      const timer = h.intervals.filter((item) => item.delay === 10_000).at(-1)!;
      const originalNow = Date.now;
      Date.now = () => 123_456;
      timer.fn();
      Date.now = originalNow;
      const after = h.emitted.filter((event) => event.event === "pidash:cron-status").at(-1)!.data;
      assert.equal(before.count, after.count);
      assert.ok(after.tasks[0].lastRun);
      assert.ok(after.tasks[0].nextRun);
    } finally { h.restore(); }
  });

  it("continues timer scheduling when durable persistence fails", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-project-")); dirs.push(cwd);
    const store = path.join(cwd, ".pi", "cron", "crons.json");
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd));
      await h.tool().execute("id", { action: "add", persist: true, task: "/status", interval_seconds: 10 });
      fs.rmSync(store); fs.mkdirSync(store);
      const timer = h.intervals.filter((item) => item.delay === 10_000).at(-1)!;
      assert.doesNotThrow(() => timer.fn());
      assert.doesNotThrow(() => timer.fn());
      assert.equal(timer.cleared, undefined);
    } finally { h.restore(); }
  });

  it("refuses cron creation in one-shot mode", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-project-")); dirs.push(cwd);
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, { ...context(cwd), mode: "print" });
      const result = await h.tool().execute("id", { action: "add", task: "nope", interval_seconds: 10 });
      assert.match(result.content[0].text, /unavailable in one-shot/i);
      assert.equal(h.intervals.length, 0);
    } finally { h.restore(); }
  });

  it("clears timers and releases old project leadership before a cwd switch", async () => {
    const firstCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-project-"));
    const secondCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-project-")); dirs.push(firstCwd, secondCwd);
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(firstCwd));
      await h.tool().execute("id", { action: "add", persist: true, task: "old project", interval_seconds: 10 });
      const timer = h.intervals.find((item) => item.delay === 10_000)!;
      const leaderLock = path.join(firstCwd, ".pi", "cron", "crons.json.leader.lock");
      assert.ok(fs.existsSync(leaderLock));
      h.handlers.get("session_start")![0]({}, context(secondCwd));
      assert.equal(timer.cleared, true);
      assert.equal(fs.existsSync(leaderLock), false);
      const listed = await h.tool().execute("id", { action: "list" });
      assert.doesNotMatch(listed.content[0].text, /old project/);
    } finally { h.restore(); }
  });

  it("restores session tasks only for the same session after extension reload", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-project-")); dirs.push(cwd);
    const first = makeCron();
    try {
      first.pi.events.on = first.pi.eventHandler;
      registerCron(first.pi, () => {});
      first.handlers.get("session_start")![0]({ reason: "startup" }, context(cwd, "one"));
      await first.tool().execute("id", { action: "add", task: "remember", interval_seconds: 10 });
      first.handlers.get("session_shutdown")![0]({ reason: "reload" });
      const second = makeCron();
      try {
        second.pi.events.on = second.pi.eventHandler;
        registerCron(second.pi, () => {});
        second.handlers.get("session_start")![0]({ reason: "reload" }, context(cwd, "one"));
        const listed = await second.tool().execute("id", { action: "list" });
        assert.match(listed.content[0].text, /remember/);
      } finally { second.restore(); }
    } finally { first.restore(); }
  });

  it("retains session tasks across session resume", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-project-")); dirs.push(cwd);
    const first = makeCron();
    try {
      first.pi.events.on = first.pi.eventHandler;
      registerCron(first.pi, () => {});
      first.handlers.get("session_start")![0]({ reason: "startup" }, context(cwd, "one"));
      await first.tool().execute("id", { action: "add", task: "resume me", interval_seconds: 10 });
      first.handlers.get("session_shutdown")![0]({ reason: "resume" });
      const second = makeCron();
      try {
        second.pi.events.on = second.pi.eventHandler;
        registerCron(second.pi, () => {});
        second.handlers.get("session_start")![0]({ reason: "resume" }, context(cwd, "one"));
        const listed = await second.tool().execute("id", { action: "list" });
        assert.match(listed.content[0].text, /resume me/);
      } finally { second.restore(); }
    } finally { first.restore(); }
  });

  it("does not restore session tasks into a new session and removes its old file", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-project-")); dirs.push(cwd);
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({ reason: "startup" }, context(cwd, "one"));
      await h.tool().execute("id", { action: "add", task: "only here", interval_seconds: 10 });
      const store = path.join(cwd, ".pi", "tmp");
      assert.equal(fs.readdirSync(store).filter((file) => file.startsWith("cron-")).length, 1);
      h.handlers.get("session_shutdown")![0]({ reason: "new" });
      h.handlers.get("session_start")![0]({ reason: "new" }, context(cwd, "two"));
      const listed = await h.tool().execute("id", { action: "list" });
      assert.doesNotMatch(listed.content[0].text, /only here/);
      assert.equal(fs.readdirSync(store).filter((file) => file.startsWith("cron-")).length, 0);
    } finally { h.restore(); }
  });

  it("rejects invalid schedules before persisting", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-project-")); dirs.push(cwd);
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd));
      for (const params of [
        { task: "bad", interval_seconds: NaN }, { task: "bad", interval_seconds: Infinity },
        { task: "bad", interval_seconds: 0 }, { task: "bad", interval_seconds: 9.9 },
        { task: "bad", at_hour: -1 }, { task: "bad", at_hour: 24 }, { task: "bad", at_hour: NaN },
        { task: "bad", at_hour: 0, at_minute: -1 }, { task: "bad", at_hour: 0, at_minute: 60 }, { task: "bad", at_hour: 0, at_minute: Infinity },
      ]) {
        const result = await h.tool().execute("id", { action: "add", ...params });
        assert.match(result.content[0].text, /^Error:/);
      }
      const listed = await h.tool().execute("id", { action: "list" });
      assert.equal(listed.content[0].text, "No scheduled tasks.");
    } finally { h.restore(); }
  });

  it("accepts minimum interval and daily time boundaries", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-project-")); dirs.push(cwd);
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd));
      for (const params of [
        { task: "minimum", interval_seconds: 10 }, { task: "start", at_hour: 0, at_minute: 0 }, { task: "end", at_hour: 23, at_minute: 59 },
      ]) assert.doesNotMatch((await h.tool().execute("id", { action: "add", ...params })).content[0].text, /^Error:/);
    } finally { h.restore(); }
  });

  it("pidash kill removes all durable tasks transactionally", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-project-")); dirs.push(cwd);
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd));
      await h.tool().execute("id", { action: "add", persist: true, task: "one", interval_seconds: 10 });
      await h.tool().execute("id", { action: "add", persist: true, task: "two", interval_seconds: 10 });
      h.handlers.get("pidash:cron-kill")![0]("all");
      assert.deepEqual(readDurableCronStore(path.join(cwd, ".pi", "cron", "crons.json")).tasks, []);
    } finally { h.restore(); }
  });

  it("pidash kill accepts a scope-qualified durable id", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-project-")); dirs.push(cwd);
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd));
      const result = await h.tool().execute("id", { action: "add", persist: true, task: "one", interval_seconds: 10 });
      const id = /Cron persist:([^ ]+)/.exec(result.content[0].text)![1];
      h.handlers.get("pidash:cron-kill")![0](`persist:${id}`);
      assert.deepEqual(readDurableCronStore(path.join(cwd, ".pi", "cron", "crons.json")).tasks, []);
    } finally { h.restore(); }
  });
});
