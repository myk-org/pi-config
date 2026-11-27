/**
 * Unit tests for compact 1-line TUI message rendering of `async-agent-result` (#1454).
 * Run with: npx tsx --test tests/node/orchestrator/async-agent-result-renderer.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  registerAsyncAgents,
  renderAsyncAgentResultMessage,
  type AsyncAgentResultDetails,
} from "../../../extensions/orchestrator/async-agents.js";
import {
  extractSummaryLine,
  type CompactCustomMessage,
  type CompactMessageRenderOptions,
} from "../../../extensions/shared/compact-message-renderer.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";

function createFakeTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  } as unknown as Theme;
}

function makeOptions(overrides: Partial<CompactMessageRenderOptions> = {}): CompactMessageRenderOptions {
  return {
    expanded: false,
    outputPad: 1,
    keyText: () => "ctrl+o",
    keyHint: (_action: any, desc: string) => `ctrl+o ${desc}`,
    ...overrides,
  };
}

function makeMessage(
  content: string,
  details?: AsyncAgentResultDetails,
): CompactCustomMessage<AsyncAgentResultDetails> {
  return {
    role: "custom",
    customType: "async-agent-result",
    content,
    display: true,
    details,
    timestamp: Date.now(),
  };
}

describe("extractSummaryLine (#1454)", () => {
  it("skips blank lines, code fences, horizontal rules, heading prefixes", () => {
    const input = "\n\n---\n```\n##   open=1 approved=1 ready=1\nsecond line";
    assert.equal(extractSummaryLine(input), "open=1 approved=1 ready=1");
  });

  it("strips ANSI escape sequences plus control characters from summary text", () => {
    const input = "\x1b[31m\x1b]0;title\x07Error:\x1b[0m build\x07 failed";
    assert.equal(extractSummaryLine(input), "Error: build failed");
  });

  it("caps long summaries with an ellipsis", () => {
    const line = "a".repeat(200);
    const summary = extractSummaryLine(line, 40);
    assert.equal(summary.length, 40);
    assert.equal(summary.endsWith("…"), true);
  });
});

describe("renderAsyncAgentResultMessage (#1454)", () => {
  const theme = createFakeTheme();

  it("renders a completed result as one compact line when collapsed", () => {
    const fullContent = [
      "## Async Agent Result: Cron: Refresh statuspage digest ✅ completed",
      "",
      "Task: refresh digest",
      "Duration: 37s",
      "",
      "open=1 approved=1 ready=1",
      "Line 2 detail",
      "Line 3 detail",
    ].join("\n");
    const msg = makeMessage(fullContent, {
      displayName: "Cron: Refresh statuspage digest",
      agent: "worker",
      status: "complete",
      durationMs: 37_000,
      summaryLine: "open=1 approved=1 ready=1",
    });

    const lines = renderAsyncAgentResultMessage(msg, makeOptions({ expanded: false }), theme).render(120);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /✓ Cron: Refresh statuspage digest \(37\.0s\) — open=1 approved=1 ready=1/);
    assert.match(lines[0], /\(ctrl\+o to expand\)/);
  });

  it("renders a failed result with a failure glyph when collapsed", () => {
    const msg = makeMessage("## Async Agent Result: security-auditor ❌ failed\n\nTask: audit\nDuration: 12s\n\nError: permission denied", {
      displayName: "security-auditor",
      agent: "security-auditor",
      status: "failed",
      durationMs: 12_000,
      summaryLine: "Error: permission denied",
      killOrigin: "user",
    });

    const lines = renderAsyncAgentResultMessage(msg, makeOptions({ expanded: false }), theme).render(120);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /✗ security-auditor \(12\.0s\) — Error: permission denied/);
  });

  it("keeps collapsed output to a single line at narrow terminal widths", () => {
    const msg = makeMessage("long body", {
      displayName: "Cron: Refresh statuspage digest",
      agent: "worker",
      status: "complete",
      durationMs: 37_000,
      summaryLine: "very long summary output line that definitely exceeds an eighty column terminal width by plenty of characters",
    });

    const lines = renderAsyncAgentResultMessage(msg, makeOptions({ expanded: false }), theme).render(80);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0]) <= 80);
    assert.match(lines[0], /\(ctrl\+o to expand\)/);
  });

  it("renders the full output body when expanded", () => {
    const fullContent = [
      "## Async Agent Result: worker ✅ completed",
      "",
      "Task: inspect repo",
      "Duration: 5s",
      "",
      "First finding line",
      "Second finding line",
      "Third finding line",
    ].join("\n");
    const msg = makeMessage(fullContent, {
      displayName: "worker",
      agent: "worker",
      status: "complete",
      durationMs: 5_000,
      summaryLine: "First finding line",
    });

    const rendered = renderAsyncAgentResultMessage(msg, makeOptions({ expanded: true }), theme).render(100).join("\n");
    assert.match(rendered, /\[async-agent-result\]/);
    assert.match(rendered, /First finding line/);
    assert.match(rendered, /Second finding line/);
    assert.match(rendered, /Third finding line/);
  });

  it("leaves message content completely unchanged for LLM context", () => {
    const fullContent = "## Async Agent Result: worker ✅ completed\n\nTask: check\nDuration: 3s\n\nDetailed output line 1\nDetailed output line 2";
    const msg = makeMessage(fullContent, {
      displayName: "worker",
      agent: "worker",
      status: "complete",
      durationMs: 3_000,
      summaryLine: "Detailed output line 1",
    });

    renderAsyncAgentResultMessage(msg, makeOptions({ expanded: false }), theme).render(80);
    renderAsyncAgentResultMessage(msg, makeOptions({ expanded: true }), theme).render(80);
    assert.equal(msg.content, fullContent);
  });

  it("falls back cleanly for legacy persisted messages without details", () => {
    const legacyContent = "## Async Agent Result: legacy-worker ❌ failed\n\nTask: check\nDuration: 9s\n\nCrash stack line 1\nCrash stack line 2";
    const msg = makeMessage(legacyContent, undefined);

    const lines = renderAsyncAgentResultMessage(msg, makeOptions({ expanded: false }), theme).render(120);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /✗ legacy-worker \(9s\) — Crash stack line 1/);
  });

  it("uses custom keyHint formatting when supplied by Pi", () => {
    const msg = makeMessage("output", {
      displayName: "worker",
      agent: "worker",
      status: "complete",
      durationMs: 1_000,
      summaryLine: "ok",
    });

    const lines = renderAsyncAgentResultMessage(
      msg,
      makeOptions({ keyHint: (_a: any, desc: string) => `alt+e ${desc}` }),
      theme,
    ).render(120);
    assert.match(lines[0], /\(alt\+e to expand\)/);
  });
});

describe("registerAsyncAgents message renderer registration (#1454)", () => {
  it("registers the async-agent-result message renderer during setup", () => {
    const registered = new Map<string, unknown>();
    const fakePi = {
      on: () => {},
      registerCommand: () => {},
      registerTool: () => {},
      registerMessageRenderer: (customType: string, renderer: unknown) => {
        registered.set(customType, renderer);
      },
      sendMessage: () => {},
      events: { on: () => () => {}, emit: () => {} },
    };

    withSubagentChildEnv(undefined, () => {
      registerAsyncAgents(fakePi as any, () => {});
    });

    assert.equal(registered.get("async-agent-result"), renderAsyncAgentResultMessage);
  });
});
