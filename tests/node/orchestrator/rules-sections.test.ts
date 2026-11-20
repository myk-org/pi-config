/**
 * before_agent_start section injection tests (issue #915).
 * Run: npx tsx --test tests/node/orchestrator/rules-sections.test.ts
 *
 * Verifies that memory/rules context is injected via
 * event.systemPromptOptions.sections (transcript-delta friendly, preserves
 * prompt-cache prefixes) instead of replacing the whole systemPrompt, and
 * that a forced prompt from an earlier handler falls back to composition.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerRules } from "../../../extensions/orchestrator/rules.js";
import { makeTempDir } from "../helpers/temp-dirs.js";


const originalChild = process.env.PI_SUBAGENT_CHILD;

before(() => delete process.env.PI_SUBAGENT_CHILD);
after(() => {
  if (originalChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = originalChild;
});

interface CapturedHandler {
  event: string;
  fn: (event: any, ctx: any) => Promise<any>;
}

function makeMockPi(): { pi: any; handlers: CapturedHandler[] } {
  const handlers: CapturedHandler[] = [];
  const pi: any = {
    on: (event: string, fn: any) => handlers.push({ event, fn }),
    registerCommand: () => {},
    registerTool: () => {},
    sendMessage: () => {},
  };
  return { pi, handlers };
}

function getBeforeAgentStart(handlers: CapturedHandler[]): CapturedHandler {
  const h = handlers.find((x) => x.event === "before_agent_start");
  assert.ok(h, "before_agent_start handler registered");
  return h;
}

function makeEvent(cwd: string, forced?: string) {
  return {
    type: "before_agent_start",
    prompt: "please review this PR for the memory system",
    // When an earlier handler forces the prompt, pi renders event.systemPrompt
    // from the forced text — later handlers observe the override.
    systemPrompt: forced ?? "# base system prompt",
    systemPromptOptions: {
      cwd,
      forceSystemPrompt: forced,
      sections: {} as Record<string, string>,
      selectedTools: [],
      hiddenTools: [],
      toolSnippets: {},
      toolGuidelines: {},
      promptGuidelines: [],
      appendSystemPrompt: "",
      contextFiles: [],
      skills: [],
    },
  };
}

describe("before_agent_start section injection", () => {
  it("injects context as structured sections, not a full systemPrompt replacement", async () => {
    const cwd = makeTempDir("rules-sections-");
    try {
      // Seed a memory so the situation report has content
      const topicsDir = path.join(cwd, ".pi", "memory", "topics");
      fs.mkdirSync(topicsDir, { recursive: true });
      fs.writeFileSync(
        path.join(topicsDir, "preferences.md"),
        "# Preferences\n\n- [preference] Always show file paths in responses\n",
      );

      const { pi, handlers } = makeMockPi();
      registerRules(pi);
      const h = getBeforeAgentStart(handlers);

      const event = makeEvent(cwd);
      const result = await h.fn(event, { cwd });

      // Structured-section path: no full-prompt replacement
      assert.equal(result, undefined);
      const sections = event.systemPromptOptions.sections;
      assert.ok(typeof sections.orchestrator_rules === "string" && sections.orchestrator_rules.length > 50,
        "rules section injected with real content");
      // The base prompt was NOT concatenated into any section
      assert.ok(!sections.orchestrator_rules!.includes("# base system prompt"));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to systemPrompt composition when an earlier handler forced the prompt", async () => {
    const cwd = makeTempDir("rules-forced-");
    try {
      const topicsDir = path.join(cwd, ".pi", "memory", "topics");
      fs.mkdirSync(topicsDir, { recursive: true });
      fs.writeFileSync(
        path.join(topicsDir, "preferences.md"),
        "# Preferences\n\n- [preference] Always show file paths in responses\n",
      );

      const { pi, handlers } = makeMockPi();
      registerRules(pi);
      const h = getBeforeAgentStart(handlers);

      const forced = "FORCED PROMPT BY EARLIER HANDLER";
      const event = makeEvent(cwd, forced);
      const result = await h.fn(event, { cwd });

      // Forced-prompt path: compose on top of the forced text
      assert.ok(result, "returns a systemPrompt result");
      assert.ok(result.systemPrompt.startsWith(forced));
      assert.ok(result.systemPrompt.length > forced.length + 50, "composed context appended");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("splits ticking async agent status into async_agents_status so orchestrator_rules stays byte-identical (#1178)", async () => {
    const cwd = makeTempDir("rules-async-section-");
    try {
      let jobs: Array<{ id: string; agent: string; name?: string; task: string; status: string; startedAt: number }> = [];
      const { pi, handlers } = makeMockPi();
      registerRules(pi, () => jobs);
      const h = getBeforeAgentStart(handlers);

      // Turn 1: 0 async jobs
      const e1 = makeEvent(cwd);
      await h.fn(e1, { cwd });
      const s1 = e1.systemPromptOptions.sections;
      assert.ok(s1.orchestrator_rules && !s1.orchestrator_rules.includes("# Async Agents Status"));
      assert.equal(s1.async_agents_status, "# Async Agents Status\n\nNo async agents running.");

      // Turn 2: 1 running job (5s elapsed)
      jobs = [{ id: "j1", agent: "worker", name: "Watcher", task: "watch", status: "running", startedAt: Date.now() - 5_000 }];
      const e2 = makeEvent(cwd);
      await h.fn(e2, { cwd });
      const s2 = e2.systemPromptOptions.sections;
      assert.equal(s2.orchestrator_rules, s1.orchestrator_rules, "orchestrator_rules stays byte-identical on 0 -> 1 transition");
      assert.ok(s2.async_agents_status.includes("1 async agent(s) running"));
      assert.ok(s2.async_agents_status.includes("Watcher (worker)"));

      // Turn 3: same job, elapsed ticked to 65s
      jobs = [{ id: "j1", agent: "worker", name: "Watcher", task: "watch", status: "running", startedAt: Date.now() - 65_000 }];
      const e3 = makeEvent(cwd);
      await h.fn(e3, { cwd });
      const s3 = e3.systemPromptOptions.sections;
      assert.equal(s3.orchestrator_rules, s1.orchestrator_rules, "orchestrator_rules stays byte-identical as elapsed ticks");
      assert.notEqual(s3.async_agents_status, s2.async_agents_status, "async_agents_status reflects updated elapsed time");

      // Fallback forced prompt still concatenates both sections in order
      const forced = "FORCED";
      const e4 = makeEvent(cwd, forced);
      const res4 = await h.fn(e4, { cwd });
      assert.ok(res4?.systemPrompt.startsWith(forced));
      assert.ok(res4.systemPrompt.includes("# Async Agents Status"));
      assert.ok(res4.systemPrompt.includes("Watcher (worker)"));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("omits async_agents_status when getAsyncJobs is not provided (#1178)", async () => {
    const cwd = makeTempDir("rules-no-async-");
    try {
      const { pi, handlers } = makeMockPi();
      registerRules(pi);
      const h = getBeforeAgentStart(handlers);
      const event = makeEvent(cwd);
      await h.fn(event, { cwd });
      assert.equal(event.systemPromptOptions.sections.async_agents_status, undefined);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
