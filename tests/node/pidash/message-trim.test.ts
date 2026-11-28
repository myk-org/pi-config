/**
 * #1534 — Regression tests for trimming trailing blank lines on user/assistant
 * message cards in PiDash while preserving internal newlines, indentation,
 * and verbatim tool outputs.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import * as rootReact from "react";
import { createServer, type ViteDevServer } from "vite";
import * as pidashReact from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import type { Root } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import {
  applyTranscriptEvent,
  extractToolContentText,
  textFromMessage,
  trimMessageDisplayText,
  type TranscriptRefs,
  type TranscriptSink,
} from "../../../extensions/shared/pidash-transcript-reducer.ts";
import { trimMessageDisplayText as uxTrimMessageDisplayText } from "../../../extensions/pidash/pidash-ui/src/lib/pidash-ux-helpers.ts";
import { useMessageHandler } from "../../../extensions/pidash/pidash-ui/src/hooks/useMessageHandler.ts";
import type { ChatMessage, SessionInfo } from "../../../extensions/shared/types.ts";
import { elements, installReactDomShim } from "./react-dom-shim.mjs";

function makeReducerHarness() {
  const messages: ChatMessage[] = [];
  let seq = 0;
  const refs: TranscriptRefs = {
    think: { id: "", text: "", startTs: 0 },
    assist: { id: "", text: "" },
    tool: { id: "", name: "", startTs: 0, callId: "" },
    asyncMsgs: new Map(),
    lastUserText: "",
    pendingLocalUserTexts: [],
  };
  const sink: TranscriptSink = {
    add(role, text, className, meta, options) {
      const id = options?.explicitId ?? `m-${++seq}`;
      messages.push({ id, role, text, className, meta, timestamp: options?.timestamp ?? 1000 });
      return id;
    },
    patch(id, fn) {
      const idx = messages.findIndex((m) => m.id === id);
      if (idx !== -1) messages[idx] = fn(messages[idx]);
    },
    findLast(pred) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (pred(messages[i])) return messages[i];
      }
      return undefined;
    },
    dismissAsk() {},
    nextId: () => `id-${++seq}`,
  };
  return { messages, refs, sink };
}

describe("trimMessageDisplayText (#1534)", () => {
  it("strips trailing blank lines from single-line replies", () => {
    assert.equal(trimMessageDisplayText("All checks passed.\n\n\n\n\n"), "All checks passed.");
  });

  it("strips trailing spaces with mixed line endings", () => {
    assert.equal(trimMessageDisplayText("Done  \r\n  \n\t\n"), "Done");
  });

  it("preserves internal multi-line paragraphs", () => {
    assert.equal(
      trimMessageDisplayText("First paragraph.\n\nSecond paragraph.\n\n\n"),
      "First paragraph.\n\nSecond paragraph.",
    );
  });

  it("preserves internal code blocks with indentation", () => {
    const body = "Example:\n\n```ts\nfunction greet(): string {\n  return 'hi';\n}\n```";
    assert.equal(trimMessageDisplayText(`${body}\n\n\n\n`), body);
  });

  it("preserves leading indentation on the first line", () => {
    assert.equal(trimMessageDisplayText("    indented line\n\n\n"), "    indented line");
  });

  it("returns empty string for whitespace-only text", () => {
    assert.equal(trimMessageDisplayText("   \n\n\t\n"), "");
  });

  it("is re-exported identically from pidash-ux-helpers", () => {
    assert.equal(uxTrimMessageDisplayText, trimMessageDisplayText);
  });
});

describe("pidash-transcript-reducer trailing whitespace trimming (#1534)", () => {
  it("trims trailing blank lines in textFromMessage for string content", () => {
    assert.equal(textFromMessage({ content: "Check status\n\n\n\n\n" }), "Check status");
  });

  it("trims trailing blank lines in textFromMessage for text block arrays", () => {
    const result = textFromMessage({
      content: [
        { type: "text", text: "Line one" },
        { type: "text", text: "Line two\n\n\n\n" },
      ],
    });
    assert.equal(result, "Line one\nLine two");
  });

  it("trims trailing blank lines on user message_start events", () => {
    const { messages, refs, sink } = makeReducerHarness();
    applyTranscriptEvent(
      { type: "message_start", message: { role: "user", content: "  Run suite\n\n\n\n" }, timestamp: 1001 },
      refs,
      sink,
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.role, "user");
    assert.equal(messages[0]?.text, "  Run suite");
  });

  it("deduplicates local user prompt echo when user text has trailing blank lines", () => {
    const { messages, refs, sink } = makeReducerHarness();
    refs.pendingLocalUserTexts!.push(trimMessageDisplayText("Ship it\n\n\n"));
    applyTranscriptEvent(
      { type: "message_start", message: { role: "user", content: "Ship it\n\n\n" }, timestamp: 1002 },
      refs,
      sink,
    );
    assert.equal(messages.length, 0);
    assert.equal(refs.pendingLocalUserTexts!.length, 0);
  });

  it("preserves spaces across streaming text_delta chunks before message_end", () => {
    const { messages, refs, sink } = makeReducerHarness();
    applyTranscriptEvent({ type: "message_start", message: { role: "assistant" }, timestamp: 1000 }, refs, sink);
    applyTranscriptEvent(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " }, timestamp: 1001 },
      refs,
      sink,
    );
    applyTranscriptEvent(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world\n\n\n\n\n" }, timestamp: 1002 },
      refs,
      sink,
    );
    applyTranscriptEvent(
      { type: "message_end", message: { role: "assistant" }, timestamp: 1003 },
      refs,
      sink,
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.text, "hello world");
    assert.equal(messages[0]?.className, undefined);
  });

  it("trims trailing blank lines when assistant text_end fires", () => {
    const { messages, refs, sink } = makeReducerHarness();
    applyTranscriptEvent({ type: "message_start", message: { role: "assistant" }, timestamp: 1000 }, refs, sink);
    applyTranscriptEvent(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done.\n\n\n\n" }, timestamp: 1001 },
      refs,
      sink,
    );
    applyTranscriptEvent(
      { type: "message_update", assistantMessageEvent: { type: "text_end" }, timestamp: 1002 },
      refs,
      sink,
    );
    assert.equal(messages[0]?.text, "Done.");
    assert.equal(messages[0]?.className, undefined);
  });

  it("trims trailing blank lines when agent_end finalizes a streaming assistant message", () => {
    const { messages, refs, sink } = makeReducerHarness();
    applyTranscriptEvent({ type: "message_start", message: { role: "assistant" }, timestamp: 1000 }, refs, sink);
    applyTranscriptEvent(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Settled.\n\n\n\n\n" }, timestamp: 1001 },
      refs,
      sink,
    );
    applyTranscriptEvent({ type: "agent_end", timestamp: 1002 }, refs, sink);
    assert.equal(messages[0]?.text, "Settled.");
    assert.equal(messages[0]?.className, undefined);
  });

  it("keeps trailing newlines verbatim in extractToolContentText", () => {
    const raw = "line1\nline2\n\n\n";
    assert.equal(extractToolContentText([{ type: "text", text: raw }]), raw);
  });

  it("keeps trailing newlines verbatim on tool_execution_end results", () => {
    const { messages, refs, sink } = makeReducerHarness();
    const rawOutput = "PASS test_a\n\n\n";
    applyTranscriptEvent(
      { type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "echo hi\n\n" }, timestamp: 1000 },
      refs,
      sink,
    );
    applyTranscriptEvent(
      {
        type: "tool_execution_end",
        toolCallId: "tc-1",
        toolName: "bash",
        isError: false,
        result: { content: [{ type: "text", text: rawOutput }] },
        timestamp: 1001,
      },
      refs,
      sink,
    );
    const resultMsg = messages.find((m) => m.className === "tool-result");
    assert.equal(resultMsg?.text, `✓ ${rawOutput}`);
  });

  it("keeps trailing newlines verbatim on tool_execution_start call arguments", () => {
    const { messages, refs, sink } = makeReducerHarness();
    const rawCommand = "printf 'ok'\n\n";
    applyTranscriptEvent(
      { type: "tool_execution_start", toolCallId: "tc-2", toolName: "bash", args: { command: rawCommand }, timestamp: 1000 },
      refs,
      sink,
    );
    const callMsg = messages.find((m) => m.className === "tool-call");
    assert.equal(callMsg?.text, rawCommand);
  });
});

let vite: ViteDevServer | undefined;
let createRoot: (container: Element) => Root;
let MessageList: any;
let MessageItem: any;
let ToolGroup: any;

const rootInternals = (rootReact as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const pidashInternals = (pidashReact as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
for (const key of ["H", "A", "T"]) {
  Object.defineProperty(rootInternals, key, {
    configurable: true,
    get: () => pidashInternals[key],
    set: (value) => { pidashInternals[key] = value; },
  });
}

describe("MessageItem trailing blank line display (#1534)", () => {
  const mounted: Root[] = [];
  const originalClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator ?? {}, "clipboard");

  before(async () => {
    installReactDomShim();
    ({ createRoot } = await import("../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js"));
    vite = await createServer({
      root: path.resolve("extensions/pidash/pidash-ui"),
      server: { middlewareMode: true, hmr: false },
      appType: "custom",
    });
    ({ MessageList, MessageItem, ToolGroup } = await vite.ssrLoadModule("/src/components/MessageList.tsx"));
  });

  after(() => vite?.close());

  afterEach(async () => {
    while (mounted.length) await act(async () => mounted.pop()!.unmount());
    if (originalClipboard) {
      Object.defineProperty(globalThis.navigator, "clipboard", originalClipboard);
    }
  });

  it("renders assistant cards without trailing blank lines", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const msg: ChatMessage = { id: "a1", role: "assistant", text: "Compact reply.\n\n\n\n\n" };
    await act(async () => root.render(createElement(MessageItem, { msg })));

    const body = elements(container, "div").find((d) => (d.getAttribute("class") ?? "").includes("whitespace-pre-wrap"));
    assert.equal(body?.textContent, "Compact reply.");
  });

  it("renders user cards without trailing blank lines", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const msg: ChatMessage = { id: "u1", role: "user", text: "Short prompt\n\n\n\n" };
    await act(async () => root.render(createElement(MessageItem, { msg })));

    const body = elements(container, "div").find((d) => (d.getAttribute("class") ?? "").includes("whitespace-pre-wrap"));
    assert.equal(body?.textContent, "Short prompt");
  });

  it("renders streaming assistant cards without trailing blank lines", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const msg: ChatMessage = { id: "s1", role: "assistant", text: "Streaming line\n\n\n\n", className: "streaming" };
    await act(async () => root.render(createElement(MessageItem, { msg })));

    const body = elements(container, "div").find((d) => (d.getAttribute("class") ?? "").includes("whitespace-pre-wrap"));
    assert.equal(body?.textContent, "Streaming line");
  });

  it("copies trimmed text from assistant Copy message button", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const copied: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: async (txt: string) => { copied.push(txt); } },
      configurable: true,
    });

    const msg: ChatMessage = { id: "a2", role: "assistant", text: "Clean copy\n\n\n\n\n" };
    await act(async () => root.render(createElement(MessageItem, { msg })));

    const copyBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Copy message");
    assert.equal(Boolean(copyBtn), true);
    await act(async () => {
      copyBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.deepEqual(copied, ["Clean copy"]);
  });

  it("copies trimmed text from user Copy message button", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const copied: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: async (txt: string) => { copied.push(txt); } },
      configurable: true,
    });

    const msg: ChatMessage = { id: "u2", role: "user", text: "User prompt\n\n\n" };
    await act(async () => root.render(createElement(MessageItem, { msg })));

    const copyBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Copy message");
    assert.equal(Boolean(copyBtn), true);
    await act(async () => {
      copyBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.deepEqual(copied, ["User prompt"]);
  });

  it("preserves leading indentation on rendered assistant cards", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const msg: ChatMessage = { id: "a3", role: "assistant", text: "    indented block\n\n\n" };
    await act(async () => root.render(createElement(MessageItem, { msg })));

    const body = elements(container, "div").find((d) => (d.getAttribute("class") ?? "").includes("whitespace-pre-wrap"));
    assert.equal(body?.textContent, "    indented block");
  });

  it("preserves internal paragraphs on rendered assistant cards", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const expected = "Para 1\n\n```js\n  const x = 1;\n```\n\nPara 2";
    const msg: ChatMessage = { id: "a4", role: "assistant", text: `${expected}\n\n\n\n` };
    await act(async () => root.render(createElement(MessageItem, { msg })));

    const body = elements(container, "div").find((d) => (d.getAttribute("class") ?? "").includes("whitespace-pre-wrap"));
    assert.equal(body?.textContent, expected);
  });

  it("keeps trailing newlines verbatim in rendered ToolGroup results", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const copied: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: async (txt: string) => { copied.push(txt); } },
      configurable: true,
    });

    const rawOutput = "output line\n\n\n";
    const call: ChatMessage = { id: "c1", role: "bash" as any, text: "echo hi\n\n", className: "tool-call", meta: { callId: "k1" } };
    const result: ChatMessage = { id: "r1", role: "bash" as any, text: `✓ ${rawOutput}`, className: "tool-result", meta: { callId: "k1" } };

    await act(async () => root.render(createElement(ToolGroup, { call, result, searchQuery: "output" })));

    const copyOutputBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Copy output");
    assert.equal(Boolean(copyOutputBtn), true);
    await act(async () => {
      copyOutputBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.deepEqual(copied, [rawOutput]);
  });

  it("deduplicates echoed user prompts with trailing blank lines in useMessageHandler", async () => {
    const { container } = installReactDomShim();
    const session: SessionInfo = {
      sessionId: "s-trim-1",
      pid: 1,
      cwd: "/tmp/project",
      branch: "main",
      model: "m",
      startedAt: "now",
      lastActivity: 0,
      active: true,
    };
    const notifications = {
      preferences: { sessionError: false, agentComplete: false, testResults: false, toolComplete: false },
      notify: () => {},
    } as any;
    let emit: (ev: any) => void = () => {};
    let api: ReturnType<typeof useMessageHandler> | null = null;

    function Probe() {
      api = useMessageHandler(
        (handler) => { emit = handler as any; return () => {}; },
        session,
        notifications,
        () => {},
      );
      return null;
    }

    const root = createRoot(container);
    mounted.push(root);
    await act(async () => root.render(createElement(Probe)));

    await act(async () => {
      api!.setLastUserText("Ship it\n\n\n");
      api!.addMsg("user", "Ship it\n\n\n");
      emit({ type: "message_start", message: { role: "user", content: "Ship it\n\n\n" } });
    });

    assert.equal(api!.messages.length, 1);
    assert.equal(api!.messages[0]?.role, "user");
  });

  it("trims trailing blank lines after rAF-coalesced streaming deltas finish", async () => {
    const { container } = installReactDomShim();
    const session: SessionInfo = {
      sessionId: "s-trim-2",
      pid: 1,
      cwd: "/tmp/project",
      branch: "main",
      model: "m",
      startedAt: "now",
      lastActivity: 0,
      active: true,
    };
    const notifications = {
      preferences: { sessionError: false, agentComplete: false, testResults: false, toolComplete: false },
      notify: () => {},
    } as any;
    let emit: (ev: any) => void = () => {};
    let api: ReturnType<typeof useMessageHandler> | null = null;

    function Probe() {
      api = useMessageHandler(
        (handler) => { emit = handler as any; return () => {}; },
        session,
        notifications,
        () => {},
      );
      return null;
    }

    const root = createRoot(container);
    mounted.push(root);
    await act(async () => root.render(createElement(Probe)));

    await act(async () => {
      emit({ type: "message_start", message: { role: "assistant" } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hel" } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo " } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world\n\n\n\n\n" } });
      emit({ type: "message_end", message: { role: "assistant" } });
    });

    assert.equal(api!.messages.length, 1);
    assert.equal(api!.messages[0]?.text, "hello world");
    assert.equal(api!.messages[0]?.className, undefined);
  });

  it("excludes streaming assistant cards when search matches only trailing whitespace", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const messages: ChatMessage[] = [
      { id: "s-search", role: "assistant", text: "Done\n\n", className: "streaming" },
    ];
    await act(async () => root.render(createElement(MessageList, { messages, searchQuery: "\n" })));

    assert.equal((container.textContent ?? "").includes("Done"), false);
  });

  it("excludes user cards when search matches only trailing whitespace", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const messages: ChatMessage[] = [
      { id: "u-search", role: "user", text: "Ping   " },
    ];
    await act(async () => root.render(createElement(MessageList, { messages, searchQuery: "   " })));

    assert.equal((container.textContent ?? "").includes("Ping"), false);
  });

  it("retains tool result cards when search matches trailing newlines", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const messages: ChatMessage[] = [
      { id: "tc-s", role: "bash" as any, text: "echo ok", className: "tool-call", meta: { callId: "k-s" } },
      { id: "tr-s", role: "bash" as any, text: "✓ ok\n\n", className: "tool-result", meta: { callId: "k-s" } },
    ];
    await act(async () => root.render(createElement(MessageList, { messages, searchQuery: "\n\n" })));

    assert.equal((container.textContent ?? "").includes("✓ ok"), true);
  });
});
