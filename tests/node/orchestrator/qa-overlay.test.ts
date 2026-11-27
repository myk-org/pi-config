/**
 * Unit tests for /qa human Q&A reader overlay, 1-key section quoting,
 * configurable shortcut (qa_overlay_shortcut), and buried-answer widget (#1453).
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  clearSettingsCache,
  getSetting,
  setGlobalSettingsPath,
  SETTINGS_KEYS,
} from "../../../extensions/orchestrator/project-settings.js";
import {
  QA_HINT_WIDGET_KEY,
  QaListOverlay,
  buildQaDetailLines,
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
) {
  return {
    type: "custom_message",
    id,
    timestamp,
    customType,
    content,
    display,
  };
}

function createFakePi() {
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const sentMessages: any[] = [];

  const pi = {
    on(event: string, fn: (...args: any[]) => any) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
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

  return { pi, commands, shortcuts, handlers, sentMessages, emit };
}

function createMockCtx(options: {
  cwd: string;
  branch: unknown[];
  hasUI?: boolean;
  sessionId?: string;
  customInputs?: string[][];
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
        const comp = await factory(fakeTui({ rows: 24 }), fakeTheme(), fakeKeybindings(), done);
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
});
