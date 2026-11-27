/**
 * Unit and real pi-tui / SessionManager end-to-end integration tests for /qa
 * human Q&A reader overlay, 1-key section quoting, configurable shortcut
 * (qa_overlay_shortcut), and buried-answer widget (#1453).
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  stripTerminalSequences,
  type Terminal,
} from "@earendil-works/pi-tui";
import {
  clearSettingsCache,
  getSetting,
  setGlobalSettingsPath,
  SETTINGS_KEYS,
} from "../../../extensions/orchestrator/project-settings.js";
import {
  CRON_USER_MESSAGE_ENTRY_TYPE,
  QA_HINT_WIDGET_KEY,
  QaListOverlay,
  buildQaDetailLines,
  createDetailBodyLinesGetter,
  extractAnswerSections,
  extractAnswerTitle,
  extractQaHistory,
  filterQaPairs,
  formatBuriedAnswerHint,
  formatQaPlainText,
  formatQuotePrefix,
  formatShortcutLabel,
  isAutomatedUserMessage,
  openQaOverlay,
  registerQaOverlay,
  resolveConfiguredQaShortcut,
  type QaListResult,
} from "../../../extensions/orchestrator/qa-overlay.js";
import { fakeKeybindings, fakeTheme, fakeTui } from "../helpers/fake-tui.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

function userEntry(id: string, content: unknown, timestamp = "2026-11-27T10:00:00.000Z") {
  return {
    type: "message",
    id,
    timestamp,
    message: { role: "user", content },
  };
}

function assistantEntry(id: string, content: unknown, timestamp = "2026-11-27T10:00:05.000Z") {
  return {
    type: "message",
    id,
    timestamp,
    message: { role: "assistant", content },
  };
}

function customEntry(
  id: string,
  customType: string,
  content: string,
  display = true,
  timestamp = "2026-11-27T10:01:00.000Z",
  details?: Record<string, unknown>,
) {
  return {
    type: "custom_message",
    id,
    timestamp,
    customType,
    content,
    display,
    ...(details ? { details } : {}),
  };
}

function createFakePi() {
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const eventListeners = new Map<string, Array<(data: unknown) => void>>();
  const sentMessages: any[] = [];
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];

  const pi = {
    on(event: string, fn: (...args: any[]) => any) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    events: {
      on(event: string, fn: (data: unknown) => void) {
        const list = eventListeners.get(event) ?? [];
        list.push(fn);
        eventListeners.set(event, list);
      },
      emit(event: string, data: unknown) {
        for (const fn of eventListeners.get(event) ?? []) {
          fn(data);
        }
      },
    },
    appendEntry(customType: string, data?: unknown) {
      appendedEntries.push({ customType, data });
    },
    registerCommand(name: string, opts: any) {
      commands.set(name, opts);
    },
    registerShortcut(key: string, opts: any) {
      shortcuts.set(key, opts);
    },
    sendMessage(msg: any, opts?: any) {
      sentMessages.push({ msg, opts });
    },
  } as unknown as ExtensionAPI;

  async function emit(event: string, payload: any, ctx: any): Promise<void> {
    for (const fn of handlers.get(event) ?? []) {
      await fn(payload, ctx);
    }
  }

  return { pi, commands, shortcuts, handlers, sentMessages, appendedEntries, emit };
}

function createMockCtx(options: {
  cwd: string;
  branch: unknown[];
  hasUI?: boolean;
  sessionId?: string;
  customInputs?: string[][];
  keybindings?: ReturnType<typeof fakeKeybindings>;
}) {
  const notifications: Array<{ msg: string; level?: string }> = [];
  const pasted: string[] = [];
  const widgets = new Map<string, { content: any; options: any }>();
  let customCalls = 0;

  const ctx = {
    cwd: options.cwd,
    hasUI: options.hasUI ?? true,
    sessionManager: {
      getSessionId: () => options.sessionId ?? "sess-qa-test",
      getBranch: () => options.branch,
    },
    ui: {
      notify(msg: string, level?: string) {
        notifications.push({ msg, level });
      },
      pasteToEditor(text: string) {
        pasted.push(text);
      },
      setWidget(key: string, content: any, opts?: any) {
        if (content === undefined) widgets.delete(key);
        else widgets.set(key, { content, options: opts });
      },
      async custom<T>(factory: any): Promise<T> {
        const inputs = options.customInputs?.[customCalls] ?? ["\x1b"];
        customCalls += 1;
        let resolved: T | undefined;
        let isDone = false;
        const done = (val: T) => {
          resolved = val;
          isDone = true;
        };
        const comp = await factory(
          fakeTui({ rows: 24 }),
          fakeTheme(),
          options.keybindings ?? fakeKeybindings(),
          done,
        );
        comp.render(100);
        for (const seq of inputs) {
          if (isDone) break;
          comp.handleInput?.(seq);
          if (!isDone) comp.render(100);
        }
        comp.dispose?.();
        return resolved as T;
      },
    },
  } as unknown as ExtensionCommandContext;

  return { ctx, notifications, pasted, widgets, getCustomCalls: () => customCalls };
}

describe("extractQaHistory", () => {
  it("extracts human Q&A pairs newest-first", () => {
    const branch = [
      userEntry("u1", "First question"),
      assistantEntry("a1", [{ type: "text", text: "First answer" }]),
      userEntry("u2", "Second question"),
      assistantEntry("a2", [{ type: "text", text: "Second answer" }]),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.pairs.length, 2);
    assert.equal(history.pairs[0].question, "Second question");
    assert.equal(history.pairs[0].answer, "Second answer");
    assert.equal(history.pairs[1].question, "First question");
    assert.equal(history.buriedLatest, null);
    assert.equal(history.backgroundTurnsAfterLatest, 0);
  });

  it("skips unanswered human prompts", () => {
    const branch = [
      userEntry("u1", "Answered question"),
      assistantEntry("a1", [{ type: "text", text: "Helpful answer" }]),
      userEntry("u2", "Still waiting"),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.pairs.length, 1);
    assert.equal(history.pairs[0].question, "Answered question");
  });

  it("keeps final assistant text across multi-tool human turns", () => {
    const branch = [
      userEntry("u1", "Fix parser"),
      assistantEntry("a1", [
        { type: "text", text: "Let me inspect parser.ts." },
        { type: "toolCall", id: "tc1", name: "read", arguments: {} },
      ]),
      { type: "message", id: "tr1", message: { role: "toolResult", content: [{ type: "text", text: "file" }] } },
      assistantEntry("a2", [
        { type: "text", text: "### Summary\n1. Fixed null handling" },
      ]),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.pairs.length, 1);
    assert.equal(history.pairs[0].answerEntryId, "a2");
    assert.equal(history.pairs[0].answer, "### Summary\n1. Fixed null handling");
  });

  it("excludes async-agent-result background replies from human pairs", () => {
    const branch = [
      userEntry("u1", "What is the merge order?"),
      assistantEntry("a1", [{ type: "text", text: "Merge PR #1 first." }]),
      customEntry("c1", "async-agent-result", "## Async Agent Result: tests ✅"),
      assistantEntry("a2", [{ type: "text", text: "Async test run passed." }]),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.pairs.length, 1);
    assert.equal(history.pairs[0].answer, "Merge PR #1 first.");
    assert.equal(history.buriedLatest?.answerEntryId, "a1");
    assert.equal(history.backgroundTurnsAfterLatest, 1);
  });

  it("excludes COMS inbound turns from human pairs", () => {
    const branch = [
      userEntry("u1", "Explain caching"),
      assistantEntry("a1", [{ type: "text", text: "Caching uses an LRU map." }]),
      customEntry("c1", "from peer-1 @ /repo", "[from peer-1 @ /repo] Done!"),
      assistantEntry("a2", [{ type: "text", text: "Thanks peer-1." }]),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.pairs.length, 1);
    assert.equal(history.pairs[0].answer, "Caching uses an LRU map.");
    assert.equal(history.buriedLatest?.answerEntryId, "a1");
  });

  it("excludes task-focus-reminder background turns from human pairs", () => {
    const branch = [
      userEntry("u1", "Status?"),
      assistantEntry("a1", [{ type: "text", text: "All green." }]),
      customEntry("c1", "task-focus-reminder", "[Task Focus Reminder] Resume #2"),
      assistantEntry("a2", [{ type: "text", text: "Resuming task #2." }]),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.pairs.length, 1);
    assert.equal(history.buriedLatest?.answerEntryId, "a1");
  });

  it("excludes reload-flag-done background turns from human pairs", () => {
    const branch = [
      userEntry("u1", "Ready?"),
      assistantEntry("a1", [{ type: "text", text: "Ready." }]),
      customEntry("c1", "reload-flag-done", "Reload finished"),
      assistantEntry("a2", [{ type: "text", text: "Reloaded." }]),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.pairs.length, 1);
    assert.equal(history.buriedLatest?.answerEntryId, "a1");
  });

  it("excludes automated user-role prompts from human pairs", () => {
    assert.equal(isAutomatedUserMessage("[system message — not written by the user]\nBlocked"), true);
    assert.equal(isAutomatedUserMessage("/reload-flag"), true);
    assert.equal(isAutomatedUserMessage("[from peer-2 @ /tmp] ping"), true);
    assert.equal(isAutomatedUserMessage("## Async Agent Result: build"), true);
    assert.equal(isAutomatedUserMessage("[Task Focus Reminder] continue"), true);
    assert.equal(isAutomatedUserMessage("How do I run tests?"), false);

    const branch = [
      userEntry("u0", "/reload-flag"),
      assistantEntry("a0", [{ type: "text", text: "Reloading..." }]),
      userEntry("u1", "How do I run tests?"),
      assistantEntry("a1", [{ type: "text", text: "Run tox." }]),
      userEntry("u2", "[Cron: monitor] check CI"),
      assistantEntry("a2", [{ type: "text", text: "CI green." }]),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.pairs.length, 1);
    assert.equal(history.pairs[0].question, "How do I run tests?");
    assert.equal(history.buriedLatest?.answerEntryId, "a1");
  });

  it("preserves human pairing across passive coms-peer-joined notices", () => {
    const branch = [
      userEntry("u1", "Explain widgets"),
      customEntry("c1", "coms-peer-joined", "📡 Peer joined: worker-1", true),
      assistantEntry("a1", [{ type: "text", text: "Widgets render above or below the editor." }]),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.pairs.length, 1);
    assert.equal(history.pairs[0].answer, "Widgets render above or below the editor.");
    assert.equal(history.buriedLatest, null);
  });

  it("preserves human pairing across hidden mid-turn context injections", () => {
    const branch = [
      userEntry("u1", "Check settings"),
      customEntry("c1", "orchestrator-turn-context", "Rules...", false),
      customEntry("c2", "tool-arg-rejected", "[system message — not written by the user]\nRetry", true),
      assistantEntry("a1", [{ type: "text", text: "Settings look valid." }]),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.pairs.length, 1);
    assert.equal(history.pairs[0].answer, "Settings look valid.");
  });

  it("ignores thinking blocks in assistant messages", () => {
    const branch = [
      userEntry("u1", "Why?"),
      assistantEntry("a1", [
        { type: "thinking", thinking: "Internal scratchpad" },
        { type: "text", text: "Because of caching." },
      ]),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.pairs[0].answer, "Because of caching.");
  });

  it("uses [Image] placeholder for image-only human prompts", () => {
    const branch = [
      userEntry("u1", [{ type: "image", data: "abc", mimeType: "image/png" }]),
      assistantEntry("a1", [{ type: "text", text: "That screenshot shows a CSS flex wrap issue." }]),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.pairs.length, 1);
    assert.equal(history.pairs[0].question, "[Image]");
  });

  it("does not mark latest answer buried after passive memory-reminder", () => {
    const branch = [
      userEntry("u1", "Update docs"),
      assistantEntry("a1", [{ type: "text", text: "Updated README.md." }]),
      customEntry("c1", "memory-reminder", "📝 Memory reminder", true),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.buriedLatest, null);
    assert.equal(history.backgroundTurnsAfterLatest, 0);
  });

  it("clears buried state when a newer human prompt follows background traffic", () => {
    const branch = [
      userEntry("u1", "Old question"),
      assistantEntry("a1", [{ type: "text", text: "Old answer" }]),
      customEntry("c1", "async-agent-result", "## Async Agent Result: job"),
      assistantEntry("a2", [{ type: "text", text: "Job finished" }]),
      userEntry("u2", "New question"),
      assistantEntry("a3", [{ type: "text", text: "New answer" }]),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.pairs.length, 2);
    assert.equal(history.buriedLatest, null);
    assert.equal(history.backgroundTurnsAfterLatest, 0);
  });

  it("excludes cron-dispatched slash commands recorded via cron-user-message", () => {
    const branch = [
      userEntry("u1", "What should I deploy?"),
      assistantEntry("a1", [{ type: "text", text: "Deploy PR #1475." }]),
      { type: "custom", id: "cm1", customType: CRON_USER_MESSAGE_ENTRY_TYPE, data: { command: "/review-local" } },
      userEntry("u2", "/review-local"),
      assistantEntry("a2", [{ type: "text", text: "Local review clean." }]),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.pairs.length, 1);
    assert.equal(history.pairs[0].question, "What should I deploy?");
    assert.equal(history.pairs[0].answer, "Deploy PR #1475.");
    assert.equal(history.buriedLatest?.answerEntryId, "a1");
    assert.equal(history.backgroundTurnsAfterLatest, 1);
  });

  it("treats idle subagent-chain-error recovery with separateTurn detail as background", () => {
    const branch = [
      userEntry("u1", "Run the migration"),
      assistantEntry("a1", [{ type: "text", text: "Started async chain." }]),
      customEntry(
        "c1",
        "subagent-chain-error",
        "[system message — not written by the user]\nChain stopped",
        true,
        "2026-11-27T10:02:00.000Z",
        { separateTurn: true },
      ),
      assistantEntry("a2", [{ type: "text", text: "Chain recovery acknowledged." }]),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.pairs.length, 1);
    assert.equal(history.pairs[0].answer, "Started async chain.");
    assert.equal(history.buriedLatest?.answerEntryId, "a1");
  });

  it("treats post-answer subagent-chain-error without details as background", () => {
    const branch = [
      userEntry("u1", "Run checks"),
      assistantEntry("a1", [{ type: "text", text: "Checks kicked off." }]),
      customEntry("c1", "subagent-chain-error", "[system message — not written by the user]\nChain stalled"),
      assistantEntry("a2", [{ type: "text", text: "Recovered stalled chain." }]),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.pairs.length, 1);
    assert.equal(history.pairs[0].answer, "Checks kicked off.");
    assert.equal(history.buriedLatest?.answerEntryId, "a1");
  });

  it("preserves human pairing across genuinely mid-turn subagent-chain-error retry", () => {
    const branch = [
      userEntry("u1", "Run build chain"),
      assistantEntry("a1", [
        { type: "text", text: "Spawning chain." },
        { type: "toolCall", id: "tc1", name: "subagent", arguments: {} },
      ]),
      customEntry("c1", "subagent-chain-error", "[system message — not written by the user]\nMissing taskId"),
      assistantEntry("a2", [{ type: "text", text: "Chain spawned after retry." }]),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.pairs.length, 1);
    assert.equal(history.pairs[0].answer, "Chain spawned after retry.");
    assert.equal(history.buriedLatest, null);
  });

  it("preserves human pairing across mid-turn skill-maintenance-nudge steer", () => {
    const branch = [
      userEntry("u1", "Check PR review status"),
      assistantEntry("a1", [
        { type: "toolCall", id: "tc1", name: "bash", arguments: {} },
      ]),
      {
        type: "message",
        id: "tr1",
        message: { role: "toolResult", isError: true, content: [{ type: "text", text: "failed" }] },
      },
      customEntry(
        "c1",
        "skill-maintenance-nudge",
        "The guidance from skill `qodo-review` just failed. Fix the skill now.",
        true,
      ),
      assistantEntry("a2", [{ type: "text", text: "Fixed the command; PR #1475 is clean." }]),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.pairs.length, 1);
    assert.equal(history.pairs[0].answer, "Fixed the command; PR #1475 is clean.");
    assert.equal(history.buriedLatest, null);
  });

  it("does not restore buried hint for an older pair after a newer unanswered prompt", () => {
    const branch = [
      userEntry("u1", "Old question"),
      assistantEntry("a1", [{ type: "text", text: "Old answer" }]),
      userEntry("u2", "Newer unanswered question"),
      customEntry("c1", "async-agent-result", "## Async Agent Result: job"),
      assistantEntry("a2", [{ type: "text", text: "Async job completed." }]),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.pairs.length, 1);
    assert.equal(history.pairs[0].answerEntryId, "a1");
    assert.equal(history.buriedLatest, null);
    assert.equal(history.backgroundTurnsAfterLatest, 0);
  });

  it("treats headless qa-overlay output as passive without burying latest answer", () => {
    const branch = [
      userEntry("u1", "Summarize changes"),
      assistantEntry("a1", [{ type: "text", text: "Added /qa overlay." }]),
      customEntry("c1", "qa-overlay", "Human Q&A (1):\n1. Q: Summarize changes", true),
    ];

    const history = extractQaHistory(branch);
    assert.equal(history.pairs.length, 1);
    assert.equal(history.buriedLatest, null);
    assert.equal(history.backgroundTurnsAfterLatest, 0);
  });
});

describe("extractAnswerSections", () => {
  it("extracts Markdown headings as numbered sections", () => {
    const md = "## Overview\nSome prose\n### Recommendation for Issue #2\nDetails";
    const sections = extractAnswerSections(md);
    assert.equal(sections.length, 2);
    assert.deepEqual(sections[0], { index: 1, kind: "heading", label: "Overview", lineIndex: 0 });
    assert.deepEqual(sections[1], {
      index: 2,
      kind: "heading",
      label: "Recommendation for Issue #2",
      lineIndex: 2,
    });
  });

  it("extracts numbered list items with dots or parentheses", () => {
    const md = "Options:\n1. **Use SQLite** — fast\n2) Keep `qa_overlay_shortcut` configurable";
    const sections = extractAnswerSections(md);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].label, "Use SQLite — fast");
    assert.equal(sections[1].label, "Keep qa_overlay_shortcut configurable");
  });

  it("preserves document order for mixed headings with numbered items", () => {
    const md = "### Plan\n1. Add setting\n2. Add overlay\n### Risks\nNone";
    const sections = extractAnswerSections(md);
    assert.deepEqual(
      sections.map((s) => `${s.index}:${s.kind}:${s.label}`),
      [
        "1:heading:Plan",
        "2:item:Add setting",
        "3:item:Add overlay",
        "4:heading:Risks",
      ],
    );
  });

  it("caps extracted sections at nine slots", () => {
    const md = Array.from({ length: 12 }, (_, i) => `${i + 1}. Item ${i + 1}`).join("\n");
    const sections = extractAnswerSections(md);
    assert.equal(sections.length, 9);
    assert.equal(sections[8].index, 9);
    assert.equal(sections[8].label, "Item 9");
  });

  it("ignores headings inside fenced code blocks", () => {
    const md = [
      "### Real Heading",
      "```bash",
      "# Shell comment inside fence",
      "1. Not a list item",
      "```",
      "1. Real item",
    ].join("\n");
    const sections = extractAnswerSections(md);
    assert.deepEqual(
      sections.map((s) => s.label),
      ["Real Heading", "Real item"],
    );
  });

  it("selects first meaningful prose line as answer title when skipping code fences", () => {
    const md = "```ts\nconst x = 1;\n```\n\n---\n### Actual Title\nBody";
    assert.equal(extractAnswerTitle(md), "Actual Title");
  });
});

describe("formatting & filtering helpers", () => {
  it("formats quote prefix for editor paste", () => {
    assert.equal(
      formatQuotePrefix("### Recommendation for Issue #2:"),
      'Re: "### Recommendation for Issue #2" — ',
    );
    assert.equal(
      formatQuotePrefix("Recommendation for Issue #2"),
      'Re: "Recommendation for Issue #2" — ',
    );
  });

  it("sanitizes inner double quotes in quote prefixes", () => {
    assert.equal(
      formatQuotePrefix('Use "alt+q" shortcut'),
      "Re: \"Use 'alt+q' shortcut\" — ",
    );
  });

  it("formats shortcut key labels in title case", () => {
    assert.equal(formatShortcutLabel("alt+q"), "Alt+Q");
    assert.equal(formatShortcutLabel("ctrl+shift+q"), "Ctrl+Shift+Q");
  });

  it("falls back to /qa label when shortcut is disabled", () => {
    assert.equal(formatShortcutLabel(null), "/qa");
  });

  it("formats buried-answer hint line with configured shortcut", () => {
    const pair = extractQaHistory([
      userEntry("u1", "How should we structure auth?"),
      assistantEntry("a1", [{ type: "text", text: "Use JWT." }]),
    ]).pairs[0];
    assert.equal(
      formatBuriedAnswerHint(pair, "alt+q"),
      '💬 Answer ready for "How should we structure auth?" — Alt+Q to read',
    );
  });

  it("filters Q&A pairs across multiple case-insensitive tokens", () => {
    const pairs = extractQaHistory([
      userEntry("u1", "How does auth work?"),
      assistantEntry("a1", [{ type: "text", text: "JWT tokens with refresh." }]),
      userEntry("u2", "How does SQLite lock?"),
      assistantEntry("a2", [{ type: "text", text: "WAL mode with busy timeout." }]),
    ]).pairs;

    const matched = filterQaPairs(pairs, "sqlite wal");
    assert.equal(matched.length, 1);
    assert.equal(matched[0].question, "How does SQLite lock?");
  });

  it("renders inline section badges in detail lines", () => {
    const pair = extractQaHistory([
      userEntry("u1", "Steps?"),
      assistantEntry("a1", [{ type: "text", text: "### Steps\n1. First step" }]),
    ]).pairs[0];
    const lines = buildQaDetailLines(pair, fakeTheme());
    assert.ok(lines.some((line) => line.includes("[1] ### Steps")));
    assert.ok(lines.some((line) => line.includes("[2] 1. First step")));
  });
});

describe("QaListOverlay & openQaOverlay", () => {
  const sampleBranch = [
    userEntry("u1", "Explain caching"),
    assistantEntry("a1", [{ type: "text", text: "### Cache Design\n1. Use LRU\n2. Cap entries" }]),
    userEntry("u2", "Recommendation for Issue #2"),
    assistantEntry("a2", [{ type: "text", text: "### Recommendation for Issue #2\n1. Add shortcut\n2. Add hint" }]),
  ];

  it("navigates list rows with down arrow", () => {
    const pairs = extractQaHistory(sampleBranch).pairs;
    const results: QaListResult[] = [];
    const selection = { index: 0, id: pairs[0].id };
    const overlay = new QaListOverlay(fakeTui(), fakeTheme(), pairs, selection, (r) => {
      results.push(r);
    });

    overlay.handleInput("\x1b[B"); // Down arrow -> second row (u1)
    overlay.handleInput("\r"); // Enter
    const result = results[0];
    assert.equal(result?.action, "open");
    if (result?.action === "open") {
      assert.equal(result.pair.question, "Explain caching");
    }
  });

  it("filters list rows live after pressing slash", () => {
    const pairs = extractQaHistory(sampleBranch).pairs;
    const results: QaListResult[] = [];
    const selection = { index: 0, id: pairs[0].id };
    const overlay = new QaListOverlay(fakeTui(), fakeTheme(), pairs, selection, (r) => {
      results.push(r);
    });

    overlay.handleInput("/");
    for (const ch of "lru") overlay.handleInput(ch);
    const frame = overlay.render(100).join("\n");
    assert.match(frame, /Filter: \/lru/);
    assert.match(frame, /1\/2 matching/);

    overlay.handleInput("\r");
    const result = results[0];
    assert.equal(result?.action, "open");
    if (result?.action === "open") {
      assert.equal(result.pair.question, "Explain caching");
    }
  });

  it("clears active filter on Escape before closing overlay", () => {
    const pairs = extractQaHistory(sampleBranch).pairs;
    const results: QaListResult[] = [];
    const selection = { index: 0, id: pairs[0].id };
    const overlay = new QaListOverlay(fakeTui(), fakeTheme(), pairs, selection, (r) => {
      results.push(r);
    });

    overlay.handleInput("/");
    overlay.handleInput("z");
    overlay.handleInput("\x1b"); // exits & clears filter
    assert.equal(results.length, 0);
    assert.match(overlay.render(100).join("\n"), /2 answers/);

    overlay.handleInput("\x1b"); // now closes overlay
    assert.deepEqual(results[0], { action: "close" });
  });

  it("pastes whole-answer quote prefix when pressing r in list view", async () => {
    const mock = createMockCtx({
      cwd: process.cwd(),
      branch: sampleBranch,
      customInputs: [["r"]],
    });

    const pasted = await openQaOverlay(mock.ctx);
    assert.equal(pasted, 'Re: "Recommendation for Issue #2" — ');
    assert.deepEqual(mock.pasted, ['Re: "Recommendation for Issue #2" — ']);
  });

  it("pastes whole-answer quote prefix when pressing r in detail reader", async () => {
    const mock = createMockCtx({
      cwd: process.cwd(),
      branch: sampleBranch,
      customInputs: [["\r"], ["r"]],
    });

    const pasted = await openQaOverlay(mock.ctx);
    assert.equal(pasted, 'Re: "Recommendation for Issue #2" — ');
    assert.deepEqual(mock.pasted, ['Re: "Recommendation for Issue #2" — ']);
  });

  it("pastes specific section quote prefix when pressing digit 2 in detail reader", async () => {
    const mock = createMockCtx({
      cwd: process.cwd(),
      branch: sampleBranch,
      customInputs: [["\r"], ["2"]],
    });

    const pasted = await openQaOverlay(mock.ctx);
    assert.equal(pasted, 'Re: "Add shortcut" — ');
    assert.deepEqual(mock.pasted, ['Re: "Add shortcut" — ']);
  });

  it("ignores out-of-range digit presses in detail reader", async () => {
    const mock = createMockCtx({
      cwd: process.cwd(),
      branch: sampleBranch,
      customInputs: [["\r"], ["9", "\x1b"], ["\x1b"]],
    });

    const pasted = await openQaOverlay(mock.ctx);
    assert.equal(pasted, null);
    assert.deepEqual(mock.pasted, []);
  });

  it("returns from detail reader to list overlay on Escape", async () => {
    const mock = createMockCtx({
      cwd: process.cwd(),
      branch: sampleBranch,
      customInputs: [["\r"], ["\x1b"], ["\x1b"]],
    });

    await openQaOverlay(mock.ctx);
    assert.equal(mock.getCustomCalls(), 3);
  });

  it("notifies user when opening /qa with empty Q&A history", async () => {
    const mock = createMockCtx({
      cwd: process.cwd(),
      branch: [],
    });

    const pasted = await openQaOverlay(mock.ctx);
    assert.equal(pasted, null);
    assert.equal(mock.notifications.length, 1);
    assert.match(mock.notifications[0].msg, /No human Q&A pairs/);
  });

  it("honors remapped tui.select navigation keybindings in QaListOverlay", () => {
    const pairs = extractQaHistory(sampleBranch).pairs;
    const results: QaListResult[] = [];
    const selection = { index: 0, id: pairs[0].id };
    const remappedKb = fakeKeybindings((data, action) => {
      if (action === "tui.select.down") return data === "n";
      if (action === "tui.select.confirm") return data === "o";
      return false;
    });
    const overlay = new QaListOverlay(fakeTui(), fakeTheme(), pairs, selection, (r) => {
      results.push(r);
    }, "", remappedKb);

    overlay.handleInput("n");
    overlay.handleInput("o");
    const result = results[0];
    assert.equal(result?.action, "open");
    if (result?.action === "open") {
      assert.equal(result.pair.question, "Explain caching");
    }
  });

  it("honors remapped tui.select confirm keybinding in openQaOverlay", async () => {
    const remappedKb = fakeKeybindings((data, action) => {
      if (action === "tui.select.confirm") return data === "o";
      if (action === "tui.select.cancel") return data === "q";
      return false;
    });
    const mock = createMockCtx({
      cwd: process.cwd(),
      branch: sampleBranch,
      keybindings: remappedKb,
      customInputs: [["o"], ["1"]],
    });

    const pasted = await openQaOverlay(mock.ctx);
    assert.equal(pasted, 'Re: "Recommendation for Issue #2" — ');
  });

  it("returns identical body lines array across repeated calls with the same theme", () => {
    const pair = extractQaHistory(sampleBranch).pairs[0];
    const getBodyLines = createDetailBodyLinesGetter(pair);
    const themeA = fakeTheme();
    const themeB = fakeTheme();

    const first = getBodyLines(themeA);
    const second = getBodyLines(themeA);
    assert.strictEqual(first, second);

    const refreshed = getBodyLines(themeB);
    assert.notStrictEqual(refreshed, first);
    assert.deepEqual(refreshed, first);
  });

  it("reveals later lines when scrolling a long answer in detail reader", async () => {
    const longAnswer = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: detail paragraph text`).join("\n");
    const longBranch = [
      userEntry("u1", "Give me a long answer"),
      assistantEntry("a1", [{ type: "text", text: longAnswer }]),
    ];

    let callNum = 0;
    let initialFrame = "";
    let scrolledFrame = "";
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      sessionManager: { getBranch: () => longBranch },
      ui: {
        notify() {},
        pasteToEditor() {},
        async custom(factory: any) {
          callNum += 1;
          let doneVal: any;
          let closed = false;
          const comp = await factory(fakeTui({ rows: 14 }), fakeTheme(), fakeKeybindings(), (v: any) => {
            doneVal = v;
            closed = true;
          });
          if (callNum === 1) {
            comp.render(80);
            comp.handleInput("\r");
          } else if (callNum === 2) {
            initialFrame = comp.render(80).join("\n");
            for (let i = 0; i < 12; i++) {
              comp.handleInput("j");
            }
            scrolledFrame = comp.render(80).join("\n");
            comp.handleInput("\x1b");
          } else if (!closed) {
            comp.handleInput("\x1b");
          }
          comp.dispose?.();
          return doneVal;
        },
      },
    } as unknown as ExtensionCommandContext;

    await openQaOverlay(ctx);
    assert.match(initialFrame, /Line 1: detail paragraph text/);
    assert.doesNotMatch(initialFrame, /Line 14: detail paragraph text/);
    assert.match(scrolledFrame, /Line 14: detail paragraph text/);
  });
});

describe("qa_overlay_shortcut & buried-answer widget lifecycle", () => {
  let tempDir: string;
  let globalFile: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("qa-overlay-");
    mkdirSync(join(tempDir, ".pi"), { recursive: true });
    globalFile = join(tempDir, "global-settings.json");
    setGlobalSettingsPath(globalFile);
    prevEnv = process.env.PI_QA_OVERLAY_SHORTCUT;
    delete process.env.PI_QA_OVERLAY_SHORTCUT;
    clearSettingsCache();
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.PI_QA_OVERLAY_SHORTCUT;
    else process.env.PI_QA_OVERLAY_SHORTCUT = prevEnv;
    setGlobalSettingsPath(null);
    clearSettingsCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("defaults qa_overlay_shortcut to alt+q in settings schema", () => {
    assert.equal(SETTINGS_KEYS.qa_overlay_shortcut?.default, "alt+q");
    assert.equal(getSetting(tempDir, "qa_overlay_shortcut"), "alt+q");
    assert.equal(resolveConfiguredQaShortcut(tempDir), "alt+q");
  });

  it("disables shortcut registration when qa_overlay_shortcut is empty string", () => {
    writeFileSync(join(tempDir, ".pi", "pi-config-settings.json"), JSON.stringify({ qa_overlay_shortcut: "" }));
    clearSettingsCache();

    const harness = createFakePi();
    let registered: string | null = "alt+q";
    withSubagentChildEnv(undefined, () => {
      registered = registerQaOverlay(harness.pi, { cwd: tempDir }).registeredShortcut;
      return undefined;
    });
    assert.equal(registered, null);
    assert.equal(harness.shortcuts.size, 0);
    assert.equal(harness.commands.has("qa"), true);
  });

  it("disables shortcut registration on invalid shortcut syntax", () => {
    writeFileSync(
      join(tempDir, ".pi", "pi-config-settings.json"),
      JSON.stringify({ qa_overlay_shortcut: "not-a-valid-key" }),
    );
    clearSettingsCache();

    assert.equal(resolveConfiguredQaShortcut(tempDir), null);
    const harness = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerQaOverlay(harness.pi, { cwd: tempDir });
      return undefined;
    });
    assert.equal(harness.shortcuts.size, 0);
  });

  it("skips registration when PI_SUBAGENT_CHILD=1", () => {
    const harness = createFakePi();
    withSubagentChildEnv("1", () => {
      registerQaOverlay(harness.pi, { cwd: tempDir });
      return undefined;
    });
    assert.equal(harness.commands.size, 0);
    assert.equal(harness.shortcuts.size, 0);
  });

  it("registers /qa command with alt+q shortcut in parent sessions", () => {
    const harness = createFakePi();
    let registered: string | null = null;
    withSubagentChildEnv(undefined, () => {
      registered = registerQaOverlay(harness.pi, { cwd: tempDir }).registeredShortcut;
      return undefined;
    });
    assert.equal(registered, "alt+q");
    assert.equal(harness.commands.has("qa"), true);
    assert.equal(harness.shortcuts.has("alt+q"), true);
  });

  it("shows 1-line dim buried-answer widget above editor after a background turn", async () => {
    const harness = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerQaOverlay(harness.pi, { cwd: tempDir });
      return undefined;
    });

    const branch = [
      userEntry("u1", "Which PR should merge first?"),
      assistantEntry("a1", [{ type: "text", text: "PR #1453 first." }]),
      customEntry("c1", "async-agent-result", "## Async Agent Result: ci"),
      assistantEntry("a2", [{ type: "text", text: "CI passed." }]),
    ];
    const mock = createMockCtx({ cwd: tempDir, branch });

    await harness.emit("agent_end", {}, mock.ctx);
    const widget = mock.widgets.get(QA_HINT_WIDGET_KEY);
    assert.ok(widget);
    assert.deepEqual(widget.options, { placement: "aboveEditor" });
    const comp = widget.content(fakeTui(), fakeTheme());
    const lines = comp.render(120);
    assert.equal(lines.length, 1);
    assert.equal(
      lines[0],
      '💬 Answer ready for "Which PR should merge first?" — Alt+Q to read',
    );
  });

  it("clears buried-answer widget when /qa opens", async () => {
    const harness = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerQaOverlay(harness.pi, { cwd: tempDir });
      return undefined;
    });

    const branch = [
      userEntry("u1", "Which PR should merge first?"),
      assistantEntry("a1", [{ type: "text", text: "PR #1453 first." }]),
      customEntry("c1", "async-agent-result", "## Async Agent Result: ci"),
      assistantEntry("a2", [{ type: "text", text: "CI passed." }]),
    ];
    const mock = createMockCtx({ cwd: tempDir, branch, customInputs: [["\x1b"]] });

    await harness.emit("agent_end", {}, mock.ctx);
    assert.equal(mock.widgets.has(QA_HINT_WIDGET_KEY), true);

    await harness.commands.get("qa").handler("", mock.ctx);
    assert.equal(mock.widgets.has(QA_HINT_WIDGET_KEY), false);
  });

  it("keeps buried-answer widget dismissed on later background turns for same answer", async () => {
    const harness = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerQaOverlay(harness.pi, { cwd: tempDir });
      return undefined;
    });

    const branch: unknown[] = [
      userEntry("u1", "Check deploy"),
      assistantEntry("a1", [{ type: "text", text: "Deploy ready." }]),
      customEntry("c1", "async-agent-result", "## Async Agent Result: job1"),
      assistantEntry("a2", [{ type: "text", text: "Job1 done." }]),
    ];
    const mock = createMockCtx({ cwd: tempDir, branch, customInputs: [["\x1b"]] });

    await harness.emit("agent_end", {}, mock.ctx);
    await harness.commands.get("qa").handler("", mock.ctx);
    assert.equal(mock.widgets.has(QA_HINT_WIDGET_KEY), false);

    branch.push(
      customEntry("c2", "async-agent-result", "## Async Agent Result: job2"),
      assistantEntry("a3", [{ type: "text", text: "Job2 done." }]),
    );
    await harness.emit("agent_end", {}, mock.ctx);
    assert.equal(mock.widgets.has(QA_HINT_WIDGET_KEY), false);
  });

  it("clears buried-answer widget on next interactive human input", async () => {
    const harness = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerQaOverlay(harness.pi, { cwd: tempDir });
      return undefined;
    });

    const branch = [
      userEntry("u1", "Check deploy"),
      assistantEntry("a1", [{ type: "text", text: "Deploy ready." }]),
      customEntry("c1", "async-agent-result", "## Async Agent Result: job1"),
      assistantEntry("a2", [{ type: "text", text: "Job1 done." }]),
    ];
    const mock = createMockCtx({ cwd: tempDir, branch });

    await harness.emit("agent_end", {}, mock.ctx);
    assert.equal(mock.widgets.has(QA_HINT_WIDGET_KEY), true);

    await harness.emit("input", { source: "interactive", text: "Looks good, ship it" }, mock.ctx);
    assert.equal(mock.widgets.has(QA_HINT_WIDGET_KEY), false);
  });

  it("clears buried-answer widget on before_agent_start for a human prompt", async () => {
    const harness = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerQaOverlay(harness.pi, { cwd: tempDir });
      return undefined;
    });

    const branch = [
      userEntry("u1", "Check deploy"),
      assistantEntry("a1", [{ type: "text", text: "Deploy ready." }]),
      customEntry("c1", "async-agent-result", "## Async Agent Result: job1"),
      assistantEntry("a2", [{ type: "text", text: "Job1 done." }]),
    ];
    const mock = createMockCtx({ cwd: tempDir, branch });

    await harness.emit("agent_end", {}, mock.ctx);
    assert.equal(mock.widgets.has(QA_HINT_WIDGET_KEY), true);

    await harness.emit("before_agent_start", { messageType: "user", prompt: "Next step?" }, mock.ctx);
    assert.equal(mock.widgets.has(QA_HINT_WIDGET_KEY), false);
  });

  it("outputs plain-text summary when /qa runs without UI", async () => {
    const harness = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerQaOverlay(harness.pi, { cwd: tempDir });
      return undefined;
    });

    const branch = [
      userEntry("u1", "What changed?"),
      assistantEntry("a1", [{ type: "text", text: "Added /qa overlay." }]),
    ];
    const mock = createMockCtx({ cwd: tempDir, branch, hasUI: false });

    await harness.commands.get("qa").handler("", mock.ctx);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0].msg.customType, "qa-overlay");
    assert.match(harness.sentMessages[0].msg.content, /What changed\?/);
    assert.equal(
      formatQaPlainText(extractQaHistory(branch).pairs),
      harness.sentMessages[0].msg.content,
    );
  });

  it("tolerates stale contexts with throwing getters during session_start", async () => {
    const harness = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerQaOverlay(harness.pi, { cwd: tempDir });
      return undefined;
    });

    const staleCtx = {
      get mode() {
        throw new Error("stale context: mode");
      },
      get hasUI() {
        throw new Error("stale context: hasUI");
      },
      get sessionManager() {
        throw new Error("stale context: sessionManager");
      },
    };

    await assert.doesNotReject(async () => {
      await harness.emit("session_start", {}, staleCtx);
      await harness.emit("agent_end", {}, staleCtx);
      await harness.emit("session_shutdown", {}, staleCtx);
    });
  });

  it("records expanded cron prompt provenance across input to before_agent_start", async () => {
    const harness = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerQaOverlay(harness.pi, { cwd: tempDir });
      return undefined;
    });

    const mock = createMockCtx({ cwd: tempDir, branch: [] });
    harness.pi.events.emit("cron:dispatch-command", { command: "/review-local" });
    await harness.emit("input", { source: "extension", text: "/review-local" }, mock.ctx);
    await harness.emit(
      "before_agent_start",
      { messageType: "user", prompt: "Expanded local review prompt body" },
      mock.ctx,
    );

    assert.equal(harness.appendedEntries.length, 1);
    assert.deepEqual(harness.appendedEntries[0], {
      customType: CRON_USER_MESSAGE_ENTRY_TYPE,
      data: { command: "Expanded local review prompt body" },
    });
  });

  it("preserves provenance for two queued transformed cron prompts", async () => {
    const harness = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerQaOverlay(harness.pi, { cwd: tempDir });
      return undefined;
    });

    const mock = createMockCtx({ cwd: tempDir, branch: [], sessionId: "sess-queue" });
    harness.pi.events.emit("cron:dispatch-command", { command: "/review-local" });
    harness.pi.events.emit("cron:dispatch-command", { command: "/retro" });
    await harness.emit("input", { source: "extension", text: "/review-local" }, mock.ctx);
    await harness.emit("input", { source: "extension", text: "/retro" }, mock.ctx);

    await harness.emit(
      "before_agent_start",
      { messageType: "user", prompt: "Transformed review prompt 1" },
      mock.ctx,
    );
    await harness.emit(
      "before_agent_start",
      { messageType: "user", prompt: "Transformed retro prompt 2" },
      mock.ctx,
    );

    assert.deepEqual(harness.appendedEntries, [
      { customType: CRON_USER_MESSAGE_ENTRY_TYPE, data: { command: "Transformed review prompt 1" } },
      { customType: CRON_USER_MESSAGE_ENTRY_TYPE, data: { command: "Transformed retro prompt 2" } },
    ]);
  });

  it("isolates queued cron provenance across sessions without letting unrelated prompts steal it", async () => {
    const harness = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerQaOverlay(harness.pi, { cwd: tempDir });
      return undefined;
    });

    const sessA = createMockCtx({ cwd: tempDir, branch: [], sessionId: "sess-a" });
    const sessB = createMockCtx({ cwd: tempDir, branch: [], sessionId: "sess-b" });

    harness.pi.events.emit("cron:dispatch-command", { command: "/review-local" });
    await harness.emit("input", { source: "extension", text: "/review-local" }, sessA.ctx);
    await harness.emit("input", { source: "interactive", text: "Human prompt in session B" }, sessB.ctx);
    await harness.emit(
      "before_agent_start",
      { messageType: "user", prompt: "Human prompt in session B" },
      sessB.ctx,
    );
    assert.equal(harness.appendedEntries.length, 0);

    await harness.emit(
      "before_agent_start",
      { messageType: "user", prompt: "Expanded review prompt in session A" },
      sessA.ctx,
    );
    assert.deepEqual(harness.appendedEntries, [
      { customType: CRON_USER_MESSAGE_ENTRY_TYPE, data: { command: "Expanded review prompt in session A" } },
    ]);
  });
});

describe("real pi-tui & SessionManager end-to-end integration", () => {
  let tempDir: string;
  let globalFile: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("qa-real-tui-");
    mkdirSync(join(tempDir, ".pi"), { recursive: true });
    globalFile = join(tempDir, "global-settings.json");
    setGlobalSettingsPath(globalFile);
    prevEnv = process.env.PI_QA_OVERLAY_SHORTCUT;
    delete process.env.PI_QA_OVERLAY_SHORTCUT;
    clearSettingsCache();
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.PI_QA_OVERLAY_SHORTCUT;
    else process.env.PI_QA_OVERLAY_SHORTCUT = prevEnv;
    setGlobalSettingsPath(null);
    clearSettingsCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createVirtualTerminal(cols = 120, rows = 30) {
    let onInput: ((data: string) => void) | undefined;
    let output = "";
    const terminal: Terminal = {
      start(inputCb) {
        onInput = inputCb;
      },
      stop() {
        onInput = undefined;
      },
      async drainInput() {},
      write(data: string) {
        output += data;
      },
      get columns() {
        return cols;
      },
      get rows() {
        return rows;
      },
      get kittyProtocolActive() {
        return false;
      },
      moveBy() {},
      hideCursor() {},
      showCursor() {},
      clearLine() {},
      clearFromCursor() {},
      clearScreen() {},
      setTitle() {},
      setProgress() {},
      setProgramStatus() {},
    };
    return {
      terminal,
      send(seq: string) {
        onInput?.(seq);
      },
      readPlain() {
        return stripTerminalSequences(output);
      },
      clearOutput() {
        output = "";
      },
    };
  }

  function createSeededSession(cwd: string): SessionManager {
    const sm = SessionManager.inMemory(cwd);
    const usage = {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Explain caching strategy" }],
      timestamp: 1_795_788_060_000,
    });
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "### Cache Architecture\n1. Use LRU map\n2. Cap entries at 512" }],
      api: "openai-responses",
      provider: "test",
      model: "test",
      usage,
      stopReason: "stop",
      timestamp: 1_795_788_065_000,
    });
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Recommendation for Issue #2" }],
      timestamp: 1_795_788_120_000,
    });
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "### Recommendation for Issue #2\n1. Add shortcut\n2. Add buried hint" }],
      api: "openai-responses",
      provider: "test",
      model: "test",
      usage,
      stopReason: "stop",
      timestamp: 1_795_788_125_000,
    });
    sm.appendCustomMessageEntry(
      "async-agent-result",
      "## Async Agent Result: test-runner passed",
      true,
    );
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Background test-runner completed cleanly." }],
      api: "openai-responses",
      provider: "test",
      model: "test",
      usage,
      stopReason: "stop",
      timestamp: 1_795_788_185_000,
    });
    return sm;
  }

  function createRealTuiHarness(cwd: string) {
    const vt = createVirtualTerminal(120, 30);
    const tui = new TuiAltScreen(vt.terminal, false);
    const kb = new KeybindingsManager(TUI_KEYBINDINGS);
    const theme = fakeTheme();
    const editor = new Editor(tui, {
      borderColor: (s: string) => s,
      selectList: {
        selectedPrefix: (s: string) => s,
        selectedText: (s: string) => s,
        description: (s: string) => s,
        scrollInfo: (s: string) => s,
        noMatch: (s: string) => s,
      },
    });
    tui.addChild(editor);
    const sm = createSeededSession(cwd);
    const mountedWidgets = new Map<string, any>();

    const ctx = {
      cwd,
      mode: "interactive",
      hasUI: true,
      sessionManager: sm,
      ui: {
        notify() {},
        pasteToEditor(text: string) {
          editor.handleInput(`\x1b[200~${text}\x1b[201~`);
          tui.requestRender(true);
        },
        setWidget(key: string, content: any) {
          const prev = mountedWidgets.get(key);
          if (prev) {
            tui.removeChild(prev);
            mountedWidgets.delete(key);
          }
          if (typeof content === "function") {
            const comp = content(tui, theme);
            mountedWidgets.set(key, comp);
            tui.addChild(comp);
          }
          tui.requestRender(true);
        },
        custom<T>(factory: any, opts?: any): Promise<T> {
          return new Promise<T>((resolve) => {
            let overlayHandle: { hide(): void } | undefined;
            let comp: any;
            const done = (val: T) => {
              overlayHandle?.hide();
              comp?.dispose?.();
              tui.requestRender(true);
              resolve(val);
            };
            Promise.resolve(factory(tui, theme, kb, done)).then((created) => {
              comp = created;
              overlayHandle = tui.showOverlay(comp, opts?.overlayOptions);
              tui.requestRender(true);
            });
          });
        },
      },
    } as unknown as ExtensionCommandContext;

    tui.start();
    return {
      vt,
      tui,
      editor,
      ctx,
      mountedWidgets,
      stop() {
        tui.stop();
      },
    };
  }

  async function waitForCondition(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.fail(`Timed out waiting for ${label} after ${timeoutMs}ms`);
  }

  it("renders buried-answer hint widget in real TuiAltScreen after background turn", async () => {
    const harness = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerQaOverlay(harness.pi, { cwd: tempDir });
      return undefined;
    });
    const ui = createRealTuiHarness(tempDir);
    try {
      await harness.emit("agent_end", {}, ui.ctx);
      await waitForCondition(
        () => /Answer ready for "Recommendation for Issue #2" — Alt\+Q to read/.test(ui.vt.readPlain()),
        "buried-answer hint frame",
      );
      assert.equal(ui.mountedWidgets.has(QA_HINT_WIDGET_KEY), true);
    } finally {
      ui.stop();
    }
  });

  it("pastes section quote via Alt+Q filter in real TuiAltScreen", async () => {
    const harness = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerQaOverlay(harness.pi, { cwd: tempDir });
      return undefined;
    });
    const ui = createRealTuiHarness(tempDir);
    try {
      await harness.emit("agent_end", {}, ui.ctx);
      assert.equal(ui.mountedWidgets.has(QA_HINT_WIDGET_KEY), true);

      const overlayDone = harness.shortcuts.get("alt+q").handler(ui.ctx);
      await waitForCondition(() => /Human Q&A/.test(ui.vt.readPlain()), "Human Q&A list frame");
      assert.equal(ui.mountedWidgets.has(QA_HINT_WIDGET_KEY), false);

      for (const seq of ["/", "l", "r", "u"]) {
        ui.vt.send(seq);
      }
      await waitForCondition(() => /1\/2 matching/.test(ui.vt.readPlain()), "filtered match frame");

      ui.vt.send("\r");
      await waitForCondition(() => /Q&A Reader/.test(ui.vt.readPlain()), "Q&A Reader detail frame");

      ui.vt.send("2");
      await overlayDone;
      assert.equal(ui.editor.getText(), 'Re: "Use LRU map" — ');
    } finally {
      ui.stop();
    }
  });

  it("pastes whole-answer quote via /qa command in real TuiAltScreen", async () => {
    const harness = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerQaOverlay(harness.pi, { cwd: tempDir });
      return undefined;
    });
    const ui = createRealTuiHarness(tempDir);
    try {
      const overlayDone = harness.commands.get("qa").handler("", ui.ctx);
      await waitForCondition(() => /Human Q&A/.test(ui.vt.readPlain()), "Human Q&A list frame");

      ui.vt.send("r");
      await overlayDone;
      assert.equal(ui.editor.getText(), 'Re: "Recommendation for Issue #2" — ');
    } finally {
      ui.stop();
    }
  });
});
