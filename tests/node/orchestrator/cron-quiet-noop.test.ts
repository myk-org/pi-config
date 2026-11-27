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
  readDurableCronStore,
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
  messages: Array<{ message: any; options: any }>;
  terminalNotifies: Array<{ title: string; body: string }>;
  spawnedCalls: Array<{ agentName: string; task: string; options: any }>;
  cron: ReturnType<typeof registerCron>;
  asyncApi: ReturnType<typeof registerAsyncAgents>;
  execTool: (params: Record<string, unknown>) => Promise<string>;
  fireCronTimer: () => Promise<void>;
  finishJob: (id: string, output: string, opts?: { success?: boolean; exitCode?: number }) => void;
  restore: () => void;
}

const activeHarnesses = new Set<IntegratedHarness>();
afterEach(() => {
  for (const h of [...activeHarnesses]) h.restore();
  activeHarnesses.clear();
});

function createIntegratedHarness(opts: { cwd?: string; sessionId?: string } = {}): IntegratedHarness {
  const cwd = opts.cwd ?? makeTempDir("pi-cron-quiet-noop-");
  const sessionId = opts.sessionId ?? "sess-quiet-noop";
  const handlers = new Map<string, Array<(event: unknown, ctx: any) => void>>();
  const events = new EventEmitter();
  const messages: Array<{ message: any; options: any }> = [];
  const terminalNotifies: Array<{ title: string; body: string }> = [];
  const spawnedCalls: Array<{ agentName: string; task: string; options: any }> = [];
  const cronTimers: Array<{ fn: Function; delay: number; cleared?: boolean }> = [];
  let poller: (() => void) | undefined;
  let cronTool: any;

  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalDateNow = Date.now;

  Date.now = () => NOW;
  (global as any).setInterval = (fn: () => void, delay: number) => {
    // Async poller uses 3000ms interval; cron health uses 10000ms.
    if (delay === 3000) poller = fn;
    return { fn, delay, unref() {} };
  };
  (global as any).clearInterval = () => {};
  (global as any).setTimeout = (fn: Function, delay: number) => {
    const timer = { fn, delay, cleared: false, unref() {} };
    // Capture cron schedule timers (>= 10_000ms); leave short internal timers un-invoked.
    if (delay >= 10_000) cronTimers.push(timer);
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

  const harness: IntegratedHarness = {
    cwd,
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
    finishJob,
    restore() {
      try {
        for (const fn of handlers.get("session_shutdown") ?? []) fn({ reason: "quit" }, ctx);
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
