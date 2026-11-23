/**
 * Bounded auto-recovery for malformed provider stop reasons (issue #1333).
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  detectMalformedStopReason,
  registerMalformedResponseRecovery,
} from "../../../extensions/orchestrator/malformed-response-recovery.js";
import {
  SESSION_BRIDGE_SYMBOL,
  onMalformedRecoveryAborted,
  resetSessionBridge,
  shouldDeferForMalformedRecovery,
} from "../../../extensions/shared/session-bridge.js";
import { SYSTEM_NOTE_MARKER } from "../../../extensions/shared/system-note.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";

afterEach(() => {
  resetSessionBridge();
});

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

function makeLiveCtx(hasUI = true, sessionId?: string) {
  const notifications: Array<{ text: string; level: string }> = [];
  const ctx = {
    mode: "interactive",
    hasUI,
    ...(sessionId !== undefined
      ? {
          sessionManager: {
            getSessionId: () => sessionId,
          },
        }
      : {}),
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

  it("restores retry budget when sendSystemNote rejects", async () => {
    let attempts = 0;
    let succeeded = 0;
    const { emit } = createHarness({
      maxRetries: 2,
      sendMessageImpl: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient transport failure");
        succeeded += 1;
      },
    });
    const { ctx } = makeLiveCtx(false);

    const failedMsg = malformedAssistant();
    await emit("agent_end", { messages: [failedMsg] }, ctx);
    // Duplicate delivery of the same failed message object must still be ignored.
    await emit("agent_end", { messages: [failedMsg] }, ctx);
    // Subsequent malformed turns still receive the full maxRetries=2 successful sends.
    await emit("agent_end", { messages: [malformedAssistant()] }, ctx);
    await emit("agent_end", { messages: [malformedAssistant()] }, ctx);
    // A 3rd subsequent malformed turn is blocked because 2 retries succeeded.
    await emit("agent_end", { messages: [malformedAssistant()] }, ctx);

    assert.equal(attempts, 3);
    assert.equal(succeeded, 2);
  });

  it("ignores late sendSystemNote rejection after an intervening retry reset", async () => {
    let rejectFirst!: (err: Error) => void;
    let callCount = 0;
    const { emit, sentMessages } = createHarness({
      maxRetries: 1,
      sendMessageImpl: async () => {
        callCount += 1;
        if (callCount === 1) {
          await new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          });
        }
      },
    });
    const { ctx } = makeLiveCtx(false);

    const firstEmit = emit("agent_end", { messages: [malformedAssistant()] }, ctx);
    await emit("input", { source: "interactive", text: "reset budget" }, ctx);
    rejectFirst(new Error("late failure"));
    await firstEmit;

    await emit("agent_end", { messages: [malformedAssistant()] }, ctx);
    await emit("agent_end", { messages: [malformedAssistant()] }, ctx);

    // 1st failed call + 1 allowed call after reset; 3rd call must be blocked (budget did not go below 0).
    assert.equal(sentMessages.length, 2);
  });

  it("defers via shouldDeferForMalformedRecovery before orchestrator handles agent_end", () => {
    createHarness({ maxRetries: 1 });

    assert.equal(shouldDeferForMalformedRecovery([malformedAssistant()]), true);
    assert.equal(
      shouldDeferForMalformedRecovery([{ role: "assistant", stopReason: "stop" }]),
      false,
    );
  });

  it("defers via shouldDeferForMalformedRecovery after orchestrator handles agent_end", async () => {
    const { emit } = createHarness({ maxRetries: 1 });
    const { ctx } = makeLiveCtx(false);
    const msg = malformedAssistant();

    await emit("agent_end", { messages: [msg] }, ctx);

    assert.equal(shouldDeferForMalformedRecovery([msg]), true);
    assert.equal(shouldDeferForMalformedRecovery([malformedAssistant()]), false);
  });

  it("clears recovery deferral after session_shutdown", async () => {
    const { emit } = createHarness({ maxRetries: 1 });
    const { ctx } = makeLiveCtx(false);
    const msg = malformedAssistant();
    let abortedCount = 0;
    const unsub = onMalformedRecoveryAborted(() => {
      abortedCount += 1;
    });

    try {
      await emit("agent_end", { messages: [msg] }, ctx);
      assert.equal(shouldDeferForMalformedRecovery([msg]), true);

      await emit("session_shutdown", {}, ctx);
      assert.equal(shouldDeferForMalformedRecovery([msg]), false);
      assert.equal(abortedCount, 1);
    } finally {
      unsub();
    }
  });

  it("tracks retry deferral independently across concurrent sessions", async () => {
    const sessionA = createHarness({ maxRetries: 1 });
    const sessionB = createHarness({ maxRetries: 1 });
    const { ctx: ctxA } = makeLiveCtx(false, "sess-a");
    const { ctx: ctxB } = makeLiveCtx(false, "sess-b");

    await sessionA.emit("session_start", { reason: "new" }, ctxA);
    await sessionB.emit("session_start", { reason: "new" }, ctxB);

    await sessionA.emit("agent_end", { messages: [malformedAssistant()] }, ctxA);

    assert.equal(shouldDeferForMalformedRecovery([malformedAssistant()], "sess-a"), false);
    assert.equal(shouldDeferForMalformedRecovery([malformedAssistant()], "sess-b"), true);
  });

  it("preserves concurrent session recovery state after another session shuts down", async () => {
    const sessionA = createHarness({ maxRetries: 1 });
    const sessionB = createHarness({ maxRetries: 1 });
    const { ctx: ctxA } = makeLiveCtx(false, "sess-a");
    const { ctx: ctxB } = makeLiveCtx(false, "sess-b");
    const pendingB = malformedAssistant();

    await sessionA.emit("session_start", { reason: "new" }, ctxA);
    await sessionB.emit("session_start", { reason: "new" }, ctxB);
    await sessionB.emit("agent_end", { messages: [pendingB] }, ctxB);

    await sessionA.emit("session_shutdown", {}, ctxA);

    assert.equal(shouldDeferForMalformedRecovery([pendingB], "sess-b"), true);
    assert.equal(shouldDeferForMalformedRecovery(undefined, "sess-b"), true);
    assert.equal(shouldDeferForMalformedRecovery([malformedAssistant()], "sess-a"), false);
  });

  it("scopes abort notifications to the aborted session", async () => {
    const sessionA = createHarness({ maxRetries: 1 });
    const sessionB = createHarness({ maxRetries: 1 });
    const { ctx: ctxA } = makeLiveCtx(false, "sess-a");
    const { ctx: ctxB } = makeLiveCtx(false, "sess-b");

    await sessionA.emit("session_start", { reason: "new" }, ctxA);
    await sessionB.emit("session_start", { reason: "new" }, ctxB);

    let abortedA = 0;
    let abortedB = 0;
    const unsubA = onMalformedRecoveryAborted(() => {
      abortedA += 1;
    }, "sess-a");
    const unsubB = onMalformedRecoveryAborted(() => {
      abortedB += 1;
    }, "sess-b");

    try {
      await sessionA.emit("agent_end", { messages: [malformedAssistant()] }, ctxA);
      await sessionB.emit("agent_end", { messages: [malformedAssistant()] }, ctxB);

      await sessionA.emit("session_shutdown", {}, ctxA);

      assert.equal(abortedA, 1);
      assert.equal(abortedB, 0);
    } finally {
      unsubA();
      unsubB();
    }
  });

  it("prunes empty session slots from the bridge after cleanup", async () => {
    const sessionA = createHarness({ maxRetries: 1 });
    const { ctx: ctxA } = makeLiveCtx(false, "sess-prune");
    const unsub = onMalformedRecoveryAborted(() => {}, "sess-prune");

    await sessionA.emit("session_start", { reason: "new" }, ctxA);
    const bridgeMap = (globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL] as
      | Map<string, unknown>
      | undefined;
    assert.equal(bridgeMap?.has("sess-prune"), true);

    await sessionA.emit("session_shutdown", {}, ctxA);
    assert.equal(bridgeMap?.has("sess-prune"), true);

    unsub();
    assert.equal(bridgeMap?.has("sess-prune"), false);
    assert.equal((globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL], undefined);
  });
});
