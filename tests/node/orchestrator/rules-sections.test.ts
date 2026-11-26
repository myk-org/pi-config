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
const originalSupervised = process.env.PI_COMS_SUPERVISED_PEER;

before(() => {
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_COMS_SUPERVISED_PEER;
});
after(() => {
  if (originalChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = originalChild;
  if (originalSupervised === undefined) delete process.env.PI_COMS_SUPERVISED_PEER;
  else process.env.PI_COMS_SUPERVISED_PEER = originalSupervised;
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

  it("delivers ticking async agent status outside systemPromptOptions.sections so prefix stays byte-identical (#1178, #1414)", async () => {
    const cwd = makeTempDir("rules-async-section-");
    try {
      let jobs: Array<{ id: string; agent: string; name?: string; task: string; status: string; startedAt: number }> = [];
      const { pi, handlers } = makeMockPi();
      registerRules(pi, () => jobs);
      const h = getBeforeAgentStart(handlers);

      // Turn 1: 0 async jobs — no async section and no per-turn message
      const e1 = makeEvent(cwd);
      const res1 = await h.fn(e1, { cwd });
      const s1 = e1.systemPromptOptions.sections;
      assert.ok(s1.orchestrator_rules && !s1.orchestrator_rules.includes("# Async Agents Status"));
      assert.equal(s1.async_agents_status, undefined);
      assert.equal(res1, undefined);

      // Turn 2: 1 running job (5s elapsed) — delivered via turn-context message, sections unchanged
      jobs = [{ id: "j1", agent: "worker", name: "Watcher", task: "watch", status: "running", startedAt: Date.now() - 5_000 }];
      const e2 = makeEvent(cwd);
      const res2 = await h.fn(e2, { cwd });
      const s2 = e2.systemPromptOptions.sections;
      assert.equal(s2.orchestrator_rules, s1.orchestrator_rules, "orchestrator_rules stays byte-identical on 0 -> 1 transition");
      assert.equal(s2.async_agents_status, undefined, "async status never mutates cached systemPromptOptions.sections");
      assert.equal(res2?.message?.customType, "orchestrator-turn-context");
      assert.equal(res2?.message?.display, false);
      assert.ok(res2?.message?.content.includes("1 async agent(s) running"));
      assert.ok(res2?.message?.content.includes("Watcher (worker)"));

      // Turn 3: same job, elapsed ticked to 65s
      jobs = [{ id: "j1", agent: "worker", name: "Watcher", task: "watch", status: "running", startedAt: Date.now() - 65_000 }];
      const e3 = makeEvent(cwd);
      const res3 = await h.fn(e3, { cwd });
      const s3 = e3.systemPromptOptions.sections;
      assert.equal(s3.orchestrator_rules, s1.orchestrator_rules, "orchestrator_rules stays byte-identical as elapsed ticks");
      assert.equal(s3.async_agents_status, undefined);
      assert.notEqual(res3?.message?.content, res2?.message?.content, "per-turn message reflects updated elapsed time");

      // Turn 4: transition back to 0 jobs — emits one-time transition notice, then silent on Turn 5
      jobs = [];
      const e4Idle = makeEvent(cwd);
      const res4Idle = await h.fn(e4Idle, { cwd });
      assert.ok(res4Idle?.message?.content.includes("No async agents running."));
      const e5Idle = makeEvent(cwd);
      const res5Idle = await h.fn(e5Idle, { cwd });
      assert.equal(res5Idle, undefined);

      // Fallback forced prompt still concatenates both sections in order
      jobs = [{ id: "j1", agent: "worker", name: "Watcher", task: "watch", status: "running", startedAt: Date.now() - 65_000 }];
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
      const res = await h.fn(event, { cwd });

      const sections = event.systemPromptOptions.sections;
      assert.ok(sections.project_memory?.includes(pinnedRule), "pinned rule is in project_memory");
      assert.equal(
        sections.contextual_memories,
        undefined,
        "contextual memories must not mutate systemPromptOptions.sections",
      );
      assert.ok(
        !res?.message?.content?.includes(pinnedRule),
        "pinned rule already in project_memory must not be duplicated in contextual turn message",
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
      const res = await h.fn(event, { cwd });

      const sections = event.systemPromptOptions.sections;
      assert.ok(sections.project_memory?.includes(longerEmitted), "pinned longer rule is in project_memory");
      assert.ok(
        !sections.project_memory?.includes(`\n- [lesson] ${shorterPrefix}\n`),
        "shorter prefix entry was omitted from project_memory",
      );
      assert.equal(sections.contextual_memories, undefined, "contextual memories delivered outside systemPromptOptions.sections");
      assert.ok(
        res?.message?.content?.includes(`- [lesson] ${shorterPrefix}`),
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
      const res = await h.fn(event, { cwd, sessionManager: { getSessionId: () => activeSid } });

      assert.equal(event.systemPromptOptions.sections.past_sessions, undefined);
      const pastContent = res?.message?.content ?? "";
      assert.ok(pastContent.includes(pastSid.slice(0, 8)));
      assert.ok(!pastContent.includes(activeSid.slice(0, 8)));
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
      resetSessionBridge({ all: true });
      clearRulesCache();
      clearSettingsCache();
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });

  it("includes ask_user User Interaction rule for interactive TUI sessions (#1403)", async () => {
    const cwd = makeTempDir("rules-tui-ask-");
    try {
      const { pi, handlers } = makeMockPi();
      registerRules(pi);
      const h = getBeforeAgentStart(handlers);
      const event = makeEvent(cwd);
      await h.fn(event, { cwd, hasUI: true, mode: "tui", sessionManager: { getSessionId: () => "sess-tui-1403" } });
      const rules = event.systemPromptOptions.sections.orchestrator_rules;
      assert.match(rules, /always use the `ask_user` tool/);
      assert.doesNotMatch(rules, /No interactive TUI is attached to this session/);
    } finally {
      resetSessionBridge({ all: true });
      clearRulesCache();
      clearSettingsCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("replaces ask_user rule with coms_send routing for supervised COMS peers (#1403)", async () => {
    const cwd = makeTempDir("rules-sup-coms-");
    const prev = process.env.PI_COMS_SUPERVISED_PEER;
    process.env.PI_COMS_SUPERVISED_PEER = "1";
    try {
      setComsActive(true, "sess-sup-1403");
      const { pi, handlers } = makeMockPi();
      registerRules(pi);
      const h = getBeforeAgentStart(handlers);
      const event = makeEvent(cwd);
      await h.fn(event, { cwd, hasUI: true, mode: "rpc", sessionManager: { getSessionId: () => "sess-sup-1403" } });
      const rules = event.systemPromptOptions.sections.orchestrator_rules;
      assert.doesNotMatch(rules, /always use the `ask_user` tool/);
      assert.match(rules, /No interactive TUI is attached to this session/);
      assert.match(rules, /via `coms_send`/);
    } finally {
      if (prev === undefined) delete process.env.PI_COMS_SUPERVISED_PEER;
      else process.env.PI_COMS_SUPERVISED_PEER = prev;
      resetSessionBridge({ all: true });
      clearRulesCache();
      clearSettingsCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("replaces ask_user rule with stop-and-report guidance for standalone non-TUI sessions (#1403)", async () => {
    const cwd = makeTempDir("rules-standalone-nontui-");
    try {
      setComsActive(false, "sess-print-1403");
      const { pi, handlers } = makeMockPi();
      registerRules(pi);
      const h = getBeforeAgentStart(handlers);
      const event = makeEvent(cwd);
      await h.fn(event, { cwd, hasUI: false, mode: "print", sessionManager: { getSessionId: () => "sess-print-1403" } });
      const rules = event.systemPromptOptions.sections.orchestrator_rules;
      assert.doesNotMatch(rules, /always use the `ask_user` tool/);
      assert.match(rules, /No interactive TUI is attached to this session/);
      assert.match(rules, /stop and report the blocker/);
    } finally {
      resetSessionBridge({ all: true });
      clearRulesCache();
      clearSettingsCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
