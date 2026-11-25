/**
 * #1381 — cron_manage edit, pause, and resume actions (session & durable scopes).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { registerCron } from "../../../extensions/orchestrator/cron.ts";
import { readDurableCronStore } from "../../../extensions/orchestrator/cron-store.ts";
import { makeTempDir } from "../helpers/temp-dirs.ts";

const NOW = 200_000;

function makeCron(spawnAsyncAgent: (...args: any[]) => void = () => {}) {
  const handlers = new Map<string, Function[]>();
  let tool: any;
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
    dateNow: Date.now,
  };
  const clock = { now: NOW };
  Date.now = () => clock.now;
  (global as any).setInterval = (fn: Function, delay: number) => {
    const timer = { fn, delay, unref() {} };
    intervals.push(timer);
    return timer;
  };
  (global as any).setTimeout = (fn: Function, delay: number) => {
    const timer = { fn, delay, scheduledAt: Date.now(), unref() {} };
    timeouts.push(timer);
    return timer;
  };
  (global as any).clearInterval = (timer: any) => { if (timer) timer.cleared = true; };
  (global as any).clearTimeout = (timer: any) => { if (timer) timer.cleared = true; };
  const pi: any = {
    events: { emit(event: string, data: any) { emitted.push({ event, data }); }, on() {} },
    on(event: string, fn: Function) { handlers.set(event, [...(handlers.get(event) || []), fn]); },
    registerTool(spec: any) { tool = spec; },
    registerCommand() {},
    sendUserMessage(message: string, options: any) { messages.push({ message, options }); },
  };
  const cron = registerCron(pi, spawnAsyncAgent);
  return {
    pi,
    cron,
    clock,
    handlers,
    intervals,
    timeouts,
    emitted,
    messages,
    tool: () => tool,
    restore() {
      handlers.get("session_shutdown")?.[0]?.({ reason: "quit" });
      global.setInterval = original.setInterval;
      global.clearInterval = original.clearInterval;
      global.setTimeout = original.setTimeout;
      global.clearTimeout = original.clearTimeout;
      Date.now = original.dateNow;
      if (childMarker === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = childMarker;
    },
  };
}

const harnesses = new Set<ReturnType<typeof makeCron>>();
afterEach(() => {
  for (const h of [...harnesses]) h.restore();
  harnesses.clear();
});

function start(cwd: string, tasks: unknown[] = [], sessionId = "session-manage", spawnFn?: (...args: any[]) => void) {
  const store = path.join(cwd, ".pi", "cron", "crons.json");
  if (tasks.length > 0) {
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify({ version: 1, tasks }));
  }
  const h = makeCron(spawnFn);
  harnesses.add(h);
  h.handlers.get("session_start")![0]({}, {
    cwd,
    mode: "interactive",
    hasUI: false,
    model: {},
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => sessionId },
  });
  return { h, store };
}

async function execTool(h: ReturnType<typeof makeCron>, params: Record<string, unknown>): Promise<string> {
  const result = await h.tool().execute("call-1", params);
  return result.content[0].text;
}

const projectTask = (cwd: string, overrides: Record<string, unknown> = {}) => ({
  id: "job-1",
  scope: "project",
  cwd,
  description: "original desc",
  task: "/status",
  intervalMs: 60_000,
  model: "openrouter/anthropic/claude-opus-5",
  createdAt: 1_000,
  lastRun: 50_000,
  nextRun: NOW + 60_000,
  ...overrides,
});

describe("cron_manage edit (#1381)", () => {
  it("edits task, description, and model in place on a session cron without resetting id/createdAt/timer", async () => {
    const cwd = makeTempDir("pi-cron-edit-session-");
    const spawned: any[] = [];
    const { h } = start(cwd, [], "sess-edit", (...args: any[]) => spawned.push(args));

    await execTool(h, { action: "add", description: "check issues", task: "list issues", interval_seconds: 60, model: "gpt-5" });
    const created = h.cron.getCronTasks()[0];
    const originalTimer = h.timeouts.at(-1);
    const originalCreatedAt = created.createdAt;
    const originalNextRun = created.nextRun;

    const out = await execTool(h, {
      action: "edit",
      id: `session:${created.id}`,
      description: "check PRs",
      task: "list open PRs",
      model: "anthropic/claude-sonnet-4",
    });

    assert.match(out, new RegExp(`^Cron session:${created.id} updated: every 1m → check PRs \\[anthropic/claude-sonnet-4\\]$`));
    const updated = h.cron.getCronTasks()[0];
    assert.equal(updated.id, created.id);
    assert.equal(updated.createdAt, originalCreatedAt);
    assert.equal(updated.nextRun, originalNextRun);
    assert.equal(updated.description, "check PRs");
    assert.equal(updated.task, "list open PRs");
    assert.equal(updated.model, "anthropic/claude-sonnet-4");
    assert.notEqual(originalTimer.cleared, true, "non-schedule edit keeps the armed timer intact");

    // Next fire of the already-armed timer executes the edited prompt and model.
    await originalTimer.fn();
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0][1], "list open PRs");
    assert.deepEqual(spawned[0][4].explicit, { provider: "anthropic", model: "claude-sonnet-4" });
  });

  it("clears a pinned model back to inherited when model is empty string", async () => {
    const cwd = makeTempDir("pi-cron-edit-clear-model-");
    const { h, store } = start(cwd, [projectTask(cwd)]);

    const out = await execTool(h, { action: "edit", id: "persist:job-1", model: "" });

    assert.match(out, /^Cron persist:job-1 updated: every 1m → original desc$/);
    assert.equal(h.cron.getCronTasks()[0].model, undefined);
    assert.equal(readDurableCronStore(store).tasks[0].model, undefined);
  });

  it("switches schedule between interval and daily and re-arms timer", async () => {
    const cwd = makeTempDir("pi-cron-edit-schedule-");
    const { h, store } = start(cwd, [projectTask(cwd)]);
    const firstTimer = h.timeouts.at(-1);

    // interval -> daily
    const dailyOut = await execTool(h, { action: "edit", id: "persist:job-1", at_hour: 9, at_minute: 30 });
    assert.match(dailyOut, /daily at 09:30/);
    assert.equal(firstTimer.cleared, true);
    let stored = readDurableCronStore(store).tasks[0];
    assert.equal(stored.intervalMs, undefined);
    assert.equal(stored.atHour, 9);
    assert.equal(stored.atMinute, 30);
    assert.equal(stored.createdAt, 1_000);
    assert.equal(stored.lastRun, 50_000);

    // update only at_minute on existing daily cron
    const minOut = await execTool(h, { action: "edit", id: "persist:job-1", at_minute: 45 });
    assert.match(minOut, /daily at 09:45/);
    stored = readDurableCronStore(store).tasks[0];
    assert.equal(stored.atHour, 9);
    assert.equal(stored.atMinute, 45);

    // daily -> interval
    const intOut = await execTool(h, { action: "edit", id: "persist:job-1", interval_seconds: 120 });
    assert.match(intOut, /every 2m/);
    stored = readDurableCronStore(store).tasks[0];
    assert.equal(stored.intervalMs, 120_000);
    assert.equal(stored.atHour, undefined);
    assert.equal(stored.atMinute, undefined);
    assert.equal(h.timeouts.at(-1).delay, 120_000);
  });

  it("preserves paused state and does not arm a timer when editing a paused cron", async () => {
    const cwd = makeTempDir("pi-cron-edit-paused-");
    const { h, store } = start(cwd, [projectTask(cwd, { paused: true })]);
    assert.equal(h.timeouts.length, 0);

    const out = await execTool(h, { action: "edit", id: "persist:job-1", interval_seconds: 30, description: "still paused" });

    assert.match(out, /still paused.*\(paused\)$/);
    assert.equal(h.timeouts.length, 0, "editing a paused cron must not arm a timer");
    assert.equal(h.cron.getCronTasks()[0].paused, true);
    assert.equal(readDurableCronStore(store).tasks[0].paused, true);
  });

  it("rejects invalid edit payloads without modifying the task or timer", async () => {
    const cwd = makeTempDir("pi-cron-edit-invalid-");
    const { h, store } = start(cwd, [projectTask(cwd)]);
    const before = structuredClone(readDurableCronStore(store).tasks[0]);
    const armed = h.timeouts.at(-1);

    assert.match(await execTool(h, { action: "edit", id: "persist:job-1" }), /^Error: at least one field/);
    assert.match(await execTool(h, { action: "edit", id: "persist:job-1", interval_seconds: 5 }), /^Error: interval_seconds/);
    assert.match(await execTool(h, { action: "edit", id: "persist:job-1", interval_seconds: 60, at_hour: 9 }), /^Error: specify either/);
    assert.match(await execTool(h, { action: "edit", id: "persist:job-1", at_minute: 15 }), /^Error: at_minute requires at_hour/);
    assert.match(await execTool(h, { action: "edit", id: "persist:job-1", task: "   " }), /^Error: task must be/);
    assert.match(await execTool(h, { action: "edit", id: "persist:job-1", description: "" }), /^Error: description must be/);
    assert.match(await execTool(h, { action: "edit", id: "persist:job-1", model: "bad/" }), /^Error: model must be/);
    assert.equal(await execTool(h, { action: "edit", id: "persist:missing", description: "x" }), "Task not found.");
    assert.equal(await execTool(h, { action: "edit", id: "bad-id", description: "x" }), "Task not found.");

    assert.deepEqual(readDurableCronStore(store).tasks[0], before);
    assert.notEqual(armed.cleared, true);
  });

  it("propagates cleared optional fields across replicas via syncStore and preserves peer edits on persist", async () => {
    const cwd = makeTempDir("pi-cron-edit-sync-");
    const { h, store } = start(cwd, [projectTask(cwd, { nextRun: 1 })]);

    // Peer edits the durable store: clears model and switches interval -> daily.
    fs.writeFileSync(store, JSON.stringify({
      version: 1,
      tasks: [{
        id: "job-1",
        scope: "project",
        cwd,
        description: "peer edited",
        task: "/peer-cmd",
        atHour: 8,
        atMinute: 15,
        createdAt: 1_000,
      }],
    }));

    // Health tick triggers syncStore on leader.
    h.intervals.find((t) => t.delay === 10_000)!.fn();

    const synced = h.cron.getCronTasks()[0];
    assert.equal(synced.description, "peer edited");
    assert.equal(synced.task, "/peer-cmd");
    assert.equal(synced.model, undefined, "syncStore must clear removed model");
    assert.equal(synced.intervalMs, undefined, "syncStore must clear removed intervalMs");
    assert.equal(synced.atHour, 8);
    assert.equal(synced.atMinute, 15);
  });

  it("does not clobber a peer edit when the leader persists lastRun", async () => {
    const cwd = makeTempDir("pi-cron-edit-peer-persist-");
    const { h, store } = start(cwd, [projectTask(cwd, { nextRun: 1 })]);

    // Peer updates task text on disk before the leader's timer fires.
    fs.writeFileSync(store, JSON.stringify({
      version: 1,
      tasks: [projectTask(cwd, { nextRun: 1, task: "/peer-updated", description: "peer desc", model: undefined })],
    }));

    await h.timeouts.find((t) => t.delay === 0)!.fn();

    assert.deepEqual(h.messages.map((m) => m.message), ["/peer-updated"]);
    const after = readDurableCronStore(store).tasks[0];
    assert.equal(after.task, "/peer-updated");
    assert.equal(after.description, "peer desc");
    assert.equal(after.model, undefined);
    assert.equal(after.lastRun, NOW);
  });
});

describe("cron_manage pause & resume (#1381)", () => {
  it("pauses and resumes a session cron idempotently with a fresh interval on resume", async () => {
    const cwd = makeTempDir("pi-cron-pause-session-");
    const { h } = start(cwd);
    await execTool(h, { action: "add", description: "ping", task: "/ping", interval_seconds: 30 });
    const id = `session:${h.cron.getCronTasks()[0].id}`;
    const armed = h.timeouts.at(-1);

    assert.equal(await execTool(h, { action: "pause", id }), `Cron ${id} paused.`);
    assert.equal(armed.cleared, true);
    assert.equal(h.cron.getCronTasks()[0].paused, true);

    // Idempotent second pause
    assert.equal(await execTool(h, { action: "pause", id }), `Cron ${id} is already paused.`);

    // Advance past old nextRun: resume must schedule a fresh full interval, never catch up.
    h.clock.now = NOW + 10 * 60_000;
    const before = h.timeouts.length;
    assert.equal(await execTool(h, { action: "resume", id }), `Cron ${id} resumed.`);
    assert.equal(h.cron.getCronTasks()[0].paused, false);
    const rearmed = h.timeouts.slice(before);
    assert.equal(rearmed.length, 1);
    assert.equal(rearmed[0].delay, 30_000);

    // Idempotent second resume
    assert.equal(await execTool(h, { action: "resume", id }), `Cron ${id} is already active.`);
  });

  it("pauses and resumes a durable cron and respects peer-written pause state on disk", async () => {
    const cwd = makeTempDir("pi-cron-pause-durable-");
    const { h, store } = start(cwd, [projectTask(cwd)]);

    // Simulate another replica pausing the cron directly on disk without syncing this replica.
    fs.writeFileSync(store, JSON.stringify({ version: 1, tasks: [projectTask(cwd, { paused: true })] }));

    // Resume on this replica must read disk state first and unpause instead of saying "already active".
    assert.equal(await execTool(h, { action: "resume", id: "persist:job-1" }), "Cron persist:job-1 resumed.");
    assert.equal(readDurableCronStore(store).tasks[0].paused, false);

    assert.equal(await execTool(h, { action: "pause", id: "persist:job-1" }), "Cron persist:job-1 paused.");
    assert.equal(readDurableCronStore(store).tasks[0].paused, true);
  });

  it("reports missing tasks and store errors cleanly on pause/resume", async () => {
    const cwd = makeTempDir("pi-cron-pause-errors-");
    const { h, store } = start(cwd, [projectTask(cwd)]);

    assert.equal(await execTool(h, { action: "pause", id: "persist:nope" }), "Task not found.");
    assert.equal(await execTool(h, { action: "resume", id: "session:nope" }), "Task not found.");
    assert.equal(await execTool(h, { action: "pause", id: "bad-id" }), "Task not found.");

    // Replace store file with a directory to force read/write failure.
    const armed = h.timeouts.at(-1);
    fs.rmSync(store);
    fs.mkdirSync(store);
    assert.equal(await execTool(h, { action: "pause", id: "persist:job-1" }), "Error: Failed to pause cron.");
    assert.equal(h.cron.getCronTasks()[0].paused, undefined);
    assert.notEqual(armed.cleared, true);
  });
});
