/**
 * #1479 — Regression tests for PiDash transcript completeness and universal Copy buttons:
 * - Lossless `formatToolCallDetail` across codemode, write, edit, read, subagent, bash, MCP tools
 * - Multi-part `extractToolContentText` joining content[0..N] plus `[image: <mimeType>]` markers
 * - Non-clobbering `tool_execution_update` preserving call arguments in `tool-call`
 * - Lossless `replaySessionHistory` preserving `toolCallId`, `arguments`, `content[0..N]`, `details`
 * - Universal visible `CopyOutputButton` on collapsed rows, expanded CALL/RESULT, CollapsibleMessage, MessageItem
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
  appendAsyncAgentEventText,
  applyTranscriptEvent,
  extractToolContentText,
  formatToolCallDetail,
  type TranscriptRefs,
  type TranscriptSink,
} from "../../../extensions/shared/pidash-transcript-reducer.ts";
import { replaySessionHistory } from "../../../extensions/pidash/pidash.ts";
import { formatToolCallSummary } from "../../../extensions/pidash/pidash-ui/src/lib/pidash-ux-helpers.ts";
import type { ChatMessage } from "../../../extensions/shared/types.ts";
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

describe("extractToolContentText (#1479)", () => {
  it("joins all text blocks across content[0..2] for codemode output", () => {
    const text = extractToolContentText([
      { type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:" },
      { type: "text", text: '{"status":"ok"}' },
      { type: "text", text: "<console_output>\ndone\n</console_output>" },
    ]);
    assert.equal(
      text,
      'Script completed\nWall time 0.1 seconds\nOutput:\n{"status":"ok"}\n<console_output>\ndone\n</console_output>',
    );
  });

  it("emits image mimeType markers alongside text blocks", () => {
    const text = extractToolContentText([
      { type: "text", text: "Captured screenshot" },
      { type: "image", data: "base64data", mimeType: "image/png" },
    ]);
    assert.equal(text, "Captured screenshot\n[image: image/png]");
  });

  it("falls back to unknown mimeType when an image block omits mimeType", () => {
    const text = extractToolContentText([{ type: "image", data: "base64data" }]);
    assert.equal(text, "[image: unknown]");
  });

  it("returns plain string content verbatim", () => {
    assert.equal(extractToolContentText("direct text"), "direct text");
  });

  it("skips empty text blocks without adding stray newlines", () => {
    const text = extractToolContentText([
      { type: "text", text: "" },
      { type: "text", text: "body" },
    ]);
    assert.equal(text, "body");
  });
});

describe("formatToolCallDetail (#1479)", () => {
  it("preserves full codemode code verbatim", () => {
    const code = "const tasks = await tools.TaskList({});\nconst count = tasks.length;\nreturn { count };";
    assert.equal(formatToolCallDetail("codemode", { code }), code);
  });

  it("preserves write path with full multi-line file content", () => {
    const content = "line 1\nline 2\nline 3\n".repeat(20);
    const detail = formatToolCallDetail("write", { path: "src/example.ts", content });
    assert.equal(detail.split("\n")[0], "src/example.ts");
    assert.equal(detail.includes(content), true);
  });

  it("preserves edit path with every oldText/newText replacement", () => {
    const detail = formatToolCallDetail("edit", {
      path: "src/app.ts",
      edits: [
        { oldText: "const a = 1;", newText: "const a = 2;" },
        { oldText: "return a;", newText: "return a * 10;" },
      ],
    });
    assert.equal(detail.split("\n")[0], "src/app.ts (2 edits)");
    assert.equal(detail.includes("const a = 1;"), true);
    assert.equal(detail.includes("const a = 2;"), true);
    assert.equal(detail.includes("return a * 10;"), true);
  });

  it("preserves read path with offset plus limit metadata", () => {
    const detail = formatToolCallDetail("read", { path: "extensions/pidash/pidash.ts", offset: 245, limit: 130 });
    assert.equal(detail, "extensions/pidash/pidash.ts (offset: 245, limit: 130)");
  });

  it("preserves subagent single task longer than 150 characters without truncation", () => {
    const longTask = `${"Implement full lossless transcript rendering. ".repeat(10)}TAIL_MARKER_1479`;
    assert.ok(longTask.length > 300);
    const detail = formatToolCallDetail("subagent", { agent: "ts-expert", task: longTask, cwd: "/repo" });
    assert.equal(detail.includes(longTask), true);
    assert.equal(detail.includes("TAIL_MARKER_1479"), true);
    assert.equal(detail.includes('"/repo"'), true);
  });

  it("preserves all subagent parallel tasks without truncation", () => {
    const longA = `Task A ${"alpha ".repeat(40)}END_A`;
    const longB = `Task B ${"beta ".repeat(40)}END_B`;
    const detail = formatToolCallDetail("subagent", {
      tasks: [
        { agent: "python-expert", name: "py", task: longA, cwd: "/repo" },
        { agent: "ts-expert", task: longB, cwd: "/repo" },
      ],
    });
    assert.equal(detail.split("\n")[0], "2 parallel tasks");
    assert.equal(detail.includes(longA), true);
    assert.equal(detail.includes(longB), true);
  });

  it("preserves all subagent chain steps without truncation", () => {
    const step1 = `Inspect ${"detail ".repeat(35)}STEP1_END`;
    const step2 = `Patch ${"change ".repeat(35)}STEP2_END`;
    const detail = formatToolCallDetail("subagent", {
      chain: [
        { agent: "debugger", task: step1, cwd: "/repo", estimatedSeconds: 20 },
        { agent: "ts-expert", task: step2, cwd: "/repo", estimatedSeconds: 25 },
      ],
    });
    assert.equal(detail.split("\n")[0], "2 chain steps");
    assert.equal(detail.includes(step1), true);
    assert.equal(detail.includes(step2), true);
  });

  it("formats generic MCP tool arguments as pretty-printed JSON", () => {
    const detail = formatToolCallDetail("mcp__jira__search", {
      jql: "project = PI ORDER BY updated DESC",
      maxResults: 25,
    });
    assert.equal(
      detail,
      JSON.stringify({ jql: "project = PI ORDER BY updated DESC", maxResults: 25 }, null, 2),
    );
  });

  it("parses JSON-stringified tool arguments into full formatted output", () => {
    const detail = formatToolCallDetail("read", JSON.stringify({ path: "README.md", offset: 1, limit: 50 }));
    assert.equal(detail, "README.md (offset: 1, limit: 50)");
  });

  it("returns empty string for empty or nullish arguments", () => {
    assert.equal(formatToolCallDetail("list_models", {}), "");
    assert.equal(formatToolCallDetail("list_models", undefined), "");
    assert.equal(formatToolCallDetail("list_models", null), "");
  });
});

describe("applyTranscriptEvent lossless tool lifecycle (#1479)", () => {
  it("preserves full codemode call code alongside multi-part result blocks", () => {
    const { messages, refs, sink } = makeReducerHarness();
    const code = "const list = await tools.TaskList({});\nreturn list;";

    applyTranscriptEvent(
      { type: "tool_execution_start", toolCallId: "cm-1", toolName: "codemode", args: { code }, timestamp: 100 },
      refs,
      sink,
    );
    applyTranscriptEvent(
      {
        type: "tool_execution_end",
        toolCallId: "cm-1",
        toolName: "codemode",
        isError: false,
        timestamp: 200,
        result: {
          content: [
            { type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:" },
            { type: "text", text: "#1 [in_progress] Fix PiDash" },
            { type: "text", text: "#2 [pending] Add tests" },
          ],
        },
      },
      refs,
      sink,
    );

    const call = messages.find((m) => m.className === "tool-call");
    const result = messages.find((m) => m.className === "tool-result");
    assert.equal(call?.text, code);
    assert.equal(
      result?.text,
      "✓ Script completed\nWall time 0.1 seconds\nOutput:\n#1 [in_progress] Fix PiDash\n#2 [pending] Add tests",
    );
  });

  it("keeps write call arguments intact across tool_execution_update events", () => {
    const { messages, refs, sink } = makeReducerHarness();
    const fileBody = "export const answer = 42;\n";

    applyTranscriptEvent(
      {
        type: "tool_execution_start",
        toolCallId: "w-1",
        toolName: "write",
        args: { path: "src/answer.ts", content: fileBody },
        timestamp: 100,
      },
      refs,
      sink,
    );
    applyTranscriptEvent(
      {
        type: "tool_execution_update",
        toolCallId: "w-1",
        partialResult: { content: [{ type: "text", text: "writing..." }] },
      },
      refs,
      sink,
    );

    const inFlight = messages.find((m) => m.className === "tool-call");
    assert.equal(inFlight?.text, `src/answer.ts\n\n${fileBody}`);
    assert.equal(inFlight?.meta?.partialOutput, "writing...");

    applyTranscriptEvent(
      {
        type: "tool_execution_end",
        toolCallId: "w-1",
        toolName: "write",
        isError: false,
        timestamp: 150,
        result: { content: [{ type: "text", text: "Successfully wrote 26 bytes to src/answer.ts" }] },
      },
      refs,
      sink,
    );

    const finalizedCall = messages.find((m) => m.className === "tool-call");
    assert.equal(finalizedCall?.text, `src/answer.ts\n\n${fileBody}`);
    assert.equal(finalizedCall?.meta?.partialOutput, undefined);
  });

  it("correlates parallel tool calls by toolCallId without dropping call arguments", () => {
    const { messages, refs, sink } = makeReducerHarness();

    applyTranscriptEvent(
      { type: "tool_execution_start", toolCallId: "p-1", toolName: "read", args: { path: "a.ts", offset: 1, limit: 10 }, timestamp: 100 },
      refs,
      sink,
    );
    applyTranscriptEvent(
      { type: "tool_execution_start", toolCallId: "p-2", toolName: "read", args: { path: "b.ts", offset: 20, limit: 30 }, timestamp: 101 },
      refs,
      sink,
    );
    applyTranscriptEvent(
      { type: "tool_execution_end", toolCallId: "p-1", toolName: "read", isError: false, timestamp: 110, result: { content: [{ type: "text", text: "contents of a" }] } },
      refs,
      sink,
    );
    applyTranscriptEvent(
      { type: "tool_execution_end", toolCallId: "p-2", toolName: "read", isError: false, timestamp: 112, result: { content: [{ type: "text", text: "contents of b" }] } },
      refs,
      sink,
    );

    const results = messages.filter((m) => m.className === "tool-result");
    assert.equal(results.length, 2);
    assert.equal(results[0].meta?.callId, "p-1");
    assert.equal(results[0].text, "✓ contents of a");
    assert.equal(results[1].meta?.callId, "p-2");
    assert.equal(results[1].text, "✓ contents of b");
  });

  it("joins multi-part tool_execution_end blocks inside appendAsyncAgentEventText", () => {
    const tracked = { text: "" };
    const changed = appendAsyncAgentEventText(tracked, {
      type: "tool_execution_end",
      isError: false,
      result: {
        content: [
          { type: "text", text: "Output:" },
          { type: "text", text: "second block payload" },
        ],
      },
    });
    assert.equal(changed, true);
    assert.equal(tracked.text, "\n✓ Output:\nsecond block payload");
  });

  it("includes non-bash tool detail preview inside appendAsyncAgentEventText", () => {
    const tracked = { text: "" };
    const changed = appendAsyncAgentEventText(tracked, {
      type: "tool_execution_start",
      toolName: "read",
      args: { path: "src/index.ts", offset: 1, limit: 20 },
    });
    assert.equal(changed, true);
    assert.equal(tracked.text, "\n🔧 read src/index.ts (offset: 1, limit: 20)");
  });
});

describe("replaySessionHistory lossless replay (#1479)", () => {
  it("preserves full toolCall arguments with multi-part toolResult content across replay", () => {
    const buffered: string[] = [];
    const sent: string[] = [];
    const entries = [
      {
        type: "message",
        timestamp: "2026-11-27T18:00:00.000Z",
        message: {
          role: "assistant",
          model: "gemini-4-neon",
          content: [
            {
              type: "toolCall",
              id: "call-cm",
              name: "codemode",
              arguments: { code: "return await tools.TaskList({});" },
            },
            {
              type: "toolCall",
              id: "call-read",
              name: "read",
              arguments: { path: "README.md", offset: 1, limit: 25 },
            },
          ],
        },
      },
      {
        type: "message",
        timestamp: "2026-11-27T18:00:01.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-cm",
          toolName: "codemode",
          isError: false,
          content: [
            { type: "text", text: "Script completed\nOutput:" },
            { type: "text", text: "task-list-body" },
            { type: "image", data: "abc", mimeType: "image/webp" },
          ],
        },
      },
      {
        type: "message",
        timestamp: "2026-11-27T18:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-read",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "# Pi Config" }],
          details: { fullOutputError: "disk full" },
        },
      },
      {
        type: "message",
        timestamp: "2026-11-27T18:00:03.000Z",
        message: {
          role: "custom",
          display: true,
          customType: "notice",
          content: [
            { type: "text", text: "Custom part 1" },
            { type: "text", text: "Custom part 2" },
          ],
        },
      },
    ];

    replaySessionHistory(
      { send: (frame: string) => sent.push(frame) },
      { sessionManager: { getEntries: () => entries } },
      (frame) => buffered.push(frame),
    );

    const { messages, refs, sink } = makeReducerHarness();
    for (const raw of buffered) {
      applyTranscriptEvent(JSON.parse(raw), refs, sink);
    }

    const cmCall = messages.find((m) => m.className === "tool-call" && m.meta?.callId === "call-cm");
    const cmResult = messages.find((m) => m.className === "tool-result" && m.meta?.callId === "call-cm");
    const readCall = messages.find((m) => m.className === "tool-call" && m.meta?.callId === "call-read");
    const readResult = messages.find((m) => m.className === "tool-result" && m.meta?.callId === "call-read");
    const customMsg = messages.find((m) => m.role === "system");

    assert.equal(cmCall?.text, "return await tools.TaskList({});");
    assert.equal(cmResult?.text, "✓ Script completed\nOutput:\ntask-list-body\n[image: image/webp]");
    assert.equal(readCall?.text, "README.md (offset: 1, limit: 25)");
    assert.equal(readResult?.text, "✓ # Pi Config\n⚠️ Full output not saved: disk full");
    assert.equal(customMsg?.text, "Custom part 1\nCustom part 2");
    assert.equal(sent.some((f) => JSON.parse(f).type === "replay_complete"), true);
  });
});

let vite: ViteDevServer;
let createRoot: (container: Element) => Root;
let MessageItem: any;
let ToolGroup: any;
let CollapsibleMessage: any;

const rootInternals = (rootReact as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const pidashInternals = (pidashReact as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
for (const key of ["H", "A", "T"]) {
  Object.defineProperty(rootInternals, key, {
    configurable: true,
    get: () => pidashInternals[key],
    set: (value) => { pidashInternals[key] = value; },
  });
}

describe("MessageList universal Copy buttons (#1479)", () => {
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
    ({ MessageItem, ToolGroup, CollapsibleMessage } = await vite.ssrLoadModule("/src/components/MessageList.tsx"));
  });

  after(() => vite?.close());

  afterEach(async () => {
    while (mounted.length) await act(async () => mounted.pop()!.unmount());
    if (originalClipboard) {
      Object.defineProperty(globalThis.navigator, "clipboard", originalClipboard);
    }
  });

  it("collapses pretty-printed JSON call text into a readable one-line preview", () => {
    const pretty = JSON.stringify({ query: "pidash", limit: 5 }, null, 2);
    assert.equal(formatToolCallSummary(pretty), '{ "query": "pidash", "limit": 5 }');
  });

  it("renders a visible Copy output button on collapsed non-bash tool rows", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const call: ChatMessage = { id: "c1", role: "codemode" as any, text: "return 42;", className: "tool-call", meta: { callId: "k1" } };
    const result: ChatMessage = { id: "r1", role: "codemode" as any, text: "✓ Output:\n42", className: "tool-result", meta: { callId: "k1" } };

    await act(async () => root.render(createElement(ToolGroup, { call, result })));

    const copyBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Copy output");
    assert.equal(Boolean(copyBtn), true);
  });

  it("copies full call arguments from an expanded ToolGroup CALL section", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const copied: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: async (txt: string) => { copied.push(txt); } },
      configurable: true,
    });

    const fullCode = "const x = 1;\nreturn x + 1;";
    const call: ChatMessage = { id: "c2", role: "codemode" as any, text: fullCode, className: "tool-call", meta: { callId: "k2" } };
    const result: ChatMessage = { id: "r2", role: "codemode" as any, text: "✓ Output:\n2", className: "tool-result", meta: { callId: "k2" } };

    await act(async () => root.render(createElement(ToolGroup, { call, result, searchQuery: "return" })));

    const copyCallBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Copy call");
    assert.equal(Boolean(copyCallBtn), true);

    await act(async () => {
      copyCallBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.deepEqual(copied, [fullCode]);
  });

  it("copies stripped multi-part output from an expanded ToolGroup RESULT section", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const copied: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: async (txt: string) => { copied.push(txt); } },
      configurable: true,
    });

    const call: ChatMessage = { id: "c3", role: "write" as any, text: "foo.ts\n\nexport const x = 1;", className: "tool-call", meta: { callId: "k3" } };
    const result: ChatMessage = { id: "r3", role: "write" as any, text: "✓ Wrote foo.ts\n20 bytes", className: "tool-result", meta: { callId: "k3" } };

    await act(async () => root.render(createElement(ToolGroup, { call, result, searchQuery: "foo.ts" })));

    const copyOutBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Copy output");
    assert.equal(Boolean(copyOutBtn), true);

    await act(async () => {
      copyOutBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.deepEqual(copied, ["Wrote foo.ts\n20 bytes"]);
  });

  it("renders a visible Copy button on CollapsibleMessage for thinking blocks", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const copied: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: async (txt: string) => { copied.push(txt); } },
      configurable: true,
    });

    const msg: ChatMessage = { id: "t1", role: "thinking", text: "Deep reasoning step" };
    await act(async () => root.render(createElement(CollapsibleMessage, { msg })));

    const copyBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Copy content");
    assert.equal(Boolean(copyBtn), true);

    await act(async () => {
      copyBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.deepEqual(copied, ["Deep reasoning step"]);
  });

  it("renders a visible Copy button on CollapsibleMessage for system entries", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const msg: ChatMessage = { id: "s1", role: "system", text: "System notice body" };
    await act(async () => root.render(createElement(CollapsibleMessage, { msg })));

    const copyBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Copy content");
    assert.equal(Boolean(copyBtn), true);
  });

  it("renders streaming partialOutput on an expanded standalone tool-call without losing arguments", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const msg: ChatMessage = {
      id: "call-live",
      role: "bash" as any,
      text: "pytest -q",
      className: "tool-call",
      meta: { callId: "k-live", partialOutput: "collecting tests..." },
    };
    await act(async () => root.render(createElement(CollapsibleMessage, { msg, searchQuery: "pytest" })));

    const text = container.textContent ?? "";
    assert.equal(text.includes("pytest -q"), true);
    assert.equal(text.includes("collecting tests..."), true);
    const copyCallBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Copy call");
    const copyProgressBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Copy output");
    assert.equal(Boolean(copyCallBtn), true);
    assert.equal(Boolean(copyProgressBtn), true);
  });

  it("renders a visible Copy message button on user MessageItem cards", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const copied: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: async (txt: string) => { copied.push(txt); } },
      configurable: true,
    });

    const msg: ChatMessage = { id: "u1", role: "user", text: "Fix hidden tool output" };
    await act(async () => root.render(createElement(MessageItem, { msg })));

    const copyBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Copy message");
    assert.equal(Boolean(copyBtn), true);

    await act(async () => {
      copyBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.deepEqual(copied, ["Fix hidden tool output"]);
  });

  it("renders a visible Copy message button on assistant MessageItem cards", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const msg: ChatMessage = { id: "a1", role: "assistant", text: "Implemented all fixes." };
    await act(async () => root.render(createElement(MessageItem, { msg })));

    const copyBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Copy message");
    assert.equal(Boolean(copyBtn), true);
  });
});
