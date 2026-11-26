/**
 * Regression tests for:
 * - #1414: Prompt-cache-safe memory injection, one-time snapshot invalidation notices,
 *          and full-entry read guard on memory_edit / memory_remove.
 * - #1422: Pre-compaction standing memory context (fail-soft, subagent skip) and
 *          post-compaction pinned snapshot refresh.
 * - #1415: Path/tool-scoped lazy rule injection, layer precedence override,
 *          per-session deduplication, and compaction reset.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { clearRulesCache, registerRules } from "../../../extensions/orchestrator/rules.js";
import { clearSettingsCache } from "../../../extensions/orchestrator/project-settings.js";
import {
  addMemoryEntry,
  clearMemoryMutationJournal,
  editMemoryEntry,
  removeMemoryEntry,
} from "../../../extensions/orchestrator/memory-store.js";
import { buildCompactionMemoryContext } from "../../../extensions/orchestrator/situation-report.js";
import { registerMemoryTools } from "../../../extensions/orchestrator/memory-tools.js";
import { reinforce } from "../../../extensions/orchestrator/memory-scoring.js";
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

describe("#1414 prompt-cache-safe memory injection and memory_edit guard", () => {
  it("keeps sections.project_memory byte-identical across turns, query-class shifts, memory_add, and reinforce", async () => {
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

      // Turn 1: general prompt
      const e1 = makeBeforeAgentStartEvent(cwd, "Tell me about the architecture");
      await beforeStart.fn(e1, ctx);
      const pm1 = e1.systemPromptOptions.sections.project_memory;
      const rules1 = e1.systemPromptOptions.sections.orchestrator_rules;
      assert.ok(pm1?.includes("Always run npm run typecheck before opening a PR"));

      // Mid-session memory_add + reinforce
      await addMemoryEntry(cwd, {
        text: "Prefer WAL mode for concurrent SQLite readers",
        category: "pattern",
      });
      reinforce(cwd, "- [lesson] Debug failing tests with minimal repros first");

      // Turn 2: PR review queryClass shift
      const e2 = makeBeforeAgentStartEvent(cwd, "Please review PR #42 and check regressions");
      await beforeStart.fn(e2, ctx);
      assert.equal(e2.systemPromptOptions.sections.project_memory, pm1, "project_memory stays byte-identical after memory_add/reinforce and queryClass shift");
      assert.equal(e2.systemPromptOptions.sections.orchestrator_rules, rules1, "orchestrator_rules stays byte-identical");
      assert.equal(e2.systemPromptOptions.sections.contextual_memories, undefined);
      assert.equal(e2.systemPromptOptions.sections.past_sessions, undefined);
      assert.equal(e2.systemPromptOptions.sections.async_agents_status, undefined);

      // Turn 3: debug queryClass shift
      const e3 = makeBeforeAgentStartEvent(cwd, "Debug this crash stack trace in worker.ts");
      await beforeStart.fn(e3, ctx);
      assert.equal(e3.systemPromptOptions.sections.project_memory, pm1);
      assert.equal(e3.systemPromptOptions.sections.orchestrator_rules, rules1);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });

  it("delivers a one-time notice outside the system prompt prefix when a pinned snapshot memory is edited or removed", async () => {
    const cwd = makeTempDir("mem-cache-notice-");
    const pkgRulesDir = makeTempDir("mem-cache-notice-pkg-");
    try {
      fs.writeFileSync(path.join(pkgRulesDir, "10-core.md"), "# Core Rule\n");
      const origRule = "Always run unit tests via npx tsx before committing";
      const updatedRule = "Always run full tox and npm run typecheck before committing";
      await addMemoryEntry(cwd, { text: origRule, category: "preference", pinned: true });

      const { pi, handlers } = makeMockPi();
      registerRules(pi, undefined, { packageRulesDir: pkgRulesDir });
      const beforeStart = getHandler(handlers, "before_agent_start");
      const ctx = { cwd, sessionManager: { getSessionId: () => "sess-1414-notice" } };

      // Turn 1 pins snapshot
      const e1 = makeBeforeAgentStartEvent(cwd, "ok");
      await beforeStart.fn(e1, ctx);
      const pm1 = e1.systemPromptOptions.sections.project_memory;
      assert.ok(pm1?.includes(origRule));

      // Edit the pinned snapshot entry mid-session
      const editRes = await editMemoryEntry(cwd, {
        category: "preference",
        text: origRule,
        newText: updatedRule,
      });
      assert.equal(editRes.status, "updated");

      // Turn 2: prefix stays byte-identical, one-time update notice delivered via message
      const e2 = makeBeforeAgentStartEvent(cwd, "ok");
      const res2 = await beforeStart.fn(e2, ctx);
      assert.equal(e2.systemPromptOptions.sections.project_memory, pm1, "pinned prefix unchanged on mid-session edit");
      assert.equal(res2?.message?.customType, "orchestrator-turn-context");
      assert.equal(res2?.message?.display, false);
      assert.ok(res2?.message?.content.includes("# Project Memory Updates"));
      assert.ok(res2?.message?.content.includes(updatedRule));

      // Turn 3: notice is NOT repeated
      const e3 = makeBeforeAgentStartEvent(cwd, "ok");
      const res3 = await beforeStart.fn(e3, ctx);
      assert.equal(res3, undefined, "invalidation notice delivered only once");

      // Remove the updated entry -> one-time removal notice on Turn 4
      const remRes = removeMemoryEntry(cwd, "preference", updatedRule, { recordTombstone: true });
      assert.equal(remRes.status, "removed");
      const e4 = makeBeforeAgentStartEvent(cwd, "ok");
      const res4 = await beforeStart.fn(e4, ctx);
      assert.equal(e4.systemPromptOptions.sections.project_memory, pm1, "pinned prefix still unchanged on removal");
      assert.ok(res4?.message?.content.includes("[removed]"));
      assert.ok(res4?.message?.content.includes(updatedRule));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });

  it("blocks truncated-preview overwrites in memory_edit and returns full unclipped entries on clipped lookup", async () => {
    const cwd = makeTempDir("mem-edit-guard-");
    try {
      const fullText = "Always run prek run --all-files and npm run typecheck before pushing any branch";
      await addMemoryEntry(cwd, { text: fullText, category: "lesson" });

      const { pi, tools } = makeMockPi();
      registerMemoryTools(pi);

      // 1. Attempting to overwrite with a truncated preview ending in '...' is rejected
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
      assert.ok(truncRes.content[0].text.includes(fullText), "rejection includes full unclipped entry text");

      // Verify file was NOT overwritten
      const topicContent = fs.readFileSync(path.join(cwd, ".pi", "memory", "topics", "lessons.md"), "utf-8");
      assert.ok(topicContent.includes(fullText));

      // 2. Lookup with a clipped prefix returns the matching full unclipped entry text
      const clippedLookup = await tools.get("memory_edit").execute(
        "c2",
        {
          op: "update",
          category: "lesson",
          text: "Always run prek run --all-files...",
          newText: "Always run full verification gates before pushing any branch",
        },
        undefined,
        undefined,
        { cwd },
      );
      assert.match(clippedLookup.content[0].text, /Memory not found/);
      assert.ok(clippedLookup.content[0].text.includes(fullText), "not_found hint returns full unclipped text");

      // 3. memory_remove with clipped lookup also returns full unclipped text hint
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

describe("#1422 pre-compaction standing memory context and post-compaction snapshot refresh", () => {
  it("builds bounded standing memory prioritizing pinned entries and respecting memory_token_budget", async () => {
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
      assert.ok(!ctxText.includes("Transient note for this session only"), "session-scoped memories excluded");
      assert.ok(ctxText.indexOf("Never commit directly to main branch") < ctxText.indexOf("Use WAL SQLite store"));

      // Respects memory_token_budget = 0 (disabled)
      fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".pi", "pi-config-settings.json"), JSON.stringify({ memory_token_budget: 0 }));
      clearSettingsCache();
      assert.equal(buildCompactionMemoryContext(cwd, 400), "");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("injects standing memory in session_before_compact, handles split turns, stays fail-soft, and skips subagents", async () => {
    const cwd = makeTempDir("mem-compact-hook-");
    try {
      await addMemoryEntry(cwd, {
        text: "Always preserve API backwards compatibility",
        category: "decision",
        pinned: true,
      });

      const { pi, handlers } = makeMockPi();
      registerRules(pi);
      const beforeCompact = getHandler(handlers, "session_before_compact");

      // Normal compaction: prepends standing memory to messagesToSummarize
      const prep1: any = {
        firstKeptEntryId: "e5",
        messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 1000,
      };
      const r1 = await beforeCompact.fn({ type: "session_before_compact", preparation: prep1, reason: "manual" }, { cwd });
      assert.equal(r1, undefined, "does not cancel or replace default compaction");
      assert.equal(prep1.messagesToSummarize.length, 2);
      assert.equal(prep1.messagesToSummarize[0].customType, "standing-project-memory");
      assert.ok(prep1.messagesToSummarize[0].content.includes("Always preserve API backwards compatibility"));

      // Re-invoking on same preparation does not duplicate
      await beforeCompact.fn({ type: "session_before_compact", preparation: prep1, reason: "manual" }, { cwd });
      assert.equal(prep1.messagesToSummarize.length, 2);

      // Split turn with empty messagesToSummarize injects into turnPrefixMessages
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

      // Fail-soft when memory store throws (locked legacy scores file)
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
        const prepLock: any = {
          messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "x" }], timestamp: 3 }],
          turnPrefixMessages: [],
          isSplitTurn: false,
        };
        const rLock = await beforeCompact.fn({ type: "session_before_compact", preparation: prepLock, reason: "overflow" }, { cwd: lockedCwd });
        assert.equal(rLock, undefined);
      } finally {
        fs.rmSync(lockedCwd, { recursive: true, force: true });
      }

      // Subagent skips injection completely
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
      assert.equal(prepSub.messagesToSummarize.length, 1, "subagent must not inject standing memory");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refreshes the pinned startup memory snapshot and clears pending notices on session_compact", async () => {
    const cwd = makeTempDir("mem-compact-refresh-");
    const pkgRulesDir = makeTempDir("mem-compact-refresh-pkg-");
    try {
      fs.writeFileSync(path.join(pkgRulesDir, "10-core.md"), "# Core\n");
      const initialEntry = "Always stage explicit paths instead of git add dot";
      const updatedEntry = "Always stage explicit file paths and verify git diff before commit";
      const addedLater = "Never mutate cached system prompt sections mid-session";
      await addMemoryEntry(cwd, { text: initialEntry, category: "preference", pinned: true });

      const { pi, handlers } = makeMockPi();
      registerRules(pi, undefined, { packageRulesDir: pkgRulesDir });
      const beforeStart = getHandler(handlers, "before_agent_start");
      const onCompact = getHandler(handlers, "session_compact");
      const ctx = { cwd, sessionManager: { getSessionId: () => "sess-1422-refresh" } };

      // Turn 1 pins initial snapshot
      const e1 = makeBeforeAgentStartEvent(cwd, "ok");
      await beforeStart.fn(e1, ctx);
      const pm1 = e1.systemPromptOptions.sections.project_memory;
      assert.ok(pm1?.includes(initialEntry));
      assert.ok(!pm1?.includes(addedLater));

      // Mid-session edits & additions (pending notice not yet drained)
      await editMemoryEntry(cwd, { category: "preference", text: initialEntry, newText: updatedEntry });
      await addMemoryEntry(cwd, { text: addedLater, category: "lesson", pinned: true });

      // Compaction fires -> clears pinned snapshot & pending notices
      await onCompact.fn({ type: "session_compact", reason: "manual", fromExtension: false }, ctx);

      // Next turn gets freshly built snapshot containing both updated & added memories, and NO stale notice
      const e2 = makeBeforeAgentStartEvent(cwd, "ok");
      const res2 = await beforeStart.fn(e2, ctx);
      const pm2 = e2.systemPromptOptions.sections.project_memory;
      assert.ok(pm2?.includes(updatedEntry), "refreshed snapshot includes updated entry");
      assert.ok(pm2?.includes(addedLater), "refreshed snapshot includes newly added entry");
      assert.ok(!pm2?.includes(initialEntry), "refreshed snapshot no longer contains superseded entry");
      assert.equal(res2, undefined, "pending mid-session notices cleared on compaction");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });
});

describe("#1415 path/tool-scoped lazy rule injection", () => {
  it("keeps lazy rules out of base orchestrator_rules, injects once on matching tool_call/tool_result, deduplicates, and resets on session_compact", async () => {
    const cwd = makeTempDir("lazy-rules-tool-");
    const pkgRulesDir = makeTempDir("lazy-rules-pkg-");
    try {
      fs.writeFileSync(path.join(pkgRulesDir, "10-base.md"), "# Always Rule\nBase instructions.\n");
      fs.writeFileSync(
        path.join(pkgRulesDir, "20-python.md"),
        [
          "---",
          "alwaysApply: false",
          'globs: ["**/*.py"]',
          'tools: ["edit", "write"]',
          "---",
          "# Python Edit Rule",
          "Use uv run pytest after editing Python files.",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(pkgRulesDir, "30-docker.md"),
        [
          "---",
          "globs:",
          '  - "Dockerfile*"',
          "---",
          "# Docker Rule",
          "Pin base image digests in Dockerfiles.",
        ].join("\n"),
      );

      const { pi, handlers } = makeMockPi();
      registerRules(pi, undefined, { packageRulesDir: pkgRulesDir });
      const beforeStart = getHandler(handlers, "before_agent_start");
      const onToolCall = getHandler(handlers, "tool_call");
      const onToolResult = getHandler(handlers, "tool_result");
      const onCompact = getHandler(handlers, "session_compact");
      const ctx = { cwd, sessionManager: { getSessionId: () => "sess-1415-tool" } };

      // Base system prompt contains ONLY alwaysApply rules
      const e1 = makeBeforeAgentStartEvent(cwd, "Help me check the repo");
      const res1 = await beforeStart.fn(e1, ctx);
      const base1 = e1.systemPromptOptions.sections.orchestrator_rules;
      assert.ok(base1.includes("# Always Rule"));
      assert.ok(!base1.includes("# Python Edit Rule"));
      assert.ok(!base1.includes("# Docker Rule"));
      assert.equal(res1, undefined);

      // Non-matching tool call (read on .py does not satisfy tools: [edit, write])
      await onToolCall.fn({ type: "tool_call", toolCallId: "tc1", toolName: "read", input: { path: "src/app.py" } }, ctx);
      const tr1 = await onToolResult.fn(
        { type: "tool_result", toolCallId: "tc1", toolName: "read", input: { path: "src/app.py" }, content: [{ type: "text", text: "ok" }] },
        ctx,
      );
      assert.equal(tr1, undefined, "read does not trigger edit/write-scoped python rule");

      // Matching tool call: edit on src/app.py -> injects python rule on tool_result, preserving structuredContent
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
      assert.ok(tr2, "tool_result returns appended scoped rule");
      assert.equal(tr2.content.length, 2);
      assert.ok(tr2.content[1].text.includes("# Python Edit Rule"));
      assert.deepEqual(tr2.structuredContent, { ok: true }, "preserves structuredContent");

      // Second matching edit in same session -> deduplicated (no repeat)
      await onToolCall.fn({ type: "tool_call", toolCallId: "tc3", toolName: "edit", input: { path: "src/other.py" } }, ctx);
      const tr3 = await onToolResult.fn(
        { type: "tool_result", toolCallId: "tc3", toolName: "edit", input: { path: "src/other.py" }, content: [{ type: "text", text: "edited" }] },
        ctx,
      );
      assert.equal(tr3, undefined, "deduplicated within session");

      // Base system prompt prefix stays byte-identical
      const e2 = makeBeforeAgentStartEvent(cwd, "Please inspect docker/Dockerfile.prod");
      const res2 = await beforeStart.fn(e2, ctx);
      assert.equal(e2.systemPromptOptions.sections.orchestrator_rules, base1, "base orchestrator_rules untouched");
      assert.ok(res2?.message?.content.includes("# Docker Rule"), "glob-only rule injected on matching prompt path");

      // Next prompt mentioning Dockerfile again -> deduplicated
      const e3 = makeBeforeAgentStartEvent(cwd, "Check Dockerfile again");
      const res3 = await beforeStart.fn(e3, ctx);
      assert.equal(res3, undefined, "prompt-triggered lazy rule deduplicated within session");

      // After compaction, deduplication resets so lazy rules can inject again
      await onCompact.fn({ type: "session_compact", reason: "manual", fromExtension: false }, ctx);
      await onToolCall.fn({ type: "tool_call", toolCallId: "tc4", toolName: "write", input: { path: "src/new.py" } }, ctx);
      const tr4 = await onToolResult.fn(
        { type: "tool_result", toolCallId: "tc4", toolName: "write", input: { path: "src/new.py" }, content: [{ type: "text", text: "written" }] },
        ctx,
      );
      assert.ok(tr4?.content[1]?.text.includes("# Python Edit Rule"), "lazy rule re-injects after compaction reset");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pkgRulesDir, { recursive: true, force: true });
    }
  });

  it("preserves project > package override precedence for lazy scoping and enabled: false", async () => {
    const cwd = makeTempDir("lazy-rules-prec-");
    const pkgRulesDir = makeTempDir("lazy-rules-prec-pkg-");
    try {
      // Package defines two always-apply rules
      fs.writeFileSync(path.join(pkgRulesDir, "10-keep.md"), "# Keep Base\n");
      fs.writeFileSync(path.join(pkgRulesDir, "20-override.md"), "# Package Always\n");
      fs.writeFileSync(path.join(pkgRulesDir, "30-disable.md"), "# Package To Disable\n");

      // Project overrides 20-override.md as a lazy rule and disables 30-disable.md
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
      assert.ok(!base.includes("# Package Always"), "project lazy override removed rule from base prompt");
      assert.ok(!base.includes("# Package To Disable"), "project enabled:false disabled package rule");

      // Invoking bash triggers the project's lazy override
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
