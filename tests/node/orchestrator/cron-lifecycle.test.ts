import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { registerCron } from "../../../extensions/orchestrator/cron.js";
import { mutateDurableCronStore, readDurableCronStore } from "../../../extensions/orchestrator/cron-store.ts";
import { clearSettingsCache, setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.js";
import { resolveAgentModelProvider } from "../../../extensions/orchestrator/resolve-agent-model.js";
import { makeTempDir } from "../helpers/temp-dirs.js";


const dirs: string[] = [];
const harnesses = new Set<{ restore(): void }>();
afterEach(() => {
  for (const harness of [...harnesses].reverse()) harness.restore();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeCron() {
  const originalChildMarker = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  const handlers = new Map<string, Function[]>();
  let tool: any;
  const commands = new Map<string, any>();
  const intervals: any[] = [];
  const timeouts: any[] = [];
  const emitted: Array<{ event: string; data: any }> = [];
  const messages: Array<{ message: string; options: any }> = [];
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalDateNow = Date.now;
  Date.now = () => 123_456;
  (global as any).setInterval = (fn: Function, delay: number) => { const timer = { fn, delay, unref() {} }; intervals.push(timer); return timer; };
  (global as any).setTimeout = (fn: Function, delay: number) => { const timer = { fn, delay, scheduledAt: Date.now(), unref() {} }; timeouts.push(timer); return timer; };
  (global as any).clearInterval = (timer: any) => { if (timer) timer.cleared = true; };
  (global as any).clearTimeout = (timer: any) => { if (timer) timer.cleared = true; };
  const pi: any = {
    events: { emit(event: string, data: any) { emitted.push({ event, data }); }, on() {} },
    on(event: string, fn: Function) { const list = handlers.get(event) || []; list.push(fn); handlers.set(event, list); },
    eventHandler(event: string, fn: Function) { const list = handlers.get(event) || []; list.push(fn); handlers.set(event, list); },
    registerTool(value: any) { tool = value; }, registerCommand(name: string, command: any) { commands.set(name, command); }, sendUserMessage(message: string, options: any) { messages.push({ message, options }); },
  };
  let restored = false;
  const harness = {
    pi, handlers, commands, intervals, timeouts, emitted, messages, tool: () => tool,
    restore() {
      if (restored) return;
      restored = true;
      try { handlers.get("session_shutdown")?.[0]?.({ reason: "quit" }); }
      finally {
        global.setInterval = originalSetInterval; global.clearInterval = originalClearInterval; global.setTimeout = originalSetTimeout; global.clearTimeout = originalClearTimeout;
        Date.now = originalDateNow;
        if (originalChildMarker === undefined) delete process.env.PI_SUBAGENT_CHILD;
        else process.env.PI_SUBAGENT_CHILD = originalChildMarker;
        harnesses.delete(harness);
      }
    },
  };
  harnesses.add(harness);
  return harness;
}

function context(cwd: string, sessionId = "session-one", trusted = true) { return { cwd, mode: "interactive", hasUI: false, model: {}, isProjectTrusted: () => trusted, sessionManager: { getSessionId: () => sessionId } }; }

describe("cron zero-arg command (#1392)", { concurrency: false }, () => {
  it("registers /cron with no argument completions", () => {
    const h = makeCron();
    registerCron(h.pi, () => assert.fail("must not spawn an agent"));
    assert.ok(h.commands.has("cron"));
    assert.equal(h.commands.get("cron").getArgumentCompletions, undefined);
  });

  for (const args of [undefined, "", "list", "--persist", "add every hour check issues"]) {
    it(`falls back to plain-text list without LLM dispatch when headless: ${JSON.stringify(args)}`, async (t) => {
      const cwd = makeTempDir("pi-cron-command-"); dirs.push(cwd);
      const h = makeCron();
      const cron = registerCron(h.pi, () => assert.fail("must not spawn an agent"));
      const notifications: unknown[][] = [];
      const writes = t.mock.method(fs, "writeFileSync");
      syncBuiltinESMExports();
      t.after(() => { writes.mock.restore(); syncBuiltinESMExports(); });
      await h.commands.get("cron").handler(args, { ...context(cwd), ui: { notify: (...values: unknown[]) => notifications.push(values) } });
      assert.deepEqual(h.messages, []);
      assert.equal(writes.mock.calls.filter(call => String(call.arguments[0]).startsWith(cwd)).length, 0);
      assert.deepEqual(cron.getCronTasks(), []);
      assert.deepEqual(notifications, [["No scheduled tasks.", "info"]]);
    });
  }

  it("prints existing schedules in plain text when headless", async () => {
    const cwd = makeTempDir("pi-cron-command-"); dirs.push(cwd);
    const h = makeCron();
    registerCron(h.pi, () => assert.fail("must not spawn an agent"));
    h.handlers.get("session_start")![0]({}, context(cwd));
    await h.tool().execute("seed", { action: "add", task: "check issues", description: "Issue check", interval_seconds: 60 });
    const notifications: unknown[][] = [];
    await h.commands.get("cron").handler("", { ...context(cwd), ui: { notify: (...values: unknown[]) => notifications.push(values) } });
    assert.equal(notifications.length, 1);
    assert.match(String(notifications[0][0]), /Issue check/);
    assert.deepEqual(h.messages, []);
  });

  it("moves a cron between session and durable project storage preserving fields", async () => {
    const cwd = makeTempDir("pi-cron-scope-"); dirs.push(cwd);
    const h = makeCron();
    const cron = registerCron(h.pi, () => assert.fail("must not spawn"));
    h.handlers.get("session_start")![0]({}, context(cwd));
    await h.tool().execute("seed", {
      action: "add",
      task: "check PRs",
      description: "PR watch",
      interval_seconds: 120,
      model: "google/gemini-2.5-flash",
    });
    const created = cron.getCronTasks()[0];
    cron.togglePaused(`session:${created.id}`);
    assert.equal(cron.getCronTasks()[0].paused, true);

    // Move session -> project (persist)
    const toPersist = cron.setScope(`session:${created.id}`, "project");
    assert.deepEqual(toPersist, { ok: true, scope: "project", id: `persist:${created.id}` });
    const persisted = cron.getCronTasks()[0];
    assert.equal(persisted.scope, "project");
    assert.equal(persisted.task, "check PRs");
    assert.equal(persisted.description, "PR watch");
    assert.equal(persisted.intervalMs, 120_000);
    assert.equal(persisted.model, "google/gemini-2.5-flash");
    assert.equal(persisted.paused, true);
    const durablePath = path.join(cwd, ".pi", "cron", "crons.json");
    assert.equal(JSON.parse(fs.readFileSync(durablePath, "utf8")).tasks.length, 1);

    // Move project -> session
    const toSession = cron.setScope(`persist:${created.id}`, "session");
    assert.deepEqual(toSession, { ok: true, scope: "session", id: `session:${created.id}` });
    const restored = cron.getCronTasks()[0];
    assert.equal(restored.scope, "session");
    assert.equal(restored.task, "check PRs");
    assert.equal(restored.model, "google/gemini-2.5-flash");
    assert.equal(restored.paused, true);
    assert.equal(JSON.parse(fs.readFileSync(durablePath, "utf8")).tasks.length, 0);
  });
});

describe("cron lifecycle", { concurrency: false }, () => {
  for (const persist of [false, true]) {
    for (const action of ["resume", "remove", "shutdown", "switch", "kill-all"]) {
      it(`fences an in-flight ${persist ? "project" : "session"} callback after ${action}`, async () => {
        const cwd = makeTempDir("pi-cron-race-"); dirs.push(cwd);
        const h = makeCron();
        h.pi.events.on = h.pi.eventHandler;
        const cron = registerCron(h.pi, () => {});
        h.handlers.get("session_start")![0]({}, context(cwd));
        await h.tool().execute("seed", { action: "add", persist, task: "/check", interval_seconds: 60 });
        const task = cron.getCronTasks()[0];
        const id = `${persist ? "persist" : "session"}:${task.id}`;
        const old = h.timeouts.at(-1)!;
        // execute() has returned a promise, but fire() is still awaiting it.
        const pending = old.fn();
        if (action === "resume") {
          cron.togglePaused(id);
          Date.now = () => 200_000;
          cron.togglePaused(id);
        } else if (action === "remove") await h.tool().execute("remove", { action: "remove", id });
        else if (action === "shutdown") h.handlers.get("session_shutdown")![0]({ reason: "quit" });
        else if (action === "kill-all") h.handlers.get("pidash:cron-kill")![0]("all");
        else h.handlers.get("session_start")![0]({}, context(cwd, "session-two", false));
        const count = h.timeouts.length;
        await pending;
        assert.equal(h.timeouts.length, count, "old continuation must not arm a timer");
        if (action === "resume") {
          const next = h.timeouts.at(-1)!;
          assert.equal(next.delay, 60_000, "resume starts a fresh interval");
          assert.equal(h.timeouts.filter(t => !t.cleared && t !== old).length, 1);
          await next.fn();
          assert.equal(h.messages.length, 2, "exactly one future fire");
          cron.togglePaused(id);
          const messages = h.messages.length;
          await next.fn();
          assert.equal(h.messages.length, messages, "a queued stale callback cannot dispatch");
        }
      });
    }
  }

  for (const duringDiscovery of [false, true]) {
    it(`stops a peer-removed project cron ${duringDiscovery ? "during discovery" : "before fire"}`, async () => {
      const cwd = makeTempDir("pi-cron-peer-remove-"); dirs.push(cwd);
      const h = makeCron();
      const spawns: unknown[][] = [];
      registerCron(h.pi, (...args: unknown[]) => spawns.push(args));
      h.handlers.get("session_start")![0]({}, context(cwd));
      await h.tool().execute("seed", { action: "add", persist: true, task: duringDiscovery ? "check issues" : "/check", model: "openai/gpt-5.4", interval_seconds: 60 });
      const timer = h.timeouts.at(-1)!;
      const pending = duringDiscovery ? timer.fn() : undefined;
      mutateDurableCronStore(path.join(cwd, ".pi", "cron", "crons.json"), () => []);
      const count = h.timeouts.length;
      await (pending ?? timer.fn());
      assert.equal(h.messages.length, 0);
      assert.equal(spawns.length, 0);
      assert.equal(h.timeouts.length, count, "peer removal must stop the timer chain before watcher sync");
    });
  }

  it("stops a project cron when the store file is deleted before fire", async () => {
    const cwd = makeTempDir("pi-cron-file-remove-"); dirs.push(cwd);
    const h = makeCron();
    const cron = registerCron(h.pi, () => {});
    h.handlers.get("session_start")![0]({}, context(cwd));
    await h.tool().execute("seed", { action: "add", persist: true, task: "/check", interval_seconds: 60 });
    const timer = h.timeouts.at(-1)!;
    fs.unlinkSync(path.join(cwd, ".pi", "cron", "crons.json"));
    const count = h.timeouts.length;
    await timer.fn();
    assert.deepEqual(h.messages, []);
    assert.equal(h.timeouts.length, count, "deleted store file must stop the timer chain");
    assert.deepEqual(cron.getCronTasks(), []);
  });

  it("reschedules a project cron after a transient store parse error", async () => {
    const cwd = makeTempDir("pi-cron-parse-error-"); dirs.push(cwd);
    const store = path.join(cwd, ".pi", "cron", "crons.json");
    const h = makeCron();
    registerCron(h.pi, () => {});
    h.handlers.get("session_start")![0]({}, context(cwd));
    await h.tool().execute("seed", { action: "add", persist: true, task: "/check", interval_seconds: 60 });
    const saved = fs.readFileSync(store, "utf8");
    const timer = h.timeouts.at(-1)!;
    fs.writeFileSync(store, "{");
    const count = h.timeouts.length;
    await timer.fn();
    assert.deepEqual(h.messages, []);
    assert.equal(fs.readFileSync(store, "utf8"), "{", "rescheduling on read error must not clobber the store");
    assert.equal(h.timeouts.length, count + 1, "transient parse error must re-arm the next interval");
    fs.writeFileSync(store, saved);
    await h.timeouts.at(-1)!.fn();
    assert.equal(h.messages.length, 1);
  });

  it("reschedules a project cron after a transient store read error", async () => {
    const cwd = makeTempDir("pi-cron-read-error-"); dirs.push(cwd);
    const store = path.join(cwd, ".pi", "cron", "crons.json");
    const h = makeCron();
    registerCron(h.pi, () => {});
    h.handlers.get("session_start")![0]({}, context(cwd));
    await h.tool().execute("seed", { action: "add", persist: true, task: "/check", interval_seconds: 60 });
    const saved = fs.readFileSync(store, "utf8");
    const timer = h.timeouts.at(-1)!;
    fs.rmSync(store);
    fs.mkdirSync(store);
    const count = h.timeouts.length;
    await timer.fn();
    assert.deepEqual(h.messages, []);
    assert.equal(h.timeouts.length, count + 1, "transient OS read error must re-arm the next interval");
    fs.rmSync(store, { recursive: true, force: true });
    fs.writeFileSync(store, saved);
    await h.timeouts.at(-1)!.fn();
    assert.equal(h.messages.length, 1);
  });

  it("reschedules after a transient store parse error during discovery", async () => {
    const cwd = makeTempDir("pi-cron-discovery-error-"); dirs.push(cwd);
    const store = path.join(cwd, ".pi", "cron", "crons.json");
    const h = makeCron();
    const spawns: unknown[][] = [];
    registerCron(h.pi, (...args: unknown[]) => spawns.push(args));
    h.handlers.get("session_start")![0]({}, context(cwd));
    await h.tool().execute("seed", { action: "add", persist: true, task: "check issues", model: "openai/gpt-5.4", interval_seconds: 60 });
    const saved = fs.readFileSync(store, "utf8");
    const timer = h.timeouts.at(-1)!;
    const pending = timer.fn();
    fs.writeFileSync(store, "{");
    const count = h.timeouts.length;
    await pending;
    assert.equal(spawns.length, 0);
    assert.equal(h.timeouts.length, count + 1, "transient parse error during discovery must still re-arm");
    fs.writeFileSync(store, saved);
    await h.timeouts.at(-1)!.fn();
    assert.equal(spawns.length, 1);
  });

  it("keeps project tasks during sync when the store is transiently unreadable", async () => {
    const cwd = makeTempDir("pi-cron-sync-error-"); dirs.push(cwd);
    const store = path.join(cwd, ".pi", "cron", "crons.json");
    const h = makeCron();
    const cron = registerCron(h.pi, () => {});
    h.handlers.get("session_start")![0]({}, context(cwd));
    await h.tool().execute("seed", { action: "add", persist: true, task: "/check", interval_seconds: 60 });
    const timer = h.timeouts.at(-1)!;
    fs.writeFileSync(store, "{");
    h.intervals.find((item) => item.delay === 10_000)!.fn();
    assert.equal(cron.getCronTasks().length, 1);
    assert.equal(timer.cleared, undefined);
  });

  it("self-heals a disarmed leader timer during sync once the store is readable", async () => {
    const cwd = makeTempDir("pi-cron-self-heal-"); dirs.push(cwd);
    const store = path.join(cwd, ".pi", "cron", "crons.json");
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify({ version: 1, tasks: [{ id: "due", scope: "project", cwd, description: "due", task: "/status", intervalMs: 10_000, createdAt: 1, nextRun: 1 }] }));
    const h = makeCron();
    registerCron(h.pi, () => {});
    h.handlers.get("session_start")![0]({}, context(cwd));
    const due = h.timeouts.find((timer) => timer.delay === 0)!;
    const originalSetTimeout = global.setTimeout;
    let failNextArm = false;
    const originalSend = h.pi.sendUserMessage;
    h.pi.sendUserMessage = (message: string, options: any) => {
      originalSend(message, options);
      failNextArm = true;
    };
    (global as any).setTimeout = (fn: Function, delay: number) => {
      if (failNextArm) {
        failNextArm = false;
        throw new Error("transient timer arm failure");
      }
      return (originalSetTimeout as any)(fn, delay);
    };
    await due.fn();
    assert.equal(h.messages.length, 1);
    assert.equal(h.timeouts.filter((timer) => timer.delay === 10_000).length, 0);
    h.intervals.find((item) => item.delay === 10_000)!.fn();
    const healed = h.timeouts.find((timer) => timer.delay === 10_000);
    assert.ok(healed, "syncStore must re-arm a disarmed active leader task even when fields are unchanged");
    await healed.fn();
    assert.equal(h.messages.length, 2);
  });

  for (const action of ["resume", "remove", "shutdown", "switch", "kill-all"]) {
    it(`stops discovery's stale continuation after ${action}`, async () => {
      const cwd = makeTempDir("pi-cron-discovery-"); dirs.push(cwd);
      const h = makeCron();
      h.pi.events.on = h.pi.eventHandler;
      const spawns: unknown[][] = [];
      const cron = registerCron(h.pi, (...args: unknown[]) => spawns.push(args));
      h.handlers.get("session_start")![0]({}, context(cwd));
      await h.tool().execute("seed", { action: "add", task: "check issues", model: "openai/gpt-5.4", interval_seconds: 60 });
      const id = `session:${cron.getCronTasks()[0].id}`;
      // import() always yields: keep discovery deferred until the lifecycle change is complete.
      const pending = h.timeouts.at(-1)!.fn();
      assert.equal(spawns.length, 0);
      if (action === "resume") { cron.togglePaused(id); cron.togglePaused(id); }
      else if (action === "remove") await h.tool().execute("remove", { action: "remove", id });
      else if (action === "shutdown") h.handlers.get("session_shutdown")![0]({ reason: "quit" });
      else if (action === "kill-all") h.handlers.get("pidash:cron-kill")![0]("all");
      else h.handlers.get("session_start")![0]({}, context(cwd, "session-two", false));
      const count = h.timeouts.length;
      await pending;
      assert.equal(spawns.length, 0, "invalidated discovery cannot dispatch");
      assert.equal(h.timeouts.length, count, "invalidated discovery cannot reschedule");
    });
  }

  it("skips malformed durable records before scheduling timers", () => {
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
    const store = path.join(cwd, ".pi", "cron", "crons.json");
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify({ version: 1, tasks: [
      { id: "valid", scope: "project", cwd, description: "valid", task: "check", intervalMs: 10_000, createdAt: 1 },
      { id: "nan", scope: "project", cwd, description: "bad", task: "check", intervalMs: null, createdAt: 1 },
      { id: "missing-cwd", scope: "project", description: "bad", task: "check", intervalMs: 10_000, createdAt: 1 },
      { id: "scope", scope: "session", cwd, description: "bad", task: "check", intervalMs: 10_000, createdAt: 1 },
      { id: "schedule", scope: "project", cwd, description: "bad", task: "check", createdAt: 1 },
      { id: "model", scope: "project", cwd, description: "bad", task: "check", intervalMs: 10_000, createdAt: 1, model: "p/" },
    ] }));
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      const cron = registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd));
      const [valid] = cron.getCronTasks();
      const timer = h.timeouts.find(({ delay }) => delay === 10_000);
      assert.deepEqual(cron.getCronTasks().map(({ id }) => id), ["valid"], "malformed records are skipped");
      assert.ok(timer, "the valid task is scheduled one interval ahead");
      assert.equal(timer.delay, 10_000);
      assert.equal(valid.nextRun, timer.scheduledAt + 10_000);
      assert.equal(h.timeouts.some((item) => !Number.isFinite(item.delay)), false);
    } finally { h.restore(); }
  });

  it("clears timers and intervals during teardown", async () => {
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd));
      await h.tool().execute("id", { action: "add", task: "check", interval_seconds: 10 });
      h.restore();
      assert.ok(h.timeouts.every(({ cleared }) => cleared));
      assert.ok(h.intervals.every(({ cleared }) => cleared));
    } finally { h.restore(); }
  });

  it("removes the leader lock during teardown", () => {
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd));
      const lock = path.join(cwd, ".pi", "cron", "crons.json.leader.lock");
      assert.ok(fs.existsSync(lock));
      h.restore();
      assert.equal(fs.existsSync(lock), false);
    } finally { h.restore(); }
  });

  it("restores PI_SUBAGENT_CHILD during teardown", () => {
    const previous = process.env.PI_SUBAGENT_CHILD;
    process.env.PI_SUBAGENT_CHILD = "preserve-me";
    let h: ReturnType<typeof makeCron> | undefined;
    try {
      h = makeCron();
      h.restore();
      assert.equal(process.env.PI_SUBAGENT_CHILD, "preserve-me");
    } finally {
      h?.restore();
      if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = previous;
    }
  });

  it("notifies the user when persisted project crons load", () => {
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
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

  it("does not schedule untrusted durable tasks", () => {
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
    const store = path.join(cwd, ".pi", "cron", "crons.json");
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify({ version: 1, tasks: [{ id: "untrusted", scope: "project", cwd, description: "nope", task: "/status", intervalMs: 10_000, createdAt: 1 }] }));
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      const cron = registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd, "session-one", false));
      assert.equal(cron.getCronTasks()[0]?.leader, false);
      assert.equal(h.timeouts.length, 0);
      assert.equal(h.intervals.length, 0);
    } finally { h.restore(); }
  });

  it("dispatches one overdue durable occurrence before rescheduling", async () => {
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
    const store = path.join(cwd, ".pi", "cron", "crons.json");
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify({ version: 1, tasks: [{ id: "overdue", scope: "project", cwd, description: "overdue", task: "/status", intervalMs: 10_000, createdAt: 1, nextRun: 1 }] }));
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd));
      const overdue = h.timeouts.find((timer) => timer.delay === 0)!;
      assert.ok(overdue);
      await overdue.fn();
      assert.deepEqual(h.messages, [{ message: "/status", options: { deliverAs: "followUp" } }]);
      assert.equal(readDurableCronStore(store).tasks[0].lastRun !== undefined, true);
      assert.ok(h.timeouts.some((timer) => timer.delay === 10_000));
    } finally { h.restore(); }
  });

  it("does not dispatch a durable task after losing its lease", async () => {
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
    const store = path.join(cwd, ".pi", "cron", "crons.json");
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify({ version: 1, tasks: [{ id: "due", scope: "project", cwd, description: "due", task: "/status", intervalMs: 10_000, createdAt: 1, nextRun: 1 }] }));
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd));
      const due = h.timeouts.find((timer) => timer.delay === 0)!;
      assert.ok(due);
      const lock = `${store}.leader.lock`;
      fs.renameSync(lock, `${lock}.old`);
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, process_start_token: "other", instance_id: "new-leader", heartbeat_at: new Date().toISOString(), pid_namespace: "pid:[foreign]" }));
      await due.fn();
      assert.deepEqual(h.messages, []);
      assert.equal(readDurableCronStore(store).tasks[0].lastRun, undefined);
      assert.equal(h.timeouts.filter((timer) => timer.delay === 10_000).length, 0, "fenced follower must not re-arm its timer");
    } finally { h.restore(); }
  });

  it("does not dispatch a slash task after losing its lease during persistence", async () => {
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
    const store = path.join(cwd, ".pi", "cron", "crons.json");
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify({ version: 1, tasks: [{ id: "due", scope: "project", cwd, description: "due", task: "/status", intervalMs: 10_000, createdAt: 1, nextRun: 1 }] }));
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd));
      const due = h.timeouts.find((timer) => timer.delay === 0)!;
      assert.ok(due);
      const lock = `${store}.leader.lock`;
      let replaced = false;
      const originalEmit = h.pi.events.emit;
      h.pi.events.emit = (event: string, data: any) => {
        if (event === "pidash:cron-status" && !replaced) {
          replaced = true;
          fs.renameSync(lock, `${lock}.old`);
          fs.mkdirSync(lock);
          fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, process_start_token: "other", instance_id: "new-leader", heartbeat_at: new Date().toISOString(), pid_namespace: "pid:[foreign]" }));
        }
        originalEmit(event, data);
      };
      await due.fn();
      assert.equal(replaced, true, "test must replace leadership after the initial refresh");
      assert.deepEqual(h.messages, []);
    } finally { h.restore(); }
  });

  it("does not dispatch a durable task when its own heartbeat has expired", async () => {
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
    const store = path.join(cwd, ".pi", "cron", "crons.json");
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify({ version: 1, tasks: [{ id: "due", scope: "project", cwd, description: "due", task: "/status", intervalMs: 10_000, createdAt: 1, nextRun: 1 }] }));
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd));
      const due = h.timeouts.find((timer) => timer.delay === 0)!;
      assert.ok(due);
      const file = `${store}.leader.lock/owner.json`;
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), heartbeat_at: new Date(0).toISOString() }));
      await due.fn();
      assert.deepEqual(h.messages, []);
      assert.equal(readDurableCronStore(store).tasks[0].lastRun, undefined);
    } finally { h.restore(); }
  });

  it("starts a newly added durable task immediately when this process is leader", async () => {
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd));
      await h.tool().execute("id", { action: "add", persist: true, task: "check", interval_seconds: 10 });
      assert.ok(h.timeouts.some((timer) => timer.delay === 10_000), "the leader schedules the new durable task without waiting for fs.watch");
    } finally { h.restore(); }
  });

  it("publishes cron status changes even when the task count is unchanged", async () => {
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd));
      await h.tool().execute("id", { action: "add", task: "/status", interval_seconds: 10 });
      const before = h.emitted.filter((event) => event.event === "pidash:cron-status").at(-1)!.data;
      const timer = h.timeouts.filter((item) => item.delay === 10_000).at(-1)!;
      timer.fn();
      const after = h.emitted.filter((event) => event.event === "pidash:cron-status").at(-1)!.data;
      assert.equal(before.count, after.count);
      assert.ok(after.tasks[0].lastRun);
      assert.ok(after.tasks[0].nextRun);
    } finally { h.restore(); }
  });

  it("continues timer scheduling when durable persistence fails", async () => {
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
    const store = path.join(cwd, ".pi", "cron", "crons.json");
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd));
      await h.tool().execute("id", { action: "add", persist: true, task: "/status", interval_seconds: 10 });
      fs.rmSync(store); fs.mkdirSync(store);
      const timer = h.timeouts.filter((item) => item.delay === 10_000).at(-1)!;
      assert.doesNotThrow(() => timer.fn());
      assert.doesNotThrow(() => timer.fn());
      assert.equal(timer.cleared, undefined);
    } finally { h.restore(); }
  });

  it("refuses cron creation in one-shot mode", async () => {
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
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
    const firstCwd = makeTempDir("pi-cron-project-");
    const secondCwd = makeTempDir("pi-cron-project-"); dirs.push(firstCwd, secondCwd);
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(firstCwd));
      await h.tool().execute("id", { action: "add", persist: true, task: "old project", interval_seconds: 10 });
      const timer = h.timeouts.find((item) => item.delay === 10_000)!;
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
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
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
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
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
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
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
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
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

  it("accepts the minimum interval", async () => {
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd));
      assert.doesNotMatch((await h.tool().execute("id", { action: "add", task: "minimum", interval_seconds: 10 })).content[0].text, /^Error:/);
    } finally { h.restore(); }
  });

  for (const [hour, minute] of [[0, 0], [23, 59]]) it(`accepts daily time ${String(hour).padStart(2, "0")}:${minute}`, async () => {
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
    const h = makeCron();
    try {
      h.pi.events.on = h.pi.eventHandler;
      registerCron(h.pi, () => {});
      h.handlers.get("session_start")![0]({}, context(cwd));
      assert.doesNotMatch((await h.tool().execute("id", { action: "add", task: "daily", at_hour: hour, at_minute: minute })).content[0].text, /^Error:/);
    } finally { h.restore(); }
  });

  it("pidash kill removes all durable tasks transactionally", async () => {
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
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
    const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
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

  describe("model override", () => {
    /** Isolate settings so dispatch decisions do not read the developer's global config. */
    function isolateSettings(cwd: string, settings: Record<string, unknown> = {}) {
      const globalDir = makeTempDir("pi-cron-global-"); dirs.push(globalDir);
      setGlobalSettingsPath(path.join(globalDir, "pi-config-settings.json"));
      fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".pi", "pi-config-settings.json"), JSON.stringify(settings));
      clearSettingsCache();
      return () => { setGlobalSettingsPath(null); clearSettingsCache(); };
    }

    /** Run the cron's scheduled timer callback and return the spawnAsyncAgent options. */
    async function dispatch(h: ReturnType<typeof makeCron>, spawns: any[]) {
      await h.timeouts.at(-1)!.fn();
      return spawns[0]?.[4];
    }

    it("normalizes and persists the requested model", async () => {
      const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
      const h = makeCron();
      const restore = isolateSettings(cwd);
      try {
        h.pi.events.on = h.pi.eventHandler;
        const cron = registerCron(h.pi, () => {});
        h.handlers.get("session_start")![0]({}, context(cwd));
        const created = await h.tool().execute("id", { action: "add", persist: true, task: "check", interval_seconds: 60, model: "  openrouter/anthropic/claude-opus-5  " });
        assert.match(created.content[0].text, /\[openrouter\/anthropic\/claude-opus-5\]/);
        assert.equal(cron.getCronTasks()[0].model, "openrouter/anthropic/claude-opus-5");
        assert.equal(readDurableCronStore(path.join(cwd, ".pi", "cron", "crons.json")).tasks[0].model, "openrouter/anthropic/claude-opus-5");
        const listed = await h.tool().execute("id", { action: "list", persist: true });
        assert.match(listed.content[0].text, /openrouter\/anthropic\/claude-opus-5/);
      } finally { restore(); h.restore(); }
    });

    it("rejects a malformed model", async () => {
      const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
      const h = makeCron();
      const restore = isolateSettings(cwd);
      try {
        h.pi.events.on = h.pi.eventHandler;
        const cron = registerCron(h.pi, () => {});
        h.handlers.get("session_start")![0]({}, context(cwd));
        // A leading slash is a bare model id (shared parseModelOverride semantics), so only
        // an empty side is rejected.
        for (const model of ["openrouter/", "p/"]) assert.match((await h.tool().execute("id", { action: "add", task: "bad", interval_seconds: 60, model })).content[0].text, /^Error:/);
        assert.deepEqual(cron.getCronTasks(), []);
      } finally { restore(); h.restore(); }
    });

    it("treats a blank model as inherit", async () => {
      const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
      const h = makeCron();
      const restore = isolateSettings(cwd);
      try {
        h.pi.events.on = h.pi.eventHandler;
        const cron = registerCron(h.pi, () => {});
        h.handlers.get("session_start")![0]({}, context(cwd));
        assert.doesNotMatch((await h.tool().execute("id", { action: "add", task: "blank", interval_seconds: 60, model: "   " })).content[0].text, /^Error:/);
        assert.equal(cron.getCronTasks()[0].model, undefined);
      } finally { restore(); h.restore(); }
    });

    it("accepts a bare model id", async () => {
      const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
      const h = makeCron();
      const restore = isolateSettings(cwd);
      try {
        h.pi.events.on = h.pi.eventHandler;
        const cron = registerCron(h.pi, () => {});
        h.handlers.get("session_start")![0]({}, context(cwd));
        await h.tool().execute("id", { action: "add", task: "bare", interval_seconds: 60, model: "claude-opus-5" });
        assert.equal(cron.getCronTasks()[0].model, "claude-opus-5");
      } finally { restore(); h.restore(); }
    });

    it("passes the pinned provider and model to the async agent", async () => {
      const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
      const h = makeCron();
      const restore = isolateSettings(cwd);
      const spawns: any[] = [];
      try {
        h.pi.events.on = h.pi.eventHandler;
        registerCron(h.pi, (...args: any[]) => { spawns.push(args); return { id: "job" }; });
        h.handlers.get("session_start")![0]({}, context(cwd));
        await h.tool().execute("id", { action: "add", task: "check", interval_seconds: 60, model: "openrouter/anthropic/claude-opus-5" });
        const options = await dispatch(h, spawns);
        assert.deepEqual(options.explicit, { provider: "openrouter", model: "anthropic/claude-opus-5" });
        assert.equal(options.parentProvider, undefined);
      } finally { restore(); h.restore(); }
    });

    it("keeps provider resolution when only a bare model id is pinned", async () => {
      const cwd = makeTempDir("pi-cron-project-"); dirs.push(cwd);
      const h = makeCron();
      const restore = isolateSettings(cwd);
      const spawns: any[] = [];
      try {
        h.pi.events.on = h.pi.eventHandler;
        registerCron(h.pi, (...args: any[]) => { spawns.push(args); return { id: "job" }; });
        h.handlers.get("session_start")![0]({}, context(cwd));
        await h.tool().execute("id", { action: "add", task: "check", interval_seconds: 60, model: "claude-opus-5" });
        const options = await dispatch(h, spawns);
        assert.deepEqual(options.explicit, { model: "claude-opus-5" });
      } finally { restore(); h.restore(); }
    });
  });
});
