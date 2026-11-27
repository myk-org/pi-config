/**
 * #1452 — quiet_on_noop mode for cron_manage, async-agents delivery, and /cron formatting.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  registerAsyncAgents,
  shouldSuppressQuietNoop,
} from "../../../extensions/orchestrator/async-agents.js";
import {
  CRON_QUIET_NOOP_PROMPT_SUFFIX,
  isCronNoopOutput,
  registerCron,
} from "../../../extensions/orchestrator/cron.js";
import {
  applyCronRunOutcomeUpdate,
  readDurableCronStore,
  recordDurableCronRunOutcome,
  releaseLeaderLock,
  acquireLeaderLock,
  validateDurableCronTask,
  type DurableCronTask,
} from "../../../extensions/orchestrator/cron-store.js";
import {
  cronDetailRows,
  formatCronQuietBadge,
  formatLastRunLabel,
  toCronStatusTaskView,
} from "../../../extensions/orchestrator/cron-status-format.js";
import { openCronStatusOverlay } from "../../../extensions/orchestrator/cron-status-ui.js";
import { getPiLogPath, setGlobalSessionId } from "../../../extensions/shared/file-logger.js";
import { fakeAgent, fakeSpawnProcess } from "../helpers/fake-async-runtime.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

setGlobalSessionId("cron-quiet-noop-test");

const NOW = 500_000;

interface IntegratedHarness {
  cwd: string;
  clock: { now: number };
  messages: Array<{ message: any; options: any }>;
  terminalNotifies: Array<{ title: string; body: string }>;
  spawnedCalls: Array<{ agentName: string; task: string; options: any }>;
  cron: ReturnType<typeof registerCron>;
  asyncApi: ReturnType<typeof registerAsyncAgents>;
  execTool: (params: Record<string, unknown>) => Promise<string>;
  fireCronTimer: () => Promise<void>;
  triggerPoller: () => void;
  flushShortTimers: () => Promise<void>;
  finishJob: (id: string, output: string, opts?: { success?: boolean; exitCode?: number }) => void;
  shutdown: (reason?: string) => void;
  restore: () => void;
}

const activeHarnesses = new Set<IntegratedHarness>();
afterEach(() => {
  for (const h of [...activeHarnesses]) h.restore();
  activeHarnesses.clear();
});

function createIntegratedHarness(
  opts: {
    cwd?: string;
    sessionId?: string;
    spawnOverride?: (...args: any[]) => any;
  } = {},
): IntegratedHarness {
  const cwd = opts.cwd ?? makeTempDir("pi-cron-quiet-noop-");
  const sessionId = opts.sessionId ?? "sess-quiet-noop";
  const handlers = new Map<string, Array<(event: unknown, ctx: any) => void>>();
  const events = new EventEmitter();
  const messages: Array<{ message: any; options: any }> = [];
  const terminalNotifies: Array<{ title: string; body: string }> = [];
  const spawnedCalls: Array<{ agentName: string; task: string; options: any }> = [];
  const cronTimers: Array<{ fn: Function; delay: number; cleared?: boolean }> = [];
  const shortTimers: Array<{ fn: Function; delay: number; cleared?: boolean }> = [];
  let poller: (() => void) | undefined;
  let cronTool: any;

  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalDateNow = Date.now;

  const clock = { now: NOW };
  Date.now = () => clock.now;
  (global as any).setInterval = (fn: () => void, delay: number) => {
    // Async poller uses 3000ms interval; cron health uses 10000ms.
    if (delay === 3000) poller = fn;
    return { fn, delay, unref() {} };
  };
  (global as any).clearInterval = () => {};
  (global as any).setTimeout = (fn: Function, delay: number) => {
    const timer = { fn, delay, cleared: false, unref() {} };
    // Capture cron schedule timers (>= 10_000ms) separately from short internal waits.
    if (delay >= 10_000) cronTimers.push(timer);
    else shortTimers.push(timer);
    return timer;
  };
  (global as any).clearTimeout = (timer: any) => {
    if (timer && typeof timer === "object") timer.cleared = true;
  };

  const pi: any = {
    events,
    on(event: string, fn: (event: unknown, ctx: any) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    registerTool(spec: any) {
      if (spec.name === "cron_manage") cronTool = spec;
    },
    registerCommand() {},
    sendMessage(message: any, options?: any) {
      messages.push({ message, options });
    },
    sendUserMessage(message: string, options?: any) {
      messages.push({ message, options });
    },
  };

  let asyncApi!: ReturnType<typeof registerAsyncAgents>;
  let cron!: ReturnType<typeof registerCron>;
  withSubagentChildEnv(undefined, () => {
    asyncApi = registerAsyncAgents(
      pi,
      (title, body) => terminalNotifies.push({ title, body }),
      {
        spawnProcess: fakeSpawnProcess(),
        discoverAgents: () => ({ agents: [fakeAgent("worker")] }),
      },
    );
    const wrappedSpawn: typeof asyncApi.spawnAsyncAgent = (agentName, task, jobCwd, _agents, options) => {
      spawnedCalls.push({ agentName, task, options });
      if (opts.spawnOverride) return opts.spawnOverride(agentName, task, jobCwd, [fakeAgent("worker")], options);
      return asyncApi.spawnAsyncAgent(agentName, task, jobCwd, [fakeAgent("worker")], options);
    };
    cron = registerCron(pi, wrappedSpawn);
  });

  const ctx = {
    cwd,
    mode: "interactive",
    hasUI: true,
    ui: {
      theme: { fg: (_: string, text: string) => text },
      notify() {},
    },
    isProjectTrusted: () => true,
    sessionManager: { getCwd: () => cwd, getSessionId: () => sessionId },
  };
  for (const fn of handlers.get("session_start") ?? []) fn({}, ctx);

  const resultDir = () => {
    const tmp = path.join(cwd, ".pi", "tmp");
    const name = fs.readdirSync(tmp).find((entry) => entry.startsWith(`async-results-pid-${process.pid}`));
    assert.ok(name, "expected async results dir to exist");
    return path.join(tmp, name);
  };

  const finishJob = (id: string, output: string, jobOpts: { success?: boolean; exitCode?: number } = {}) => {
    const success = jobOpts.success ?? true;
    const exitCode = jobOpts.exitCode ?? (success ? 0 : 1);
    const workerDir = path.join(cwd, ".pi", "tmp", id);
    fs.writeFileSync(
      path.join(workerDir, "status.json"),
      JSON.stringify({ runId: id, state: "running", pid: process.pid }),
    );
    fs.writeFileSync(
      path.join(resultDir(), `${id}.json`),
      JSON.stringify({ id, agent: "worker", task: "cron check", success, output, durationMs: 25, exitCode }),
    );
    assert.ok(poller, "expected async poller to be registered");
    poller();
  };

  let shutDown = false;
  const shutdown = (reason = "quit") => {
    if (shutDown) return;
    shutDown = true;
    for (const fn of handlers.get("session_shutdown") ?? []) fn({ reason }, ctx);
  };

  const harness: IntegratedHarness = {
    cwd,
    clock,
    messages,
    terminalNotifies,
    spawnedCalls,
    cron,
    asyncApi,
    async execTool(params) {
      const res = await cronTool.execute("call-1", params);
      return res.content[0].text;
    },
    async fireCronTimer() {
      const active = [...cronTimers].reverse().find((t) => !t.cleared);
      assert.ok(active, "expected an active cron timer");
      await active.fn();
    },
    triggerPoller() {
      assert.ok(poller, "expected async poller to be registered");
      poller();
    },
    async flushShortTimers() {
      for (let round = 0; round < 5; round++) {
        const pending = shortTimers.splice(0, shortTimers.length).filter((t) => !t.cleared);
        for (const t of pending) t.fn();
        for (let i = 0; i < 10; i++) await Promise.resolve();
      }
    },
    finishJob,
    shutdown,
    restore() {
      try {
        shutdown("quit");
      } finally {
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
        Date.now = originalDateNow;
      }
    },
  };
  activeHarnesses.add(harness);
  return harness;
}

function cronLogOffset(): number {
  const file = getPiLogPath("cron");
  return file && fs.existsSync(file) ? fs.readFileSync(file, "utf-8").length : 0;
}

function cronLogSince(offset: number): string {
  const file = getPiLogPath("cron");
  return file && fs.existsSync(file) ? fs.readFileSync(file, "utf-8").slice(offset) : "";
}

describe("isCronNoopOutput / shouldSuppressQuietNoop", () => {
  it("matches [NOOP] case-insensitively after trimming leading whitespace", () => {
    assert.equal(isCronNoopOutput("[NOOP]"), true);
    assert.equal(isCronNoopOutput("  [noop] nothing changed\n"), true);
    assert.equal(isCronNoopOutput("[Noop] 0 PRs ready"), true);
  });

  it("rejects non-prefix [NOOP] mentions or empty strings", () => {
    assert.equal(isCronNoopOutput("PR #42 ready for review"), false);
    assert.equal(isCronNoopOutput("Error: [NOOP]"), false);
    assert.equal(isCronNoopOutput("NOOP"), false);
    assert.equal(isCronNoopOutput(""), false);
    assert.equal(isCronNoopOutput(undefined), false);
  });

  it("refuses suppression when job failed", () => {
    assert.equal(
      shouldSuppressQuietNoop({ quietOnNoop: true, status: "failed", output: "[NOOP] nothing changed" }),
      false,
    );
  });

  it("refuses suppression when job was killed", () => {
    assert.equal(
      shouldSuppressQuietNoop({ quietOnNoop: true, status: "complete", output: "[NOOP]", killOrigin: "user" }),
      false,
    );
  });

  it("refuses suppression when no result file was ingested", () => {
    assert.equal(
      shouldSuppressQuietNoop({ quietOnNoop: true, status: "complete", output: "[NOOP]" }, true),
      false,
    );
  });
});

describe("cron quiet_on_noop delivery behavior (#1452)", () => {
  it("delivers [NOOP] output normally when quiet_on_noop defaults to false", async () => {
    const h = createIntegratedHarness();
    await h.execTool({ action: "add", description: "status check", task: "check open PRs", interval_seconds: 60 });
    await h.fireCronTimer();

    assert.equal(h.spawnedCalls.length, 1);
    assert.equal(h.spawnedCalls[0].task, "check open PRs");
    assert.equal(h.spawnedCalls[0].options.quietOnNoop, undefined);

    const jobId = h.asyncApi.getAsyncJobs()[0].id;
    h.finishJob(jobId, "[NOOP] nothing changed");

    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].options?.deliverAs, "followUp");
    assert.equal(h.terminalNotifies.length, 1);
    const task = h.cron.getCronTasks()[0];
    assert.equal(task.lastOutcome, "delivered");
    assert.equal(task.runCount, 1);
  });

  it("appends [NOOP] instruction to worker prompt without mutating stored task", async () => {
    const h = createIntegratedHarness();
    await h.execTool({
      action: "add",
      description: "peer watch",
      task: "check stalled peers",
      interval_seconds: 60,
      quiet_on_noop: true,
    });
    await h.fireCronTimer();

    assert.equal(h.spawnedCalls.length, 1);
    assert.equal(h.spawnedCalls[0].task, `check stalled peers${CRON_QUIET_NOOP_PROMPT_SUFFIX}`);
    assert.equal(h.spawnedCalls[0].options.quietOnNoop, true);
    assert.equal(h.cron.getCronTasks()[0].task, "check stalled peers");
  });

  it("suppresses followUp delivery when quiet_on_noop worker replies with [NOOP]", async () => {
    const h = createIntegratedHarness();
    const logStart = cronLogOffset();
    await h.execTool({
      action: "add",
      description: "peer watch",
      task: "check stalled peers",
      interval_seconds: 60,
      quiet_on_noop: true,
    });
    await h.fireCronTimer();

    const jobId = h.asyncApi.getAsyncJobs()[0].id;
    h.finishJob(jobId, "[NOOP]");

    assert.equal(h.messages.length, 0);
    assert.equal(h.terminalNotifies.length, 0);
    const task = h.cron.getCronTasks()[0];
    assert.equal(task.lastOutcome, "noop");
    assert.equal(task.runCount, 1);
    assert.equal(task.lastRun, NOW);
    assert.match(cronLogSince(logStart), /cron_noop_suppressed/);
  });

  it("suppresses followUp delivery on case-insensitive [noop] reason line", async () => {
    const h = createIntegratedHarness();
    await h.execTool({
      action: "add",
      persist: true,
      description: "pr watch",
      task: "check PR readiness",
      interval_seconds: 60,
      quiet_on_noop: true,
    });
    await h.fireCronTimer();

    const jobId = h.asyncApi.getAsyncJobs()[0].id;
    h.finishJob(jobId, "  [noop] nothing changed  \n");

    assert.equal(h.messages.length, 0);
    const stored = readDurableCronStore(path.join(h.cwd, ".pi", "cron", "crons.json")).tasks[0];
    assert.equal(stored.lastOutcome, "noop");
    assert.equal(stored.runCount, 1);
    assert.equal(stored.lastRun, NOW);
  });

  it("delivers non-[NOOP] output normally when quiet_on_noop is true", async () => {
    const h = createIntegratedHarness();
    await h.execTool({
      action: "add",
      description: "pr watch",
      task: "check PR readiness",
      interval_seconds: 60,
      quiet_on_noop: true,
    });
    await h.fireCronTimer();

    const jobId = h.asyncApi.getAsyncJobs()[0].id;
    h.finishJob(jobId, "PR #1452 is ready for review");

    assert.equal(h.messages.length, 1);
    assert.match(h.messages[0].message.content, /PR #1452 is ready for review/);
    assert.equal(h.messages[0].options?.deliverAs, "followUp");
    assert.equal(h.terminalNotifies.length, 1);
    assert.equal(h.cron.getCronTasks()[0].lastOutcome, "delivered");
    assert.equal(h.cron.getCronTasks()[0].runCount, 1);
  });

  it("delivers failed job output even when output starts with [NOOP]", async () => {
    const h = createIntegratedHarness();
    await h.execTool({
      action: "add",
      description: "pr watch",
      task: "check PR readiness",
      interval_seconds: 60,
      quiet_on_noop: true,
    });
    await h.fireCronTimer();

    const jobId = h.asyncApi.getAsyncJobs()[0].id;
    h.finishJob(jobId, "[NOOP] rate limit crashed", { success: false, exitCode: 1 });

    assert.equal(h.messages.length, 1);
    assert.match(h.messages[0].message.content, /❌ failed/);
    assert.match(h.messages[0].message.content, /\[NOOP\] rate limit crashed/);
    assert.equal(h.terminalNotifies.length, 1);
    assert.equal(h.cron.getCronTasks()[0].lastOutcome, "error");
    assert.equal(h.cron.getCronTasks()[0].runCount, 1);
  });

  it("persists quietOnNoop flag in async worker session.json for reload safety", async () => {
    const h = createIntegratedHarness();
    await h.execTool({
      action: "add",
      description: "reload check",
      task: "check status",
      interval_seconds: 60,
      quiet_on_noop: true,
    });
    await h.fireCronTimer();

    const job = h.asyncApi.getAsyncJobs()[0];
    const sessionMeta = JSON.parse(fs.readFileSync(path.join(job.workerDir, "session.json"), "utf-8"));
    assert.equal(sessionMeta.quietOnNoop, true);
  });
});

describe("cron_manage edit toggling quiet_on_noop (#1452)", () => {
  it("toggles quiet_on_noop on a paused durable cron while preserving id, history, paused state", async () => {
    const h = createIntegratedHarness();
    await h.execTool({
      action: "add",
      persist: true,
      description: "status watch",
      task: "check statuspage",
      interval_seconds: 60,
    });
    const original = h.cron.getCronTasks()[0];
    const qualified = `persist:${original.id}`;

    // Run once to record history before pausing.
    await h.fireCronTimer();
    const jobId = h.asyncApi.getAsyncJobs()[0].id;
    h.finishJob(jobId, "all good");
    await h.execTool({ action: "pause", id: qualified });

    const enableOut = await h.execTool({ action: "edit", id: qualified, quiet_on_noop: true });
    assert.match(enableOut, /\(quiet\)/);
    assert.match(enableOut, /\(paused\)/);

    const enabled = h.cron.getCronTasks()[0];
    assert.equal(enabled.id, original.id);
    assert.equal(enabled.createdAt, original.createdAt);
    assert.equal(enabled.runCount, 1);
    assert.equal(enabled.lastOutcome, "delivered");
    assert.equal(enabled.paused, true);
    assert.equal(enabled.quiet_on_noop, true);

    const disableOut = await h.execTool({ action: "edit", id: qualified, quiet_on_noop: false });
    assert.doesNotMatch(disableOut, /\(quiet\)/);
    const disabled = h.cron.getCronTasks()[0];
    assert.equal(disabled.id, original.id);
    assert.equal(disabled.runCount, 1);
    assert.equal(disabled.paused, true);
    assert.equal(disabled.quiet_on_noop, false);

    const disk = readDurableCronStore(path.join(h.cwd, ".pi", "cron", "crons.json")).tasks[0];
    assert.equal(disk.quiet_on_noop, false);
    assert.equal(disk.runCount, 1);
    assert.equal(disk.paused, true);
  });

  it("rejects non-boolean quiet_on_noop values on add or edit", async () => {
    const h = createIntegratedHarness();
    const addErr = await h.execTool({
      action: "add",
      task: "check",
      interval_seconds: 60,
      quiet_on_noop: "yes",
    });
    assert.match(addErr, /^Error: quiet_on_noop must be a boolean/);

    await h.execTool({ action: "add", task: "check", interval_seconds: 60 });
    const id = `session:${h.cron.getCronTasks()[0].id}`;
    const editErr = await h.execTool({ action: "edit", id, quiet_on_noop: 1 });
    assert.match(editErr, /^Error: quiet_on_noop must be a boolean/);
  });

  it("validates quiet_on_noop, runCount, lastOutcome fields on durable tasks", () => {
    const base: DurableCronTask = {
      id: "t-1",
      scope: "project",
      cwd: "/tmp/proj",
      description: "desc",
      task: "check",
      intervalMs: 60_000,
      createdAt: 1_000,
    };
    assert.doesNotThrow(() =>
      validateDurableCronTask({ ...base, quiet_on_noop: true, runCount: 3, lastOutcome: "noop" }),
    );
    assert.throws(() => validateDurableCronTask({ ...base, quiet_on_noop: "true" }), /quiet_on_noop/);
    assert.throws(() => validateDurableCronTask({ ...base, runCount: -1 }), /runCount/);
    assert.throws(() => validateDurableCronTask({ ...base, lastOutcome: "bogus" }), /lastOutcome/);
  });
});

describe("/cron formatting for quiet badge with noop outcome (#1452)", () => {
  it("returns quiet badge only when quiet_on_noop is enabled", () => {
    assert.equal(formatCronQuietBadge({ quiet_on_noop: true }), "quiet");
    assert.equal(formatCronQuietBadge({ quiet_on_noop: false }), undefined);
    assert.equal(formatCronQuietBadge({}), undefined);
  });

  it("appends (noop) to formatLastRunLabel when lastOutcome is noop", () => {
    const now = 1_000_000;
    const view = toCronStatusTaskView(
      {
        id: "1",
        description: "watch",
        task: "check",
        createdAt: 0,
        lastRun: now - 120_000,
        quiet_on_noop: true,
        runCount: 4,
        lastOutcome: "noop",
      },
      { overlayId: "session:1" },
    );
    assert.equal(formatLastRunLabel(view, now), "2m ago (noop)");
  });

  it("appends (error) to formatLastRunLabel when lastOutcome is error", () => {
    const now = 1_000_000;
    const view = toCronStatusTaskView(
      {
        id: "1",
        description: "watch",
        task: "check",
        createdAt: 0,
        lastRun: now - 60_000,
        lastOutcome: "error",
      },
      { overlayId: "session:1" },
    );
    assert.equal(formatLastRunLabel(view, now), "1m ago (error)");
  });

  it("includes Mode with Runs rows in cronDetailRows for quiet crons", () => {
    const view = toCronStatusTaskView(
      {
        id: "1",
        description: "watch",
        task: "check",
        intervalMs: 60_000,
        createdAt: 0,
        lastRun: 100_000,
        quiet_on_noop: true,
        runCount: 5,
        lastOutcome: "noop",
      },
      { overlayId: "session:1" },
    );
    const rows = cronDetailRows(view, 160_000);
    assert.deepEqual(rows.filter(([label]) => label === "Mode"), [["Mode", "quiet on noop"]]);
    assert.deepEqual(rows.filter(([label]) => label === "Runs"), [["Runs", "5 (last: noop)"]]);
  });

  it("renders quiet badge with (noop) outcome in /cron overlay rows", async () => {
    const now = Date.now();
    const view = toCronStatusTaskView(
      {
        id: "1",
        description: "monitor PRs",
        task: "check PRs",
        intervalMs: 300_000,
        createdAt: now - 600_000,
        lastRun: now - 60_000,
        quiet_on_noop: true,
        runCount: 2,
        lastOutcome: "noop",
      },
      { overlayId: "session:1", sessionLabel: "session", isLocal: true },
    );
    let rendered = "";
    const ctx = {
      hasUI: true,
      ui: {
        notify: () => {},
        custom: async (factory: any) => {
          const fakeTui = { terminal: { rows: 24 }, requestRender: () => {} };
          const fakeTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
          const comp = factory(fakeTui, fakeTheme, { matches: () => false }, () => {});
          try {
            rendered = comp.render(140).join("\n");
          } finally {
            comp.dispose?.();
          }
          return undefined;
        },
      },
    } as any;

    await openCronStatusOverlay(ctx, {
      listTasks: () => [view],
      removeTask: () => true,
      togglePaused: () => ({ ok: true, paused: false }),
    });

    const rowLine = rendered.split("\n").find((line) => line.includes("monitor PRs")) ?? "";
    assert.match(rowLine, /\bquiet\b/);
    assert.match(rowLine, /\(noop\)/);
  });

  it("surfaces quiet flag with last outcome in cron_manage list output", async () => {
    const h = createIntegratedHarness();
    await h.execTool({
      action: "add",
      description: "quiet list test",
      task: "check peers",
      interval_seconds: 60,
      quiet_on_noop: true,
    });
    await h.fireCronTimer();
    h.finishJob(h.asyncApi.getAsyncJobs()[0].id, "[NOOP] clean");

    const listed = await h.execTool({ action: "list" });
    assert.match(listed, /\| quiet \| last: noop$/);
  });
});

describe("cron run history reliability regressions (Qodo R1)", () => {
  it("records in-flight worker history when a session cron moves to project scope", async () => {
    const h = createIntegratedHarness();
    await h.execTool({
      action: "add",
      description: "move to project",
      task: "check peers",
      interval_seconds: 60,
      quiet_on_noop: true,
    });
    const taskId = h.cron.getCronTasks()[0].id;
    await h.fireCronTimer();

    const moved = h.cron.setScope(`session:${taskId}`, "project");
    assert.equal(moved.ok, true);

    const jobId = h.asyncApi.getAsyncJobs()[0].id;
    h.finishJob(jobId, "[NOOP] moved cleanly");

    assert.equal(h.messages.length, 0);
    const stored = readDurableCronStore(path.join(h.cwd, ".pi", "cron", "crons.json")).tasks[0];
    assert.equal(stored.id, taskId);
    assert.equal(stored.runCount, 1);
    assert.equal(stored.lastOutcome, "noop");
  });

  it("records in-flight worker history when a project cron moves to session scope", async () => {
    const h = createIntegratedHarness();
    await h.execTool({
      action: "add",
      persist: true,
      description: "move to session",
      task: "check peers",
      interval_seconds: 60,
      quiet_on_noop: true,
    });
    const taskId = h.cron.getCronTasks()[0].id;
    await h.fireCronTimer();

    const moved = h.cron.setScope(`persist:${taskId}`, "session");
    assert.equal(moved.ok, true);

    const jobId = h.asyncApi.getAsyncJobs()[0].id;
    h.finishJob(jobId, "[NOOP] moved to session");

    assert.equal(h.messages.length, 0);
    const live = h.cron.getCronTasks().find((t) => t.id === taskId)!;
    assert.equal(live.scope, "session");
    assert.equal(live.runCount, 1);
    assert.equal(live.lastOutcome, "noop");
  });

  it("preserves dispatch start timestamp in lastRun after a long-running worker finishes", async () => {
    const h = createIntegratedHarness();
    await h.execTool({
      action: "add",
      description: "slow check",
      task: "check build",
      interval_seconds: 60,
      quiet_on_noop: true,
    });
    const dispatchTime = NOW;
    await h.fireCronTimer();

    h.clock.now = dispatchTime + 45_000;
    h.finishJob(h.asyncApi.getAsyncJobs()[0].id, "[NOOP] done later");

    const task = h.cron.getCronTasks()[0];
    assert.equal(task.lastRun, dispatchTime);
    assert.equal(task.runCount, 1);
    assert.equal(task.lastOutcome, "noop");
  });

  it("reconciles late result outcome after timeout fallback without double-counting runCount", () => {
    const initial = { lastRun: 100, runCount: 0, lastOutcome: undefined, lastRunId: undefined };
    const afterTimeout = applyCronRunOutcomeUpdate(initial, {
      runId: "worker-1",
      startedAt: 100,
      outcome: "error",
      isLate: false,
    });
    assert.equal(afterTimeout.runCount, 1);
    assert.equal(afterTimeout.lastOutcome, "error");
    assert.equal(afterTimeout.lastRunId, "worker-1");

    const afterLate = applyCronRunOutcomeUpdate(afterTimeout, {
      runId: "worker-1",
      startedAt: 100,
      outcome: "noop",
      isLate: true,
    });
    assert.equal(afterLate.runCount, 1);
    assert.equal(afterLate.lastOutcome, "noop");
    assert.equal(afterLate.lastRun, 100);
  });

  it("ignores stale late reconciliation once a newer run superseded lastRunId", () => {
    const afterNewer = { lastRun: 200, runCount: 2, lastOutcome: "delivered" as const, lastRunId: "worker-2" };
    const afterStaleLate = applyCronRunOutcomeUpdate(afterNewer, {
      runId: "worker-1",
      startedAt: 100,
      outcome: "error",
      isLate: true,
    });
    assert.deepEqual(afterStaleLate, afterNewer);
  });

  it("persists durable completion after leader lease handoff without overwriting peer edits", async () => {
    const h = createIntegratedHarness();
    const store = path.join(h.cwd, ".pi", "cron", "crons.json");
    await h.execTool({
      action: "add",
      persist: true,
      description: "durable watch",
      task: "check status",
      interval_seconds: 60,
      quiet_on_noop: true,
    });
    await h.fireCronTimer();

    // Simulate another leader taking over the lock and editing the cron description on disk.
    const lockDir = `${store}.leader.lock`;
    fs.rmSync(lockDir, { recursive: true, force: true });
    const otherLeader = acquireLeaderLock(store, "other-leader-instance");
    assert.ok(otherLeader, "expected simulated new leader to acquire lock");
    try {
      const diskBefore = readDurableCronStore(store);
      diskBefore.tasks[0].description = "peer edited desc";
      fs.writeFileSync(store, JSON.stringify(diskBefore));

      const jobId = h.asyncApi.getAsyncJobs()[0].id;
      h.finishJob(jobId, "[NOOP] old leader finished");

      const diskAfter = readDurableCronStore(store).tasks[0];
      assert.equal(diskAfter.description, "peer edited desc");
      assert.equal(diskAfter.runCount, 1);
      assert.equal(diskAfter.lastOutcome, "noop");
    } finally {
      releaseLeaderLock(store, otherLeader);
    }
  });

  it("counts an older run after leader handoff without clobbering a newer run outcome", () => {
    const cwd = makeTempDir("pi-cron-handoff-order-");
    const store = path.join(cwd, ".pi", "cron", "crons.json");
    fs.mkdirSync(path.dirname(store), { recursive: true });
    const seed: DurableCronTask = {
      id: "cron-1",
      scope: "project",
      cwd,
      description: "watch",
      task: "check",
      intervalMs: 60_000,
      createdAt: 1_000,
      lastRun: 2_000,
      runCount: 1,
      lastOutcome: "delivered",
      lastRunId: "worker-newer",
    };
    fs.writeFileSync(store, JSON.stringify({ version: 1, tasks: [seed] }));

    const res = recordDurableCronRunOutcome(store, {
      id: "cron-1",
      runId: "worker-older",
      startedAt: 1_500,
      outcome: "error",
      isLate: false,
    });
    assert.equal(res.found, true);
    assert.equal(res.runCount, 2);
    assert.equal(res.lastOutcome, "delivered");
    assert.equal(res.lastRunId, "worker-newer");
  });

  it("records quiet [NOOP] history when a worker finishes after simulated /reload", async () => {
    const cwd = makeTempDir("pi-cron-reload-quiet-");
    const h1 = createIntegratedHarness({ cwd, sessionId: "sess-reload-1" });
    await h1.execTool({
      action: "add",
      description: "survive reload",
      task: "check status",
      interval_seconds: 60,
      quiet_on_noop: true,
    });
    await h1.fireCronTimer();

    const job = h1.asyncApi.getAsyncJobs()[0];
    fs.writeFileSync(
      path.join(job.workerDir, "status.json"),
      JSON.stringify({ runId: job.id, state: "running", pid: process.pid, agent: "worker", task: job.task, startedAt: NOW }),
    );
    const sessionMeta = JSON.parse(fs.readFileSync(path.join(job.workerDir, "session.json"), "utf-8"));
    assert.equal(sessionMeta.cronTaskId, h1.cron.getCronTasks()[0].id);
    assert.equal(sessionMeta.quietOnNoop, true);

    // Simulate extension reload (reason !== "quit" keeps session cron file intact).
    h1.shutdown("reload");
    activeHarnesses.delete(h1);
    h1.restore();

    const h2 = createIntegratedHarness({ cwd, sessionId: "sess-reload-1" });
    assert.equal(h2.cron.getCronTasks().length, 1);
    assert.equal(h2.asyncApi.getAsyncJobs().length, 1);

    h2.finishJob(job.id, "[NOOP] clean after reload");

    assert.equal(h2.messages.length, 0);
    const restoredCron = h2.cron.getCronTasks()[0];
    assert.equal(restoredCron.runCount, 1);
    assert.equal(restoredCron.lastOutcome, "noop");
    assert.equal(restoredCron.lastRun, NOW);
  });

  it("records error outcome when spawnAsyncAgent returns a spawn error", async () => {
    let failSpawn = false;
    const h = createIntegratedHarness({
      spawnOverride: (...args: any[]) => {
        if (failSpawn) return { id: "", error: "jiti-cli.mjs not found" };
        return h.asyncApi.spawnAsyncAgent(args[0], args[1], args[2], args[3], args[4]);
      },
    });
    await h.execTool({
      action: "add",
      description: "spawn err",
      task: "check status",
      interval_seconds: 60,
      quiet_on_noop: true,
    });

    await h.fireCronTimer();
    h.finishJob(h.asyncApi.getAsyncJobs()[0].id, "[NOOP] clean first");
    assert.equal(h.cron.getCronTasks()[0].lastOutcome, "noop");
    assert.equal(h.cron.getCronTasks()[0].runCount, 1);

    failSpawn = true;
    h.clock.now = NOW + 60_000;
    await h.fireCronTimer();

    const task = h.cron.getCronTasks()[0];
    assert.equal(task.lastOutcome, "error");
    assert.equal(task.runCount, 2);
  });

  it("records error outcome when spawnAsyncAgent throws synchronously", async () => {
    const h = createIntegratedHarness({
      spawnOverride: () => {
        throw new Error("spawn exploded");
      },
    });
    await h.execTool({
      action: "add",
      description: "spawn throw",
      task: "check status",
      interval_seconds: 60,
      quiet_on_noop: true,
    });

    await h.fireCronTimer();

    const task = h.cron.getCronTasks()[0];
    assert.equal(task.lastOutcome, "error");
    assert.equal(task.runCount, 1);
  });

  it("records error outcome when an in-flight cron worker is killed", async () => {
    const h = createIntegratedHarness();
    await h.execTool({
      action: "add",
      description: "kill test",
      task: "check status",
      interval_seconds: 60,
      quiet_on_noop: true,
    });

    await h.fireCronTimer();
    h.finishJob(h.asyncApi.getAsyncJobs()[0].id, "[NOOP] clean first");
    assert.equal(h.cron.getCronTasks()[0].lastOutcome, "noop");

    h.clock.now = NOW + 60_000;
    await h.fireCronTimer();
    const secondJob = h.asyncApi.getAsyncJobs().find((j) => j.status === "queued" || j.status === "running")!;
    fs.writeFileSync(
      path.join(secondJob.workerDir, "status.json"),
      JSON.stringify({ runId: secondJob.id, state: "running", pid: 999_999_999 }),
    );
    const killed = h.asyncApi.killAsyncAgent(secondJob.id, "user");
    assert.equal(killed.killed.length, 1);

    // Flush microtasks for void deliverJobResult(job, { fireHook: false }).
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const task = h.cron.getCronTasks()[0];
    assert.equal(task.lastOutcome, "error");
    assert.equal(task.runCount, 2);
    assert.equal(h.messages.length, 1);
  });

  it("reconciles late result through deliverJobResult after phantom timeout fallback", async () => {
    const h = createIntegratedHarness();
    await h.execTool({
      action: "add",
      description: "late result watch",
      task: "check status",
      interval_seconds: 60,
      quiet_on_noop: true,
    });
    await h.fireCronTimer();

    const job = h.asyncApi.getAsyncJobs()[0];
    // Mark terminal with old timestamps, then advance past phantom timeout (30s) without a result file.
    fs.writeFileSync(
      path.join(job.workerDir, "status.json"),
      JSON.stringify({ runId: job.id, state: "complete", startedAt: NOW, lastUpdate: NOW }),
    );
    h.clock.now = NOW + 120_000;
    h.triggerPoller();
    // Advance clock past waitForResultFiles's 2000ms deadline so its short poll timer resolves immediately.
    h.clock.now += 5_000;
    await h.flushShortTimers();

    assert.equal(h.messages.length, 1);
    assert.equal(h.cron.getCronTasks()[0].runCount, 1);
    assert.equal(h.cron.getCronTasks()[0].lastOutcome, "error");

    // Late result arrives with [NOOP]: reconciles outcome without double-counting or second chat turn.
    h.finishJob(job.id, "[NOOP] late clean result");
    await h.flushShortTimers();

    assert.equal(h.messages.length, 1);
    assert.equal(h.cron.getCronTasks()[0].runCount, 1);
    assert.equal(h.cron.getCronTasks()[0].lastOutcome, "noop");
  });
});
