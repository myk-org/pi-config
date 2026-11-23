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
import { clearRulesCache, registerRules } from "../../../extensions/orchestrator/rules.js";
import { resetSessionBridge, setComsActive } from "../../../extensions/shared/session-bridge.js";
import { clearSettingsCache } from "../../../extensions/orchestrator/project-settings.js";
import { clearSessionScanCache, getProjectSessionsDir } from "../../../extensions/orchestrator/session-search.js";
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

  it("deduplicates contextual_memories against entries already emitted in project_memory (#1199)", async () => {
    const cwd = makeTempDir("rules-dedup-");
    try {
      const { isVectorSearchAvailable, embedEntry } = await import(
        "../../../extensions/orchestrator/memory-embeddings.js"
      );
      if (!(await isVectorSearchAvailable())) return;

      const topicsDir = path.join(cwd, ".pi", "memory", "topics");
      fs.mkdirSync(topicsDir, { recursive: true });
      const pinnedRule = "Always run tox before pushing changes to the branch";
      fs.writeFileSync(
        path.join(topicsDir, "preferences.md"),
        `# Preferences\n\n- [preference] ${pinnedRule} *(pinned)*\n`,
      );
      await embedEntry(cwd, pinnedRule, "preference");

      const { pi, handlers } = makeMockPi();
      registerRules(pi);
      const h = getBeforeAgentStart(handlers);

      const event = { ...makeEvent(cwd), messageType: "user" as const, prompt: "Always run tox before pushing changes to the branch" };
      await h.fn(event, { cwd });

      const sections = event.systemPromptOptions.sections;
      assert.ok(sections.project_memory?.includes(pinnedRule), "pinned rule is in project_memory");
      assert.equal(
        sections.contextual_memories,
        undefined,
        "pinned rule already in project_memory must not be duplicated in contextual_memories",
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("retains a distinct contextual candidate whose canonical line prefixes an emitted entry (#1199)", async () => {
    const cwd = makeTempDir("rules-prefix-");
    try {
      const { isVectorSearchAvailable, embedEntry } = await import(
        "../../../extensions/orchestrator/memory-embeddings.js"
      );
      if (!(await isVectorSearchAvailable())) return;

      const topicsDir = path.join(cwd, ".pi", "memory", "topics");
      fs.mkdirSync(topicsDir, { recursive: true });
      const longerEmitted = "Use tox before pushing any branch updates to origin";
      const fillerPinned = "Always check build output logs before merging any pull request";
      const shorterPrefix = "Use tox";
      fs.writeFileSync(
        path.join(topicsDir, "lessons.md"),
        `# Lessons\n\n- [lesson] ${longerEmitted} *(pinned)*\n- [lesson] ${fillerPinned} *(pinned)*\n- [lesson] ${shorterPrefix}\n`,
      );
      // Tighten memory_token_budget so Pinned entries fit in project_memory while
      // non-pinned shorterPrefix is omitted for context budget (remains eligible for contextual recall).
      fs.writeFileSync(
        path.join(cwd, ".pi", "pi-config-settings.json"),
        JSON.stringify({ memory_token_budget: 75 }),
      );
      await embedEntry(cwd, longerEmitted, "lesson");
      await embedEntry(cwd, fillerPinned, "lesson");
      await embedEntry(cwd, shorterPrefix, "lesson");

      const { pi, handlers } = makeMockPi();
      registerRules(pi);
      const h = getBeforeAgentStart(handlers);

      const event = { ...makeEvent(cwd), messageType: "user" as const, prompt: "Use tox" };
      await h.fn(event, { cwd });

      const sections = event.systemPromptOptions.sections;
      assert.ok(sections.project_memory?.includes(longerEmitted), "pinned longer rule is in project_memory");
      assert.ok(
        !sections.project_memory?.includes(`\n- [lesson] ${shorterPrefix}\n`),
        "shorter prefix entry was omitted from project_memory",
      );
      assert.ok(
        sections.contextual_memories?.includes(`- [lesson] ${shorterPrefix}`),
        "distinct prefix memory must not be dropped by substring match",
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("continues turn cleanly when memory store migration lock fails (#1199)", async () => {
    const cwd = makeTempDir("rules-lockfail-");
    try {
      const memDir = path.join(cwd, ".pi", "memory");
      fs.mkdirSync(path.join(memDir, "topics"), { recursive: true });
      fs.writeFileSync(
        path.join(memDir, "topics", "lessons.md"),
        "# Lessons\n\n- [lesson] Keep running\n",
      );
      // Legacy scores without hashAlgo triggers locked migration inside loadScores()
      fs.writeFileSync(
        path.join(memDir, "memory-scores.jsonl"),
        JSON.stringify({ entries: { deadbeef: { class: "lesson", score: 1 } }, lastRebuild: new Date().toISOString() }) + "\n",
      );
      // Hold the lock with live parent PID so migration fails after backoff
      fs.writeFileSync(path.join(memDir, "memory-scores.jsonl.wlock"), String(process.ppid));

      const { pi, handlers } = makeMockPi();
      registerRules(pi);
      const h = getBeforeAgentStart(handlers);

      const event = makeEvent(cwd);
      await h.fn(event, { cwd });

      assert.ok(
        typeof event.systemPromptOptions.sections.orchestrator_rules === "string" &&
          event.systemPromptOptions.sections.orchestrator_rules.length > 50,
        "rules still inject when memory store throws",
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("caches assembled rules across repeated turns (#1229)", async () => {
    const cwd = makeTempDir("rules-cache-hit-");
    try {
      clearRulesCache();
      clearSettingsCache();
      const rulesDir = path.join(cwd, ".pi", "rules");
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(path.join(rulesDir, "99-custom-test.md"), "CUSTOM_RULE_V1 cycle={{REVIEW_LOOP_MAX_CYCLES}}\n");

      const { pi, handlers } = makeMockPi();
      registerRules(pi);
      const h = getBeforeAgentStart(handlers);

      const e1 = makeEvent(cwd);
      await h.fn(e1, { cwd });
      const r1 = e1.systemPromptOptions.sections.orchestrator_rules;
      assert.ok(r1.includes("CUSTOM_RULE_V1 cycle=3"));

      const e2 = makeEvent(cwd);
      await h.fn(e2, { cwd });
      assert.equal(e2.systemPromptOptions.sections.orchestrator_rules, r1);
    } finally {
      clearRulesCache();
      clearSettingsCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("invalidates assembled rules cache when settings change (#1229)", async () => {
    const cwd = makeTempDir("rules-cache-settings-");
    try {
      clearRulesCache();
      clearSettingsCache();
      const rulesDir = path.join(cwd, ".pi", "rules");
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(path.join(rulesDir, "99-custom-test.md"), "CUSTOM_RULE_V1 cycle={{REVIEW_LOOP_MAX_CYCLES}}\n");

      const { pi, handlers } = makeMockPi();
      registerRules(pi);
      const h = getBeforeAgentStart(handlers);

      await h.fn(makeEvent(cwd), { cwd });
      fs.writeFileSync(
        path.join(cwd, ".pi", "pi-config-settings.json"),
        JSON.stringify({ review_loop_max_cycles: 5 }),
      );
      clearSettingsCache();
      const e2 = makeEvent(cwd);
      await h.fn(e2, { cwd });
      assert.ok(e2.systemPromptOptions.sections.orchestrator_rules.includes("CUSTOM_RULE_V1 cycle=5"));
    } finally {
      clearRulesCache();
      clearSettingsCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("invalidates assembled rules cache when a project rule file changes (#1229)", async () => {
    const cwd = makeTempDir("rules-cache-project-");
    try {
      clearRulesCache();
      clearSettingsCache();
      const rulesDir = path.join(cwd, ".pi", "rules");
      fs.mkdirSync(rulesDir, { recursive: true });
      const customRulePath = path.join(rulesDir, "99-custom-test.md");
      fs.writeFileSync(customRulePath, "CUSTOM_RULE_V1\n");

      const { pi, handlers } = makeMockPi();
      registerRules(pi);
      const h = getBeforeAgentStart(handlers);

      await h.fn(makeEvent(cwd), { cwd });
      fs.writeFileSync(customRulePath, "CUSTOM_RULE_V2\n");
      const e2 = makeEvent(cwd);
      await h.fn(e2, { cwd });
      assert.ok(e2.systemPromptOptions.sections.orchestrator_rules.includes("CUSTOM_RULE_V2"));
    } finally {
      clearRulesCache();
      clearSettingsCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reflects edits to package rules on the next turn without restart (#1229)", async () => {
    const cwd = makeTempDir("rules-cache-pkg-");
    const pkgRulesDir = makeTempDir("pkg-rules-");
    try {
      clearRulesCache();
      clearSettingsCache();
      const pkgRuleFile = path.join(pkgRulesDir, "00-pkg.md");
      fs.writeFileSync(pkgRuleFile, "PKG_RULE_V1\n");

      const { pi, handlers } = makeMockPi();
      registerRules(pi, undefined, { packageRulesDir: pkgRulesDir });
      const h = getBeforeAgentStart(handlers);

      const e1 = makeEvent(cwd);
      await h.fn(e1, { cwd });
      assert.ok(e1.systemPromptOptions.sections.orchestrator_rules.includes("PKG_RULE_V1"));

      fs.writeFileSync(pkgRuleFile, "PKG_RULE_V2\n");
      const e2 = makeEvent(cwd);
      await h.fn(e2, { cwd });
      assert.ok(e2.systemPromptOptions.sections.orchestrator_rules.includes("PKG_RULE_V2"));
    } finally {
      clearRulesCache();
      clearSettingsCache();
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });

  it("excludes the active session from automatic past_sessions recall (#1342)", async () => {
    const cwd = makeTempDir("rules-past-sessions-");
    const agentDir = makeTempDir("rules-pi-agent-");
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      clearRulesCache();
      clearSettingsCache();
      clearSessionScanCache();

      const sessionsDir = getProjectSessionsDir(cwd);
      fs.mkdirSync(sessionsDir, { recursive: true });
      const activeSid = "active-turn-session-1";
      const pastSid = "previous-chat-session-2";
      fs.writeFileSync(
        path.join(sessionsDir, `2026-11-22T18-00-00-000Z_${activeSid}.jsonl`),
        [
          JSON.stringify({ type: "session", version: 3, id: activeSid, timestamp: "2026-11-22T18:00:00.000Z", cwd }),
          JSON.stringify({
            type: "message",
            timestamp: "2026-11-22T18:01:00.000Z",
            message: { role: "user", content: "Investigating unique-autosession-topic in the current session" },
          }),
        ].join("\n") + "\n",
      );
      fs.writeFileSync(
        path.join(sessionsDir, `2026-11-21T18-00-00-000Z_${pastSid}.jsonl`),
        [
          JSON.stringify({ type: "session", version: 3, id: pastSid, timestamp: "2026-11-21T18:00:00.000Z", cwd }),
          JSON.stringify({
            type: "message",
            timestamp: "2026-11-21T18:01:00.000Z",
            message: { role: "user", content: "Prior discussion about unique-autosession-topic yesterday" },
          }),
        ].join("\n") + "\n",
      );

      const { pi, handlers } = makeMockPi();
      registerRules(pi);
      const h = getBeforeAgentStart(handlers);
      const event = {
        ...makeEvent(cwd),
        messageType: "user",
        prompt: "Tell me more about unique-autosession-topic",
      };
      await h.fn(event, { cwd, sessionManager: { getSessionId: () => activeSid } });

      const pastSection = event.systemPromptOptions.sections.past_sessions ?? "";
      assert.ok(pastSection.includes(pastSid.slice(0, 8)));
      assert.ok(!pastSection.includes(activeSid.slice(0, 8)));
    } finally {
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      clearSessionScanCache();
      clearRulesCache();
      clearSettingsCache();
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("isolates coms_active-gated rules per session", async () => {
    const cwd = makeTempDir("rules-coms-iso-cwd-");
    const pkgRulesDir = makeTempDir("rules-coms-iso-pkg-");
    try {
      fs.writeFileSync(
        path.join(pkgRulesDir, "10-coms-gated.md"),
        "---\nrequires: coms_active\n---\n# Coms Session Only Rule\n",
      );
      fs.writeFileSync(path.join(pkgRulesDir, "20-always.md"), "# Always Rule\n");

      setComsActive(true, "sess-with-coms");
      setComsActive(false, "sess-without-coms");

      const { pi, handlers } = makeMockPi();
      registerRules(pi, undefined, { packageRulesDir: pkgRulesDir });
      const h = getBeforeAgentStart(handlers);

      const evWithComs = makeEvent(cwd);
      await h.fn(evWithComs, { cwd, sessionManager: { getSessionId: () => "sess-with-coms" } });
      const evWithoutComs = makeEvent(cwd);
      await h.fn(evWithoutComs, { cwd, sessionManager: { getSessionId: () => "sess-without-coms" } });

      assert.ok(evWithComs.systemPromptOptions.sections.orchestrator_rules.includes("Coms Session Only Rule"));
      assert.ok(!evWithoutComs.systemPromptOptions.sections.orchestrator_rules.includes("Coms Session Only Rule"));
      assert.ok(evWithoutComs.systemPromptOptions.sections.orchestrator_rules.includes("Always Rule"));
    } finally {
      resetSessionBridge();
      clearRulesCache();
      clearSettingsCache();
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });
});
