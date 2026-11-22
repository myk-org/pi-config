/**
 * Bounded auto-recovery for malformed provider stop reasons (issue #1333).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  detectMalformedStopReason,
  registerMalformedResponseRecovery,
} from "../../../extensions/orchestrator/malformed-response-recovery.js";
import { SYSTEM_NOTE_MARKER } from "../../../extensions/shared/system-note.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";

type Handler = (...args: any[]) => any;

function createHarness(opts?: {
  maxRetries?: number;
  subagentChildEnv?: string | undefined;
  sendMessageImpl?: (message: any, options: any) => Promise<void> | void;
}) {
  const handlers = new Map<string, Handler[]>();
  const sentMessages: Array<{ message: any; options: any }> = [];

  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    async sendMessage(message: any, options: any) {
      sentMessages.push({ message, options });
      if (opts?.sendMessageImpl) {
        await opts.sendMessageImpl(message, options);
      }
    },
  } as any;

  withSubagentChildEnv(opts?.subagentChildEnv, () => {
    registerMalformedResponseRecovery(
      pi,
      opts?.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : undefined,
    );
  });

  async function emit(event: string, payload: any, ctx?: any): Promise<void> {
    for (const handler of handlers.get(event) ?? []) {
      await handler(payload, ctx);
    }
  }

  return { emit, sentMessages };
}

function makeLiveCtx(hasUI = true) {
  const notifications: Array<{ text: string; level: string }> = [];
  const ctx = {
    mode: "interactive",
    hasUI,
    ui: {
      notify(text: string, level: string) {
        notifications.push({ text, level });
      },
    },
  };
  return { ctx, notifications };
}

function makeStaleCtx() {
  const notifications: Array<{ text: string; level: string }> = [];
  const ctx = {
    hasUI: true,
    get mode(): string {
      throw new Error("Context is stale after session replacement or reload");
    },
    ui: {
      notify(text: string, level: string) {
        notifications.push({ text, level });
      },
    },
  };
  return { ctx, notifications };
}

function malformedAssistant(reason = "MALFORMED_RESPONSE") {
  return {
    role: "assistant",
    stopReason: "error",
    rawStopReason: reason,
    errorMessage: `Unhandled stop reason: ${reason}`,
  };
}

describe("detectMalformedStopReason", () => {
  it("detects rawStopReason MALFORMED_RESPONSE", () => {
    const reason = detectMalformedStopReason([
      { role: "user", content: "hello" },
      { role: "assistant", stopReason: "error", rawStopReason: "MALFORMED_RESPONSE" },
    ]);
    assert.equal(reason, "MALFORMED_RESPONSE");
  });

  it("normalizes lowercase padded rawStopReason", () => {
    const reason = detectMalformedStopReason([
      { role: "assistant", stopReason: "error", rawStopReason: "  malformed_response  " },
    ]);
    assert.equal(reason, "MALFORMED_RESPONSE");
  });

  it("detects MALFORMED_RESPONSE from errorMessage without rawStopReason", () => {
    const reason = detectMalformedStopReason([
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Unhandled stop reason: MALFORMED_RESPONSE",
      },
    ]);
    assert.equal(reason, "MALFORMED_RESPONSE");
  });

  it("detects MALFORMED_FUNCTION_CALL", () => {
    const reason = detectMalformedStopReason([
      { role: "assistant", stopReason: "error", rawStopReason: "MALFORMED_FUNCTION_CALL" },
    ]);
    assert.equal(reason, "MALFORMED_FUNCTION_CALL");
  });

  it("detects UNEXPECTED_TOOL_CALL", () => {
    const reason = detectMalformedStopReason([
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Provider failed with UNEXPECTED_TOOL_CALL",
      },
    ]);
    assert.equal(reason, "UNEXPECTED_TOOL_CALL");
  });

  it("ignores assistant message with stopReason aborted", () => {
    const reason = detectMalformedStopReason([
      {
        role: "assistant",
        stopReason: "aborted",
        rawStopReason: "MALFORMED_RESPONSE",
        errorMessage: "MALFORMED_RESPONSE",
      },
    ]);
    assert.equal(reason, null);
  });

  it("ignores assistant message with stopReason stop", () => {
    const reason = detectMalformedStopReason([
      {
        role: "assistant",
        stopReason: "stop",
        rawStopReason: "MALFORMED_RESPONSE",
        errorMessage: "MALFORMED_RESPONSE",
      },
    ]);
    assert.equal(reason, null);
  });

  it("ignores unrelated provider error message", () => {
    const reason = detectMalformedStopReason([
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "429 rate limit exceeded",
      },
    ]);
    assert.equal(reason, null);
  });

  it("stops scanning when a newer user message precedes the error", () => {
    const reason = detectMalformedStopReason([
      { role: "assistant", stopReason: "error", rawStopReason: "MALFORMED_RESPONSE" },
      { role: "user", content: "try something else" },
    ]);
    assert.equal(reason, null);
  });

  it("returns null for an empty message list", () => {
    assert.equal(detectMalformedStopReason([]), null);
  });

  it("returns null when messages is undefined", () => {
    assert.equal(detectMalformedStopReason(undefined), null);
  });
});

describe("registerMalformedResponseRecovery", () => {
  it("sends a hidden followUp system note on MALFORMED_RESPONSE", async () => {
    const { emit, sentMessages } = createHarness();
    const { ctx } = makeLiveCtx(false);

    await emit("agent_end", { messages: [malformedAssistant("MALFORMED_RESPONSE")] }, ctx);

    assert.equal(sentMessages.length, 1);
    const { message, options } = sentMessages[0];
    assert.equal(message.customType, "malformed-response-recovery");
    assert.equal(message.display, false);
    assert.ok(
      typeof message.content === "string" && message.content.startsWith(SYSTEM_NOTE_MARKER),
      "message must start with SYSTEM_NOTE_MARKER",
    );
    assert.match(message.content, /MALFORMED_RESPONSE/);
    assert.equal(options.triggerTurn, true);
    assert.equal(options.deliverAs, "followUp");
  });

  it("shows a warning toast when UI is attached", async () => {
    const { emit } = createHarness();
    const { ctx, notifications } = makeLiveCtx(true);

    await emit("agent_end", { messages: [malformedAssistant("MALFORMED_RESPONSE")] }, ctx);

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "warning");
    assert.match(notifications[0].text, /MALFORMED_RESPONSE/);
    assert.match(notifications[0].text, /\(1\/2\)/);
  });

  it("skips ui.notify when hasUI is false", async () => {
    const { emit, sentMessages } = createHarness();
    const { ctx, notifications } = makeLiveCtx(false);

    await emit("agent_end", { messages: [malformedAssistant("MALFORMED_RESPONSE")] }, ctx);

    assert.equal(notifications.length, 0);
    assert.equal(sentMessages.length, 1);
  });

  it("skips ui.notify when ctx is stale", async () => {
    const { emit, sentMessages } = createHarness();
    const { ctx, notifications } = makeStaleCtx();

    await emit("agent_end", { messages: [malformedAssistant("MALFORMED_RESPONSE")] }, ctx);

    assert.equal(notifications.length, 0);
    assert.equal(sentMessages.length, 1);
  });

  it("stops retrying after maxRetries consecutive malformed responses", async () => {
    const { emit, sentMessages } = createHarness({ maxRetries: 2 });
    const { ctx } = makeLiveCtx(false);

    await emit("agent_end", { messages: [malformedAssistant()] }, ctx);
    await emit("agent_end", { messages: [malformedAssistant()] }, ctx);
    await emit("agent_end", { messages: [malformedAssistant()] }, ctx);

    assert.equal(sentMessages.length, 2);
  });

  it("notifies exhaustion after maxRetries consecutive malformed responses", async () => {
    const { emit } = createHarness({ maxRetries: 2 });
    const { ctx, notifications } = makeLiveCtx(true);

    await emit("agent_end", { messages: [malformedAssistant()] }, ctx);
    await emit("agent_end", { messages: [malformedAssistant()] }, ctx);
    await emit("agent_end", { messages: [malformedAssistant()] }, ctx);

    assert.equal(notifications.length, 3);
    assert.equal(notifications[2].level, "warning");
    assert.match(notifications[2].text, /3 times — stopping auto-retry\./);
  });

  it("resets the retry counter after a normal assistant turn", async () => {
    const { emit, sentMessages } = createHarness({ maxRetries: 1 });
    const { ctx } = makeLiveCtx(false);

    await emit("agent_end", { messages: [malformedAssistant()] }, ctx);
    await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await emit("agent_end", { messages: [malformedAssistant()] }, ctx);

    assert.equal(sentMessages.length, 2);
  });

  it("resets the retry counter on a user input event", async () => {
    const { emit, sentMessages } = createHarness({ maxRetries: 1 });
    const { ctx } = makeLiveCtx(false);

    await emit("agent_end", { messages: [malformedAssistant()] }, ctx);
    await emit("input", { source: "interactive", text: "continue" }, ctx);
    await emit("agent_end", { messages: [malformedAssistant()] }, ctx);

    assert.equal(sentMessages.length, 2);
  });

  it("keeps the retry counter on an extension-sourced input event", async () => {
    const { emit, sentMessages } = createHarness({ maxRetries: 1 });
    const { ctx } = makeLiveCtx(false);

    await emit("agent_end", { messages: [malformedAssistant()] }, ctx);
    await emit("input", { source: "extension", text: "system note" }, ctx);
    await emit("agent_end", { messages: [malformedAssistant()] }, ctx);

    assert.equal(sentMessages.length, 1);
  });

  it("resets the retry counter on session_start", async () => {
    const { emit, sentMessages } = createHarness({ maxRetries: 1 });
    const { ctx } = makeLiveCtx(false);

    await emit("agent_end", { messages: [malformedAssistant()] }, ctx);
    await emit("session_start", { reason: "new" }, ctx);
    await emit("agent_end", { messages: [malformedAssistant()] }, ctx);

    assert.equal(sentMessages.length, 2);
  });

  it("skips retry after session_shutdown", async () => {
    const { emit, sentMessages } = createHarness();
    const { ctx } = makeLiveCtx(false);

    await emit("session_shutdown", {}, ctx);
    await emit("agent_end", { messages: [malformedAssistant()] }, ctx);

    assert.equal(sentMessages.length, 0);
  });

  it("ignores duplicate agent_end delivery for the same assistant message object", async () => {
    const { emit, sentMessages } = createHarness({ maxRetries: 2 });
    const { ctx } = makeLiveCtx(false);
    const sameMessage = malformedAssistant();

    await emit("agent_end", { messages: [sameMessage] }, ctx);
    await emit("agent_end", { messages: [sameMessage] }, ctx);

    assert.equal(sentMessages.length, 1);
  });

  it("swallows pi.sendMessage failures without rejecting agent_end", async () => {
    const { emit } = createHarness({
      sendMessageImpl: async () => {
        throw new Error("transport closed");
      },
    });
    const { ctx } = makeLiveCtx(false);

    await assert.doesNotReject(() =>
      emit("agent_end", { messages: [malformedAssistant()] }, ctx),
    );
  });

  it("recovers from MALFORMED_RESPONSE inside PI_SUBAGENT_CHILD=1", async () => {
    const { emit, sentMessages } = createHarness({ subagentChildEnv: "1" });
    const { ctx } = makeLiveCtx(false);

    await emit("agent_end", { messages: [malformedAssistant("MALFORMED_RESPONSE")] }, ctx);

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].message.customType, "malformed-response-recovery");
  });
});
