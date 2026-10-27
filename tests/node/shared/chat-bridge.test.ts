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
  it("streams into one edited message, then publishes the tail in chunks", async () => {
    const { bridge, sent, edits, state, typing } = setup();
    bridge.onPiEvent("s1", { type: "agent_start" });
    bridge.onPiEvent("s1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hel" } });
    bridge.onPiEvent("s1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } });
    bridge.onPiEvent("s1", { type: "message_end", message: { role: "assistant" } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(typing, [true], "typing started");
    assert.equal(sent.length, 1, "one live message while streaming");
    assert.equal(edits.at(-1)?.text, "Hello", "the live message is finalised by edit");
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
    state.render.expectedEcho = "run the tests";
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
