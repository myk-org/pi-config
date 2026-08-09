/**
 * Tests for markdown transformer — rich TUI display formatting.
 * Run with: npx tsx --test tests/node/orchestrator/markdown-transformer.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  transformMemoryBadges,
  transformMemorySectionHeaders,
  transformComsHeaders,
  transformReviewFindings,
  transformSettingsDisplay,
  transformTaskStatus,
  transformAsyncStatus,
  transformMarkdown,
  transformOutsideCodeBlocks,
  registerMarkdownTransformer,
  MEMORY_BADGES,
  SEVERITY_BADGES,
  TASK_STATUS_BADGES,
  ASYNC_STATUS_BADGES,
} from "../../../extensions/orchestrator/markdown-transformer.ts";
import type { MarkdownTransformContext } from "@earendil-works/pi-coding-agent";

// ── Helper ──

function assistantCtx(
  overrides: Partial<MarkdownTransformContext> = {},
): MarkdownTransformContext {
  return {
    messageType: "assistant",
    isStreaming: false,
    availableWidth: 120,
    ...overrides,
  };
}

// ── transformOutsideCodeBlocks ──

describe("transformOutsideCodeBlocks", () => {
  it("transforms text outside code blocks", () => {
    const result = transformOutsideCodeBlocks("hello world", (t) =>
      t.toUpperCase(),
    );
    assert.equal(result, "HELLO WORLD");
  });

  it("preserves content inside fenced code blocks", () => {
    const md = "before\n```\nhello world\n```\nafter";
    const result = transformOutsideCodeBlocks(md, (t) => t.toUpperCase());
    assert.equal(result, "BEFORE\n```\nhello world\n```\nAFTER");
  });

  it("preserves content inside tilde code blocks", () => {
    const md = "before\n~~~\nhello world\n~~~\nafter";
    const result = transformOutsideCodeBlocks(md, (t) => t.toUpperCase());
    assert.equal(result, "BEFORE\n~~~\nhello world\n~~~\nAFTER");
  });

  it("handles multiple code blocks", () => {
    const md = "a\n```\nb\n```\nc\n```\nd\n```\ne";
    const result = transformOutsideCodeBlocks(md, (t) => t.toUpperCase());
    assert.equal(result, "A\n```\nb\n```\nC\n```\nd\n```\nE");
  });
});

// ── transformMemoryBadges ──

describe("transformMemoryBadges", () => {
  it("transforms [preference] to badge", () => {
    const result = transformMemoryBadges("- [preference] Use uv for Python");
    assert.equal(result, `- ${MEMORY_BADGES.preference} Use uv for Python`);
  });

  it("transforms [lesson] to badge", () => {
    const result = transformMemoryBadges("- [lesson] Always run tests first");
    assert.equal(result, `- ${MEMORY_BADGES.lesson} Always run tests first`);
  });

  it("transforms [mistake] to badge", () => {
    const result = transformMemoryBadges("- [mistake] Never skip pre-commit");
    assert.equal(result, `- ${MEMORY_BADGES.mistake} Never skip pre-commit`);
  });

  it("transforms [pattern] to badge", () => {
    const result = transformMemoryBadges("- [pattern] Tests in tests/node/");
    assert.equal(result, `- ${MEMORY_BADGES.pattern} Tests in tests/node/`);
  });

  it("transforms [decision] to badge", () => {
    const result = transformMemoryBadges("- [decision] Use TypeScript for extensions");
    assert.equal(result, `- ${MEMORY_BADGES.decision} Use TypeScript for extensions`);
  });

  it("transforms [done] to badge", () => {
    const result = transformMemoryBadges("- [done] Merged PR #123");
    assert.equal(result, `- ${MEMORY_BADGES.done} Merged PR #123`);
  });

  it("transforms all categories in multi-line content", () => {
    const input = [
      "- [preference] Dark theme",
      "- [lesson] Check tests",
      "- [mistake] Forgot lint",
    ].join("\n");
    const result = transformMemoryBadges(input);
    assert.ok(result.includes(MEMORY_BADGES.preference));
    assert.ok(result.includes(MEMORY_BADGES.lesson));
    assert.ok(result.includes(MEMORY_BADGES.mistake));
  });

  it("does not transform non-list-item brackets", () => {
    const input = "The [preference] tag is used for user preferences.";
    const result = transformMemoryBadges(input);
    assert.equal(result, input);
  });

  it("does not transform unknown categories", () => {
    const input = "- [unknown] Some text";
    const result = transformMemoryBadges(input);
    assert.equal(result, input);
  });

  it("preserves memory tags inside code blocks", () => {
    const input = "```\n- [preference] Use uv\n```";
    const result = transformMemoryBadges(input);
    assert.equal(result, input);
  });
});

// ── transformMemorySectionHeaders ──

describe("transformMemorySectionHeaders", () => {
  it("adds icon to Active Preferences header", () => {
    const result = transformMemorySectionHeaders("## Active Preferences");
    assert.equal(result, "## 🎯 Active Preferences");
  });

  it("adds icon to Active Lessons header", () => {
    const result = transformMemorySectionHeaders("## Active Lessons");
    assert.equal(result, "## 📝 Active Lessons");
  });

  it("adds icon to Vetoes & Mistakes header", () => {
    const result = transformMemorySectionHeaders("## Vetoes & Mistakes");
    assert.equal(result, "## ⚠️ Vetoes & Mistakes");
  });

  it("adds icon to Patterns header", () => {
    const result = transformMemorySectionHeaders("## Patterns");
    assert.equal(result, "## 🔄 Patterns");
  });

  it("adds icon to Recent Decisions header", () => {
    const result = transformMemorySectionHeaders("## Recent Decisions");
    assert.equal(result, "## 📌 Recent Decisions");
  });

  it("adds icon to Recent Completions header", () => {
    const result = transformMemorySectionHeaders("## Recent Completions");
    assert.equal(result, "## ✅ Recent Completions");
  });

  it("adds icon to Pinned header", () => {
    const result = transformMemorySectionHeaders("## Pinned");
    assert.equal(result, "## 📌 Pinned");
  });

  it("adds icon to Project Memory header with capacity", () => {
    const result = transformMemorySectionHeaders(
      "# Project Memory [42% — 714/1700 tokens]",
    );
    assert.equal(result, "# 🧠 Project Memory [42% — 714/1700 tokens]");
  });

  it("handles h3 headers", () => {
    const result = transformMemorySectionHeaders("### Active Preferences");
    assert.equal(result, "### 🎯 Active Preferences");
  });

  it("does not transform partial matches", () => {
    const input = "## Active Preferences and more text";
    const result = transformMemorySectionHeaders(input);
    assert.equal(result, input);
  });

  it("does not transform non-header text", () => {
    const input = "Active Preferences are important";
    const result = transformMemorySectionHeaders(input);
    assert.equal(result, input);
  });

  it("preserves headers inside code blocks", () => {
    const input = "```\n## Active Preferences\n```";
    const result = transformMemorySectionHeaders(input);
    assert.equal(result, input);
  });
});

// ── transformComsHeaders ──

describe("transformComsHeaders", () => {
  it("transforms coms header with peer and cwd", () => {
    const result = transformComsHeaders(
      "[from worker @ /home/user/project]",
    );
    assert.equal(result, "📨 **worker** `@ /home/user/project`");
  });

  it("transforms multiple coms headers", () => {
    const input =
      "[from agent1 @ /path/one]\nHello\n[from agent2 @ /path/two]";
    const result = transformComsHeaders(input);
    assert.ok(result.includes("📨 **agent1** `@ /path/one`"));
    assert.ok(result.includes("📨 **agent2** `@ /path/two`"));
  });

  it("preserves surrounding text", () => {
    const result = transformComsHeaders(
      "Before [from peer @ /cwd] after",
    );
    assert.equal(result, "Before 📨 **peer** `@ /cwd` after");
  });

  it("preserves coms headers inside code blocks", () => {
    const input = "```\n[from peer @ /cwd]\n```";
    const result = transformComsHeaders(input);
    assert.equal(result, input);
  });

  it("escapes markdown metacharacters in peer name", () => {
    const result = transformComsHeaders("[from peer_name @ /cwd]");
    assert.ok(result.includes("peer\\_name"));
    assert.ok(!result.includes("peer_name**"));
  });

  it("preserves backticks in cwd using longer code span delimiters", () => {
    const result = transformComsHeaders("[from peer @ /path/with`backtick]");
    // inlineCode() should use `` (double backtick) delimiter for content containing a single backtick
    assert.equal(result, "📨 **peer** ``@ /path/with`backtick``");
  });

  it("transforms arrow format with self name", () => {
    const result = transformComsHeaders("[from manager → coder-async @ /home/user/project]");
    assert.equal(result, "📨 **manager** → **coder\\-async** `@ /home/user/project`");
  });

  it("transforms arrow format without self name (legacy)", () => {
    const result = transformComsHeaders("[from manager @ /home/user/project]");
    assert.equal(result, "📨 **manager** `@ /home/user/project`");
  });

  it("escapes markdown in self name", () => {
    const result = transformComsHeaders("[from peer → self_name @ /cwd]");
    assert.ok(result.includes("self\\_name"));
  });
});

// ── transformReviewFindings ──

describe("transformReviewFindings", () => {
  it("transforms findings JSON into readable format", () => {
    const json = JSON.stringify({
      findings: [{
        severity: "CRITICAL",
        file: "src/index.ts",
        line: 42,
        description: "Missing null check",
        suggestion: "Add null guard before access",
      }],
    }, null, 2);
    const input = "```json\n" + json + "\n```";
    const result = transformReviewFindings(input);
    assert.ok(result.includes("🔴 **CRITICAL**"));
    assert.ok(result.includes("`src/index.ts:42`"));
    assert.ok(result.includes("Missing null check"));
    assert.ok(result.includes("💡 Add null guard before access"));
    assert.ok(result.includes("**1 finding:**"));
  });

  it("transforms multiple findings with plural label", () => {
    const json = JSON.stringify({
      findings: [
        { severity: "WARNING", file: "a.ts", description: "Issue 1" },
        { severity: "SUGGESTION", file: "b.ts", description: "Issue 2" },
      ],
    }, null, 2);
    const input = "```json\n" + json + "\n```";
    const result = transformReviewFindings(input);
    assert.ok(result.includes("**2 findings:**"));
    assert.ok(result.includes("🟡 **WARNING**"));
    assert.ok(result.includes("🟢 SUGGESTION"));
  });

  it("renders empty findings as passed", () => {
    const json = JSON.stringify({ findings: [] }, null, 2);
    const input = "```json\n" + json + "\n```";
    const result = transformReviewFindings(input);
    assert.ok(result.includes("✅ **No findings** — review passed"));
  });

  it("renders impact field", () => {
    const json = JSON.stringify({
      findings: [{
        severity: "CRITICAL",
        file: "x.ts",
        description: "Bug",
        impact: "Crashes in prod",
      }],
    }, null, 2);
    const input = "```json\n" + json + "\n```";
    const result = transformReviewFindings(input);
    assert.ok(result.includes("⚡ Crashes in prod"));
  });

  it("handles file without line number", () => {
    const json = JSON.stringify({
      findings: [{ severity: "INFO", file: "readme.md", description: "Typo" }],
    }, null, 2);
    const input = "```json\n" + json + "\n```";
    const result = transformReviewFindings(input);
    assert.ok(result.includes("`readme.md`"));
    assert.ok(!result.includes("undefined"));
  });

  it("preserves non-findings JSON code blocks", () => {
    const input = '```json\n{"name": "test"}\n```';
    const result = transformReviewFindings(input);
    assert.equal(result, input);
  });

  it("preserves invalid JSON code blocks", () => {
    const input = "```json\n{invalid json}\n```";
    const result = transformReviewFindings(input);
    assert.equal(result, input);
  });

  it("handles bare code fence without json label", () => {
    const json = JSON.stringify({
      findings: [{ severity: "WARNING", file: "a.ts", description: "Test" }],
    }, null, 2);
    const input = "```\n" + json + "\n```";
    const result = transformReviewFindings(input);
    assert.ok(result.includes("🟡 **WARNING**"));
  });

  it("handles case-insensitive severity", () => {
    const json = JSON.stringify({
      findings: [{ severity: "critical", file: "a.ts", description: "Test" }],
    }, null, 2);
    const input = "```json\n" + json + "\n```";
    const result = transformReviewFindings(input);
    assert.ok(result.includes("🔴 **CRITICAL**"));
  });

  it("findings content is not mutated by later transforms in dispatcher", () => {
    const json = JSON.stringify({
      findings: [{
        severity: "WARNING",
        file: "test.ts",
        line: 1,
        description: "The status: running should not become a badge",
      }],
    }, null, 2);
    const input = "```json\n" + json + "\n```";
    const result = transformMarkdown(input, assistantCtx());
    assert.ok(result.includes("The status: running should not become a badge"));
    assert.ok(!result.includes("🟡 **running**"));
  });
});

// ── transformSettingsDisplay ──

describe("transformSettingsDisplay", () => {
  it("transforms project-sourced setting", () => {
    const input = "dco = true (source: project)";
    const result = transformSettingsDisplay(input);
    assert.equal(result, "`dco` = **true** 📁 _project_");
  });

  it("transforms global-sourced setting", () => {
    const input = "dream_interval_hours = 3 (source: global)";
    const result = transformSettingsDisplay(input);
    assert.equal(result, "`dream_interval_hours` = **3** 🌐 _global_");
  });

  it("transforms env-sourced setting", () => {
    const input = "review_loop_enforcement = true (source: env)";
    const result = transformSettingsDisplay(input);
    assert.equal(result, "`review_loop_enforcement` = **true** 🔧 _env_");
  });

  it("transforms default-sourced setting", () => {
    const input = "pidash_enable = true (source: default)";
    const result = transformSettingsDisplay(input);
    assert.equal(result, "`pidash_enable` = **true** ⚙️ _default_");
  });

  it("transforms multiple settings lines", () => {
    const input = "dco = true (source: project)\nuse_worktrees = false (source: default)";
    const result = transformSettingsDisplay(input);
    assert.ok(result.includes("`dco` = **true** 📁 _project_"));
    assert.ok(result.includes("`use_worktrees` = **false** ⚙️ _default_"));
  });

  it("preserves indentation", () => {
    const input = "  pidash_port = 8080 (source: env)";
    const result = transformSettingsDisplay(input);
    assert.equal(result, "  `pidash_port` = **8080** 🔧 _env_");
  });

  it("does not transform non-settings text", () => {
    const input = "This is a regular sentence.";
    const result = transformSettingsDisplay(input);
    assert.equal(result, input);
  });

  it("preserves settings inside code blocks", () => {
    const input = "```\ndco = true (source: project)\n```";
    const result = transformSettingsDisplay(input);
    assert.equal(result, input);
  });
});

// ── transformTaskStatus ──

describe("transformTaskStatus", () => {
  it("adds badge to status: pending", () => {
    const result = transformTaskStatus("status: pending");
    assert.equal(result, "status: ⏳ pending");
  });

  it("adds badge to status: in_progress", () => {
    const result = transformTaskStatus("status: in_progress");
    assert.equal(result, "status: 🔄 in_progress");
  });

  it("adds badge to status: completed", () => {
    const result = transformTaskStatus("status: completed");
    assert.equal(result, "status: ✅ completed");
  });

  it("adds badge to [pending] marker", () => {
    const result = transformTaskStatus("Task #1 [pending] Fix bug");
    assert.equal(result, "Task #1 ⏳ pending Fix bug");
  });

  it("adds badge to [in_progress] marker", () => {
    const result = transformTaskStatus("Task #2 [in_progress] Writing code");
    assert.equal(result, "Task #2 🔄 in_progress Writing code");
  });

  it("adds badge to [completed] marker", () => {
    const result = transformTaskStatus("Task #3 [completed] Done");
    assert.equal(result, "Task #3 ✅ completed Done");
  });

  it("transforms multiple task statuses", () => {
    const input = "Task #1 [pending]\nTask #2 [in_progress]\nTask #3 [completed]";
    const result = transformTaskStatus(input);
    assert.ok(result.includes("⏳ pending"));
    assert.ok(result.includes("🔄 in_progress"));
    assert.ok(result.includes("✅ completed"));
  });

  it("does not transform unknown statuses", () => {
    const input = "status: unknown";
    const result = transformTaskStatus(input);
    assert.equal(result, input);
  });

  it("preserves task status inside code blocks", () => {
    const input = "```\nstatus: pending\n```";
    const result = transformTaskStatus(input);
    assert.equal(result, input);
  });

  it("does not corrupt markdown links", () => {
    const input = "[pending](https://example.com)";
    const result = transformTaskStatus(input);
    assert.equal(result, input);
  });
});

// ── transformAsyncStatus ──

describe("transformAsyncStatus", () => {
  it("adds badge to status: running", () => {
    const result = transformAsyncStatus("status: running");
    assert.equal(result, "status: 🟡 **running**");
  });

  it("adds badge to status: complete", () => {
    const result = transformAsyncStatus("status: complete");
    assert.equal(result, "status: 🟢 **done**");
  });

  it("adds badge to status: failed", () => {
    const result = transformAsyncStatus("status: failed");
    assert.equal(result, "status: 🔴 **failed**");
  });

  it("adds badge to status: queued", () => {
    const result = transformAsyncStatus("status: queued");
    assert.equal(result, "status: 🟡 queued");
  });

  it("adds badge to status: killed", () => {
    const result = transformAsyncStatus("status: killed");
    assert.equal(result, "status: ⚪ killed");
  });

  it("transforms [running] marker", () => {
    const result = transformAsyncStatus("code-reviewer [running] 45s");
    assert.equal(result, "code-reviewer 🟡 **running** 45s");
  });

  it("transforms [complete] marker", () => {
    const result = transformAsyncStatus("code-reviewer [complete] 12s");
    assert.equal(result, "code-reviewer 🟢 **done** 12s");
  });

  it("transforms [failed] marker", () => {
    const result = transformAsyncStatus("code-reviewer [failed]");
    assert.equal(result, "code-reviewer 🔴 **failed**");
  });

  it("transforms multiple async statuses", () => {
    const input = "reviewer [running]\nlinter [complete]\nbuilder [failed]";
    const result = transformAsyncStatus(input);
    assert.ok(result.includes("🟡 **running**"));
    assert.ok(result.includes("🟢 **done**"));
    assert.ok(result.includes("🔴 **failed**"));
  });

  it("does not transform unknown statuses", () => {
    const input = "status: paused";
    const result = transformAsyncStatus(input);
    assert.equal(result, input);
  });

  it("preserves async status inside code blocks", () => {
    const input = "```\nstatus: running\n```";
    const result = transformAsyncStatus(input);
    assert.equal(result, input);
  });

  it("does not corrupt markdown links", () => {
    const input = "[running](https://example.com)";
    const result = transformAsyncStatus(input);
    assert.equal(result, input);
  });
});

// ── transformMarkdown (main dispatcher) ──

describe("transformMarkdown", () => {
  it("transforms assistant messages", () => {
    const input = "- [preference] Dark theme\n## Active Lessons\n- [lesson] Test first";
    const result = transformMarkdown(input, assistantCtx());
    assert.ok(result.includes(MEMORY_BADGES.preference));
    assert.ok(result.includes("📝 Active Lessons"));
    assert.ok(result.includes(MEMORY_BADGES.lesson));
  });

  it("skips user messages", () => {
    const input = "- [preference] Dark theme";
    const result = transformMarkdown(
      input,
      assistantCtx({ messageType: "user" }),
    );
    assert.equal(result, input);
  });

  it("skips assistant-thinking messages", () => {
    const input = "- [preference] Dark theme";
    const result = transformMarkdown(
      input,
      assistantCtx({ messageType: "assistant-thinking" }),
    );
    assert.equal(result, input);
  });

  it("skips streaming messages", () => {
    const input = "- [preference] Dark theme";
    const result = transformMarkdown(
      input,
      assistantCtx({ isStreaming: true }),
    );
    assert.equal(result, input);
  });

  it("applies all transformers in sequence", () => {
    const findingsJson = JSON.stringify({
      findings: [{ severity: "WARNING", file: "test.ts", line: 1, description: "Issue" }],
    }, null, 2);
    const input = [
      "# Project Memory [50% — 850/1700 tokens]",
      "## Active Preferences",
      "- [preference] Use TypeScript",
      "## Vetoes & Mistakes",
      "- [mistake] Never skip tests",
      "",
      "[from manager @ /home/user/project]",
      "Hello from coms!",
      "",
      "```json",
      findingsJson,
      "```",
      "",
      "dco = true (source: project)",
      "",
      "Task #1 [pending] Fix the bug",
      "code-reviewer [running] 45s",
    ].join("\n");
    const result = transformMarkdown(input, assistantCtx());

    // Memory badges
    assert.ok(result.includes(MEMORY_BADGES.preference));
    assert.ok(result.includes(MEMORY_BADGES.mistake));

    // Section headers
    assert.ok(result.includes("🧠 Project Memory"));
    assert.ok(result.includes("🎯 Active Preferences"));
    assert.ok(result.includes("⚠️ Vetoes & Mistakes"));

    // Coms
    assert.ok(result.includes("📨 **manager**"), "coms header should have manager badge");

    // Review findings
    assert.ok(result.includes("🟡 **WARNING**"));

    // Settings
    assert.ok(result.includes("`dco` = **true** 📁 _project_"));

    // Task status
    assert.ok(result.includes("⏳ pending"));

    // Async status
    assert.ok(result.includes("🟡 **running**"));
  });

  it("preserves non-matching content unchanged", () => {
    const input = "Just a regular paragraph with no special patterns.";
    const result = transformMarkdown(input, assistantCtx());
    assert.equal(result, input);
  });
});

// ── registerMarkdownTransformer ──

describe("registerMarkdownTransformer", () => {
  it("calls pi.registerMarkdownTransformer with transformMarkdown", () => {
    let registered: unknown = null;
    const mockPi = {
      registerMarkdownTransformer: (fn: unknown) => { registered = fn; },
    };
    registerMarkdownTransformer(mockPi as any);
    assert.equal(registered, transformMarkdown);
  });

  it("skips registration when API is not available (pre-0.84.0)", () => {
    const mockPi = {};
    // Should not throw
    registerMarkdownTransformer(mockPi as any);
  });
});
