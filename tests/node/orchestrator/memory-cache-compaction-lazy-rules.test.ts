/**
 * Regression tests for:
 * - #1414: Prompt-cache-safe memory injection, snapshot mutation/cross-process
 *          notices, transient load retry, full-entry read guard on memory_edit.
 * - #1422: Pre-compaction standing memory context (fail-soft, subagent skip,
 *          real Pi compact() delivery) plus post-compaction snapshot refresh.
 * - #1415: Path/tool-scoped lazy rule injection, layer precedence override,
 *          blocked-call recovery, per-session deduplication, compaction reset.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { compact, DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { clearRulesCache, registerRules } from "../../../extensions/orchestrator/rules.js";
import { clearSettingsCache } from "../../../extensions/orchestrator/project-settings.js";
import {
  addMemoryEntry,
  clearMemoryMutationJournal,
  editMemoryEntry,
  pruneExpiredEntries,
  removeMemoryEntry,
} from "../../../extensions/orchestrator/memory-store.js";
import { buildCompactionMemoryContext } from "../../../extensions/orchestrator/situation-report.js";
import { registerMemoryTools } from "../../../extensions/orchestrator/memory-tools.js";
import { entryHash, mutateScores, reinforce } from "../../../extensions/orchestrator/memory-scoring.js";
import { invalidateTopicFileCache } from "../../../extensions/orchestrator/memory-tree.js";
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

afterEach(() => {
  delete process.env.PI_SUBAGENT_CHILD;
  clearRulesCache();
  clearSettingsCache();
  clearMemoryMutationJournal();
});

interface CapturedHandler {
  event: string;
  fn: (event: any, ctx: any) => Promise<any>;
}

function makeMockPi(): { pi: any; handlers: CapturedHandler[]; tools: Map<string, any> } {
  const handlers: CapturedHandler[] = [];
  const tools = new Map<string, any>();
  const pi: any = {
    on: (event: string, fn: any) => handlers.push({ event, fn }),
    registerCommand: () => {},
    registerTool: (tool: any) => tools.set(tool.name, tool),
    sendMessage: () => {},
  };
  return { pi, handlers, tools };
}

function getHandler(handlers: CapturedHandler[], event: string): CapturedHandler {
  const h = handlers.find((x) => x.event === event);
  assert.ok(h, `${event} handler registered`);
  return h;
}

function makeBeforeAgentStartEvent(cwd: string, prompt = "inspect the repo") {
  return {
    type: "before_agent_start",
    messageType: "user" as const,
    prompt,
    systemPrompt: "# base system prompt",
    systemPromptOptions: {
      cwd,
      forceSystemPrompt: undefined,
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

describe("#1414 prompt-cache-safe memory injection", () => {
  it("keeps project_memory byte-identical across query-class shifts plus mid-session writes", async () => {
    const cwd = makeTempDir("mem-cache-prefix-");
    const pkgRulesDir = makeTempDir("mem-cache-pkg-");
    try {
      fs.writeFileSync(path.join(pkgRulesDir, "10-core.md"), "# Core Rule\nAlways be concise.\n");
      await addMemoryEntry(cwd, {
        text: "Always run npm run typecheck before opening a PR",
        category: "preference",
        pinned: true,
      });
      await addMemoryEntry(cwd, {
        text: "Debug failing tests with minimal repros first",
        category: "lesson",
      });

      const { pi, handlers } = makeMockPi();
      registerRules(pi, undefined, { packageRulesDir: pkgRulesDir });
      const beforeStart = getHandler(handlers, "before_agent_start");
      const ctx = { cwd, sessionManager: { getSessionId: () => "sess-1414-stable" } };

      const e1 = makeBeforeAgentStartEvent(cwd, "Tell me about the architecture");
      await beforeStart.fn(e1, ctx);
      const pm1 = e1.systemPromptOptions.sections.project_memory;
      const rules1 = e1.systemPromptOptions.sections.orchestrator_rules;
      assert.ok(pm1?.includes("Always run npm run typecheck before opening a PR"));

      await addMemoryEntry(cwd, {
        text: "Prefer WAL mode for concurrent SQLite readers",
        category: "pattern",
      });
      reinforce(cwd, "- [lesson] Debug failing tests with minimal repros first");

      const e2 = makeBeforeAgentStartEvent(cwd, "Please review PR #42 for regressions");
      await beforeStart.fn(e2, ctx);
      assert.equal(e2.systemPromptOptions.sections.project_memory, pm1);
      assert.equal(e2.systemPromptOptions.sections.orchestrator_rules, rules1);
      assert.equal(e2.systemPromptOptions.sections.contextual_memories, undefined);
      assert.equal(e2.systemPromptOptions.sections.past_sessions, undefined);
      assert.equal(e2.systemPromptOptions.sections.async_agents_status, undefined);

      const e3 = makeBeforeAgentStartEvent(cwd, "Debug this crash stack trace in worker.ts");
      await beforeStart.fn(e3, ctx);
      assert.equal(e3.systemPromptOptions.sections.project_memory, pm1);
      assert.equal(e3.systemPromptOptions.sections.orchestrator_rules, rules1);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });

  it("delivers a one-time notice outside sections when a pinned snapshot memory changes", async () => {
    const cwd = makeTempDir("mem-cache-notice-");
    const pkgRulesDir = makeTempDir("mem-cache-notice-pkg-");
    try {
      fs.writeFileSync(path.join(pkgRulesDir, "10-core.md"), "# Core Rule\n");
      const origRule = "Always run unit tests via npx tsx before committing";
      const updatedRule = "Always run full tox plus npm run typecheck before committing";
      await addMemoryEntry(cwd, { text: origRule, category: "preference", pinned: true });

      const { pi, handlers } = makeMockPi();
      registerRules(pi, undefined, { packageRulesDir: pkgRulesDir });
      const beforeStart = getHandler(handlers, "before_agent_start");
      const ctx = { cwd, sessionManager: { getSessionId: () => "sess-1414-notice" } };

      const e1 = makeBeforeAgentStartEvent(cwd, "ok");
      await beforeStart.fn(e1, ctx);
      const pm1 = e1.systemPromptOptions.sections.project_memory;
      assert.ok(pm1?.includes(origRule));

      const editRes = await editMemoryEntry(cwd, {
        category: "preference",
        text: origRule,
        newText: updatedRule,
      });
      assert.equal(editRes.status, "updated");

      const e2 = makeBeforeAgentStartEvent(cwd, "ok");
      const res2 = await beforeStart.fn(e2, ctx);
      assert.equal(e2.systemPromptOptions.sections.project_memory, pm1);
      assert.equal(res2?.message?.customType, "orchestrator-turn-context");
      assert.equal(res2?.message?.display, false);
      assert.ok(res2?.message?.content.includes("# Project Memory Updates"));
      assert.ok(res2?.message?.content.includes(updatedRule));

      const e3 = makeBeforeAgentStartEvent(cwd, "ok");
      const res3 = await beforeStart.fn(e3, ctx);
      assert.equal(res3, undefined, "invalidation notice delivered only once");

      const remRes = removeMemoryEntry(cwd, "preference", updatedRule, { recordTombstone: true });
      assert.equal(remRes.status, "removed");
      const e4 = makeBeforeAgentStartEvent(cwd, "ok");
      const res4 = await beforeStart.fn(e4, ctx);
      assert.equal(e4.systemPromptOptions.sections.project_memory, pm1);
      assert.ok(res4?.message?.content.includes("[removed]"));
      assert.ok(res4?.message?.content.includes(updatedRule));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });

  it("keeps replacement text of an edited pinned memory eligible for vector recall", async () => {
    const cwd = makeTempDir("mem-cache-edit-recall-");
    const pkgRulesDir = makeTempDir("mem-cache-edit-recall-pkg-");
    try {
      const { isVectorSearchAvailable } = await import("../../../extensions/orchestrator/memory-embeddings.js");
      if (!(await isVectorSearchAvailable())) return;

      fs.writeFileSync(path.join(pkgRulesDir, "10-core.md"), "# Core Rule\n");
      const origRule = "Always build containers with docker buildx";
      const updatedRule = "Always use podman build with rootless storage for containers";
      await addMemoryEntry(cwd, { text: origRule, category: "preference", pinned: true });

      const { pi, handlers } = makeMockPi();
      registerRules(pi, undefined, { packageRulesDir: pkgRulesDir });
      const beforeStart = getHandler(handlers, "before_agent_start");
      const ctx = { cwd, sessionManager: { getSessionId: () => "sess-1414-recall" } };

      const e1 = makeBeforeAgentStartEvent(cwd, "ok");
      await beforeStart.fn(e1, ctx);

      await editMemoryEntry(cwd, { category: "preference", text: origRule, newText: updatedRule });

      // Turn 2 consumes the one-time notice
      const e2 = makeBeforeAgentStartEvent(cwd, "ok");
      await beforeStart.fn(e2, ctx);

      // Turn 3 queries for the replacement topic: must still surface via contextual vector recall
      const e3 = makeBeforeAgentStartEvent(cwd, "How should I run podman build with rootless storage for containers?");
      const res3 = await beforeStart.fn(e3, ctx);
      assert.ok(
        res3?.message?.content?.includes(updatedRule),
        "edited replacement text must remain recallable since pinned snapshot still shows old text",
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });

  it("retries pinning memory snapshot after a transient load failure on turn 1", async () => {
    const cwd = makeTempDir("mem-cache-retry-");
    const pkgRulesDir = makeTempDir("mem-cache-retry-pkg-");
    try {
      fs.writeFileSync(path.join(pkgRulesDir, "10-core.md"), "# Core Rule\n");
      const ruleText = "Recover cleanly after transient store error";
      const memDir = path.join(cwd, ".pi", "memory");
      fs.mkdirSync(path.join(memDir, "topics"), { recursive: true });
      fs.writeFileSync(
        path.join(memDir, "topics", "lessons.md"),
        `# Lessons\n\n- [lesson] ${ruleText} *(pinned)*\n`,
      );
      // Place a directory at .pi/data/state.db so SQLite open fails transiently on turn 1
      const stateDbPath = path.join(cwd, ".pi", "data", "state.db");
      fs.mkdirSync(stateDbPath, { recursive: true });

      const { pi, handlers } = makeMockPi();
      registerRules(pi, undefined, { packageRulesDir: pkgRulesDir });
      const beforeStart = getHandler(handlers, "before_agent_start");
      const ctx = { cwd, sessionManager: { getSessionId: () => "sess-1414-retry" } };

      // Turn 1 fails to load due to unusable state.db -> empty memory, NOT pinned
      const e1 = makeBeforeAgentStartEvent(cwd, "ok");
      await beforeStart.fn(e1, ctx);
      assert.equal(e1.systemPromptOptions.sections.project_memory, undefined);

      // Remove obstruction and initialize scores -> Turn 2 loads cleanly and pins memory
      fs.rmSync(stateDbPath, { recursive: true, force: true });
      const e2 = makeBeforeAgentStartEvent(cwd, "ok");
      await beforeStart.fn(e2, ctx);
      assert.ok(e2.systemPromptOptions.sections.project_memory?.includes(ruleText));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });

  it("emits a removal notice when pruneExpiredEntries deletes a pinned snapshot entry", async () => {
    const cwd = makeTempDir("mem-cache-expire-");
    const pkgRulesDir = makeTempDir("mem-cache-expire-pkg-");
    try {
      fs.writeFileSync(path.join(pkgRulesDir, "10-core.md"), "# Core Rule\n");
      const taskRule = "Keep feature flag enabled during rollout";
      const addRes = await addMemoryEntry(cwd, { text: taskRule, category: "lesson", pinned: true });
      assert.equal(addRes.status, "added");

      const { pi, handlers } = makeMockPi();
      registerRules(pi, undefined, { packageRulesDir: pkgRulesDir });
      const beforeStart = getHandler(handlers, "before_agent_start");
      const ctx = { cwd, sessionManager: { getSessionId: () => "sess-1414-expire" } };

      const e1 = makeBeforeAgentStartEvent(cwd, "ok");
      await beforeStart.fn(e1, ctx);
      assert.ok(e1.systemPromptOptions.sections.project_memory?.includes(taskRule));

      // Expire the entry and prune via store maintenance
      const hash = entryHash(`- [lesson] ${taskRule}`);
      mutateScores(cwd, (s) => {
        if (s.entries[hash]) s.entries[hash].expiresAt = new Date(Date.now() - 60_000).toISOString();
      });
      assert.equal(pruneExpiredEntries(cwd), 1);

      const e2 = makeBeforeAgentStartEvent(cwd, "ok");
      const res2 = await beforeStart.fn(e2, ctx);
      assert.ok(res2?.message?.content.includes("[removed]"));
      assert.ok(res2?.message?.content.includes(taskRule));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });

  it("reconciles snapshot notices when more than 200 mutations overflow the bounded journal", async () => {
    const cwd = makeTempDir("mem-cache-overflow-");
    const pkgRulesDir = makeTempDir("mem-cache-overflow-pkg-");
    try {
      fs.writeFileSync(path.join(pkgRulesDir, "10-core.md"), "# Core Rule\n");
      const watchedRule = "Always run database migrations in a transaction";
      await addMemoryEntry(cwd, { text: watchedRule, category: "lesson", pinned: true });
      await addMemoryEntry(cwd, { text: "Chatter rule iteration 0", category: "pattern" });

      const { pi, handlers } = makeMockPi();
      registerRules(pi, undefined, { packageRulesDir: pkgRulesDir });
      const beforeStart = getHandler(handlers, "before_agent_start");
      const ctx = { cwd, sessionManager: { getSessionId: () => "sess-1414-overflow" } };

      const e1 = makeBeforeAgentStartEvent(cwd, "ok");
      await beforeStart.fn(e1, ctx);
      assert.ok(e1.systemPromptOptions.sections.project_memory?.includes(watchedRule));

      // Remove watchedRule first, then push >200 unrelated edits so watchedRule is evicted from the journal
      removeMemoryEntry(cwd, "lesson", watchedRule, { recordTombstone: true });
      let current = "Chatter rule iteration 0";
      for (let i = 1; i <= 205; i++) {
        const next = `Chatter rule iteration ${i}`;
        const res = await editMemoryEntry(cwd, { category: "pattern", text: current, newText: next });
        assert.equal(res.status, "updated");
        current = next;
      }

      const e2 = makeBeforeAgentStartEvent(cwd, "ok");
      const res2 = await beforeStart.fn(e2, ctx);
      assert.ok(res2?.message?.content.includes("[removed]"));
      assert.ok(res2?.message?.content.includes(watchedRule));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });

  it("detects cross-process topic file removals without in-process journal events", async () => {
    const cwd = makeTempDir("mem-cache-xproc-");
    const pkgRulesDir = makeTempDir("mem-cache-xproc-pkg-");
    try {
      fs.writeFileSync(path.join(pkgRulesDir, "10-core.md"), "# Core Rule\n");
      const sharedRule = "Never push force to release branches";
      await addMemoryEntry(cwd, { text: sharedRule, category: "preference", pinned: true });

      const { pi, handlers } = makeMockPi();
      registerRules(pi, undefined, { packageRulesDir: pkgRulesDir });
      const beforeStart = getHandler(handlers, "before_agent_start");
      const ctx = { cwd, sessionManager: { getSessionId: () => "sess-1414-xproc" } };

      const e1 = makeBeforeAgentStartEvent(cwd, "ok");
      await beforeStart.fn(e1, ctx);
      assert.ok(e1.systemPromptOptions.sections.project_memory?.includes(sharedRule));

      // Simulate another process editing the topic markdown directly (no in-process journal record)
      const topicPath = path.join(cwd, ".pi", "memory", "topics", "preferences.md");
      fs.writeFileSync(topicPath, "# Preferences\n\n");
      invalidateTopicFileCache(topicPath);

      const e2 = makeBeforeAgentStartEvent(cwd, "ok");
      const res2 = await beforeStart.fn(e2, ctx);
      assert.ok(res2?.message?.content.includes("[removed]"));
      assert.ok(res2?.message?.content.includes(sharedRule));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });

  it("rejects truncated-preview overwrites in memory_edit", async () => {
    const cwd = makeTempDir("mem-edit-trunc-");
    try {
      const fullText = "Always run prek run --all-files plus npm run typecheck before pushing";
      await addMemoryEntry(cwd, { text: fullText, category: "lesson" });

      const { pi, tools } = makeMockPi();
      registerMemoryTools(pi);

      const truncRes = await tools.get("memory_edit").execute(
        "c1",
        {
          op: "update",
          category: "lesson",
          text: fullText,
          newText: "Always run prek run --all-files...",
        },
        undefined,
        undefined,
        { cwd },
      );
      assert.match(truncRes.content[0].text, /truncated preview/i);
      assert.ok(truncRes.content[0].text.includes(fullText));

      const topicContent = fs.readFileSync(path.join(cwd, ".pi", "memory", "topics", "lessons.md"), "utf-8");
      assert.ok(topicContent.includes(fullText));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns matching full unclipped text on clipped lookup misses", async () => {
    const cwd = makeTempDir("mem-edit-lookup-");
    try {
      const fullText = "Always run prek run --all-files plus npm run typecheck before pushing";
      await addMemoryEntry(cwd, { text: fullText, category: "lesson" });

      const { pi, tools } = makeMockPi();
      registerMemoryTools(pi);

      const clippedLookup = await tools.get("memory_edit").execute(
        "c2",
        {
          op: "update",
          category: "lesson",
          text: "Always run prek run --all-files...",
          newText: "Always run full verification gates before pushing",
        },
        undefined,
        undefined,
        { cwd },
      );
      assert.match(clippedLookup.content[0].text, /Memory not found/);
      assert.ok(clippedLookup.content[0].text.includes(fullText));

      const clippedRemove = await tools.get("memory_remove").execute(
        "c3",
        {
          category: "lesson",
          text: "Always run prek run --all-files…",
        },
        undefined,
        undefined,
        { cwd },
      );
      assert.match(clippedRemove.content[0].text, /Memory not found/);
      assert.ok(clippedRemove.content[0].text.includes(fullText));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("#1422 pre-compaction standing memory context", () => {
  it("prioritizes pinned entries over unpinned entries while excluding session-scoped items", async () => {
    const cwd = makeTempDir("mem-compact-ctx-");
    try {
      await addMemoryEntry(cwd, {
        text: "Never commit directly to main branch",
        category: "preference",
        pinned: true,
      });
      await addMemoryEntry(cwd, {
        text: "Use WAL SQLite store for concurrent state writes",
        category: "decision",
      });
      await addMemoryEntry(cwd, {
        text: "Transient note for this session only",
        category: "lesson",
        scope: "session",
      });

      const ctxText = buildCompactionMemoryContext(cwd, 400);
      assert.ok(ctxText.includes("# Standing Project Memory"));
      assert.ok(ctxText.includes("Never commit directly to main branch"));
      assert.ok(ctxText.includes("Use WAL SQLite store for concurrent state writes"));
      assert.ok(!ctxText.includes("Transient note for this session only"));
      assert.ok(ctxText.indexOf("Never commit directly to main branch") < ctxText.indexOf("Use WAL SQLite store"));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("disables compaction memory context when memory_token_budget is zero", async () => {
    const cwd = makeTempDir("mem-compact-zero-");
    try {
      await addMemoryEntry(cwd, { text: "Keep commits atomic", category: "preference", pinned: true });
      fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".pi", "pi-config-settings.json"), JSON.stringify({ memory_token_budget: 0 }));
      clearSettingsCache();
      assert.equal(buildCompactionMemoryContext(cwd, 400), "");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("excludes expired task-scoped entries from compaction memory context", async () => {
    const cwd = makeTempDir("mem-compact-expired-");
    try {
      const expiredText = "Temporary migration cutoff rule from last week";
      const activeText = "Always run npm run typecheck before commit";
      await addMemoryEntry(cwd, { text: expiredText, category: "decision", scope: "task" });
      await addMemoryEntry(cwd, { text: activeText, category: "preference", pinned: true });

      const hash = entryHash(`- [decision] ${expiredText}`);
      mutateScores(cwd, (s) => {
        if (s.entries[hash]) s.entries[hash].expiresAt = new Date(Date.now() - 60_000).toISOString();
      });

      const ctxText = buildCompactionMemoryContext(cwd, 400);
      assert.ok(ctxText.includes(activeText));
      assert.ok(!ctxText.includes(expiredText), "expired task-scoped entry must be excluded");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("skips an oversized pinned entry so shorter standing rules still fit", async () => {
    const cwd = makeTempDir("mem-compact-oversized-");
    try {
      const oversizedPinned = "Very long pinned constraint " + "x".repeat(300);
      const shortRule = "Use uv run for Python";
      await addMemoryEntry(cwd, { text: oversizedPinned, category: "preference", pinned: true });
      await addMemoryEntry(cwd, { text: shortRule, category: "lesson" });

      // Budget of 70 tokens = 280 chars: header (~180 chars) leaves ~100 chars,
      // enough for shortRule but not for oversizedPinned.
      const ctxText = buildCompactionMemoryContext(cwd, 70);
      assert.ok(!ctxText.includes(oversizedPinned));
      assert.ok(ctxText.includes(shortRule), "shorter rule must still be included");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("prepends standing memory in session_before_compact idempotently", async () => {
    const cwd = makeTempDir("mem-compact-normal-");
    try {
      await addMemoryEntry(cwd, {
        text: "Always preserve API backwards compatibility",
        category: "decision",
        pinned: true,
      });

      const { pi, handlers } = makeMockPi();
      registerRules(pi);
      const beforeCompact = getHandler(handlers, "session_before_compact");

      const prep: any = {
        firstKeptEntryId: "e5",
        messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 1000,
      };
      const r1 = await beforeCompact.fn({ type: "session_before_compact", preparation: prep, reason: "manual" }, { cwd });
      assert.equal(r1, undefined);
      assert.equal(prep.messagesToSummarize.length, 2);
      assert.equal(prep.messagesToSummarize[0].customType, "standing-project-memory");
      assert.ok(prep.messagesToSummarize[0].content.includes("Always preserve API backwards compatibility"));

      await beforeCompact.fn({ type: "session_before_compact", preparation: prep, reason: "manual" }, { cwd });
      assert.equal(prep.messagesToSummarize.length, 2);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("targets turnPrefixMessages on split turns when messagesToSummarize is empty", async () => {
    const cwd = makeTempDir("mem-compact-split-");
    try {
      await addMemoryEntry(cwd, {
        text: "Always preserve API backwards compatibility",
        category: "decision",
        pinned: true,
      });

      const { pi, handlers } = makeMockPi();
      registerRules(pi);
      const beforeCompact = getHandler(handlers, "session_before_compact");

      const prepSplit: any = {
        firstKeptEntryId: "e9",
        messagesToSummarize: [],
        turnPrefixMessages: [{ role: "user", content: [{ type: "text", text: "split" }], timestamp: 2 }],
        isSplitTurn: true,
        tokensBefore: 2000,
      };
      await beforeCompact.fn({ type: "session_before_compact", preparation: prepSplit, reason: "threshold" }, { cwd });
      assert.equal(prepSplit.turnPrefixMessages.length, 2);
      assert.equal(prepSplit.turnPrefixMessages[0].customType, "standing-project-memory");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("stays fail-soft when memory store throws during session_before_compact", async () => {
    const lockedCwd = makeTempDir("mem-compact-lock-");
    try {
      const memDir = path.join(lockedCwd, ".pi", "memory");
      fs.mkdirSync(path.join(memDir, "topics"), { recursive: true });
      fs.writeFileSync(path.join(memDir, "topics", "lessons.md"), "# Lessons\n\n- [lesson] Keep calm\n");
      fs.writeFileSync(
        path.join(memDir, "memory-scores.jsonl"),
        JSON.stringify({ entries: { bad: { class: "lesson", score: 1 } }, lastRebuild: new Date().toISOString() }) + "\n",
      );
      fs.writeFileSync(path.join(memDir, "memory-scores.jsonl.wlock"), String(process.ppid));

      const { pi, handlers } = makeMockPi();
      registerRules(pi);
      const beforeCompact = getHandler(handlers, "session_before_compact");

      const prepLock: any = {
        messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "x" }], timestamp: 3 }],
        turnPrefixMessages: [],
        isSplitTurn: false,
      };
      const rLock = await beforeCompact.fn(
        { type: "session_before_compact", preparation: prepLock, reason: "overflow" },
        { cwd: lockedCwd },
      );
      assert.equal(rLock, undefined);
      assert.equal(prepLock.messagesToSummarize.length, 1);
    } finally {
      fs.rmSync(lockedCwd, { recursive: true, force: true });
    }
  });

  it("skips pre-compaction standing memory injection for subagents", async () => {
    const cwd = makeTempDir("mem-compact-sub-");
    try {
      await addMemoryEntry(cwd, { text: "Keep subagents stateless", category: "preference", pinned: true });
      process.env.PI_SUBAGENT_CHILD = "1";
      const sub = makeMockPi();
      registerRules(sub.pi);
      const subBeforeCompact = getHandler(sub.handlers, "session_before_compact");

      const prepSub: any = {
        messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "sub" }], timestamp: 4 }],
        turnPrefixMessages: [],
        isSplitTurn: false,
      };
      await subBeforeCompact.fn({ type: "session_before_compact", preparation: prepSub, reason: "manual" }, { cwd });
      assert.equal(prepSub.messagesToSummarize.length, 1);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("delivers prepended standing memory into Pi compact() summarizer prompt", async () => {
    const cwd = makeTempDir("mem-compact-pi-int-");
    try {
      const standingRule = "Never disable strict TypeScript compilation checks";
      await addMemoryEntry(cwd, { text: standingRule, category: "preference", pinned: true });

      const { pi, handlers } = makeMockPi();
      registerRules(pi);
      const beforeCompact = getHandler(handlers, "session_before_compact");

      const preparation: any = {
        firstKeptEntryId: "entry-2",
        messagesToSummarize: [
          { role: "user", content: [{ type: "text", text: "Please refactor the parser" }], timestamp: 100 },
        ],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 1200,
        previousSummary: undefined,
        fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
        settings: DEFAULT_COMPACTION_SETTINGS,
      };

      await beforeCompact.fn({ type: "session_before_compact", preparation, reason: "manual" }, { cwd });

      let capturedPrompt = "";
      const fakeModel: any = {
        id: "mock-model",
        name: "Mock Model",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "http://127.0.0.1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      };
      const mockStreamFn: any = (_model: any, context: any) => {
        for (const m of context.messages ?? []) {
          if (Array.isArray(m.content)) {
            for (const block of m.content) {
              if (block?.type === "text") capturedPrompt += block.text;
            }
          }
        }
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({
            type: "done",
            reason: "stop",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "## Goal\nRefactor parser keeping strict TS checks." }],
              api: "anthropic-messages",
              provider: "anthropic",
              model: "mock-model",
              usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "stop",
              timestamp: Date.now(),
            },
          });
          stream.end();
        });
        return stream;
      };

      const result = await compact(
        preparation,
        fakeModel,
        "test-key",
        undefined,
        undefined,
        undefined,
        undefined,
        mockStreamFn,
      );
      assert.ok(capturedPrompt.includes("# Standing Project Memory"), "real Pi compact() received standing memory header");
      assert.ok(capturedPrompt.includes(standingRule), "real Pi compact() received standing rule text");
      assert.ok(result.summary.includes("Refactor parser"));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refreshes the pinned startup memory snapshot on session_compact", async () => {
    const cwd = makeTempDir("mem-compact-refresh-");
    const pkgRulesDir = makeTempDir("mem-compact-refresh-pkg-");
    try {
      fs.writeFileSync(path.join(pkgRulesDir, "10-core.md"), "# Core\n");
      const initialEntry = "Always stage explicit paths instead of git add dot";
      const updatedEntry = "Always stage explicit file paths before commit";
      const addedLater = "Never mutate cached system prompt sections mid-session";
      await addMemoryEntry(cwd, { text: initialEntry, category: "preference", pinned: true });

      const { pi, handlers } = makeMockPi();
      registerRules(pi, undefined, { packageRulesDir: pkgRulesDir });
      const beforeStart = getHandler(handlers, "before_agent_start");
      const onCompact = getHandler(handlers, "session_compact");
      const ctx = { cwd, sessionManager: { getSessionId: () => "sess-1422-refresh" } };

      const e1 = makeBeforeAgentStartEvent(cwd, "ok");
      await beforeStart.fn(e1, ctx);
      const pm1 = e1.systemPromptOptions.sections.project_memory;
      assert.ok(pm1?.includes(initialEntry));
      assert.ok(!pm1?.includes(addedLater));

      await editMemoryEntry(cwd, { category: "preference", text: initialEntry, newText: updatedEntry });
      await addMemoryEntry(cwd, { text: addedLater, category: "lesson", pinned: true });

      await onCompact.fn({ type: "session_compact", reason: "manual", fromExtension: false }, ctx);

      const e2 = makeBeforeAgentStartEvent(cwd, "ok");
      const res2 = await beforeStart.fn(e2, ctx);
      const pm2 = e2.systemPromptOptions.sections.project_memory;
      assert.ok(pm2?.includes(updatedEntry));
      assert.ok(pm2?.includes(addedLater));
      assert.ok(!pm2?.includes(initialEntry));
      assert.equal(res2, undefined);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });
});

describe("#1415 path/tool-scoped lazy rule injection", () => {
  it("excludes lazy rules from base orchestrator_rules section", async () => {
    const cwd = makeTempDir("lazy-rules-base-");
    const pkgRulesDir = makeTempDir("lazy-rules-base-pkg-");
    try {
      fs.writeFileSync(path.join(pkgRulesDir, "10-base.md"), "# Always Rule\nBase instructions.\n");
      fs.writeFileSync(
        path.join(pkgRulesDir, "20-python.md"),
        '---\nalwaysApply: false\nglobs: ["**/*.py"]\ntools: ["edit", "write"]\n---\n# Python Edit Rule\n',
      );

      const { pi, handlers } = makeMockPi();
      registerRules(pi, undefined, { packageRulesDir: pkgRulesDir });
      const beforeStart = getHandler(handlers, "before_agent_start");
      const ctx = { cwd, sessionManager: { getSessionId: () => "sess-1415-base" } };

      const e1 = makeBeforeAgentStartEvent(cwd, "Help me check the repo");
      const res1 = await beforeStart.fn(e1, ctx);
      const base1 = e1.systemPromptOptions.sections.orchestrator_rules;
      assert.ok(base1.includes("# Always Rule"));
      assert.ok(!base1.includes("# Python Edit Rule"));
      assert.equal(res1, undefined);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });

  it("injects matching lazy rules once per session on tool_result while preserving structuredContent", async () => {
    const cwd = makeTempDir("lazy-rules-tool-");
    const pkgRulesDir = makeTempDir("lazy-rules-tool-pkg-");
    try {
      fs.writeFileSync(path.join(pkgRulesDir, "10-base.md"), "# Always Rule\n");
      fs.writeFileSync(
        path.join(pkgRulesDir, "20-python.md"),
        '---\nalwaysApply: false\nglobs: ["**/*.py"]\ntools: ["edit", "write"]\n---\n# Python Edit Rule\n',
      );

      const { pi, handlers } = makeMockPi();
      registerRules(pi, undefined, { packageRulesDir: pkgRulesDir });
      const onToolCall = getHandler(handlers, "tool_call");
      const onToolResult = getHandler(handlers, "tool_result");
      const ctx = { cwd, sessionManager: { getSessionId: () => "sess-1415-tool" } };

      await onToolCall.fn({ type: "tool_call", toolCallId: "tc1", toolName: "read", input: { path: "src/app.py" } }, ctx);
      const tr1 = await onToolResult.fn(
        { type: "tool_result", toolCallId: "tc1", toolName: "read", input: { path: "src/app.py" }, content: [{ type: "text", text: "ok" }] },
        ctx,
      );
      assert.equal(tr1, undefined);

      await onToolCall.fn({ type: "tool_call", toolCallId: "tc2", toolName: "edit", input: { path: "src/app.py" } }, ctx);
      const tr2 = await onToolResult.fn(
        {
          type: "tool_result",
          toolCallId: "tc2",
          toolName: "edit",
          input: { path: "src/app.py" },
          content: [{ type: "text", text: "edited" }],
          structuredContent: { ok: true },
        },
        ctx,
      );
      assert.ok(tr2);
      assert.equal(tr2.content.length, 2);
      assert.ok(tr2.content[1].text.includes("# Python Edit Rule"));
      assert.deepEqual(tr2.structuredContent, { ok: true });

      await onToolCall.fn({ type: "tool_call", toolCallId: "tc3", toolName: "edit", input: { path: "src/other.py" } }, ctx);
      const tr3 = await onToolResult.fn(
        { type: "tool_result", toolCallId: "tc3", toolName: "edit", input: { path: "src/other.py" }, content: [{ type: "text", text: "edited" }] },
        ctx,
      );
      assert.equal(tr3, undefined);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });

  it("allows a later matching tool_result to deliver a lazy rule after an earlier tool_call was blocked", async () => {
    const cwd = makeTempDir("lazy-rules-blocked-");
    const pkgRulesDir = makeTempDir("lazy-rules-blocked-pkg-");
    try {
      fs.writeFileSync(path.join(pkgRulesDir, "10-base.md"), "# Always Rule\n");
      fs.writeFileSync(
        path.join(pkgRulesDir, "20-python.md"),
        '---\nalwaysApply: false\nglobs: ["**/*.py"]\ntools: ["edit", "write"]\n---\n# Python Edit Rule\n',
      );

      const { pi, handlers } = makeMockPi();
      registerRules(pi, undefined, { packageRulesDir: pkgRulesDir });
      const beforeStart = getHandler(handlers, "before_agent_start");
      const onToolCall = getHandler(handlers, "tool_call");
      const onToolResult = getHandler(handlers, "tool_result");
      const ctx = { cwd, sessionManager: { getSessionId: () => "sess-1415-blocked" } };

      // First call matches tool_call, then is blocked (no tool_result fires for tc-blocked)
      await onToolCall.fn({ type: "tool_call", toolCallId: "tc-blocked", toolName: "edit", input: { path: "src/a.py" } }, ctx);

      // Second call in the same turn succeeds -> MUST deliver the rule immediately on its tool_result
      await onToolCall.fn({ type: "tool_call", toolCallId: "tc-ok", toolName: "edit", input: { path: "src/b.py" } }, ctx);
      const trOk = await onToolResult.fn(
        { type: "tool_result", toolCallId: "tc-ok", toolName: "edit", input: { path: "src/b.py" }, content: [{ type: "text", text: "ok" }] },
        ctx,
      );
      assert.ok(trOk?.content[1]?.text.includes("# Python Edit Rule"), "second tool result must deliver pending rule");

      // Next before_agent_start must NOT re-emit the already-delivered rule
      const eNext = makeBeforeAgentStartEvent(cwd, "ok");
      const resNext = await beforeStart.fn(eNext, ctx);
      assert.equal(resNext, undefined);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });

  it("injects glob-only lazy rules once on matching prompt paths without mutating base sections", async () => {
    const cwd = makeTempDir("lazy-rules-prompt-");
    const pkgRulesDir = makeTempDir("lazy-rules-prompt-pkg-");
    try {
      fs.writeFileSync(path.join(pkgRulesDir, "10-base.md"), "# Always Rule\n");
      fs.writeFileSync(
        path.join(pkgRulesDir, "30-docker.md"),
        '---\nglobs:\n  - "Dockerfile*"\n---\n# Docker Rule\nPin base image digests.\n',
      );

      const { pi, handlers } = makeMockPi();
      registerRules(pi, undefined, { packageRulesDir: pkgRulesDir });
      const beforeStart = getHandler(handlers, "before_agent_start");
      const ctx = { cwd, sessionManager: { getSessionId: () => "sess-1415-prompt" } };

      const e1 = makeBeforeAgentStartEvent(cwd, "Check repo layout");
      await beforeStart.fn(e1, ctx);
      const base1 = e1.systemPromptOptions.sections.orchestrator_rules;

      const e2 = makeBeforeAgentStartEvent(cwd, "Please inspect docker/Dockerfile.prod");
      const res2 = await beforeStart.fn(e2, ctx);
      assert.equal(e2.systemPromptOptions.sections.orchestrator_rules, base1);
      assert.ok(res2?.message?.content.includes("# Docker Rule"));

      const e3 = makeBeforeAgentStartEvent(cwd, "Check Dockerfile again");
      const res3 = await beforeStart.fn(e3, ctx);
      assert.equal(res3, undefined);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });

  it("resets lazy rule deduplication on session_compact", async () => {
    const cwd = makeTempDir("lazy-rules-compact-");
    const pkgRulesDir = makeTempDir("lazy-rules-compact-pkg-");
    try {
      fs.writeFileSync(path.join(pkgRulesDir, "10-base.md"), "# Always Rule\n");
      fs.writeFileSync(
        path.join(pkgRulesDir, "20-python.md"),
        '---\nalwaysApply: false\nglobs: ["**/*.py"]\ntools: ["write"]\n---\n# Python Write Rule\n',
      );

      const { pi, handlers } = makeMockPi();
      registerRules(pi, undefined, { packageRulesDir: pkgRulesDir });
      const onToolResult = getHandler(handlers, "tool_result");
      const onCompact = getHandler(handlers, "session_compact");
      const ctx = { cwd, sessionManager: { getSessionId: () => "sess-1415-compact" } };

      const tr1 = await onToolResult.fn(
        { type: "tool_result", toolCallId: "tc1", toolName: "write", input: { path: "a.py" }, content: [{ type: "text", text: "ok" }] },
        ctx,
      );
      assert.ok(tr1?.content[1]?.text.includes("# Python Write Rule"));

      await onCompact.fn({ type: "session_compact", reason: "manual", fromExtension: false }, ctx);

      const tr2 = await onToolResult.fn(
        { type: "tool_result", toolCallId: "tc2", toolName: "write", input: { path: "b.py" }, content: [{ type: "text", text: "ok" }] },
        ctx,
      );
      assert.ok(tr2?.content[1]?.text.includes("# Python Write Rule"));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });

  it("preserves project > package override precedence for lazy scoping", async () => {
    const cwd = makeTempDir("lazy-rules-prec-");
    const pkgRulesDir = makeTempDir("lazy-rules-prec-pkg-");
    try {
      fs.writeFileSync(path.join(pkgRulesDir, "10-keep.md"), "# Keep Base\n");
      fs.writeFileSync(path.join(pkgRulesDir, "20-override.md"), "# Package Always\n");
      fs.writeFileSync(path.join(pkgRulesDir, "30-disable.md"), "# Package To Disable\n");

      const projectRulesDir = path.join(cwd, ".pi", "rules");
      fs.mkdirSync(projectRulesDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectRulesDir, "20-override.md"),
        '---\nalwaysApply: false\ntools: ["bash"]\n---\n# Project Lazy Bash Rule\n',
      );
      fs.writeFileSync(
        path.join(projectRulesDir, "30-disable.md"),
        "---\nenabled: false\n---\n# Disabled By Project\n",
      );

      const { pi, handlers } = makeMockPi();
      registerRules(pi, undefined, { packageRulesDir: pkgRulesDir });
      const beforeStart = getHandler(handlers, "before_agent_start");
      const onToolResult = getHandler(handlers, "tool_result");
      const ctx = { cwd, sessionManager: { getSessionId: () => "sess-1415-prec" } };

      const e1 = makeBeforeAgentStartEvent(cwd, "ok");
      await beforeStart.fn(e1, ctx);
      const base = e1.systemPromptOptions.sections.orchestrator_rules;
      assert.ok(base.includes("# Keep Base"));
      assert.ok(!base.includes("# Package Always"));
      assert.ok(!base.includes("# Package To Disable"));

      const tr = await onToolResult.fn(
        { type: "tool_result", toolCallId: "tc-bash", toolName: "bash", input: { command: "ls" }, content: [{ type: "text", text: "files" }] },
        ctx,
      );
      assert.ok(tr?.content[1]?.text.includes("# Project Lazy Bash Rule"));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });
});
