import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { discoverAgents } from "../../../extensions/orchestrator/agents.js";
import { registerRules } from "../../../extensions/orchestrator/rules.js";
import * as sessionValidation from "../../../extensions/orchestrator/session-validation.js";

describe("ESM runtime module paths", () => {
  it("discoverAgents loads package agents from the module directory", () => {
    const packageAgent = discoverAgents(process.cwd(), "project").agents.find(
      (agent) => agent.source === "package",
    );

    assert.ok(packageAgent);
    assert.ok(existsSync(packageAgent.filePath));
  });

  it("registerRules loads package rules from the module directory", async () => {
    const child = process.env.PI_SUBAGENT_CHILD;
    const handlers = new Map<string, Function>();
    delete process.env.PI_SUBAGENT_CHILD;
    try {
      registerRules({ on(event: string, handler: Function) { handlers.set(event, handler); } } as any);
      const result = await handlers.get("before_agent_start")!(
        { systemPrompt: "base", prompt: "ok" },
        { cwd: process.cwd() },
      );
      assert.match(result.systemPrompt, /# Orchestrator Core Rules/);
    } finally {
      if (child === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = child;
    }
  });

  it("findPackageVersion searches from the ESM module directory", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    assert.equal(sessionValidation.findPackageVersion(), pkg.version);
  });
});
