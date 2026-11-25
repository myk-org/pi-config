/**
 * Canonical server-side SessionViewState reducer, bounded trimming,
 * single-frame session_snapshot emission, and useMessageHandler hydration (#1398).
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { createRoot, type Root } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import { useMessageHandler } from "../../../extensions/pidash/pidash-ui/src/hooks/useMessageHandler.ts";
import type { ChatMessage, SessionInfo, TokenUsage } from "../../../extensions/pidash/pidash-ui/src/types.ts";
import {
  applyEventToViewState,
  buildSessionSnapshot,
  createPidashSessionState,
  processPiPendingUiEvent,
  recordPendingUiRequest,
  resetSessionViewState,
  sendSessionSnapshot,
} from "../../../scripts/pidash-session-state.ts";
import { installReactDomShim } from "./react-dom-shim.mjs";

const mounted: Root[] = [];
afterEach(async () => {
  while (mounted.length) await act(async () => mounted.pop()!.unmount());
});

const notifications = {
  permission: "denied" as NotificationPermission,
  supported: false,
  preferences: {
    turnComplete: false,
    agentComplete: false,
    testResults: false,
    sessionError: false,
    toolComplete: false,
    inputNeeded: false,
  },
  notify: () => {},
} as any;

function makeClient(overrides: Record<string, unknown> = {}) {
  const state = createPidashSessionState(() => {});
  const socket = { send: () => {} };
  const client = state.register(socket, {
    type: "register",
    pid: 101,
    sessionId: "101:/repo",
    cwd: "/repo",
    model: "claude-opus-4-6",
    activity: "idle",
    activitySequence: 1,
    streaming: false,
    ...overrides,
  });
  client.replaying = false;
  return { state, socket, client };
}

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "101:/repo",
    pid: 101,
    cwd: "/repo",
    branch: "main",
    model: "claude-opus-4-6",
    startedAt: "now",
    lastActivity: 0,
    active: true,
    ...overrides,
  };
}

async function mountHandler(session: SessionInfo = makeSession()) {
  const { container } = installReactDomShim();
  let emit: (ev: any) => void = () => {};
  let latest: {
    messages: ChatMessage[];
    model: string;
    tokens: TokenUsage | null;
    streaming: boolean;
    queuedCount: number;
    streamingBehavior: string | null;
    availableCommands: Array<{ name: string; description: string }>;
  } = {
    messages: [],
    model: "",
    tokens: null,
    streaming: false,
    queuedCount: 0,
    streamingBehavior: null,
    availableCommands: [],
  };
  let renderCount = 0;

  function Probe() {
    renderCount++;
    const state = useMessageHandler(
      (handler) => { emit = handler as any; return () => {}; },
      session,
      notifications,
      () => {},
    );
    latest = {
      messages: state.messages,
      model: state.model,
      tokens: state.tokens,
      streaming: state.streaming,
      queuedCount: state.queuedCount,
      streamingBehavior: state.streamingBehavior,
      availableCommands: state.availableCommands,
    };
    return null;
  }

  const root = createRoot(container);
  mounted.push(root);
  await act(async () => root.render(createElement(Probe)));
  return {
    emit: (ev: any) => emit(ev),
    state: () => latest,
    renders: () => renderCount,
  };
}

describe("SessionViewState server snapshot (#1398)", () => {
  it("folds full conversation history, tool metadata, commands, and status into one snapshot", () => {
    const { client } = makeClient();

    const events = [
      { type: "replay_start" },
      { type: "message_start", message: { role: "user", content: [{ type: "text", text: "Run tests" }] }, timestamp: 1000 },
      { type: "message_start", message: { role: "assistant" }, timestamp: 1001 },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Checking " }, timestamp: 1002 },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "suite" }, timestamp: 1003 },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Running " }, timestamp: 1004 },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "tests now." }, timestamp: 1005 },
      { type: "tool_execution_start", toolName: "subagent", toolCallId: "tc-sub", args: { agent: "test-runner", task: "Run pytest" }, timestamp: 1006 },
      {
        type: "tool_execution_end",
        toolName: "subagent",
        toolCallId: "tc-sub",
        isError: false,
        timestamp: 1010,
        result: {
          content: [{ type: "text", text: "all green" }],
          details: { results: [{ model: "sonnet", usage: { input: 100, output: 50, turns: 2, cacheRead: 10, contextTokens: 150, cost: 0.01 } }] },
        },
      },
      { type: "message_end", message: { role: "assistant", model: "gemini-4-neon", usage: { input: 300, output: 120 } }, timestamp: 1011 },
      { type: "message_start", message: { role: "custom", display: true, content: "Summary ready" }, timestamp: 1012 },
      { type: "coms_peer_event", content: "Peer ping", timestamp: 1013 },
      { type: "notification", message: "Heads up", timestamp: 1014 },
      { type: "commands-list", commands: [{ name: "status", description: "Show status" }] },
      { type: "replay_end" },
    ];
    for (const ev of events) applyEventToViewState(client, ev);

    const frames: string[] = [];
    const stats = sendSessionSnapshot({ send: (d) => frames.push(d) }, client);

    assert.equal(frames.length, 1);
    assert.deepEqual(stats, { messageCount: 8, pendingCount: 0 });
    const snap = JSON.parse(frames[0]);
    assert.equal(snap.type, "session_snapshot");
    assert.equal(snap.model, "gemini-4-neon");
    assert.deepEqual(snap.tokens, { input: 300, output: 120 });
    assert.deepEqual(snap.availableCommands, [{ name: "status", description: "Show status" }]);
    assert.deepEqual(
      snap.messages.map((m: ChatMessage) => [m.role, m.text, m.className ?? null]),
      [
        ["user", "Run tests", null],
        ["thinking", "Checking suite", null],
        ["assistant", "Running tests now.", null],
        ["subagent (test-runner)", "Run pytest", "tool-call"],
        ["subagent (test-runner)", "✓ all green", "tool-result"],
        ["system", "Summary ready", null],
        ["system", "Peer ping", null],
        ["system", "⚠️ Heads up", null],
      ],
    );
    assert.equal(snap.messages[4].meta.callId, "tc-sub");
    assert.equal(snap.messages[4].meta.turns, 2);
    assert.equal(snap.messages[4].meta.cost, 0.01);
  });

  it("trims bounded history at message boundaries without orphaned deltas or evicting active streams", () => {
    const { client } = makeClient();

    // Push 5 committed turns (10 messages), then start a live assistant + tool stream under maxMessages=4
    for (let i = 0; i < 5; i++) {
      applyEventToViewState(client, { type: "message_start", message: { role: "user", content: `prompt-${i}` } }, 4);
      applyEventToViewState(client, { type: "tool_execution_start", toolName: "bash", toolCallId: `c-${i}`, args: { command: `echo ${i}` } }, 4);
      applyEventToViewState(client, { type: "tool_execution_end", toolName: "bash", toolCallId: `c-${i}`, result: { content: [{ type: "text", text: `out-${i}` }] }, isError: false }, 4);
    }

    // Now start an active in-flight thinking + assistant + async agent stream
    applyEventToViewState(client, { type: "agent_start" }, 4);
    applyEventToViewState(client, { type: "message_start", message: { role: "assistant" } }, 4);
    applyEventToViewState(client, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "deep " } }, 4);
    applyEventToViewState(client, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "thought" } }, 4);
    applyEventToViewState(client, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial " } }, 4);
    applyEventToViewState(client, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "reply" } }, 4);
    applyEventToViewState(client, { type: "async_agent_start", id: "job-1", agent: "worker", cwd: "/repo", sessionId: client.session.sessionId }, 4);
    applyEventToViewState(client, { type: "async_agent_event", id: "job-1", sessionId: client.session.sessionId, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "working" } } }, 4);

    // Push extra committed system notifications that force trimming
    for (let i = 0; i < 4; i++) {
      applyEventToViewState(client, { type: "notification", message: `note-${i}` }, 4);
    }

    const snap = buildSessionSnapshot(client);
    assert.ok(snap.messages.length <= 4, `expected <=4 messages, got ${snap.messages.length}`);
    // No orphaned tool-result at index 0
    assert.notEqual(snap.messages[0]?.className, "tool-result");
    // All active in-flight messages survived trimming intact
    assert.ok(snap.messages.some((m) => m.id === snap.live.think.id && m.text === "deep thought"));
    assert.ok(snap.messages.some((m) => m.id === snap.live.assist.id && m.text === "partial reply" && m.className === "streaming"));
    assert.ok(snap.live.asyncMsgs["job-1"]);
    assert.ok(snap.messages.some((m) => m.id === snap.live.asyncMsgs["job-1"].msgId && m.text.includes("working")));
  });

  it("resets cleanly on replay_start and session_switch without cross-session leakage", () => {
    const { client } = makeClient({ model: "model-a" });
    applyEventToViewState(client, { type: "agent_start" });
    applyEventToViewState(client, { type: "prompt-queued" });
    applyEventToViewState(client, { type: "streaming-behavior", behavior: "steer" });
    applyEventToViewState(client, { type: "message_start", message: { role: "user", content: "session A msg" } });
    applyEventToViewState(client, { type: "message_end", message: { role: "assistant", model: "model-a", usage: { input: 50, output: 20 } } });

    // Simulate session_switch reset
    client.session.model = "model-b";
    client.session.streaming = false;
    resetSessionViewState(client);

    let snap = buildSessionSnapshot(client);
    assert.deepEqual(snap.messages, []);
    assert.equal(snap.model, "model-b");
    assert.equal(snap.tokens, null);
    assert.equal(snap.streaming, false);
    assert.equal(snap.queuedCount, 0);
    assert.equal(snap.streamingBehavior, null);

    // Populate then replay_start clears again
    applyEventToViewState(client, { type: "message_start", message: { role: "user", content: "before replay" } });
    applyEventToViewState(client, { type: "replay_start" });
    applyEventToViewState(client, { type: "message_start", message: { role: "user", content: "after replay" } });
    applyEventToViewState(client, { type: "replay_end" });

    snap = buildSessionSnapshot(client);
    assert.equal(snap.messages.length, 1);
    assert.equal(snap.messages[0].text, "after replay");
  });

  it("clears pending UI prompts and marks inline asks answered on disconnect", () => {
    const { state, socket, client } = makeClient();
    const req = { type: "extension_ui_request", id: "ask-dc", method: "confirm", title: "Proceed?" };
    processPiPendingUiEvent(client, req, JSON.stringify(req), () => {});

    let snap = buildSessionSnapshot(client);
    assert.equal(snap.pendingUiRequests.length, 1);
    assert.equal(snap.messages[0].className, "ask|ask-dc|confirm|Yes|||No");

    state.disconnect(client, socket, "close");

    snap = buildSessionSnapshot(client);
    assert.equal(snap.pendingUiRequests.length, 0);
    assert.equal(snap.streaming, false);
    assert.equal(snap.messages[0].className, "ask-answered|ask-dc");
  });

  it("ignores stale activitySequence transitions on viewState streaming flag", () => {
    const { client } = makeClient({ streaming: true, activitySequence: 5 });
    applyEventToViewState(client, { type: "agent_settled", activitySequence: 2 });
    assert.equal(buildSessionSnapshot(client).streaming, true);

    client.session.activitySequence = 6;
    applyEventToViewState(client, { type: "agent_settled", activitySequence: 6 });
    assert.equal(buildSessionSnapshot(client).streaming, false);
  });
});

describe("useMessageHandler session_snapshot hydration (#1398)", () => {
  it("hydrates full history, status, commands, and pending UI prompts in one atomic pass", async () => {
    const { client } = makeClient({ streaming: true });
    applyEventToViewState(client, { type: "agent_start" });
    applyEventToViewState(client, { type: "prompt-queued" });
    applyEventToViewState(client, { type: "streaming-behavior", behavior: "followUp" });
    applyEventToViewState(client, { type: "message_start", message: { role: "user", content: [{ type: "text", text: "Hello" }] } });
    applyEventToViewState(client, { type: "message_end", message: { role: "assistant", model: "claude-sonnet-4", usage: { input: 10, output: 20 } } });
    applyEventToViewState(client, { type: "commands-list", commands: [{ name: "help", description: "Help" }] });
    // Simulate a pending prompt whose inline message was trimmed out of messages[]
    const trimmedAsk = { type: "extension_ui_request", id: "ask-trimmed", method: "select", title: "Pick env", options: ["dev", "prod"] };
    recordPendingUiRequest(client, trimmedAsk, JSON.stringify(trimmedAsk));
    // Plus a live prompt present in BOTH messages[] and pendingUiRequests (must NOT duplicate)
    const inlineAsk = { type: "extension_ui_request", id: "ask-inline", method: "confirm", title: "Ship it?" };
    processPiPendingUiEvent(client, inlineAsk, JSON.stringify(inlineAsk), () => {});

    const snap = buildSessionSnapshot(client);
    const h = await mountHandler(makeSession());
    const rendersBefore = h.renders();

    await act(async () => {
      h.emit(snap);
    });

    assert.ok(h.renders() - rendersBefore <= 2, `expected <=2 renders for snapshot hydration, got ${h.renders() - rendersBefore}`);
    assert.equal(h.state().model, "claude-sonnet-4");
    assert.deepEqual(h.state().tokens, { input: 10, output: 20 });
    assert.equal(h.state().streaming, true);
    assert.equal(h.state().queuedCount, 1);
    assert.equal(h.state().streamingBehavior, "followUp");
    assert.deepEqual(h.state().availableCommands, [{ name: "help", description: "Help" }]);
    // User + inlineAsk + trimmedAsk (deduplicated: inlineAsk appears once, trimmedAsk materialized once)
    assert.equal(h.state().messages.length, 3);
    assert.equal(h.state().messages.filter((m) => m.className?.startsWith("ask|ask-inline|")).length, 1);
    assert.equal(h.state().messages.filter((m) => m.className?.startsWith("ask|ask-trimmed|")).length, 1);
  });

  it("continues live mid-stream thinking, assistant, tool, async agent, and ui-dismiss updates seamlessly after snapshot", async () => {
    const { client } = makeClient({ streaming: true });
    applyEventToViewState(client, { type: "agent_start" });
    applyEventToViewState(client, { type: "message_start", message: { role: "assistant" } });
    applyEventToViewState(client, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Part 1" }, timestamp: 100 });
    applyEventToViewState(client, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hel" }, timestamp: 105 });
    applyEventToViewState(client, { type: "tool_execution_start", toolName: "bash", toolCallId: "tc-live", args: { command: "echo hi" }, timestamp: 110 });
    applyEventToViewState(client, { type: "async_agent_start", id: "async-1", agent: "worker", cwd: "/repo", sessionId: client.session.sessionId });
    applyEventToViewState(client, { type: "async_agent_event", id: "async-1", sessionId: client.session.sessionId, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "step 1" } } });
    const req = { type: "extension_ui_request", id: "ask-mid", method: "input", title: "Token?" };
    processPiPendingUiEvent(client, req, JSON.stringify(req), () => {});

    const snap = buildSessionSnapshot(client);
    const h = await mountHandler(makeSession());

    await act(async () => {
      h.emit(snap);
    });

    // Now deliver live continuation events after reconnect
    await act(async () => {
      h.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo world" } });
      h.emit({ type: "message_end", message: { role: "assistant", model: "opus-4" } });
      h.emit({ type: "tool_execution_update", partialResult: { content: [{ type: "text", text: "running..." }] } });
      h.emit({ type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "hi" }] }, isError: false, timestamp: 150 });
      h.emit({ type: "async_agent_event", id: "async-1", sessionId: "101:/repo", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " + step 2" } } });
      h.emit({ type: "async_agent_complete", id: "async-1", sessionId: "101:/repo", success: true });
      h.emit({ type: "ui-dismiss", id: "ask-mid" });
      h.emit({ type: "agent_settled" });
    });

    const msgs = h.state().messages;
    const thinking = msgs.find((m) => m.role === "thinking");
    const assistant = msgs.find((m) => m.role === "assistant");
    const toolCall = msgs.find((m) => m.className === "tool-call");
    const toolResult = msgs.find((m) => m.className === "tool-result");
    const asyncCard = msgs.find((m) => m.className === "async-agent-done");
    const askCard = msgs.find((m) => m.className === "ask-answered|ask-mid");

    assert.equal(thinking?.text, "Part 1");
    assert.equal(assistant?.text, "Hello world");
    assert.equal(assistant?.className, undefined);
    assert.equal(toolCall?.text, "bash: running...");
    assert.equal(toolResult?.text, "✓ hi");
    assert.equal(toolResult?.meta?.callId, "tc-live");
    assert.equal(toolResult?.meta?.startTs, 110);
    assert.ok(asyncCard?.text.includes("step 1 + step 2"));
    assert.ok(asyncCard?.text.startsWith("✅"));
    assert.ok(askCard);
    assert.equal(h.state().streaming, false);
  });

  it("ignores a stale session_snapshot belonging to a different sessionId", async () => {
    const h = await mountHandler(makeSession({ sessionId: "session-current" }));

    await act(async () => {
      h.emit({
        type: "session_snapshot",
        sessionId: "session-other",
        messages: [{ id: "s-1", role: "user", text: "wrong session" }],
        live: {
          think: { id: "", text: "", startTs: 0 },
          assist: { id: "", text: "" },
          tool: { id: "", name: "", startTs: 0, callId: "" },
          asyncMsgs: {},
          lastUserText: "",
        },
        model: "wrong-model",
        tokens: null,
        streaming: true,
        queuedCount: 3,
        streamingBehavior: null,
        availableCommands: [],
        pendingUiRequests: [],
      });
    });

    assert.deepEqual(h.state().messages, []);
    assert.equal(h.state().streaming, false);
    assert.equal(h.state().queuedCount, 0);
  });
});
