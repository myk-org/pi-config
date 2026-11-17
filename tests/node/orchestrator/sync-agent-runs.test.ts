/**
 * Sync agent run registry — visibility-only registry for sync subagents (#1121).
 *
 * Checks the parts that decide what the footer, /async-status and pidash show:
 * counts, the footer strings for every mix, idempotent end, abort routing by run id,
 * and the finished-row retention that keeps a detail view from lying. The last three
 * tests drive `runSingleAgent` itself, because "stop one row, keep the batch" is a
 * property of the spawn loop, not of the map.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
import { makeTempDir } from "../helpers/temp-dirs.js";

function reset() {
  abortAllSyncAgentRuns();
}

test("begin registers a running run; end clears it", () => {
  reset();
  const run = beginSyncAgentRun({ agent: "worker", task: "do it", cwd: "/tmp" });
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
  const run = beginSyncAgentRun({ agent: "worker", task: "t", cwd: "/tmp" });
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
  const run = beginSyncAgentRun({ agent: "worker", task: "t", cwd: "/tmp" });
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
  const run = beginSyncAgentRun({ agent: "code-reviewer-x", task: "t", cwd: "/tmp" });
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
  const run = beginSyncAgentRun({ agent: "worker", task: "t", cwd: "/tmp" });
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
  beginSyncAgentRun({ agent: "worker", task: "t", cwd: "/tmp" });
  assert.equal(abortSyncAgentRun("nobody"), false);
  assert.equal(syncAgentRunCount(), 1);
  reset();
});

test("a finished run is retained with its final status, then dropped after the grace window", () => {
  reset();
  const run = beginSyncAgentRun({ agent: "worker", task: "t", cwd: "/tmp" });
  run.end(true);
  assert.equal(syncAgentRunCount(), 0);
  const [done] = listSyncAgentRunsWithFinished();
  assert.equal(done.id, run.id);
  assert.equal(done.status, "complete");
  assert.ok(done.endedAt! >= done.startedAt);

  // A long session cannot grow the retained set: newest 20 only.
  for (let i = 0; i < 25; i++) beginSyncAgentRun({ agent: "worker", task: `t${i}`, cwd: "/tmp" }).end(true);
  const retained = listSyncAgentRunsWithFinished();
  assert.equal(retained.length, 20);
  assert.equal(retained[retained.length - 1].task, "t24", "newest kept");

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
  const run = beginSyncAgentRun({ agent: "worker", task: "t", cwd: "/tmp" });
  const afterBegin = calls;
  assert.ok(afterBegin > 0, "begin must repaint the footer");
  run.end(true);
  assert.ok(calls > afterBegin, "end must repaint the footer");
  run.end(true); // idempotent but still notifies
  const afterSecondEnd = calls;
  assert.ok(afterSecondEnd > afterBegin);

  unsubscribe();
  beginSyncAgentRun({ agent: "worker", task: "t2", cwd: "/tmp" });
  assert.equal(calls, afterSecondEnd);
  reset();
});

test("abortAll stops every running child before clearing", () => {
  reset();
  const first = beginSyncAgentRun({ agent: "a", task: "t", cwd: "/tmp" });
  const second = beginSyncAgentRun({ agent: "b", task: "t", cwd: "/tmp" });
  const aborted: string[] = [];
  first.setAbort(() => { aborted.push("a"); });
  second.setAbort(() => { aborted.push("b"); });
  const stopped = beginSyncAgentRun({ agent: "c", task: "t", cwd: "/tmp" });
  beginSyncAgentRun({ agent: "done", task: "t", cwd: "/tmp" }).end(true);

  assert.equal(abortAllSyncAgentRuns(), 3, "every still-running run counts, handle or not");
  assert.deepEqual(aborted.sort(), ["a", "b"]);
  assert.deepEqual(listSyncAgentRuns(), []);
  assert.deepEqual(listSyncAgentRunsWithFinished(), [], "clearing drops finished rows too");
  assert.equal(abortSyncAgentRun(stopped.id), false);
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
 * `runSingleAgent` runs. One script, two behaviours, chosen by the task text it is given.
 */
const CHILD = `
const task = process.argv[process.argv.length - 1] || "";
require("node:fs").writeFileSync(process.env.CHILD_MARK + (task.includes("slow") ? ".slow" : ".fast"), "up");
if (task.includes("ignore-term")) process.on("SIGTERM", () => {});
if (task.includes("slow")) setInterval(() => {}, 1000);
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
    assert.equal(abortSyncAgentRun(stopped.id), true);

    // A returned result, not a rejection: Promise.all must not discard the sibling.
    const [slowResult, fastResult] = await Promise.all([slow, fast]);
    assert.equal(slowResult.exitCode, 1);
    assert.match(slowResult.stderr, /stopped from \/async-status/);
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
    assert.match(result.stderr, /stopped from \/async-status/);
    assert.equal(listSyncAgentRunsWithFinished()[0].status, "failed");
  } finally {
    unsubscribe();
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
    // this promise would never settle. Reaching the 5 s timer is the proof it fired.
    assert.ok(Date.now() - started >= 5_000, "escalation runs on its 5 s timer");
    assert.equal(result.exitCode, 1);
  } finally {
    h.restore();
    reset();
  }
});
