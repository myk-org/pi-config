/**
 * Unit tests for #1417: `/async` agent revive (`r`) and unified live Activity Log (`1`/`2`).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  formatAsyncStatusPlainText,
  openAsyncStatusOverlay,
  type AsyncStatusJobView,
  type AsyncStatusUiDeps,
} from "../../../extensions/orchestrator/async-status-ui.js";
import {
  OverlayActivityView,
  activityFilterLabel,
  collectAsyncActivityEvents,
  filterActivityEvents,
  nextActivityFilter,
  type ActivityEvent,
} from "../../../extensions/orchestrator/overlay-activity-log.js";
import { registerAsyncAgents } from "../../../extensions/orchestrator/async-agents.js";
import { fakeCommandCtx, fakeCustom, type FakeCustomFactory } from "../helpers/fake-extension-ctx.js";
import { fakeKeybindings, fakeTheme, fakeTui } from "../helpers/fake-tui.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function makeJob(overrides: Partial<AsyncStatusJobView> & { id: string }): AsyncStatusJobView {
  return {
    agent: "worker",
    name: `job-${overrides.id}`,
    task: `do work ${overrides.id}`,
    status: "running",
    startedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeUiHarness(scripts: string[][], width = 100) {
  const notifications: Array<{ message: string; level: string | undefined }> = [];
  const frames: string[][] = [];
  let opened = 0;
  const custom = (<T,>(factory: FakeCustomFactory<T>) => {
    const idx = opened++;
    const keys = scripts[idx] ?? ["close"];
    frames[idx] = [];
    return fakeCustom(factory, keys, {
      onOpen: (comp) => {
        frames[idx].push((comp.render?.(width) ?? []).join("\n"));
      },
      onKey: (_k, _d, comp) => {
        frames[idx].push((comp.render?.(width) ?? []).join("\n"));
      },
    });
  }) satisfies ExtensionUIContext["custom"];

  return {
    notifications,
    frames,
    openedCount: () => opened,
    ctx: fakeCommandCtx({
      notify: (message: string, level?: "info" | "warning" | "error") => {
        notifications.push({ message, level });
      },
      custom,
    }),
  };
}

describe("/async revive (`r`) overlay dispatch (#1417)", () => {
  it("revives a killed/failed job on `r` and shows an inline feedback banner", async () => {
    const h = makeUiHarness([["r", "close"]]);
    const revived: string[] = [];
    const failedJob = makeJob({ id: "worker-1001", status: "failed", durationMs: 2500 });

    const deps: AsyncStatusUiDeps = {
      listJobs: () => [failedJob],
      killJob: () => ({ killed: [], errors: [] }),
      reviveJob: (job) => {
        revived.push(job.id);
        return { ok: true, id: "worker-2002", message: "Revived job-worker-1001 (ker-2002) · context recovered." };
      },
      formatDuration: (ms) => `${ms}ms`,
    };

    await openAsyncStatusOverlay(h.ctx, deps);
    assert.deepEqual(revived, ["worker-1001"]);
    assert.equal(h.notifications.length, 1);
    assert.equal(h.notifications[0].level, "info");
    assert.match(h.notifications[0].message, /Revived job-worker-1001/);
    const lastFrame = h.frames[0][h.frames[0].length - 1];
    assert.match(lastFrame, /ℹ Revived job-worker-1001/);
  });

  it("refuses `r` on an active/running job with an inline warning banner", async () => {
    const h = makeUiHarness([["r", "close"]]);
    let reviveCalls = 0;
    const runningJob = makeJob({ id: "worker-live", status: "running" });

    await openAsyncStatusOverlay(h.ctx, {
      listJobs: () => [runningJob],
      killJob: () => ({ killed: [], errors: [] }),
      reviveJob: () => {
        reviveCalls++;
        return { ok: true, id: "never" };
      },
      formatDuration: (ms) => `${ms}ms`,
    });

    assert.equal(reviveCalls, 0);
    assert.equal(h.notifications.length, 1);
    assert.equal(h.notifications[0].level, "warning");
    assert.match(h.notifications[0].message, /Cannot revive active agent/);
    const lastFrame = h.frames[0][h.frames[0].length - 1];
    assert.match(lastFrame, /⚠ Cannot revive active agent/);
  });

  it("handles Kitty CSI-u `r` (\\x1b[114u) for revive", async () => {
    const h = makeUiHarness([["\x1b[114u", "close"]]);
    const revived: string[] = [];
    const doneJob = makeJob({ id: "worker-done", status: "complete", durationMs: 1200 });

    await openAsyncStatusOverlay(h.ctx, {
      listJobs: () => [doneJob],
      killJob: () => ({ killed: [], errors: [] }),
      reviveJob: (job) => {
        revived.push(job.id);
        return { ok: true, id: "worker-revived" };
      },
      formatDuration: (ms) => `${ms}ms`,
    });

    assert.deepEqual(revived, ["worker-done"]);
    assert.equal(h.notifications[0]?.level, "info");
  });

  it("revives only eligible finished jobs in a multi-selection on `r`", async () => {
    const h = makeUiHarness([[" ", "j", " ", "r", "close"]]);
    const revived: string[] = [];
    const jobs = [
      makeJob({ id: "a", status: "running" }),
      makeJob({ id: "b", status: "failed", durationMs: 1000 }),
    ];

    await openAsyncStatusOverlay(h.ctx, {
      listJobs: () => jobs,
      killJob: () => ({ killed: [], errors: [] }),
      reviveJob: (job) => {
        revived.push(job.id);
        return { ok: true, id: `new-${job.id}` };
      },
      formatDuration: (ms) => `${ms}ms`,
    });

    assert.deepEqual(revived, ["b"]);
    assert.match(h.notifications[0]?.message ?? "", /revived 1 async agent/);
  });
});

describe("registerAsyncAgents.reviveAsyncJob integration (#1417)", () => {
  it("respawns a failed job with recovered output.log context and preserves agent, cwd, name, taskId", async () => {
    const tmp = makeTempDir("async-revive-");
    tempDirs.push(tmp);
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const pi = {
      on: (ev: string, fn: (...args: any[]) => any) => {
        const list = handlers.get(ev) ?? [];
        list.push(fn);
        handlers.set(ev, list);
      },
      registerCommand: () => {},
      registerTool: () => {},
      events: { on: () => () => {}, emit: () => {} },
      sendMessage: () => {},
    } as unknown as ExtensionAPI;

    const spawnedConfigs: any[] = [];
    const fakeSpawn = ((_cmd: string, args: string[]) => {
      const cfgPath = args[args.length - 1];
      const raw = JSON.parse(readFileSync(cfgPath, "utf-8"));
      spawnedConfigs.push(raw);
      const proc = new EventEmitter() as any;
      proc.pid = 99999;
      proc.stderr = new EventEmitter();
      proc.stderr.pipe = () => {};
      return proc;
    }) as any;

    const reg = registerAsyncAgents(pi, () => {}, {
      spawnProcess: fakeSpawn,
      discoverAgents: () => ({
        agents: [
          {
            name: "worker",
            description: "general worker",
            systemPrompt: "",
            source: "package",
            filePath: "/fake/worker.md",
          },
        ],
      }),
    });

    // Trigger session_start so PROJECT_TMP_DIR & ASYNC_RESULTS_DIR are initialized
    for (const fn of handlers.get("session_start") ?? []) {
      fn({}, { cwd: tmp, hasUI: false, sessionManager: { getSessionId: () => "sess-1", getCwd: () => tmp } });
    }

    const first = reg.spawnAsyncAgent("worker", "Fix the widget rendering", tmp, [
      { name: "worker", description: "general worker", systemPrompt: "", source: "package", filePath: "/fake/worker.md" },
    ], { name: "ui-fixer", taskId: "42", persistSession: false });
    assert.ok(first.id);

    // Refuses revive while active
    const whileRunning = await reg.reviveAsyncJob(first.id);
    assert.equal(whileRunning.ok, false);

    // Write output.log to workerDir and mark job killed/failed
    const workerDir = join(tmp, ".pi", "tmp", first.id);
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, "output.log"),
      `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Inspected overlay-dashboard.ts" } })}\n`,
    );
    reg.killAsyncAgent(first.id, "user");

    // Revive failed job
    const revived = await reg.reviveAsyncJob(first.id);
    assert.equal(revived.ok, true);
    assert.ok(revived.ok && revived.id !== first.id);
    assert.equal(spawnedConfigs.length, 2);
    const secondCfg = spawnedConfigs[1];
    assert.equal(secondCfg.agent, "worker");
    assert.equal(secondCfg.cwd, tmp);
    assert.match(secondCfg.task, /Fix the widget rendering/);
    assert.match(secondCfg.task, /Inspected overlay-dashboard\.ts/);
    // Revived job persists its session so subsequent revives can resume directly
    assert.equal(secondCfg.piArgs.includes("--no-session"), false);

    // Reviving the second job (which has persistSession: true) resumes its deterministic session ID
    reg.killAsyncAgent(revived.ok ? revived.id : "", "user");
    const third = await reg.reviveAsyncJob(revived.ok ? revived.id : "");
    assert.equal(third.ok, true);
    if (third.ok) {
      assert.match(third.message ?? "", /session resumed/);
    }
    assert.equal(spawnedConfigs.length, 3);
    const secondSessIdx = spawnedConfigs[1].piArgs.indexOf("--session-id");
    const thirdSessIdx = spawnedConfigs[2].piArgs.indexOf("--session-id");
    assert.ok(secondSessIdx >= 0 && thirdSessIdx >= 0);
    assert.equal(
      spawnedConfigs[2].piArgs[thirdSessIdx + 1],
      spawnedConfigs[1].piArgs[secondSessIdx + 1],
      "reviving a persistSession job reuses its deterministic --session-id",
    );
  });
});

describe("/async Unified Activity Log (`1`/`2`, `f`, `/`, `Space`, `Enter`) (#1417)", () => {
  it("collects chronological lifecycle, tool, error, and message events from output.log", () => {
    const dir = makeTempDir("activity-collect-");
    tempDirs.push(dir);
    const logPath = join(dir, "output.log");
    writeFileSync(
      logPath,
      [
        JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } }),
        JSON.stringify({ type: "tool_execution_end", toolName: "bash", isError: false, result: { content: [{ text: "ok" }] } }),
        JSON.stringify({ type: "tool_execution_end", toolName: "bash", isError: true, result: { content: [{ text: "exit 1" }] } }),
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "All done" }] } }),
        JSON.stringify({ type: "agent_end" }),
      ].join("\n") + "\n",
    );

    const events = collectAsyncActivityEvents([
      makeJob({ id: "j1", status: "complete", workerDir: dir, startedAt: 1_700_000_000_000, durationMs: 5000 }),
    ]);

    const cats = events.map((e) => e.category);
    assert.ok(cats.includes("lifecycle"));
    assert.ok(cats.includes("tool"));
    assert.ok(cats.includes("error"));
    assert.ok(cats.includes("message"));
    assert.equal(filterActivityEvents(events, "errors", "").length, 1);
    assert.equal(filterActivityEvents(events, "tools", "").length, 2);
    assert.equal(filterActivityEvents(events, "messages", "").length, 1);
    assert.equal(filterActivityEvents(events, "all", "npm test").length, 1);
  });

  it("switches between Roster (`1`) and Activity (`2`), supports Kitty CSI-u, and opens detail on Enter", async () => {
    const dir = makeTempDir("async-tabs-");
    tempDirs.push(dir);
    writeFileSync(
      join(dir, "output.log"),
      `${JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "README.md" } })}\n`,
    );
    const job = makeJob({ id: "j-tabs", status: "running", workerDir: dir });

    // 1) Roster opens -> press Kitty CSI-u `2` (\x1b[50u) -> switches to Activity
    // 2) Activity opens -> press `f` (Errors), `f` (Tools), `Enter` -> opens job detail
    // 3) Detail opens -> press Esc -> returns to Activity
    // 4) Activity re-opens -> press Kitty CSI-u `1` (\x1b[49u) -> returns to Roster
    // 5) Roster re-opens -> close
    const h = makeUiHarness([
      ["\x1b[50u"],
      ["f", "f", "\r"],
      ["\x1b"],
      ["\x1b[49u"],
      ["close"],
    ]);

    await openAsyncStatusOverlay(h.ctx, {
      listJobs: () => [job],
      killJob: () => ({ killed: [], errors: [] }),
      formatDuration: (ms) => `${ms}ms`,
    });

    assert.equal(h.openedCount(), 5);
    assert.match(h.frames[0][0], /\[1\] Roster/);
    assert.match(h.frames[1][0], /\[2\] Activity/);
    // Detail frame shows job header
    assert.match(h.frames[2][0], /job-j-tabs/);
    // Returning to Activity preserved filter: Tools
    assert.match(h.frames[3][0], /filter: Tools/);
    // Returning to Roster via Kitty `1`
    assert.match(h.frames[4][0], /\[1\] Roster/);
  });

  it("supports `/` inline search, `Space` follow toggle, manual scroll pause, and narrow-width rendering", () => {
    const events: ActivityEvent[] = [
      { id: "e1", timestamp: 1_700_000_001_000, sourceId: "j1", sourceLabel: "alpha", category: "lifecycle", summary: "started alpha" },
      { id: "e2", timestamp: 1_700_000_002_000, sourceId: "j1", sourceLabel: "alpha", category: "tool", summary: "→ bash pytest" },
      { id: "e3", timestamp: 1_700_000_003_000, sourceId: "j2", sourceLabel: "beta-very-long-agent-name", category: "error", summary: "✗ pytest failed with assertion error in module_xyz" },
    ];

    const followStates: boolean[] = [];
    const filters: string[] = [];
    const searches: string[] = [];
    let result: any = null;

    const view = new OverlayActivityView(
      fakeTui(),
      fakeTheme(),
      fakeKeybindings(),
      {
        title: "Async agents",
        listEvents: () => events,
        onFilterChange: (f) => filters.push(f),
        onSearchChange: (s) => searches.push(s),
        onFollowChange: (f) => followStates.push(f),
      },
      (res) => { result = res; },
    );

    // Narrow terminal width safety (40 cols) and wide width (120 cols)
    for (const width of [40, 52, 120]) {
      const rendered = view.render(width);
      assert.ok(rendered.length >= 7);
      for (const line of rendered) {
        assert.ok(
          visibleWidth(line) <= width,
          `line exceeded width ${width} (got ${visibleWidth(line)}): ${line}`,
        );
      }
    }

    // Space toggles auto-follow off, then back on
    view.handleInput(" ");
    assert.equal(followStates[followStates.length - 1], false);
    assert.match(view.render(100).join("\n"), /follow: PAUSED/);
    view.handleInput(" ");
    assert.equal(followStates[followStates.length - 1], true);
    assert.match(view.render(100).join("\n"), /follow: ON/);

    // Manual scroll up (`k`) pauses follow
    view.handleInput("k");
    assert.equal(followStates[followStates.length - 1], false);

    // `/` enters search mode, accepts Kitty CSI-u chars, Backspace deletes, Enter confirms
    view.handleInput("/");
    view.handleInput("\x1b[98u"); // 'b'
    view.handleInput("e");
    view.handleInput("t");
    view.handleInput("x");
    view.handleInput("\x7f"); // backspace removes 'x'
    view.handleInput("\r"); // confirm search "bet"
    assert.equal(searches[searches.length - 1], "bet");
    const searchedFrame = view.render(100).join("\n");
    assert.match(searchedFrame, /1\/3 events/);
    assert.match(searchedFrame, /beta/);

    // Filter cycle helper covers all 4 filters
    assert.equal(nextActivityFilter("all"), "errors");
    assert.equal(nextActivityFilter("errors"), "tools");
    assert.equal(nextActivityFilter("tools"), "messages");
    assert.equal(nextActivityFilter("messages"), "all");
    assert.equal(activityFilterLabel("messages"), "Messages");

    // Enter inspects the filtered event (`e3`)
    view.handleInput("\r");
    assert.deepEqual(result, { type: "inspect", event: events[2] });
    view.dispose();
  });

  it("falls back safely to plain text when ctx.hasUI is false", async () => {
    const notifications: Array<{ message: string; level?: string }> = [];
    const ctx = fakeCommandCtx(
      { notify: (message: string, level?: "info" | "warning" | "error") => { notifications.push({ message, level }); } },
      { hasUI: false },
    );

    await openAsyncStatusOverlay(ctx, {
      listJobs: () => [makeJob({ id: "j-plain", status: "complete", durationMs: 400 })],
      killJob: () => ({ killed: [], errors: [] }),
      formatDuration: (ms) => `${ms}ms`,
    });

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "info");
    assert.match(notifications[0].message, /Async agents: 0 active \/ 1 total/);
    assert.match(notifications[0].message, /Recent activity:/);
    assert.equal(/\x1b\[/.test(notifications[0].message), false, "plain-text fallback must not contain ANSI escapes");

    assert.equal(formatAsyncStatusPlainText([]), "No async agents running or recently completed.");
  });
});
