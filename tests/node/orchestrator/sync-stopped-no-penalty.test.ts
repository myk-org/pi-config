/**
 * A user stop must not penalise later sync calls (#1121).
 *
 * The single-agent path turns an over-limit runtime into `syncPenalty`, which then rejects
 * every later sync estimate. A child the user stopped from /async-status never ran its course,
 * so counting its runtime would block the orchestrator with the user's own kill.
 *
 * Its own file: the penalty is module-level state that only an over-limit run resets, so the
 * test must not leak it into another suite's sync calls.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerSubagentTool } from "../../../extensions/orchestrator/subagent-tool.js";
import {
  abortAllSyncAgentRuns,
  abortSyncAgentRun,
  listSyncAgentRuns,
} from "../../../extensions/orchestrator/sync-agent-runs.js";
import { clearSettingsCache, setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

/** Slow jobs stay alive until killed; fast jobs answer and exit 0. */
const CHILD = `
const task = process.argv[process.argv.length - 1] || "";
require("node:fs").writeFileSync(process.env.CHILD_MARK, "up");
if (task.includes("slow")) setInterval(() => {}, 1000);
else process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ran" }] } }) + "\\n");
`;

function harness() {
  const cwd = makeTempDir("sync-penalty-");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  // 10 is the smallest limit the setting accepts; 32s of runtime then counts as over-limit.
  writeFileSync(join(cwd, ".pi", "pi-config-settings.json"), JSON.stringify({ sync_agent_max_seconds: 10 }));
  writeFileSync(join(cwd, "settings.json"), "{}");
  setGlobalSettingsPath(join(cwd, "settings.json"));
  clearSettingsCache();

  const childScript = join(cwd, "child.cjs");
  writeFileSync(childScript, CHILD);
  const previousArgv1 = process.argv[1];
  process.argv[1] = childScript;
  process.env.CHILD_MARK = join(cwd, "started");

  let tool: any;
  const pi = {
    registerTool(definition: any) {
      tool = definition;
    },
    registerCommand() {},
    on() {},
    sendMessage() {},
    events: { on() {}, emit() {} },
  } as any;
  withSubagentChildEnv(undefined, () => {
    registerSubagentTool(pi, () => ({ id: "async-job" }), () => ({ killed: [], errors: [] }));
  });
  assert.ok(tool, "the subagent tool must register");

  const ctx = {
    cwd,
    hasUI: false,
    model: { id: "claude-sonnet-4-5", provider: "anthropic" },
    ui: { theme: { fg: (_: string, value: string) => value, bold: (value: string) => value }, notify() {}, setWorkingMessage() {}, setStatus() {}, confirm: async () => true },
    sessionManager: { getSessionId: () => "sess-sync-penalty" },
  };

  return {
    cwd,
    mark: process.env.CHILD_MARK,
    run: (params: Record<string, unknown>) =>
      tool.execute("call-sync", { confirmProjectAgents: false, agent: "worker", cwd, ...params }, new AbortController().signal, undefined, ctx),
    restore() {
      process.argv[1] = previousArgv1;
      delete process.env.CHILD_MARK;
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

test("a stopped runaway does not penalise the next sync call", { timeout: 30_000 }, async () => {
  const h = harness();
  const realNow = Date.now;
  let skew = 0;
  try {
    const slow = h.run({ task: "slow job", estimatedSeconds: 1 });
    await waitFor(() => existsSync(h.mark), "the slow child");
    // The penalty only fires past the 30s grace, so age the clock instead of sleeping 31s.
    Date.now = () => realNow() + skew;
    skew = 32_000;
    const stopped = listSyncAgentRuns().find((r) => r.task.includes("slow job"))!;
    assert.equal(abortSyncAgentRun(stopped.id), true);
    const stoppedResult = await slow;
    assert.equal(stoppedResult.isError, true, "the stopped call reports the stop");

    // Back to real time: this call's own runtime is honest, only the penalty could reject it.
    skew = 0;
    const later = await h.run({ task: "fast job", estimatedSeconds: 1 });
    assert.notEqual(later.isError, true, `a later small sync call must still run: ${later.content[0].text}`);
    assert.doesNotMatch(later.content[0].text, /Rejected/);
    assert.match(later.content[0].text, /ran/);
  } finally {
    Date.now = realNow;
    abortAllSyncAgentRuns();
    h.restore();
  }
});
