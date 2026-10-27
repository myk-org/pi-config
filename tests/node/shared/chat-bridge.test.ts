/**
 * The chat engine driven by a NON-Discord adapter.
 *
 * This is the point of `extensions/shared/chat/`: a Signal or Telegram client
 * implements `ChatAdapter` and inherits streaming, echo suppression, prompt
 * lifecycle and answer mapping. The in-memory adapter below is that proof — if
 * it works here, the platform-specific code is only transport.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createChatBridge, initialChatRuntime, type ChatRuntimeState } from "../../../extensions/shared/chat/chat-bridge.ts";
import type { ChatAdapter, ChatTarget } from "../../../extensions/shared/chat/chat-types.ts";
import { DEFAULT_CAPABILITIES } from "../../../extensions/shared/chat/chat-types.ts";
import { createLogger } from "../../../extensions/shared/logger.ts";

const log = createLogger("chat-bridge-test");

interface Sent {
  target: ChatTarget;
  text: string;
  id: string;
}

function memoryAdapter(overrides: Partial<typeof DEFAULT_CAPABILITIES> = {}) {
  const sent: Sent[] = [];
  const edits: Array<{ id: string; text: string }> = [];
  const typing: boolean[] = [];
  let nextId = 1;
  const adapter: ChatAdapter = {
    platform: "memory",
    capabilities: { ...DEFAULT_CAPABILITIES, ...overrides },
    log,
    async sendText(target, text) {
      const id = `m${nextId++}`;
      sent.push({ target, text, id });
      return id;
    },
    async editText(_target, messageId, text) {
      edits.push({ id: messageId, text });
      return true;
    },
    async setTyping(_target, active) {
      typing.push(active);
    },
  };
  return { adapter, sent, edits, typing };
}

function setup(overrides: Partial<typeof DEFAULT_CAPABILITIES> = {}) {
  const mem = memoryAdapter(overrides);
  const states = new Map<string, ChatRuntimeState>();
  const state = initialChatRuntime("s1", { channelId: "chan" });
  states.set("user1", state);
  const sessionPayloads: Array<Record<string, unknown>> = [];
  const bridge = createChatBridge({
    adapter: mem.adapter,
    users: () => states.entries(),
    sendToSession: (sessionId, payload) => {
      sessionPayloads.push({ sessionId, ...payload });
      return true;
    },
    streamEditIntervalMs: 0,
  });
  return { ...mem, bridge, state, sessionPayloads, states };
}

describe("chat engine with a non-Discord adapter", () => {
  it("starts typing when a turn begins", () => {
    const { bridge, typing } = setup();
    bridge.onPiEvent("s1", { type: "agent_start" });
    assert.deepEqual(typing, [true]);
  });

  it("streams a turn into ONE live message", async () => {
    const { bridge, sent } = setup();
    bridge.onPiEvent("s1", { type: "agent_start" });
    bridge.onPiEvent("s1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hel" } });
    bridge.onPiEvent("s1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent.length, 1, "only the live message is posted while streaming");
  });

  it("finalises the live message with the full text and clears the stream id", async () => {
    const { bridge, edits, state } = setup();
    bridge.onPiEvent("s1", { type: "agent_start" });
    bridge.onPiEvent("s1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } });
    bridge.onPiEvent("s1", { type: "message_end", message: { role: "assistant" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(edits.at(-1)?.text, "Hello");
    assert.equal(state.render.streamMessageId, null);
  });

  it("publishes a long reply without losing its beginning", async () => {
    const { bridge, sent, edits, state } = setup({ maxMessageLength: 120 });
    bridge.onPiEvent("s1", { type: "agent_start" });
    bridge.onPiEvent("s1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "START " } });
    bridge.onPiEvent("s1", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: `${"z".repeat(400)} END` },
    });
    bridge.onPiEvent("s1", { type: "message_end", message: { role: "assistant" } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const finalText = edits.at(-1)?.text ?? "";
    const tail = sent.slice(1).map((entry) => entry.text).join("");
    assert.ok(finalText.startsWith("START"), `beginning kept, got: ${finalText.slice(0, 20)}`);
    assert.ok(`${finalText}${tail}`.includes("END"), "end kept");
    assert.ok(sent.every((entry) => entry.text.length <= 120), "chunks respect the adapter limit");
  });

  it("suppresses the echo of a forwarded prompt per watcher", async () => {
    const { bridge, state, sent } = setup();
    bridge.expectEcho(state, "s1", "run the tests");
    bridge.onPiEvent("s1", { type: "message_start", message: { role: "user", content: [{ type: "text", text: "run the tests" }] } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent.filter((entry) => entry.text.includes("USER:")).length, 0);
  });

  it("shows prompts, answers them with the confirmed flag, and expires them", () => {
    const { bridge, state, sessionPayloads } = setup();
    const prompt = bridge.askUser("s1", { id: "q1", method: "confirm", title: "Run rm -rf?" }, state);
    assert.ok(prompt);
    assert.equal(state.pendingPrompt?.id, "q1");

    const replies: string[] = [];
    assert.equal(bridge.handleInbound(state, "yes", (text) => replies.push(text)), "answered");
    assert.deepEqual(sessionPayloads.at(-1), {
      sessionId: "s1", type: "extension_ui_response", id: "q1", confirmed: true,
    });
    assert.equal(state.pendingPrompt, null);
    assert.deepEqual(replies, ["Answer sent."]);
  });

  it("clears a prompt dismissed in another surface", () => {
    const { bridge, state } = setup();
    bridge.askUser("s1", { id: "q2", method: "select", options: ["A", "B"], title: "Pick" }, state);
    assert.ok(state.pendingPrompt);
    bridge.onUiEvent("s1", { type: "ui-dismiss", id: "q2" });
    assert.equal(state.pendingPrompt, null, "a prompt answered in the TUI must not linger");
  });

  it("reports a non-answer instead of consuming the message", () => {
    const { bridge, state } = setup();
    bridge.askUser("s1", { id: "q3", method: "confirm", title: "Approve?" }, state);
    assert.equal(bridge.handleInbound(state, "deploy the other branch", () => {}), "not-an-answer");
    assert.equal(state.pendingPrompt?.id, "q3", "prompt stays answerable");
  });

  it("adapts to a client with no edit or typing support", async () => {
    const { bridge, sent, edits, typing, state } = setup({ supportsEdit: false, supportsTyping: false, maxMessageLength: 60 });
    bridge.onPiEvent("s1", { type: "agent_start" });
    bridge.onPiEvent("s1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x".repeat(200) } });
    bridge.onPiEvent("s1", { type: "message_end", message: { role: "assistant" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(edits.length, 0, "no edits without support");
    assert.deepEqual(typing, [], "no typing without support");
    assert.ok(sent.length >= 4, "published in chunks instead");
    assert.ok(sent.every((entry) => entry.text.length <= 60));
    assert.equal(state.render.streamMessageId, null);
  });
});

describe("chat engine regressions found in review (R2)", () => {
  it("a prompt-end for one session leaves another user's prompt alone", () => {
    const mem = memoryAdapter();
    const states = new Map<string, ChatRuntimeState>();
    const a = initialChatRuntime("s1", { channelId: "c1" });
    const b = initialChatRuntime("s2", { channelId: "c2" });
    states.set("u1", a);
    states.set("u2", b);
    const bridge = createChatBridge({
      adapter: mem.adapter, users: () => states.entries(), sendToSession: () => true,
    });
    bridge.askUser("s1", { id: "q1", method: "confirm", title: "A?" }, a);
    bridge.askUser("s2", { id: "q2", method: "confirm", title: "B?" }, b);

    bridge.onUiEvent("s1", { type: "ui_prompt_end" });
    assert.equal(a.pendingPrompt, null, "the ended session's prompt is cleared");
    assert.equal(b.pendingPrompt?.id, "q2", "the other session's prompt survives");
  });

  it("drops a stream edit that lands after the final reply was published", async () => {
    const mem = memoryAdapter();
    const state = initialChatRuntime("s1", { channelId: "c" });
    const states = new Map([["u", state]]);
    const bridge = createChatBridge({
      adapter: mem.adapter, users: () => states.entries(), sendToSession: () => true, streamEditIntervalMs: 0,
    });
    bridge.onPiEvent("s1", { type: "agent_start" });
    bridge.onPiEvent("s1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "first" } });
    bridge.onPiEvent("s1", { type: "message_end", message: { role: "assistant" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const finalEdit = mem.edits.at(-1)?.text;
    assert.equal(finalEdit, "first");
    // a stale delta arriving after the turn must not edit the finished message
    const generation = state.renderGeneration;
    bridge.onPiEvent("s1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "late" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(state.renderGeneration, generation, "no new generation without a new turn");
  });
});

describe("multiple sessions per user (Qodo 721fc807 / 1eec9a4d)", () => {
  function twoSessions() {
    const mem = memoryAdapter();
    const state = initialChatRuntime("a", { channelId: "thread-a", threadId: "thread-a" });
    state.targets = { a: { channelId: "thread-a", threadId: "thread-a" }, b: { channelId: "thread-b", threadId: "thread-b" } };
    const states = new Map([["u", state]]);
    const sent: Array<{ channelId: string; text: string }> = [];
    const adapter = { ...mem.adapter, async sendText(target: ChatTarget, text: string) { sent.push({ channelId: target.channelId, text }); return "m"; } };
    const payloads: Array<Record<string, unknown>> = [];
    const bridge = createChatBridge({
      adapter, users: () => states.entries(), sendToSession: (id, payload) => { payloads.push({ sessionId: id, ...payload }); return true; },
    });
    return { bridge, state, sent, payloads, states, mem };
  }

  it("posts a session's output into ITS thread even while another is watched", async () => {
    const { bridge, sent } = twoSessions();
    bridge.onPiEvent("b", { type: "message_start", message: { role: "user", content: [{ type: "text", text: "from thread b" }] } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent.at(-1)?.channelId, "thread-b", "reply follows the session, not the watch");
  });

  it("keeps one pending prompt per session", () => {
    const { bridge, state, payloads } = twoSessions();
    bridge.askUser("a", { id: "qa", method: "confirm", title: "A?" }, state);
    bridge.askUser("b", { id: "qb", method: "confirm", title: "B?" }, state);
    assert.deepEqual(Object.keys(state.pendingPrompts ?? {}).sort(), ["a", "b"]);

    // cancelling for session a must not touch b's prompt
    bridge.answer(state, "/cancel", () => {}, "a");
    assert.equal(state.pendingPrompts?.b?.id, "qb");
    assert.equal(state.pendingPrompts?.a, undefined);
    assert.deepEqual(payloads.at(-1), { sessionId: "a", type: "extension_ui_response", id: "qa", cancelled: true });
  });

  it("expires a prompt without clearing the other session's", () => {
    const { bridge, state } = twoSessions();
    const stale = { id: "old", sessionId: "b", method: "confirm" as const, options: ["Yes", "No"], createdAt: Date.now() - 11 * 60 * 1000 };
    state.pendingPrompts = { b: stale };
    state.pendingPrompt = stale;
    bridge.askUser("a", { id: "fresh", method: "confirm", title: "A?" }, state);
    assert.equal(bridge.handleInbound(state, "yes", () => {}, "b"), "expired");
    assert.equal(state.pendingPrompts?.b, undefined);
    assert.equal(state.pendingPrompts?.a?.id, "fresh", "the other session keeps its question");
  });
});

describe("concurrent sessions do not merge streams (Qodo be90d322)", () => {
  it("keeps a separate streaming buffer and message per session", async () => {
    const mem = memoryAdapter();
    const state = initialChatRuntime("a", { channelId: "thread-a", threadId: "thread-a" });
    state.targets = { a: { channelId: "thread-a", threadId: "thread-a" }, b: { channelId: "thread-b", threadId: "thread-b" } };
    const sent: Array<{ channelId: string; text: string }> = [];
    const edits: Array<{ id: string; text: string }> = [];
    const adapter = {
      ...mem.adapter,
      async sendText(target: ChatTarget, text: string) { sent.push({ channelId: target.channelId, text }); return `m-${target.channelId}`; },
      async editText(_t: ChatTarget, id: string, text: string) { edits.push({ id, text }); return true; },
    };
    const bridge = createChatBridge({ adapter, users: () => new Map([["u", state]]).entries(), sendToSession: () => true, streamEditIntervalMs: 0 });

    // interleaved deltas from two sessions
    bridge.onPiEvent("a", { type: "agent_start" });
    bridge.onPiEvent("b", { type: "agent_start" });
    bridge.onPiEvent("a", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "AAA" } });
    bridge.onPiEvent("b", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "BBB" } });
    bridge.onPiEvent("a", { type: "message_end", message: { role: "assistant" } });
    bridge.onPiEvent("b", { type: "message_end", message: { role: "assistant" } });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const finalA = edits.find((edit) => edit.id === "m-thread-a")?.text;
    const finalB = edits.find((edit) => edit.id === "m-thread-b")?.text;
    assert.equal(finalA, "AAA", "session a keeps only its own text");
    assert.equal(finalB, "BBB", "session b keeps only its own text");
    assert.ok(sent.some((entry) => entry.channelId === "thread-a"));
    assert.ok(sent.some((entry) => entry.channelId === "thread-b"));
  });
});
