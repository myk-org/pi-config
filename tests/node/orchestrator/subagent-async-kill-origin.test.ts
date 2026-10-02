import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerSubagentTool } from "../../../extensions/orchestrator/subagent-tool.js";
import type { AsyncKillOrigin } from "../../../extensions/orchestrator/async-agents.js";
import { createLogger } from "../../../extensions/shared/logger.js";

const log = createLogger("subagent-async-kill-test");

/**
 * Minimal harness around registerSubagentTool. The asyncKill parameter is
 * handled by an early return before mode validation, so no agent discovery or
 * spawn behaviour is exercised here — only the attribution the tool passes to
 * killAsyncAgent.
 */
function harness() {
  const cwd = mkdtempSync(join(tmpdir(), "subagent-async-kill-"));
  const killCalls: Array<{ target: string; origin: AsyncKillOrigin | undefined }> = [];
  let tool: any;
  const pi = {
    registerTool(definition: any) { tool = definition; },
    on() {},
    events: { on() {}, emit() {} },
  } as any;

  registerSubagentTool(
    pi,
    () => ({ id: "unused", error: "spawn is not exercised by this test" }),
    (target: string, origin?: AsyncKillOrigin) => {
      killCalls.push({ target, origin });
      return { killed: [target], errors: [] };
    },
  );

  const ctx = {
    cwd,
    hasUI: true,
    ui: { theme: { fg: (_: string, value: string) => value }, notify() {}, setWorkingMessage() {} },
    sessionManager: { getCwd: () => cwd, getSessionId: () => "test" },
  };

  return {
    tool,
    killCalls,
    ctx,
    run: (params: Record<string, unknown>) => tool.execute("call-1", params, new AbortController().signal, () => {}, ctx),
    restore: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

describe("subagent asyncKill attribution (issue #816)", () => {
  it("passes the orchestrator origin when the LLM issues asyncKill", async () => {
    const h = harness();
    try {
      await h.run({ asyncKill: "worker" });
      log.debug("async_kill_case", { origin: "orchestrator", via: "subagent(asyncKill)" });
      assert.equal(h.killCalls.length, 1);
      assert.equal(h.killCalls[0].target, "worker");
      assert.equal(
        h.killCalls[0].origin,
        "orchestrator",
        "an LLM-issued kill must never be attributed to the user",
      );
    } finally { h.restore(); }
  });

  it("does not attribute the kill to the user", async () => {
    const h = harness();
    try {
      await h.run({ asyncKill: "reviewer-1" });
      assert.notEqual(h.killCalls[0].origin, "user");
    } finally { h.restore(); }
  });
});
