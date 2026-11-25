/**
 * Sync agent run registry — visibility-only registry for sync subagents (#1121).
 *
 * Checks the parts that decide what the footer, /async-status and pidash show:
 * counts, the footer strings for every mix, idempotent end, abort routing by run id,
 * and the finished-row retention that keeps a detail view from lying. The last two tests drive
 * `runSingleAgent` itself, because "stop one row, keep the batch" is a property of the spawn
 * loop, not of the map.
 */

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  abortAllSyncAgentRuns,
  abortSyncAgentRun,
  beginSyncAgentRun,
  formatAgentsStatus,
  listSyncAgentRuns,
  listSyncAgentRunsWithFinished,
  onSyncAgentRunsChanged,
  syncAgentRunCount,
} from "../../../extensions/orchestrator/sync-agent-runs.js";
import { runSingleAgent } from "../../../extensions/orchestrator/subagent-tool.js";
import { clearSettingsCache, setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.js";
import { getPiLogPath, setGlobalSessionId } from "../../../extensions/shared/file-logger.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

/** Every run writes a worker dir under its cwd, so each test gets its own project dir. */
let projectCwd = "";
beforeEach(() => {
  projectCwd = makeTempDir("sync-runs-project-");
});

function reset() {
  abortAllSyncAgentRuns();
}

/** The id the next `beginSyncAgentRun` will take, so a test can pre-place its worker dir. */
function nextRunId(cwd: string): string {
  const probe = beginSyncAgentRun({ agent: "probe", task: "probe", cwd });
  const id = probe.id;
  probe.end(true);
  reset();
  const match = /^(.*-)(\d+)$/.exec(id);
  assert.ok(match, `unexpected run id ${id}`);
  return `${match[1]}${Number(match[2]) + 1}`;
}

test("begin registers a running run; end clears it", () => {
  reset();
  const run = beginSyncAgentRun({ agent: "worker", task: "do it", cwd: projectCwd });
  assert.equal(syncAgentRunCount(), 1);
  const [listed] = listSyncAgentRuns();
  assert.equal(listed.id, run.id);
  assert.equal(listed.agent, "worker");
  assert.equal(listed.status, "running");
  assert.equal(listed.currentTool, undefined);
  assert.ok(listed.startedAt > 0);

  run.end(true);
  assert.equal(syncAgentRunCount(), 0);
  assert.deepEqual(listSyncAgentRuns(), []);

  // Idempotent: a second end neither throws nor resurrects the run.
  run.end(false);
  assert.equal(syncAgentRunCount(), 0);
  assert.equal(listSyncAgentRunsWithFinished().length, 1, "one finished row, not two");
});

test("setTool is visible while running and dies with the run", () => {
  reset();
  const run = beginSyncAgentRun({ agent: "worker", task: "t", cwd: projectCwd });
  run.setTool("bash");
  assert.equal(listSyncAgentRuns()[0].currentTool, "bash");
  run.setTool(undefined);
  assert.equal(listSyncAgentRuns()[0].currentTool, undefined);
  run.setTool("edit");
  run.end(true);
  run.setTool("read"); // no-op on a finished run
  assert.equal(syncAgentRunCount(), 0);
});

test("abort by id marks the run failed, fires the abort fn once, keeps the row until end", () => {
  reset();
  const run = beginSyncAgentRun({ agent: "worker", task: "t", cwd: projectCwd });
  let aborts = 0;
  run.setAbort(() => { aborts++; });

  assert.equal(abortSyncAgentRun(run.id), true);
  assert.equal(aborts, 1);
  assert.equal(syncAgentRunCount(), 0, "a stopped child is not running");
  // The child is still alive, so the row must stay: the footer can drop it, but a live
  // process nobody can stop again is worse than a row one second too long.
  const [stopped] = listSyncAgentRuns();
  assert.equal(stopped.id, run.id);
  assert.equal(stopped.status, "failed");
  assert.ok(stopped.endedAt! > 0);

  // Already gone from the running set: a second stop is a false, not a second kill.
  assert.equal(abortSyncAgentRun(run.id), false);
  assert.equal(aborts, 1);

  run.end(false); // end is the only thing that removes the row
  assert.deepEqual(listSyncAgentRuns(), []);
  assert.equal(listSyncAgentRunsWithFinished().length, 1);
});

test("abort matches the run id only, never the agent name", () => {
  reset();
  const run = beginSyncAgentRun({ agent: "code-reviewer-x", task: "t", cwd: projectCwd });
  let aborts = 0;
  run.setAbort(() => { aborts++; });
  // Two runs of one agent are two children; a name match would stop the wrong one.
  assert.equal(abortSyncAgentRun("code-reviewer-x"), false);
  assert.equal(aborts, 0);
  assert.equal(syncAgentRunCount(), 1);
  assert.equal(abortSyncAgentRun(run.id), true);
  reset();
});

test("a stop before the spawn is recorded and reported by setAbort", () => {
  reset();
  const run = beginSyncAgentRun({ agent: "worker", task: "t", cwd: projectCwd });
  // Stop arrives between begin and setAbort (the spawn does not exist yet).
  assert.equal(abortSyncAgentRun(run.id), true);
  assert.equal(syncAgentRunCount(), 0);
  let aborts = 0;
  assert.equal(run.setAbort(() => { aborts++; }), true, "the spawner must know to kill at once");
  assert.equal(aborts, 0, "the registry does not run the handle; the spawner does");
  run.end(false);
  reset();
});

test("abort of an unknown target returns false and changes nothing", () => {
  reset();
  beginSyncAgentRun({ agent: "worker", task: "t", cwd: projectCwd });
  assert.equal(abortSyncAgentRun("nobody"), false);
  assert.equal(syncAgentRunCount(), 1);
  reset();
});

test("a finished run is retained with its final status, then dropped after the grace window", () => {
  reset();
  const run = beginSyncAgentRun({ agent: "worker", task: "t", cwd: projectCwd });
  run.end(true);
  assert.equal(syncAgentRunCount(), 0);
  const [done] = listSyncAgentRunsWithFinished();
  assert.equal(done.id, run.id);
  assert.equal(done.status, "complete");
  assert.ok(done.endedAt! >= done.startedAt);

  // A long session cannot grow the retained set: newest 20 only.
  const dirs: string[] = [];
  for (let i = 0; i < 25; i++) {
    const extra = beginSyncAgentRun({ agent: "worker", task: `t${i}`, cwd: projectCwd });
    dirs.push(listSyncAgentRuns()[0].workerDir);
    extra.end(true);
  }
  const retained = listSyncAgentRunsWithFinished();
  assert.equal(retained.length, 20);
  assert.equal(retained[retained.length - 1].task, "t24", "newest kept");
  assert.equal(existsSync(dirs[0]), false, "a pruned row takes its worker dir with it");
  assert.ok(existsSync(dirs[24]), "a retained row keeps its status.json readable");

  // Time passing empties it — no timer, the read prunes.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 61_000;
    assert.deepEqual(listSyncAgentRunsWithFinished(), []);
  } finally {
    Date.now = realNow;
  }
  reset();
});

test("end and abort notify subscribers; unsubscribe stops them", () => {
  reset();
  let calls = 0;
  const unsubscribe = onSyncAgentRunsChanged(() => { calls++; });
  const run = beginSyncAgentRun({ agent: "worker", task: "t", cwd: projectCwd });
  const afterBegin = calls;
  assert.ok(afterBegin > 0, "begin must repaint the footer");
  run.end(true);
  assert.ok(calls > afterBegin, "end must repaint the footer");
  run.end(true); // idempotent but still notifies
  const afterSecondEnd = calls;
  assert.ok(afterSecondEnd > afterBegin);

  unsubscribe();
  beginSyncAgentRun({ agent: "worker", task: "t2", cwd: projectCwd });
  assert.equal(calls, afterSecondEnd);
  reset();
});

test("abortAll stops every running child before clearing", () => {
  reset();
  const first = beginSyncAgentRun({ agent: "a", task: "t", cwd: projectCwd });
  const second = beginSyncAgentRun({ agent: "b", task: "t", cwd: projectCwd });
  const aborted: string[] = [];
  first.setAbort(() => { aborted.push("a"); });
  second.setAbort(() => { aborted.push("b"); });
  const stopped = beginSyncAgentRun({ agent: "c", task: "t", cwd: projectCwd });
  beginSyncAgentRun({ agent: "done", task: "t", cwd: projectCwd }).end(true);

  assert.equal(abortAllSyncAgentRuns(), 3, "every still-running run counts, handle or not");
  assert.deepEqual(aborted.sort(), ["a", "b"]);
  assert.deepEqual(listSyncAgentRuns(), []);
  assert.deepEqual(listSyncAgentRunsWithFinished(), [], "clearing drops finished rows too");
  assert.equal(abortSyncAgentRun(stopped.id), false);
});

test("a run writes status.json from begin to end, then drops the dir with the row", () => {
  reset();
  const run = beginSyncAgentRun({ agent: "worker", task: "lifecycle", cwd: projectCwd });
  const dir = listSyncAgentRuns()[0].workerDir;
  assert.equal(dir, join(projectCwd, ".pi", "tmp", "sync-runs", run.id), "one dir per run under the project temp dir");
  const read = () => JSON.parse(readFileSync(join(dir, "status.json"), "utf-8"));

  // Created running: the overlay can render a row from its first instant.
  const running = read();
  assert.equal(running.state, "running");
  assert.equal(running.agent, "worker");
  assert.equal(running.task, "lifecycle");
  assert.ok(running.startedAt > 0);

  // Updated with what the child is doing right now.
  run.setPid(4242);
  run.setTool("bash");
  assert.equal(read().pid, 4242);
  assert.equal(read().tool, "bash");

  // Final state, still on disk for the grace window so an open detail view can read it.
  run.end(true);
  const done = read();
  assert.equal(done.state, "complete");
  assert.ok(done.endedAt >= done.startedAt);

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 61_000;
    assert.deepEqual(listSyncAgentRunsWithFinished(), []);
  } finally {
    Date.now = realNow;
  }
  assert.equal(existsSync(dir), false, "the dir goes with the row it described");
});

test("a registry stop writes killOrigin to status.json", () => {
  reset();
  const run = beginSyncAgentRun({ agent: "worker", task: "t", cwd: projectCwd });
  run.setAbort(() => {});
  const statusPath = join(listSyncAgentRuns()[0].workerDir, "status.json");

  assert.equal(abortSyncAgentRun(run.id), true);
  assert.equal(JSON.parse(readFileSync(statusPath, "utf-8")).killOrigin, "user");
  run.end(false);
  reset();
});

test("end keeps the killOrigin a stop wrote", () => {
  reset();
  const run = beginSyncAgentRun({ agent: "worker", task: "t", cwd: projectCwd });
  run.setAbort(() => {});
  const statusPath = join(listSyncAgentRuns()[0].workerDir, "status.json");

  assert.equal(abortSyncAgentRun(run.id), true);
  run.end(false);
  const final = JSON.parse(readFileSync(statusPath, "utf-8"));
  assert.equal(final.state, "failed");
  assert.equal(final.killOrigin, "user", "the final write must not drop who stopped it");
  reset();
});

test("a pre-placed status.json symlink is not followed", () => {
  reset();
  const id = nextRunId(projectCwd);
  const dir = join(projectCwd, ".pi", "tmp", "sync-runs", id);
  mkdirSync(dir, { recursive: true });
  const victim = join(projectCwd, "victim.txt");
  writeFileSync(victim, "untouched");
  symlinkSync(victim, join(dir, "status.json"));

  const run = beginSyncAgentRun({ agent: "worker", task: "t", cwd: projectCwd });
  assert.equal(run.id, id, "the prepared dir must be the one the run uses");
  assert.equal(readFileSync(victim, "utf-8"), "untouched", "a hostile link must not redirect the write");
  assert.equal(lstatSync(join(dir, "status.json")).isSymbolicLink(), false, "the link is replaced, not written through");
  assert.equal(JSON.parse(readFileSync(join(dir, "status.json"), "utf-8")).state, "running");
  reset();
});

test("a symlinked run dir is refused and logged", () => {
  reset();
  const previousSid = (globalThis as any).__piConfigSessionId;
  setGlobalSessionId("sync-agent-runs-symlinked-dir-test");
  const logPath = getPiLogPath("sync-agent-runs")!;
  const before = existsSync(logPath) ? readFileSync(logPath, "utf-8").length : 0;
  try {
    const id = nextRunId(projectCwd);
    const decoy = makeTempDir("sync-runs-decoy-");
    const dir = join(projectCwd, ".pi", "tmp", "sync-runs", id);
    mkdirSync(dirname(dir), { recursive: true });
    symlinkSync(decoy, dir);

    const run = beginSyncAgentRun({ agent: "worker", task: "t", cwd: projectCwd });
    assert.equal(run.id, id);
    assert.equal(existsSync(join(decoy, "status.json")), false, "nothing may be written through a symlinked run dir");
    const logged = readFileSync(logPath, "utf-8").slice(before);
    assert.match(logged, /status_write_refused_symlinked_dir/, "a refused write is visible in the log");
  } finally {
    if (previousSid === undefined) delete (globalThis as any).__piConfigSessionId;
    else (globalThis as any).__piConfigSessionId = previousSid;
    reset();
  }
});

test("two sessions never share a worker dir", () => {
  reset();
  const previousSid = (globalThis as any).__piConfigSessionId;
  try {
    setGlobalSessionId("session-a");
    const first = beginSyncAgentRun({ agent: "worker", task: "t", cwd: projectCwd });
    setGlobalSessionId("session-b");
    beginSyncAgentRun({ agent: "worker", task: "t", cwd: projectCwd });
    const dirs = listSyncAgentRuns().map((r) => r.workerDir);

    assert.notEqual(dirs[0], dirs[1], "a shared cwd must not mean a shared dir");
    assert.ok(dirs[0].includes("session-a") && dirs[1].includes("session-b"));
    // One session's teardown must leave the other's live dir alone.
    first.end(true);
    assert.ok(existsSync(join(dirs[1], "status.json")));
  } finally {
    if (previousSid === undefined) delete (globalThis as any).__piConfigSessionId;
    else (globalThis as any).__piConfigSessionId = previousSid;
    reset();
  }
});

test("formatAgentsStatus — every mix", () => {
  assert.equal(formatAgentsStatus(0, 0), "💤 agents: 0");
  assert.equal(formatAgentsStatus(2, 0), "⏳ async: 2");
  assert.equal(formatAgentsStatus(2, 1), "⏳ agents: 3 (2 async, 1 sync)");
  assert.equal(formatAgentsStatus(0, 1), "⏳ agents: 1 (1 sync)");
  assert.equal(formatAgentsStatus(0, 3), "⏳ agents: 3 (3 sync)");
  assert.equal(formatAgentsStatus(1, 0), "⏳ async: 1");
});

// ── runSingleAgent: stop one row, keep the batch ──────────────────────────

/**
 * The sync path spawns `process.argv[1]`, so a real Node child at that boundary is what
 * `runSingleAgent` runs. One script, several behaviours, chosen by the task text it is given.
 */
const CHILD = `
const task = process.argv[process.argv.length - 1] || "";
if (task.includes("error-stop")) {
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" } }));
  process.exit(0);
}
// Register SIGTERM handler and keepalive before writing the readiness marker so the parent
// never signals the child before it is actually ignoring SIGTERM.
if (task.includes("ignore-term")) process.on("SIGTERM", () => {});
if (task.includes("slow")) setInterval(() => {}, 1000);
require("node:fs").writeFileSync(process.env.CHILD_MARK + (task.includes("slow") ? ".slow" : ".fast"), "up");
`;

function withChild() {
  const cwd = makeTempDir("sync-runs-child-");
  const previous = { argv: process.argv[1], mark: process.env.CHILD_MARK };
  writeFileSync(join(cwd, "settings.json"), "{}");
  setGlobalSettingsPath(join(cwd, "settings.json"));
  clearSettingsCache();
  writeFileSync(join(cwd, "child.cjs"), CHILD);
  process.argv[1] = join(cwd, "child.cjs");
  process.env.CHILD_MARK = join(cwd, "started");
  return {
    cwd,
    agents: [
      { name: "worker", source: "project", systemPrompt: "", tools: [] },
      { name: "helper", source: "project", systemPrompt: "", tools: [] },
    ] as any,
    mark: (kind: "slow" | "fast") => `${process.env.CHILD_MARK}.${kind}`,
    restore() {
      process.argv[1] = previous.argv;
      if (previous.mark === undefined) delete process.env.CHILD_MARK;
      else process.env.CHILD_MARK = previous.mark;
      setGlobalSettingsPath(null);
      clearSettingsCache();
    },
  };
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a row stop fails that one result and lets its sibling finish", { timeout: 30_000 }, async () => {
  const h = withChild();
  reset();
  try {
    const slow = runSingleAgent(h.agents, "worker", "slow job", h.cwd, undefined, undefined, undefined, () => ({} as any));
    const fast = runSingleAgent(h.agents, "helper", "fast job", h.cwd, undefined, undefined, undefined, () => ({} as any));

    // Abort through the registry once the child exists and its handle is registered.
    await waitFor(() => existsSync(h.mark("slow")) && listSyncAgentRuns().some((r) => r.task === "slow job"), "slow child");
    const stopped = listSyncAgentRuns().find((r) => r.task === "slow job")!;
    // The worker dir the overlay reads belongs to the row, not to a name lookup.
    assert.ok(stopped.workerDir.endsWith(stopped.id), "each row carries its own worker dir");
    assert.equal(abortSyncAgentRun(stopped.id), true);

    // A returned result, not a rejection: Promise.all must not discard the sibling.
    const [slowResult, fastResult] = await Promise.all([slow, fast]);
    assert.equal(slowResult.exitCode, 1);
    assert.equal(slowResult.stoppedByRegistry, true, "a stopped result is marked so it is not penalised");
    assert.match(slowResult.stderr, /stopped from \/async/);
    assert.equal(fastResult.exitCode, 0, "the sibling must not be collateral");

    assert.equal(syncAgentRunCount(), 0);
    const statuses = listSyncAgentRunsWithFinished().map((r) => `${r.task}:${r.status}`).sort();
    assert.deepEqual(statuses, ["fast job:complete", "slow job:failed"]);
  } finally {
    h.restore();
    reset();
  }
});

test("a stop that lands before the spawn kills the fresh child", { timeout: 30_000 }, async () => {
  const h = withChild();
  reset();
  let stoppedId: string | undefined;
  // The registry notifies synchronously inside begin(), i.e. before setAbort exists: exactly
  // the window this guards. A child that survived it would keep this test hanging.
  const unsubscribe = onSyncAgentRunsChanged(() => {
    const run = listSyncAgentRuns().find((r) => r.task === "slow early stop");
    if (!run || stoppedId === run.id) return;
    stoppedId = run.id;
    assert.equal(abortSyncAgentRun(run.id), true);
  });
  try {
    const result = await runSingleAgent(h.agents, "helper", "slow early stop", h.cwd, undefined, undefined, undefined, () => ({} as any));
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /stopped from \/async/);
    assert.equal(listSyncAgentRunsWithFinished()[0].status, "failed");
  } finally {
    unsubscribe();
    h.restore();
    reset();
  }
});

test("a parent abort cancels the call even after a registry stop", { timeout: 30_000 }, async () => {
  const h = withChild();
  reset();
  try {
    const ac = new AbortController();
    const run = runSingleAgent(h.agents, "worker", "slow job", h.cwd, undefined, ac.signal, undefined, () => ({} as any));
    await waitFor(() => existsSync(h.mark("slow")), "slow child");
    // Shutdown order: the user's /async-status stop lands first, then the parent aborts. Both
    // are synchronous, so the child's close event cannot settle the promise in between.
    assert.equal(abortSyncAgentRun(listSyncAgentRuns().find((r) => r.task === "slow job")!.id), true);
    ac.abort();
    // A failed result here would tell the orchestrator the call finished normally while the
    // session is shutting down.
    await assert.rejects(run, /Subagent was aborted/);
  } finally {
    h.restore();
    reset();
  }
});

test("a zero-exit child that reports an error stop reason is not complete", { timeout: 30_000 }, async () => {
  const h = withChild();
  reset();
  try {
    const result = await runSingleAgent(h.agents, "worker", "error-stop", h.cwd, undefined, undefined, undefined, () => ({} as any));
    assert.equal(result.exitCode, 0, "the child exits cleanly");
    assert.equal(result.stopReason, "error");
    const [run] = listSyncAgentRunsWithFinished();
    assert.equal(run.status, "failed", "a failed agent must not show as complete");
    assert.equal(JSON.parse(readFileSync(join(run.workerDir, "status.json"), "utf-8")).state, "failed");
  } finally {
    h.restore();
    reset();
  }
});

test("a child that ignores SIGTERM is escalated to SIGKILL", { timeout: 30_000 }, async () => {
  const h = withChild();
  reset();
  try {
    const run = runSingleAgent(h.agents, "worker", "slow ignore-term", h.cwd, undefined, undefined, undefined, () => ({} as any));
    await waitFor(() => existsSync(h.mark("slow")), "stubborn child");
    const started = Date.now();
    assert.equal(abortSyncAgentRun(listSyncAgentRuns().find((r) => r.task === "slow ignore-term")!.id), true);
    const result = await run;
    // `proc.killed` is true the moment SIGTERM is sent, so the old escalation never fired and
    // this promise would never settle. Reaching the 5 s timer is the proof it fired; 4,950 ms
    // floor absorbs minor setTimeout/clock jitter without letting a shortened escalation timer pass.
    assert.ok(Date.now() - started >= 4_950, "escalation runs on its 5 s timer");
    assert.equal(result.exitCode, 1);
  } finally {
    h.restore();
    reset();
  }
});
