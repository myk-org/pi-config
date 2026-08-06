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
  transformMarkdown,
  transformOutsideCodeBlocks,
  MEMORY_BADGES,
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
    assert.equal(result, "📨 **worker** _@ /home/user/project_");
  });

  it("transforms multiple coms headers", () => {
    const input =
      "[from agent1 @ /path/one]\nHello\n[from agent2 @ /path/two]";
    const result = transformComsHeaders(input);
    assert.ok(result.includes("📨 **agent1** _@ /path/one_"));
    assert.ok(result.includes("📨 **agent2** _@ /path/two_"));
  });

  it("preserves surrounding text", () => {
    const result = transformComsHeaders(
      "Before [from peer @ /cwd] after",
    );
    assert.equal(result, "Before 📨 **peer** _@ /cwd_ after");
  });

  it("preserves coms headers inside code blocks", () => {
    const input = "```\n[from peer @ /cwd]\n```";
    const result = transformComsHeaders(input);
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
    const input = [
      "# Project Memory [50% — 850/1700 tokens]",
      "## Active Preferences",
      "- [preference] Use TypeScript",
      "## Vetoes & Mistakes",
      "- [mistake] Never skip tests",
      "",
      "[from manager @ /home/user/project]",
      "Hello from coms!",
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
    assert.ok(result.includes("📨 **manager**"));
  });

  it("preserves non-matching content unchanged", () => {
    const input = "Just a regular paragraph with no special patterns.";
    const result = transformMarkdown(input, assistantCtx());
    assert.equal(result, input);
  });
});
