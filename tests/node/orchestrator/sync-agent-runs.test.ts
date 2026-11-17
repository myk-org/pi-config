/**
 * Sync agent run registry — visibility-only registry for sync subagents (#1121).
 *
 * Checks the parts that decide what the footer, /async-status and pidash show:
 * counts, the footer strings for every mix, idempotent end, and abort routing by
 * id and by agent name.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  abortSyncAgentRun,
  beginSyncAgentRun,
  clearSyncAgentRuns,
  formatAgentsStatus,
  listSyncAgentRuns,
  onSyncAgentRunsChanged,
  syncAgentRunCount,
} from "../../../extensions/orchestrator/sync-agent-runs.js";

function reset() {
  clearSyncAgentRuns();
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

test("abort by id marks the run failed, fires the abort fn once", () => {
  reset();
  const run = beginSyncAgentRun({ agent: "worker", task: "t", cwd: "/tmp" });
  let aborts = 0;
  run.setAbort(() => { aborts++; });

  assert.equal(abortSyncAgentRun(run.id), true);
  assert.equal(aborts, 1);
  assert.equal(syncAgentRunCount(), 0);

  // Already gone: unknown-or-finished is a false, not a second kill.
  assert.equal(abortSyncAgentRun(run.id), false);
  assert.equal(aborts, 1);
});

test("abort matches the agent name too", () => {
  reset();
  const run = beginSyncAgentRun({ agent: "code-reviewer-x", task: "t", cwd: "/tmp" });
  let aborts = 0;
  run.setAbort(() => { aborts++; });
  assert.equal(abortSyncAgentRun("code-reviewer-x"), true);
  assert.equal(aborts, 1);
  assert.equal(syncAgentRunCount(), 0);
});

test("abort of an unknown target returns false and changes nothing", () => {
  reset();
  beginSyncAgentRun({ agent: "worker", task: "t", cwd: "/tmp" });
  assert.equal(abortSyncAgentRun("nobody"), false);
  assert.equal(syncAgentRunCount(), 1);
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

test("formatAgentsStatus — every mix", () => {
  assert.equal(formatAgentsStatus(0, 0), "💤 agents: 0");
  assert.equal(formatAgentsStatus(2, 0), "⏳ async: 2");
  assert.equal(formatAgentsStatus(2, 1), "⏳ agents: 3 (2 async, 1 sync)");
  assert.equal(formatAgentsStatus(0, 1), "⏳ agents: 1 (1 sync)");
  assert.equal(formatAgentsStatus(0, 3), "⏳ agents: 3 (3 sync)");
  assert.equal(formatAgentsStatus(1, 0), "⏳ async: 1");
});
