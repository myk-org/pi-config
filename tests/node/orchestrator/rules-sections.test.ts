/**
 * before_agent_start section injection tests (issue #915).
 * Run: npx tsx --test tests/node/orchestrator/rules-sections.test.ts
 *
 * Verifies that memory/rules context is injected via
 * event.systemPromptOptions.sections (transcript-delta friendly, preserves
 * prompt-cache prefixes) instead of replacing the whole systemPrompt, and
 * that a forced prompt from an earlier handler falls back to composition.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerRules } from "../../../extensions/orchestrator/rules.js";

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
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rules-sections-"));
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
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rules-forced-"));
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
});
