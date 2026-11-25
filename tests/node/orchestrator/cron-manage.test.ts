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
  const timers: Array<{ fn: Function; delay: number; scheduledAt: number; cleared?: boolean }> = [];
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
  (global as any).setInterval = (fn: Function, delay: number) => ({ fn, delay, unref() {} });
  (global as any).setTimeout = (fn: Function, delay: number) => {
    const timer = { fn, delay, scheduledAt: Date.now(), unref() {} };
    timers.push(timer);
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
    timers,
    emitted,
    messages,
    tool: () => tool,
    /** Fire the currently active (non-cleared) scheduled timer. */
    async fireActive() {
      const active = [...timers].reverse().find((t) => !t.cleared);
      assert.ok(active, "expected an active scheduled timer");
      await active.fn();
    },
    hasActiveTimer() {
      return timers.some((t) => !t.cleared);
    },
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
  it("edits session task metadata in place while preserving id, createdAt, and nextRun", async () => {
    const cwd = makeTempDir("pi-cron-edit-session-");
    const { h } = start(cwd, [], "sess-edit-meta");

    await execTool(h, { action: "add", description: "check issues", task: "list issues", interval_seconds: 60, model: "gpt-5" });
    const created = h.cron.getCronTasks()[0];
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
  });

  it("dispatches the edited prompt and model on the next scheduled run", async () => {
    const cwd = makeTempDir("pi-cron-edit-dispatch-");
    const spawned: any[] = [];
    const { h } = start(cwd, [], "sess-edit-dispatch", (...args: any[]) => spawned.push(args));

    await execTool(h, { action: "add", description: "check issues", task: "list issues", interval_seconds: 60, model: "gpt-5" });
    const id = `session:${h.cron.getCronTasks()[0].id}`;
    await execTool(h, { action: "edit", id, description: "check PRs", task: "list open PRs", model: "anthropic/claude-sonnet-4" });

    await h.fireActive();
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0][1], "list open PRs");
    assert.deepEqual(spawned[0][4].explicit, { provider: "anthropic", model: "claude-sonnet-4" });
  });

  it("leaves a session cron unchanged in memory when the session store write fails", async () => {
    const cwd = makeTempDir("pi-cron-edit-session-fail-");
    const { h } = start(cwd, [], "sess-write-fail");
    await execTool(h, { action: "add", description: "original", task: "/orig", interval_seconds: 60 });
    const before = structuredClone(h.cron.getCronTasks()[0]);
    // Replace session cron file with a directory so writeSessionTasks fails.
    const tmpDir = path.join(cwd, ".pi", "tmp");
    const sessionFile = fs.readdirSync(tmpDir).find((f) => f.startsWith("cron-") && f.endsWith(".json"));
    assert.ok(sessionFile, "expected session cron file");
    const fullPath = path.join(tmpDir, sessionFile);
    fs.rmSync(fullPath);
    fs.mkdirSync(fullPath);

    const out = await execTool(h, { action: "edit", id: `session:${before.id}`, description: "broken", interval_seconds: 120 });

    assert.match(out, /^Error:/);
    assert.deepEqual(h.cron.getCronTasks()[0], before);
  });

  it("clears a pinned model back to inherited when model is empty string", async () => {
    const cwd = makeTempDir("pi-cron-edit-clear-model-");
    const { h, store } = start(cwd, [projectTask(cwd)]);

    const out = await execTool(h, { action: "edit", id: "persist:job-1", model: "" });

    assert.match(out, /^Cron persist:job-1 updated: every 1m → original desc$/);
    assert.equal(h.cron.getCronTasks()[0].model, undefined);
    assert.equal(readDurableCronStore(store).tasks[0].model, undefined);
  });

  it("switches an interval cron to a daily schedule", async () => {
    const cwd = makeTempDir("pi-cron-edit-to-daily-");
    const { h, store } = start(cwd, [projectTask(cwd)]);

    const out = await execTool(h, { action: "edit", id: "persist:job-1", at_hour: 9, at_minute: 30 });

    assert.match(out, /daily at 09:30/);
    const stored = readDurableCronStore(store).tasks[0];
    assert.equal(stored.intervalMs, undefined);
    assert.equal(stored.atHour, 9);
    assert.equal(stored.atMinute, 30);
    assert.equal(stored.createdAt, 1_000);
    assert.equal(stored.lastRun, 50_000);
    assert.notEqual(h.cron.getCronTasks()[0].nextRun, NOW + 60_000);
  });

  it("updates at_minute on an existing daily schedule without requiring at_hour", async () => {
    const cwd = makeTempDir("pi-cron-edit-daily-min-");
    const { h, store } = start(cwd, [projectTask(cwd, { intervalMs: undefined, atHour: 9, atMinute: 30 })]);

    const out = await execTool(h, { action: "edit", id: "persist:job-1", at_minute: 45 });

    assert.match(out, /daily at 09:45/);
    const stored = readDurableCronStore(store).tasks[0];
    assert.equal(stored.atHour, 9);
    assert.equal(stored.atMinute, 45);
  });

  it("switches a daily cron back to an interval schedule", async () => {
    const cwd = makeTempDir("pi-cron-edit-to-interval-");
    const { h, store } = start(cwd, [projectTask(cwd, { intervalMs: undefined, atHour: 9, atMinute: 30 })]);

    const out = await execTool(h, { action: "edit", id: "persist:job-1", interval_seconds: 120 });

    assert.match(out, /every 2m/);
    const stored = readDurableCronStore(store).tasks[0];
    assert.equal(stored.intervalMs, 120_000);
    assert.equal(stored.atHour, undefined);
    assert.equal(stored.atMinute, undefined);
    assert.equal(h.cron.getCronTasks()[0].nextRun, NOW + 120_000);
  });

  it("keeps a paused cron disarmed when edited", async () => {
    const cwd = makeTempDir("pi-cron-edit-paused-");
    const { h, store } = start(cwd, [projectTask(cwd, { paused: true })]);
    assert.equal(h.hasActiveTimer(), false);

    const out = await execTool(h, { action: "edit", id: "persist:job-1", interval_seconds: 30, description: "still paused" });

    assert.match(out, /still paused.*\(paused\)$/);
    assert.equal(h.hasActiveTimer(), false, "editing a paused cron must not arm a timer");
    assert.equal(h.cron.getCronTasks()[0].paused, true);
    assert.equal(readDurableCronStore(store).tasks[0].paused, true);
  });

  it("rejects invalid edit payloads without modifying stored task state", async () => {
    const cwd = makeTempDir("pi-cron-edit-invalid-");
    const { h, store } = start(cwd, [projectTask(cwd)]);
    const before = structuredClone(readDurableCronStore(store).tasks[0]);

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
    assert.equal(h.hasActiveTimer(), true);
  });

  it("clears removed optional fields when syncing a peer edit from disk", () => {
    const cwd = makeTempDir("pi-cron-edit-sync-");
    const { h, store } = start(cwd, [projectTask(cwd, { nextRun: 1 })]);

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

    h.cron.syncProjectCrons();

    const synced = h.cron.getCronTasks()[0];
    assert.equal(synced.description, "peer edited");
    assert.equal(synced.task, "/peer-cmd");
    assert.equal(synced.model, undefined, "syncProjectCrons must clear removed model");
    assert.equal(synced.intervalMs, undefined, "syncProjectCrons must clear removed intervalMs");
    assert.equal(synced.atHour, 8);
    assert.equal(synced.atMinute, 15);
  });

  it("preserves a peer edit on disk when the leader records lastRun", async () => {
    const cwd = makeTempDir("pi-cron-edit-peer-persist-");
    const { h, store } = start(cwd, [projectTask(cwd, { nextRun: 1 })]);

    fs.writeFileSync(store, JSON.stringify({
      version: 1,
      tasks: [projectTask(cwd, { nextRun: 1, task: "/peer-updated", description: "peer desc", model: undefined })],
    }));

    await h.fireActive();

    assert.deepEqual(h.messages.map((m) => m.message), ["/peer-updated"]);
    const after = readDurableCronStore(store).tasks[0];
    assert.equal(after.task, "/peer-updated");
    assert.equal(after.description, "peer desc");
    assert.equal(after.model, undefined);
    assert.equal(after.lastRun, NOW);
  });

  it("uses peer-edited slash command after awaiting agent module discovery", async () => {
    const cwd = makeTempDir("pi-cron-edit-mid-exec-");
    const spawned: any[] = [];
    const { h, store } = start(cwd, [projectTask(cwd, { task: "run audit", nextRun: 1 })], "sess-mid", (...args: any[]) => spawned.push(args));

    // When execute() writes lastRun to disk, simulate a peer simultaneously editing the task into a slash command.
    const emit = h.pi.events.emit;
    let swapped = false;
    h.pi.events.emit = (event: string, data: any) => {
      if (!swapped && event === "pidash:cron-status" && data.tasks[0]?.lastRun === NOW) {
        swapped = true;
        fs.writeFileSync(store, JSON.stringify({
          version: 1,
          tasks: [projectTask(cwd, { task: "/peer-slash", description: "now slash", nextRun: 1 })],
        }));
      }
      emit(event, data);
    };

    await h.fireActive();

    assert.equal(spawned.length, 0, "edited slash command must not spawn an async worker");
    assert.deepEqual(h.messages.map((m) => m.message), ["/peer-slash"]);
  });

  it("does not overwrite a peer-edited schedule's nextRun when re-arming", async () => {
    const cwd = makeTempDir("pi-cron-edit-nextrun-");
    const { h, store } = start(cwd, [projectTask(cwd, { intervalMs: 60_000, nextRun: 1 })]);

    // Mid-run, a peer changes the schedule from 60s to 300s (clearing nextRun on disk).
    const emit = h.pi.events.emit;
    let edited = false;
    h.pi.events.emit = (event: string, data: any) => {
      if (!edited && event === "pidash:cron-status" && data.tasks[0]?.lastRun === NOW) {
        edited = true;
        fs.writeFileSync(store, JSON.stringify({
          version: 1,
          tasks: [projectTask(cwd, { intervalMs: 300_000, nextRun: undefined })],
        }));
      }
      emit(event, data);
    };

    await h.fireActive();

    const stored = readDurableCronStore(store).tasks[0];
    assert.equal(stored.intervalMs, 300_000);
    assert.equal(stored.nextRun, NOW + 300_000, "re-arm must use the peer's 300s schedule, not the stale 60s one");
  });
});

describe("cron_manage pause & resume (#1381)", () => {
  it("pauses a session cron and disarms its timer", async () => {
    const cwd = makeTempDir("pi-cron-pause-one-");
    const { h } = start(cwd);
    await execTool(h, { action: "add", description: "ping", task: "/ping", interval_seconds: 30 });
    const id = `session:${h.cron.getCronTasks()[0].id}`;

    const out = await execTool(h, { action: "pause", id });

    assert.equal(out, `Cron ${id} paused.`);
    assert.equal(h.cron.getCronTasks()[0].paused, true);
    assert.equal(h.hasActiveTimer(), false);
  });

  it("treats a repeated pause on a session cron as a no-op", async () => {
    const cwd = makeTempDir("pi-cron-pause-idem-");
    const { h } = start(cwd);
    await execTool(h, { action: "add", description: "ping", task: "/ping", interval_seconds: 30 });
    const id = `session:${h.cron.getCronTasks()[0].id}`;
    await execTool(h, { action: "pause", id });

    const out = await execTool(h, { action: "pause", id });

    assert.equal(out, `Cron ${id} is already paused.`);
    assert.equal(h.hasActiveTimer(), false);
  });

  it("resumes a paused session cron on a fresh interval without catch-up", async () => {
    const cwd = makeTempDir("pi-cron-resume-fresh-");
    const { h } = start(cwd);
    await execTool(h, { action: "add", description: "ping", task: "/ping", interval_seconds: 30 });
    const id = `session:${h.cron.getCronTasks()[0].id}`;
    await execTool(h, { action: "pause", id });

    h.clock.now = NOW + 10 * 60_000;
    const out = await execTool(h, { action: "resume", id });

    assert.equal(out, `Cron ${id} resumed.`);
    assert.equal(h.cron.getCronTasks()[0].paused, false);
    assert.equal(h.cron.getCronTasks()[0].nextRun, NOW + 10 * 60_000 + 30_000);
  });

  it("treats a repeated resume on an active session cron as a no-op", async () => {
    const cwd = makeTempDir("pi-cron-resume-idem-");
    const { h } = start(cwd);
    await execTool(h, { action: "add", description: "ping", task: "/ping", interval_seconds: 30 });
    const id = `session:${h.cron.getCronTasks()[0].id}`;
    const nextRunBefore = h.cron.getCronTasks()[0].nextRun;

    const out = await execTool(h, { action: "resume", id });

    assert.equal(out, `Cron ${id} is already active.`);
    assert.equal(h.cron.getCronTasks()[0].nextRun, nextRunBefore);
  });

  it("resumes a durable cron paused by another replica using the peer's latest schedule", async () => {
    const cwd = makeTempDir("pi-cron-resume-peer-schedule-");
    const { h, store } = start(cwd, [projectTask(cwd, { intervalMs: 60_000 })]);

    // Peer both pauses the cron and changes its interval from 60s to 180s on disk.
    fs.writeFileSync(store, JSON.stringify({
      version: 1,
      tasks: [projectTask(cwd, { intervalMs: 180_000, paused: true, nextRun: undefined })],
    }));

    const out = await execTool(h, { action: "resume", id: "persist:job-1" });

    assert.equal(out, "Cron persist:job-1 resumed.");
    assert.equal(readDurableCronStore(store).tasks[0].paused, false);
    assert.equal(h.cron.getCronTasks()[0].intervalMs, 180_000);
    assert.equal(h.cron.getCronTasks()[0].nextRun, NOW + 180_000);
  });

  it("pauses an active durable cron on disk", async () => {
    const cwd = makeTempDir("pi-cron-pause-durable-");
    const { h, store } = start(cwd, [projectTask(cwd)]);

    const out = await execTool(h, { action: "pause", id: "persist:job-1" });

    assert.equal(out, "Cron persist:job-1 paused.");
    assert.equal(readDurableCronStore(store).tasks[0].paused, true);
    assert.equal(h.hasActiveTimer(), false);
  });

  it("returns Task not found for missing or malformed ids on pause or resume", async () => {
    const cwd = makeTempDir("pi-cron-pause-missing-");
    const { h } = start(cwd, [projectTask(cwd)]);

    assert.equal(await execTool(h, { action: "pause", id: "persist:nope" }), "Task not found.");
    assert.equal(await execTool(h, { action: "resume", id: "session:nope" }), "Task not found.");
    assert.equal(await execTool(h, { action: "pause", id: "bad-id" }), "Task not found.");
  });

  it("leaves durable state and timer unchanged when a pause write fails", async () => {
    const cwd = makeTempDir("pi-cron-pause-write-fail-");
    const { h, store } = start(cwd, [projectTask(cwd)]);
    fs.rmSync(store);
    fs.mkdirSync(store);

    const out = await execTool(h, { action: "pause", id: "persist:job-1" });

    assert.equal(out, "Error: Failed to pause cron.");
    assert.equal(h.cron.getCronTasks()[0].paused, undefined);
    assert.equal(h.hasActiveTimer(), true);
  });
});
