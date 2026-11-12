/**
 * #1087 — pausing a cron: the flag, the timer, and the replicas that can disagree about it.
 *
 * `registerCron` is driven through a fake clock and fake timers (the cron-lifecycle harness
 * pattern), so arming, stopping and re-arming are observable without waiting a real interval.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { decideCronArm, registerCron } from "../../../extensions/orchestrator/cron.ts";
import { readDurableCronStore } from "../../../extensions/orchestrator/cron-store.ts";
import { makeTempDir } from "../helpers/temp-dirs.ts";

const NOW = 123_456;

function makeCron() {
  const handlers = new Map<string, Function[]>();
  const intervals: any[] = [];
  const timeouts: any[] = [];
  const emitted: Array<{ event: string; data: any }> = [];
  const messages: Array<{ message: string; options: any }> = [];
  const childMarker = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  const original = {
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
  };
  // A movable clock: a test advances it to make a stored `nextRun` stale.
  const clock = { now: NOW };
  Date.now = () => clock.now;
  (global as any).setInterval = (fn: Function, delay: number) => { const timer = { fn, delay, unref() {} }; intervals.push(timer); return timer; };
  (global as any).setTimeout = (fn: Function, delay: number) => { const timer = { fn, delay, scheduledAt: Date.now(), unref() {} }; timeouts.push(timer); return timer; };
  (global as any).clearInterval = (timer: any) => { timer.cleared = true; };
  (global as any).clearTimeout = (timer: any) => { timer.cleared = true; };
  const pi: any = {
    events: { emit(event: string, data: any) { emitted.push({ event, data }); }, on() {} },
    on(event: string, fn: Function) { handlers.set(event, [...(handlers.get(event) || []), fn]); },
    eventHandler(event: string, fn: Function) { handlers.set(event, [...(handlers.get(event) || []), fn]); },
    registerTool() {},
    registerCommand() {},
    sendUserMessage(message: string, options: any) { messages.push({ message, options }); },
  };
  const originalNow = Date.now;
  return {
    pi,
    clock,
    handlers,
    intervals,
    timeouts,
    emitted,
    messages,
    restore() {
      handlers.get("session_shutdown")?.[0]?.({ reason: "quit" });
      global.setInterval = original.setInterval;
      global.clearInterval = original.clearInterval;
      global.setTimeout = original.setTimeout;
      global.clearTimeout = original.clearTimeout;
      Date.now = originalNow;
      if (childMarker === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = childMarker;
    },
  };
}

const harnesses = new Set<ReturnType<typeof makeCron>>();
afterEach(() => {
  for (const harness of [...harnesses]) harness.restore();
});

function start(cwd: string, tasks: unknown[] = [], sessionId = "session-one") {
  const store = path.join(cwd, ".pi", "cron", "crons.json");
  if (tasks.length > 0) {
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify({ version: 1, tasks }));
  }
  const h = makeCron();
  harnesses.add(h);
  h.pi.events.on = h.pi.eventHandler;
  const cron = registerCron(h.pi, () => {});
  h.handlers.get("session_start")![0]({}, { cwd, mode: "interactive", hasUI: false, model: {}, isProjectTrusted: () => true, sessionManager: { getSessionId: () => sessionId } });
  return { h, cron, store };
}

const projectTask = (cwd: string) => ({
  id: "job",
  scope: "project",
  cwd,
  description: "audit",
  task: "/status",
  intervalMs: 10_000,
  createdAt: 1,
});

describe("decideCronArm", () => {
  it("skips a paused task whatever its scope or leadership", () => {
    assert.equal(decideCronArm({ paused: true, scope: "session", leader: true }), "skip");
    assert.equal(decideCronArm({ paused: true, scope: "project", leader: true }), "skip");
    assert.equal(decideCronArm({ paused: true, scope: "project" }), "skip");
  });

  it("arms an active task", () => {
    assert.equal(decideCronArm({ scope: "session", leader: true }), "arm");
    assert.equal(decideCronArm({ scope: "project", leader: true }), "arm");
  });

  it("skips a durable task this replica does not lead", () => {
    assert.equal(decideCronArm({ scope: "project", leader: false }), "skip");
  });
});

/** A loaded project cron paused through the public toggle — the fixture the pause tests share. */
function pauseProjectCron() {
  const cwd = makeTempDir("pi-cron-pause-");
  const started = start(cwd, [projectTask(cwd)]);
  const armed = started.h.timeouts.at(-1);
  return { ...started, armed, result: started.cron.togglePaused("persist:job") };
}

/** The same pause, with the store file replaced by a directory: the atomic rename must fail. */
function pauseWithBrokenStore() {
  const cwd = makeTempDir("pi-cron-pause-");
  const started = start(cwd, [projectTask(cwd)]);
  fs.rmSync(started.store);
  fs.mkdirSync(started.store);
  const armed = started.h.timeouts.at(-1);
  return { ...started, armed, result: started.cron.togglePaused("persist:job") };
}

describe("togglePaused (#1089)", () => {
  it("reports the new paused state", () => {
    assert.deepEqual(pauseProjectCron().result, { ok: true, paused: true });
  });

  it("flips the in-memory flag", () => {
    assert.equal(pauseProjectCron().cron.getCronTasks()[0].paused, true);
  });

  it("stores the flag", () => {
    const { store } = pauseProjectCron();
    assert.equal(readDurableCronStore(store).tasks[0].paused, true);
  });

  it("stops the armed timer", () => {
    assert.equal(pauseProjectCron().armed.cleared, true);
  });

  it("re-arms a resumed cron a full interval from now, never immediately", () => {
    const cwd = makeTempDir("pi-cron-pause-");
    const { h, cron } = start(cwd, [projectTask(cwd)]);
    cron.togglePaused("persist:job");
    // The stored nextRun elapses while the cron is paused: resuming must not "catch up".
    h.clock.now = NOW + 10 * 60_000;
    const before = h.timeouts.length;

    const result = cron.togglePaused("persist:job");

    assert.deepEqual(result, { ok: true, paused: false });
    const rearmed = h.timeouts.slice(before);
    assert.equal(rearmed.length, 1);
    assert.equal(rearmed[0].delay, 10_000, "a resume schedules one fresh interval");
    assert.equal(rearmed[0].scheduledAt + rearmed[0].delay, NOW + 10 * 60_000 + 10_000);
  });

  it("reports a missing task instead of claiming a pause", () => {
    const cwd = makeTempDir("pi-cron-pause-");
    const { cron } = start(cwd, [projectTask(cwd)]);
    assert.deepEqual(cron.togglePaused("persist:nope"), { ok: false, paused: false });
  });

  it("reports a failed store write", () => {
    assert.deepEqual(pauseWithBrokenStore().result, { ok: false, paused: false });
  });

  it("leaves the in-memory flag alone when the write failed", () => {
    const { cron } = pauseWithBrokenStore();
    assert.equal(cron.getCronTasks()[0].paused, undefined, "a written flag is the only one shown");
  });

  it("keeps the timer armed when the write failed", () => {
    assert.notEqual(pauseWithBrokenStore().armed.cleared, true);
  });
});

describe("pause across replicas (#1089)", () => {
  it("does not dispatch a cron paused before its timer fires", async () => {
    const cwd = makeTempDir("pi-cron-pause-");
    const { h, store } = start(cwd, [{ ...projectTask(cwd), nextRun: 1 }]);
    // A follower pauses: only the store knows, this replica's timer is still armed.
    fs.writeFileSync(store, JSON.stringify({ version: 1, tasks: [{ ...projectTask(cwd), nextRun: 1, paused: true }] }));

    await h.timeouts.find((timer) => timer.delay === 0)!.fn();

    assert.deepEqual(h.messages, [], "a stored pause must stop the run itself, not only the next one");
  });

  it("does not re-arm a cron paused before its timer fires", async () => {
    const cwd = makeTempDir("pi-cron-pause-");
    const { h, store } = start(cwd, [{ ...projectTask(cwd), nextRun: 1 }]);
    fs.writeFileSync(store, JSON.stringify({ version: 1, tasks: [{ ...projectTask(cwd), nextRun: 1, paused: true }] }));
    const before = h.timeouts.length;

    await h.timeouts.find((timer) => timer.delay === 0)!.fn();

    assert.equal(h.timeouts.length, before, "a skipped fire leaves the task disarmed until a resume");
  });

  it("keeps the stored pause when the leader's timer fires", async () => {
    const cwd = makeTempDir("pi-cron-pause-");
    const { h, store } = start(cwd, [{ ...projectTask(cwd), nextRun: 1 }]);
    fs.writeFileSync(store, JSON.stringify({ version: 1, tasks: [{ ...projectTask(cwd), nextRun: 1, paused: true }] }));

    await h.timeouts.find((timer) => timer.delay === 0)!.fn();

    assert.equal(readDurableCronStore(store).tasks[0].paused, true, "the leader's write must not overwrite the pause");
  });

  it("dispatches when the store says not paused but the in-memory flag does", async () => {
    const cwd = makeTempDir("pi-cron-pause-");
    const { h, cron } = start(cwd, [{ ...projectTask(cwd), nextRun: 1 }]);
    // The stale in-memory copy is the bug's own subject: the STORED value must win.
    cron.getCronTasks()[0].paused = true;
    const before = h.timeouts.length;

    await h.timeouts.find((timer) => timer.delay === 0)!.fn();

    assert.deepEqual(h.messages.map((m) => m.message), ["/status"]);
    assert.equal(h.timeouts.length, before + 1, "an active cron still re-arms");
  });

  it("does not re-arm a cron paused while its execution was running", async () => {
    const cwd = makeTempDir("pi-cron-pause-");
    const { h, store } = start(cwd, [{ ...projectTask(cwd), nextRun: 1 }]);
    const emit = h.pi.events.emit;
    h.pi.events.emit = (event: string, data: any) => {
      // The pause lands mid-run, which is exactly when the timer would re-arm itself.
      if (event === "pidash:cron-status") fs.writeFileSync(store, JSON.stringify({ version: 1, tasks: [{ ...projectTask(cwd), nextRun: 1, paused: true }] }));
      emit(event, data);
    };
    const before = h.timeouts.length;

    await h.timeouts.find((timer) => timer.delay === 0)!.fn();

    assert.deepEqual(h.messages.map((m) => m.message), ["/status"], "the run itself still happened");
    assert.equal(h.timeouts.length, before, "a paused cron must not schedule its next occurrence");
  });

  it("re-arms when a reloaded store disagrees about paused", () => {
    const cwd = makeTempDir("pi-cron-pause-");
    const { h, cron, store } = start(cwd, [{ ...projectTask(cwd), paused: true }]);
    assert.equal(h.timeouts.length, 0, "a paused cron is never armed");
    fs.writeFileSync(store, JSON.stringify({ version: 1, tasks: [projectTask(cwd)] }));

    h.intervals.find((timer) => timer.delay === 10_000)!.fn();

    assert.equal(cron.getCronTasks()[0].paused, undefined);
    const rearmed = h.timeouts.at(-1);
    assert.equal(rearmed.delay, 10_000);
    assert.equal(rearmed.cleared, undefined);
  });

  it("reports the paused flag to pidash", () => {
    const cwd = makeTempDir("pi-cron-pause-");
    const { h } = start(cwd, [{ ...projectTask(cwd), paused: true }]);
    const status = h.emitted.filter(({ event }) => event === "pidash:cron-status").at(-1)!.data;
    assert.equal(status.tasks[0].paused, true);
  });
});
