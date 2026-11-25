/**
 * Unit and HTTP-handler tests for optional `request_id` prompt deduplication (#1397).
 *
 * Drives `SessionStore` through `InMemoryProviderRuntime` and `createRequestHandler`
 * in-process via `invoke()` — no sockets, no temp dirs, no timers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_REQUEST_CACHE_BYTES,
  MAX_REQUEST_CACHE_ENTRIES,
  MAX_REQUEST_ID_LENGTH,
  SessionStore,
  isValidRequestId,
  type PromptResult,
} from "../../src/sessions.js";
import { createRequestHandler } from "../../src/request-handler.js";
import { logger } from "../../src/logger.js";
import { InMemoryProviderRuntime } from "./helpers/in-memory-runtime.js";
import { invoke } from "./helpers/invoke-handler.js";

type Emit = (event: unknown) => void;

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type PromptHandler = (
  message: string,
  emit: Emit,
  callIndex: number,
  sessionId: string,
) => Promise<void> | void;

type AbortHandler = (sessionId: string) => Promise<void> | void;

function emitStandardReply(emit: Emit, text: string, inputTokens = 10, outputTokens = 5): void {
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  emit({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
        usage: {
          input: inputTokens,
          output: outputTokens,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { total: 0.01 },
        },
        stopReason: "end_turn",
      },
    ],
  });
}

function createTestFixture(onPrompt?: PromptHandler, onAbort?: AbortHandler) {
  let promptCalls = 0;

  const runtime = new InMemoryProviderRuntime({
    ready: true,
    allowAnyModel: true,
    sessionFactory: ({ sessionId }) => {
      let emit: Emit = () => {};
      return {
        subscribe: (cb: Emit) => {
          emit = cb;
          return () => {
            emit = () => {};
          };
        },
        prompt: async (message: string) => {
          promptCalls += 1;
          const callIndex = promptCalls;
          if (onPrompt) {
            await onPrompt(message, emit, callIndex, sessionId);
          } else {
            emitStandardReply(emit, `reply-${callIndex}:${message}`);
          }
        },
        dispose: () => {},
        abort: async () => {
          if (onAbort) {
            await onAbort(sessionId);
          }
        },
      };
    },
  });

  const store = new SessionStore({ runtime });
  // Ensure recording stays disabled regardless of host environment (no filesystem I/O).
  store.setRecordingOverride(false);

  const handler = createRequestHandler({
    store,
    isDraining: () => false,
    getTrustBindHost: () => "127.0.0.1",
    beginRequest: () => {},
    endRequest: () => {},
  });

  const createSession = () =>
    store.create({
      provider: "test",
      model: "test",
      systemPrompt: "prompt-dedup test",
      cwd: "/tmp",
    });

  return {
    store,
    runtime,
    handler,
    createSession,
    getPromptCalls: () => promptCalls,
  };
}

function stubLogger(): {
  calls: { level: string; args: unknown[] }[];
  restore: () => void;
} {
  const orig = {
    debug: logger.debug,
    info: logger.info,
    warn: logger.warn,
    error: logger.error,
  };
  const calls: { level: string; args: unknown[] }[] = [];
  logger.debug = (...args: unknown[]) => {
    calls.push({ level: "debug", args });
  };
  logger.info = (...args: unknown[]) => {
    calls.push({ level: "info", args });
  };
  logger.warn = (...args: unknown[]) => {
    calls.push({ level: "warn", args });
  };
  logger.error = (...args: unknown[]) => {
    calls.push({ level: "error", args });
  };
  return {
    calls,
    restore: () => {
      logger.debug = orig.debug;
      logger.info = orig.info;
      logger.warn = orig.warn;
      logger.error = orig.error;
    },
  };
}

function findPromptDedupLog(
  calls: { level: string; args: unknown[] }[],
  level: string,
  pattern: RegExp,
): { level: string; args: unknown[] } | undefined {
  return calls.find(
    (c) =>
      c.level === level
      && c.args[0] === "[prompt-dedup]"
      && typeof c.args[1] === "string"
      && pattern.test(c.args[1]),
  );
}

describe("isValidRequestId (#1397)", () => {
  it("accepts non-empty strings from length 1 up to MAX_REQUEST_ID_LENGTH (256)", () => {
    assert.equal(MAX_REQUEST_ID_LENGTH, 256);
    assert.equal(isValidRequestId("a"), true);
    assert.equal(isValidRequestId("req-123_abc"), true);
    assert.equal(isValidRequestId("a".repeat(256)), true);
  });

  it("rejects empty, whitespace-only, overlong, and non-string values", () => {
    const invalidValues: unknown[] = [
      "",
      "   \t\n",
      "a".repeat(257),
      null,
      undefined,
      0,
      123,
      true,
      false,
      {},
      [],
    ];
    for (const value of invalidValues) {
      assert.equal(
        isValidRequestId(value),
        false,
        `expected isValidRequestId(${JSON.stringify(value)}) to be false`,
      );
    }
  });
});

describe("SessionStore prompt deduplication (#1397)", () => {
  it("preserves backward compatibility when request_id is omitted", async () => {
    const gate = createDeferred();
    const entered = createDeferred();
    let blockThird = false;

    const fixture = createTestFixture(async (message, emit, callIndex) => {
      if (blockThird && callIndex === 3) {
        entered.resolve();
        await gate.promise;
      }
      emitStandardReply(emit, `reply-${callIndex}:${message}`);
    });

    const id = await fixture.createSession();

    const first = await fixture.store.prompt(id, "hello");
    const second = await fixture.store.prompt(id, "hello");
    assert.equal(fixture.getPromptCalls(), 2);
    assert.equal(first.text, "reply-1:hello");
    assert.equal(second.text, "reply-2:hello");
    assert.equal(first.replayed, undefined);
    assert.equal(second.replayed, undefined);

    blockThird = true;
    const thirdPromise = fixture.store.prompt(id, "hello");
    await entered.promise;

    await assert.rejects(
      () => fixture.store.prompt(id, "hello"),
      (err: any) => err?.statusCode === 409 && /busy/i.test(String(err?.message)),
    );

    gate.resolve();
    const third = await thirdPromise;
    assert.equal(third.text, "reply-3:hello");
    assert.equal(third.replayed, undefined);
    assert.equal(fixture.getPromptCalls(), 3);
  });

  it("coalesces concurrent in-flight requests with the same request_id and message", async () => {
    const entered = createDeferred();
    const gate = createDeferred();

    const fixture = createTestFixture(async (message, emit, callIndex) => {
      entered.resolve();
      await gate.promise;
      emitStandardReply(emit, `reply-${callIndex}:${message}`, 42, 17);
    });

    const id = await fixture.createSession();

    const p1 = fixture.store.prompt(id, "hello", "req-1");
    await entered.promise;
    const p2 = fixture.store.prompt(id, "hello", "req-1");
    const p3 = fixture.store.prompt(id, "hello", "req-1");

    gate.resolve();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    assert.equal(fixture.getPromptCalls(), 1);
    assert.deepEqual(r1, r2);
    assert.deepEqual(r2, r3);
    assert.equal(r1.text, "reply-1:hello");
    assert.equal(r1.usage.input_tokens, 42);
    assert.equal(r1.usage.output_tokens, 17);
    assert.equal(r1.replayed, undefined);
    assert.equal(r2.replayed, undefined);
    assert.equal(r3.replayed, undefined);
  });

  it("returns cloned PromptResult copies so caller mutations do not affect cached replays", async () => {
    const fixture = createTestFixture(async (message, emit, callIndex) => {
      emitStandardReply(emit, `reply-${callIndex}:${message}`, 42, 17);
    });

    const id = await fixture.createSession();

    const initial = await fixture.store.prompt(id, "hello", "req-clone");
    initial.usage.input_tokens = 999_999;
    initial.usage.cost_usd = 123.45;

    const firstReplay = await fixture.store.prompt(id, "hello", "req-clone");
    assert.equal(fixture.getPromptCalls(), 1);
    assert.equal(firstReplay.usage.input_tokens, 42);
    assert.equal(firstReplay.usage.cost_usd, 0.01);

    firstReplay.usage.input_tokens = 888_888;
    firstReplay.usage.cost_usd = 99.99;

    const secondReplay = await fixture.store.prompt(id, "hello", "req-clone");
    assert.equal(fixture.getPromptCalls(), 1);
    assert.equal(secondReplay.usage.input_tokens, 42);
    assert.equal(secondReplay.usage.cost_usd, 0.01);
  });

  it("omits replayed on initial execution and sets replayed=true on completed cache replay", async () => {
    const fixture = createTestFixture();
    const id = await fixture.createSession();

    const first = await fixture.store.prompt(id, "hello", "req-replay-flag");
    assert.equal(first.replayed, undefined);
    assert.equal("replayed" in first, false);

    const replay = await fixture.store.prompt(id, "hello", "req-replay-flag");
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay, { ...first, replayed: true });
    assert.equal(fixture.getPromptCalls(), 1);
  });

  it("replays completed request_id immediately with 0 extra model calls, even while another turn is in-flight", async () => {
    const enteredSecond = createDeferred();
    const releaseSecond = createDeferred();

    const fixture = createTestFixture(async (message, emit, callIndex) => {
      if (callIndex === 2) {
        enteredSecond.resolve();
        await releaseSecond.promise;
      }
      emitStandardReply(emit, `reply-${callIndex}:${message}`);
    });

    const id = await fixture.createSession();

    const first = await fixture.store.prompt(id, "hello", "req-1");
    assert.equal(fixture.getPromptCalls(), 1);
    assert.equal(first.replayed, undefined);

    const replayIdle = await fixture.store.prompt(id, "hello", "req-1");
    assert.deepEqual(replayIdle, { ...first, replayed: true });
    assert.equal(fixture.getPromptCalls(), 1);

    // Start req-2 and keep it in-flight.
    const inFlightReq2 = fixture.store.prompt(id, "second", "req-2");
    await enteredSecond.promise;

    // Replaying req-1 must resolve immediately without waiting for req-2.
    const replayWhileBusy = await fixture.store.prompt(id, "hello", "req-1");
    assert.deepEqual(replayWhileBusy, { ...first, replayed: true });
    assert.equal(fixture.getPromptCalls(), 2);

    releaseSecond.resolve();
    const second = await inFlightReq2;
    assert.equal(second.text, "reply-2:second");
    assert.equal(fixture.getPromptCalls(), 2);
  });

  it("rejects mismatched message for an existing request_id with 409 while in-flight and after completion without overwriting or promoting LRU", async () => {
    const entered = createDeferred();
    const gate = createDeferred();

    const fixture = createTestFixture(async (message, emit, callIndex) => {
      if (callIndex === 1) {
        entered.resolve();
        await gate.promise;
      }
      emitStandardReply(emit, `reply-${callIndex}:${message}`);
    });

    const id = await fixture.createSession();

    // 1. Conflict while in-flight.
    const inFlight = fixture.store.prompt(id, "msg-0", "req-0");
    await entered.promise;

    await assert.rejects(
      () => fixture.store.prompt(id, "wrong-while-in-flight", "req-0"),
      (err: any) => err?.statusCode === 409 && /different message/i.test(String(err?.message)),
    );

    gate.resolve();
    const first = await inFlight;
    assert.equal(first.text, "reply-1:msg-0");
    assert.equal(fixture.getPromptCalls(), 1);

    // 2. Conflict after completion does not overwrite cached result.
    await assert.rejects(
      () => fixture.store.prompt(id, "wrong-after-complete", "req-0"),
      (err: any) => err?.statusCode === 409 && /different message/i.test(String(err?.message)),
    );

    const replay = await fixture.store.prompt(id, "msg-0", "req-0");
    assert.deepEqual(replay, { ...first, replayed: true });
    assert.equal(fixture.getPromptCalls(), 1);

    // 3. Conflict after completion does NOT promote LRU:
    // Fill remaining slots (req-1 .. req-63) so req-0 is the oldest (LRU) entry.
    for (let i = 1; i < MAX_REQUEST_CACHE_ENTRIES; i++) {
      await fixture.store.prompt(id, `msg-${i}`, `req-${i}`);
    }
    assert.equal(fixture.getPromptCalls(), MAX_REQUEST_CACHE_ENTRIES);

    // Conflicting call against req-0 must 409 and leave req-0 as LRU.
    await assert.rejects(
      () => fixture.store.prompt(id, "mismatch-no-promote", "req-0"),
      (err: any) => err?.statusCode === 409,
    );

    // Inserting req-64 must therefore evict req-0 (not req-1).
    await fixture.store.prompt(id, "msg-64", "req-64");
    assert.equal(fixture.getPromptCalls(), MAX_REQUEST_CACHE_ENTRIES + 1);

    // req-1 must still be cached (0 extra calls).
    await fixture.store.prompt(id, "msg-1", "req-1");
    assert.equal(fixture.getPromptCalls(), MAX_REQUEST_CACHE_ENTRIES + 1);

    // req-0 was evicted, so calling it again runs the model (+1 call).
    const reExecuted = await fixture.store.prompt(id, "msg-0", "req-0");
    assert.equal(fixture.getPromptCalls(), MAX_REQUEST_CACHE_ENTRIES + 2);
    assert.equal(reExecuted.text, `reply-${MAX_REQUEST_CACHE_ENTRIES + 2}:msg-0`);
  });

  it("rejects a different request_id while session is busy with 409 and does not pollute requestCache", async () => {
    const entered = createDeferred();
    const gate = createDeferred();

    const fixture = createTestFixture(async (message, emit, callIndex) => {
      if (callIndex === 1) {
        entered.resolve();
        await gate.promise;
      }
      emitStandardReply(emit, `reply-${callIndex}:${message}`);
    });

    const id = await fixture.createSession();

    const firstPromise = fixture.store.prompt(id, "first", "req-1");
    await entered.promise;

    await assert.rejects(
      () => fixture.store.prompt(id, "second", "req-2"),
      (err: any) => err?.statusCode === 409 && /busy/i.test(String(err?.message)),
    );
    await assert.rejects(
      () => fixture.store.prompt(id, "third-attempt-1", "req-3"),
      (err: any) => err?.statusCode === 409 && /busy/i.test(String(err?.message)),
    );

    gate.resolve();
    const first = await firstPromise;
    assert.equal(first.text, "reply-1:first");

    // req-2 was never cached, so it executes cleanly once the session is free.
    const second = await fixture.store.prompt(id, "second", "req-2");
    assert.equal(second.text, "reply-2:second");
    assert.equal(fixture.getPromptCalls(), 2);

    // req-3 was never cached either, so even a different message succeeds without 409 conflict.
    const third = await fixture.store.prompt(id, "third-attempt-2", "req-3");
    assert.equal(third.text, "reply-3:third-attempt-2");
    assert.equal(fixture.getPromptCalls(), 3);
  });

  it("evicts entry on rejected prompt so initial and coalesced callers reject and a retry succeeds and caches", async () => {
    const entered = createDeferred();
    const gate = createDeferred();

    const fixture = createTestFixture(async (message, emit, callIndex) => {
      if (callIndex === 1) {
        entered.resolve();
        await gate.promise;
        throw new Error("upstream boom");
      }
      emitStandardReply(emit, `reply-${callIndex}:${message}`);
    });

    const id = await fixture.createSession();

    const p1 = fixture.store.prompt(id, "retry-me", "req-fail");
    await entered.promise;
    const p2 = fixture.store.prompt(id, "retry-me", "req-fail");

    gate.resolve();

    await assert.rejects(
      () => p1,
      (err: any) => err?.statusCode === 500 && /upstream boom/.test(String(err?.message)),
    );
    await assert.rejects(
      () => p2,
      (err: any) => err?.statusCode === 500 && /upstream boom/.test(String(err?.message)),
    );
    assert.equal(fixture.getPromptCalls(), 1);

    // Retry with same request_id + message runs again, succeeds, and gets cached.
    const retried = await fixture.store.prompt(id, "retry-me", "req-fail");
    assert.equal(retried.text, "reply-2:retry-me");
    assert.equal(retried.replayed, undefined);
    assert.equal(fixture.getPromptCalls(), 2);

    const cached = await fixture.store.prompt(id, "retry-me", "req-fail");
    assert.deepEqual(cached, { ...retried, replayed: true });
    assert.equal(fixture.getPromptCalls(), 2);
  });

  it("evicts HTTP 200 turn returning SDK error so retry executes again and caches the clean result", async () => {
    const fixture = createTestFixture(async (message, emit, callIndex) => {
      if (callIndex === 1) {
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial output" } });
        emit({ type: "error", error: { message: "provider stream interrupted" } });
        emit({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "partial output" }],
              usage: { input: 8, output: 3, cost: { total: 0.002 } },
              stopReason: "error",
              errorMessage: "rate limit hit",
            },
          ],
        });
        return;
      }
      emitStandardReply(emit, `clean-${callIndex}:${message}`);
    });

    const id = await fixture.createSession();

    const first = await fixture.store.prompt(id, "go", "req-sdk-err");
    assert.equal(fixture.getPromptCalls(), 1);
    assert.equal(first.text, "partial output");
    assert.equal(first.stop_reason, "error");
    assert.ok(first.error && first.error.includes("provider stream interrupted"));
    assert.ok(first.error && first.error.includes("rate limit hit"));

    const retried = await fixture.store.prompt(id, "go", "req-sdk-err");
    assert.equal(fixture.getPromptCalls(), 2);
    assert.equal(retried.text, "clean-2:go");
    assert.equal(retried.error, undefined);
    assert.equal(retried.stop_reason, "end_turn");
    assert.equal(retried.replayed, undefined);

    const cached = await fixture.store.prompt(id, "go", "req-sdk-err");
    assert.equal(fixture.getPromptCalls(), 2);
    assert.deepEqual(cached, { ...retried, replayed: true });
  });

  it("evicts turn returning stop_reason error without error text so retry executes again", async () => {
    const fixture = createTestFixture(async (message, emit, callIndex) => {
      if (callIndex === 1) {
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "stopped" } });
        emit({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "stopped" }],
              usage: { input: 5, output: 2, cost: { total: 0.001 } },
              stopReason: "error",
            },
          ],
        });
        return;
      }
      emitStandardReply(emit, `recovered-${callIndex}:${message}`);
    });

    const id = await fixture.createSession();

    const first = await fixture.store.prompt(id, "retry-stop-error", "req-stop-err");
    assert.equal(fixture.getPromptCalls(), 1);
    assert.equal(first.stop_reason, "error");
    assert.equal(first.error, undefined);

    const retried = await fixture.store.prompt(id, "retry-stop-error", "req-stop-err");
    assert.equal(fixture.getPromptCalls(), 2);
    assert.equal(retried.text, "recovered-2:retry-stop-error");
    assert.equal(retried.stop_reason, "end_turn");
    assert.equal(retried.replayed, undefined);
  });

  it("evicts turn returning stop_reason aborted so retry executes again", async () => {
    const fixture = createTestFixture(async (message, emit, callIndex) => {
      if (callIndex === 1) {
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "cut short" } });
        emit({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "cut short" }],
              usage: { input: 5, output: 2, cost: { total: 0.001 } },
              stopReason: "aborted",
            },
          ],
        });
        return;
      }
      emitStandardReply(emit, `recovered-${callIndex}:${message}`);
    });

    const id = await fixture.createSession();

    const first = await fixture.store.prompt(id, "retry-aborted", "req-stop-abort");
    assert.equal(fixture.getPromptCalls(), 1);
    assert.equal(first.stop_reason, "aborted");

    const retried = await fixture.store.prompt(id, "retry-aborted", "req-stop-abort");
    assert.equal(fixture.getPromptCalls(), 2);
    assert.equal(retried.text, "recovered-2:retry-aborted");
    assert.equal(retried.stop_reason, "end_turn");
    assert.equal(retried.replayed, undefined);
  });

  it("evicts turn cancelled via store.abort() so retry executes again", async () => {
    const entered = createDeferred();
    const abortedGate = createDeferred();

    const fixture = createTestFixture(
      async (message, emit, callIndex) => {
        if (callIndex === 1) {
          emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } });
          entered.resolve();
          await abortedGate.promise;
          emit({
            type: "agent_end",
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "partial" }],
                usage: { input: 5, output: 2, cost: { total: 0.001 } },
                stopReason: "end_turn",
              },
            ],
          });
          return;
        }
        emitStandardReply(emit, `recovered-${callIndex}:${message}`);
      },
      async () => {
        abortedGate.resolve();
      },
    );

    const id = await fixture.createSession();

    const firstPromise = fixture.store.prompt(id, "cancel-me", "req-abort-call");
    await entered.promise;
    await fixture.store.abort(id);
    const first = await firstPromise;
    assert.equal(fixture.getPromptCalls(), 1);
    assert.equal(first.text, "partial");

    const retried = await fixture.store.prompt(id, "cancel-me", "req-abort-call");
    assert.equal(fixture.getPromptCalls(), 2);
    assert.equal(retried.text, "recovered-2:cancel-me");
    assert.equal(retried.replayed, undefined);
  });

  it("enforces bounded LRU eviction at MAX_REQUEST_CACHE_ENTRIES (64)", async () => {
    assert.equal(MAX_REQUEST_CACHE_ENTRIES, 64);

    const fixture = createTestFixture();
    const id = await fixture.createSession();

    // Fill 64 entries: req-0 .. req-63.
    const results: PromptResult[] = [];
    for (let i = 0; i < MAX_REQUEST_CACHE_ENTRIES; i++) {
      results.push(await fixture.store.prompt(id, `msg-${i}`, `req-${i}`));
    }
    assert.equal(fixture.getPromptCalls(), 64);

    // Hit req-0 to promote it to most-recently-used; req-1 becomes the LRU entry.
    const promoted = await fixture.store.prompt(id, "msg-0", "req-0");
    assert.deepEqual(promoted, { ...results[0], replayed: true });
    assert.equal(fixture.getPromptCalls(), 64);

    // Insert req-64 -> evicts req-1 (not req-0).
    const inserted = await fixture.store.prompt(id, "msg-64", "req-64");
    assert.equal(inserted.text, "reply-65:msg-64");
    assert.equal(fixture.getPromptCalls(), 65);

    // req-0 must still hit cache (0 new model calls).
    const hit0 = await fixture.store.prompt(id, "msg-0", "req-0");
    assert.deepEqual(hit0, { ...results[0], replayed: true });
    assert.equal(fixture.getPromptCalls(), 65);

    // req-1 must miss cache (1 new model call).
    const miss1 = await fixture.store.prompt(id, "msg-1", "req-1");
    assert.equal(fixture.getPromptCalls(), 66);
    assert.equal(miss1.text, "reply-66:msg-1");
    assert.equal(miss1.replayed, undefined);
  });

  it("evicts oldest completed entry when combined UTF-8 bytes exceed MAX_REQUEST_CACHE_BYTES", async () => {
    const chunkBytes = Math.floor(MAX_REQUEST_CACHE_BYTES * 0.4);
    const largeReply = "a".repeat(chunkBytes);

    const fixture = createTestFixture(async (message, emit, callIndex) => {
      emitStandardReply(emit, `${callIndex}:${message}:${largeReply}`);
    });

    const id = await fixture.createSession();

    const r1 = await fixture.store.prompt(id, "m1", "req-bytes-1");
    const r2 = await fixture.store.prompt(id, "m2", "req-bytes-2");
    const r3 = await fixture.store.prompt(id, "m3", "req-bytes-3");
    assert.equal(fixture.getPromptCalls(), 3);

    // Newer entries (req-bytes-2 and req-bytes-3) stay cached.
    const hit2 = await fixture.store.prompt(id, "m2", "req-bytes-2");
    const hit3 = await fixture.store.prompt(id, "m3", "req-bytes-3");
    assert.deepEqual(hit2, { ...r2, replayed: true });
    assert.deepEqual(hit3, { ...r3, replayed: true });
    assert.equal(fixture.getPromptCalls(), 3);

    // Oldest entry (req-bytes-1) was evicted to stay within MAX_REQUEST_CACHE_BYTES.
    const miss1 = await fixture.store.prompt(id, "m1", "req-bytes-1");
    assert.equal(fixture.getPromptCalls(), 4);
    assert.equal(miss1.replayed, undefined);
    assert.notEqual(miss1.text, r1.text);
  });

  it("coalesces in-flight retry of an oversized single entry but does not retain it after completion", async () => {
    const entered = createDeferred();
    const gate = createDeferred();
    const oversizedReply = "x".repeat(MAX_REQUEST_CACHE_BYTES + 1);

    const fixture = createTestFixture(async (_message, emit, callIndex) => {
      if (callIndex === 1) {
        entered.resolve();
        await gate.promise;
      }
      emitStandardReply(emit, `${callIndex}:${oversizedReply}`);
    });

    const id = await fixture.createSession();

    const p1 = fixture.store.prompt(id, "big", "req-oversized");
    await entered.promise;
    const p2 = fixture.store.prompt(id, "big", "req-oversized");

    gate.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(fixture.getPromptCalls(), 1);
    assert.equal(r1.text, `1:${oversizedReply}`);
    assert.deepEqual(r1, r2);
    assert.equal(r1.replayed, undefined);
    assert.equal(r2.replayed, undefined);

    // Completed oversized entry must NOT be retained; next call runs fresh.
    const fresh = await fixture.store.prompt(id, "big", "req-oversized");
    assert.equal(fixture.getPromptCalls(), 2);
    assert.equal(fresh.text, `2:${oversizedReply}`);
    assert.equal(fresh.replayed, undefined);
  });

  it("isolates request_id caches across distinct sessions", async () => {
    const fixture = createTestFixture();
    const sessionA = await fixture.createSession();
    const sessionB = await fixture.createSession();

    const resA = await fixture.store.prompt(sessionA, "from-A", "shared-req");
    const resB = await fixture.store.prompt(sessionB, "from-B", "shared-req");
    assert.equal(fixture.getPromptCalls(), 2);
    assert.equal(resA.text, "reply-1:from-A");
    assert.equal(resB.text, "reply-2:from-B");

    assert.deepEqual(await fixture.store.prompt(sessionA, "from-A", "shared-req"), { ...resA, replayed: true });
    assert.deepEqual(await fixture.store.prompt(sessionB, "from-B", "shared-req"), { ...resB, replayed: true });
    assert.equal(fixture.getPromptCalls(), 2);
  });

  it("clears cached entries when delete() removes an idle session", async () => {
    const fixture = createTestFixture();
    const sessionId = await fixture.createSession();

    const res = await fixture.store.prompt(sessionId, "hello", "req-idle-del");
    assert.equal(res.text, "reply-1:hello");

    assert.equal(fixture.store.delete(sessionId), true);
    assert.equal(fixture.store.count(), 0);
    await assert.rejects(() => fixture.store.prompt(sessionId, "hello", "req-idle-del"), /not found/);
  });

  it("removes idle sessions with cached entries on cleanupStale() while sparing in-flight sessions", async () => {
    const entered = createDeferred();
    const gate = createDeferred();

    const fixture = createTestFixture(async (message, emit, callIndex) => {
      if (callIndex === 2) {
        entered.resolve();
        await gate.promise;
      }
      emitStandardReply(emit, `reply-${callIndex}:${message}`);
    });

    const idleSession = await fixture.createSession();
    const activeSession = await fixture.createSession();

    await fixture.store.prompt(idleSession, "cached-idle", "req-idle");

    const inFlight = fixture.store.prompt(activeSession, "running", "req-active");
    await entered.promise;

    assert.equal(fixture.store.cleanupStale(-1), 1);
    assert.equal(fixture.store.count(), 1);
    await assert.rejects(() => fixture.store.prompt(idleSession, "cached-idle", "req-idle"), /not found/);

    gate.resolve();
    const activeResult = await inFlight;
    assert.equal(activeResult.text, "reply-2:running");

    const replayed = await fixture.store.prompt(activeSession, "running", "req-active");
    assert.deepEqual(replayed, { ...activeResult, replayed: true });
  });

  it("settles cleanly when delete() removes a session during an in-flight request_id turn that resolves", async () => {
    const entered = createDeferred();
    const gate = createDeferred();

    const fixture = createTestFixture(async (message, emit) => {
      entered.resolve();
      await gate.promise;
      emitStandardReply(emit, `done:${message}`);
    });

    const sessionId = await fixture.createSession();
    const inFlight = fixture.store.prompt(sessionId, "hi", "req-del-ok");
    await entered.promise;

    assert.equal(fixture.store.delete(sessionId), true);
    gate.resolve();

    const settled = await inFlight;
    assert.equal(settled.text, "done:hi");
    await assert.rejects(() => fixture.store.prompt(sessionId, "hi", "req-del-ok"), /not found/);
  });

  it("settles cleanly when delete() removes a session during an in-flight request_id turn that rejects", async () => {
    const entered = createDeferred();
    const gate = createDeferred();

    const fixture = createTestFixture(async () => {
      entered.resolve();
      await gate.promise;
      throw new Error("deleted mid-flight failure");
    });

    const sessionId = await fixture.createSession();
    const inFlight = fixture.store.prompt(sessionId, "hi", "req-del-err");
    await entered.promise;

    assert.equal(fixture.store.delete(sessionId), true);
    gate.resolve();

    await assert.rejects(() => inFlight, /deleted mid-flight failure/);
    await assert.rejects(() => fixture.store.prompt(sessionId, "hi", "req-del-err"), /not found/);
  });

  it("clears cached and in-flight sessions cleanly on disposeAll()", async () => {
    const entered = createDeferred();
    const gate = createDeferred();

    const fixture = createTestFixture(async (message, emit, callIndex) => {
      if (callIndex === 2) {
        entered.resolve();
        await gate.promise;
      }
      emitStandardReply(emit, `reply-${callIndex}:${message}`);
    });

    const cachedSession = await fixture.createSession();
    const runningSession = await fixture.createSession();
    await fixture.store.prompt(cachedSession, "cached", "req-cached");

    const inFlight = fixture.store.prompt(runningSession, "running", "req-running");
    await entered.promise;

    await fixture.store.disposeAll();
    assert.equal(fixture.store.count(), 0);
    await assert.rejects(
      () => fixture.store.prompt(cachedSession, "cached", "req-cached"),
      (err: any) => err?.statusCode === 503 && /shutting down/i.test(String(err?.message)),
    );

    gate.resolve();
    const disposedResult = await inFlight;
    assert.equal(disposedResult.text, "reply-2:running");
  });

  it("direct SessionStore.prompt() rejects invalid requestId with statusCode 400", async () => {
    const fixture = createTestFixture();
    const id = await fixture.createSession();

    const invalidIds: unknown[] = [
      "",
      "   \t\n",
      "a".repeat(MAX_REQUEST_ID_LENGTH + 1),
      123,
      null,
      {},
      [],
    ];

    for (const invalid of invalidIds) {
      await assert.rejects(
        () => fixture.store.prompt(id, "hello", invalid as string),
        (err: any) => err?.statusCode === 400,
        `expected statusCode 400 for requestId=${JSON.stringify(invalid)}`,
      );
    }
    assert.equal(fixture.getPromptCalls(), 0);
  });
});

describe("HTTP POST /sessions/:id/prompt deduplication (#1397)", () => {
  it("handles omitted request_id with 200 and omits replay signals", async () => {
    const fixture = createTestFixture();
    const id = await fixture.createSession();

    const res = await invoke(fixture.handler, {
      method: "POST",
      url: `/sessions/${id}/prompt`,
      headers: { "content-type": "application/json" },
      body: { message: "hello" },
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.text, "reply-1:hello");
    assert.equal(res.headers["x-request-id-replayed"], undefined);
    assert.equal(res.json.replayed, undefined);
    assert.equal(fixture.getPromptCalls(), 1);
  });

  it("rejects invalid request_id values with 400 and { error }", async () => {
    const fixture = createTestFixture();
    const id = await fixture.createSession();

    const invalidRequestIds: unknown[] = ["", "   ", 123, null, {}, "x".repeat(257)];
    for (const request_id of invalidRequestIds) {
      const res = await invoke(fixture.handler, {
        method: "POST",
        url: `/sessions/${id}/prompt`,
        headers: { "content-type": "application/json" },
        body: { message: "hello", request_id },
      });
      assert.equal(res.status, 400, `request_id=${JSON.stringify(request_id)} must 400`);
      assert.equal(typeof res.json?.error, "string");
      assert.ok(res.json.error.length > 0);
    }
    assert.equal(fixture.getPromptCalls(), 0);
  });

  it("rejects invalid body and non-string message with 400", async () => {
    const fixture = createTestFixture();
    const id = await fixture.createSession();

    const invalidBodies: Array<string | object> = [
      "null",
      "[]",
      { message: 123 },
      { message: "" },
      {},
    ];
    for (const body of invalidBodies) {
      const res = await invoke(fixture.handler, {
        method: "POST",
        url: `/sessions/${id}/prompt`,
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(res.status, 400, `body=${JSON.stringify(body)} must 400`);
      assert.equal(typeof res.json?.error, "string");
      assert.ok(res.json.error.length > 0);
    }
    assert.equal(fixture.getPromptCalls(), 0);
  });

  it("coalesces concurrent in-flight HTTP requests and omits replay signals", async () => {
    const entered = createDeferred();
    const gate = createDeferred();

    const fixture = createTestFixture(async (message, emit, callIndex) => {
      entered.resolve();
      await gate.promise;
      emitStandardReply(emit, `reply-${callIndex}:${message}`);
    });

    const id = await fixture.createSession();

    const p1 = invoke(fixture.handler, {
      method: "POST",
      url: `/sessions/${id}/prompt`,
      headers: { "content-type": "application/json" },
      body: { message: "hello", request_id: "http-coalesce-1" },
    });
    await entered.promise;

    let p2Settled = false;
    const p2 = invoke(fixture.handler, {
      method: "POST",
      url: `/sessions/${id}/prompt`,
      headers: { "content-type": "application/json" },
      body: { message: "hello", request_id: "http-coalesce-1" },
    }).then((result) => {
      p2Settled = true;
      return result;
    });

    // Let p2 finish reading its Readable body and join the in-flight promise.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(p2Settled, false, "second HTTP request must wait on in-flight turn");

    gate.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.deepEqual(r1.json, r2.json);
    assert.equal(r1.json.text, "reply-1:hello");
    assert.equal(r1.headers["x-request-id-replayed"], undefined);
    assert.equal(r2.headers["x-request-id-replayed"], undefined);
    assert.equal(r1.json.replayed, undefined);
    assert.equal(r2.json.replayed, undefined);
    assert.equal(fixture.getPromptCalls(), 1);
  });

  it("sets x-request-id-replayed header and replayed=true JSON field on completed cache replay", async () => {
    const fixture = createTestFixture();
    const id = await fixture.createSession();

    const initial = await invoke(fixture.handler, {
      method: "POST",
      url: `/sessions/${id}/prompt`,
      headers: { "content-type": "application/json" },
      body: { message: "hello", request_id: "http-replay-1" },
    });
    assert.equal(initial.status, 200);
    assert.equal(initial.headers["x-request-id-replayed"], undefined);
    assert.equal(initial.json.replayed, undefined);

    const replay = await invoke(fixture.handler, {
      method: "POST",
      url: `/sessions/${id}/prompt`,
      headers: { "content-type": "application/json" },
      body: { message: "hello", request_id: "http-replay-1" },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers["x-request-id-replayed"], "true");
    assert.equal(replay.json.replayed, true);
    assert.deepEqual(replay.json, { ...initial.json, replayed: true });
    assert.equal(fixture.getPromptCalls(), 1);
  });

  it("returns 409 when an existing request_id is reused with a different message", async () => {
    const fixture = createTestFixture();
    const id = await fixture.createSession();

    const initial = await invoke(fixture.handler, {
      method: "POST",
      url: `/sessions/${id}/prompt`,
      headers: { "content-type": "application/json" },
      body: { message: "hello", request_id: "http-conflict-1" },
    });
    assert.equal(initial.status, 200);

    const conflict = await invoke(fixture.handler, {
      method: "POST",
      url: `/sessions/${id}/prompt`,
      headers: { "content-type": "application/json" },
      body: { message: "different", request_id: "http-conflict-1" },
    });
    assert.equal(conflict.status, 409);
    assert.equal(typeof conflict.json?.error, "string");
    assert.match(conflict.json.error, /different message/i);
    assert.equal(fixture.getPromptCalls(), 1);
  });

  it("returns 500 on rejected turn and allows retry with the same request_id to succeed with 200", async () => {
    const fixture = createTestFixture(async (message, emit, callIndex) => {
      if (callIndex === 1) {
        throw new Error("transient model failure");
      }
      emitStandardReply(emit, `reply-${callIndex}:${message}`);
    });

    const id = await fixture.createSession();

    const failed = await invoke(fixture.handler, {
      method: "POST",
      url: `/sessions/${id}/prompt`,
      headers: { "content-type": "application/json" },
      body: { message: "please retry", request_id: "http-retry-1" },
    });
    assert.equal(failed.status, 500);
    assert.match(String(failed.json?.error), /transient model failure/);
    assert.equal(fixture.getPromptCalls(), 1);

    const retried = await invoke(fixture.handler, {
      method: "POST",
      url: `/sessions/${id}/prompt`,
      headers: { "content-type": "application/json" },
      body: { message: "please retry", request_id: "http-retry-1" },
    });
    assert.equal(retried.status, 200);
    assert.equal(retried.json.text, "reply-2:please retry");
    assert.equal(retried.headers["x-request-id-replayed"], undefined);
    assert.equal(retried.json.replayed, undefined);
    assert.equal(fixture.getPromptCalls(), 2);

    const replayed = await invoke(fixture.handler, {
      method: "POST",
      url: `/sessions/${id}/prompt`,
      headers: { "content-type": "application/json" },
      body: { message: "please retry", request_id: "http-retry-1" },
    });
    assert.equal(replayed.status, 200);
    assert.equal(replayed.headers["x-request-id-replayed"], "true");
    assert.deepEqual(replayed.json, { ...retried.json, replayed: true });
    assert.equal(fixture.getPromptCalls(), 2);
  });
});

describe("prompt-dedup structured logging (#1397)", () => {
  it("logs PROMPT_DEDUP_HIT with mode=in_flight on in-flight coalesce", async () => {
    const stub = stubLogger();
    try {
      const entered = createDeferred();
      const gate = createDeferred();
      const fixture = createTestFixture(async (message, emit) => {
        entered.resolve();
        await gate.promise;
        emitStandardReply(emit, `reply:${message}`);
      });
      const id = await fixture.createSession();

      const p1 = fixture.store.prompt(id, "hello", "log-hit-inflight");
      await entered.promise;
      const p2 = fixture.store.prompt(id, "hello", "log-hit-inflight");
      gate.resolve();
      await Promise.all([p1, p2]);

      const match = findPromptDedupLog(
        stub.calls,
        "info",
        new RegExp(`PROMPT_DEDUP_HIT: session=${id}, request_id=log-hit-inflight, mode=in_flight`),
      );
      assert.ok(match, "expected PROMPT_DEDUP_HIT info log with mode=in_flight");
    } finally {
      stub.restore();
    }
  });

  it("logs PROMPT_DEDUP_HIT with mode=cached on completed replay", async () => {
    const stub = stubLogger();
    try {
      const fixture = createTestFixture();
      const id = await fixture.createSession();

      await fixture.store.prompt(id, "hello", "log-hit-cached");
      await fixture.store.prompt(id, "hello", "log-hit-cached");

      const match = findPromptDedupLog(
        stub.calls,
        "info",
        new RegExp(`PROMPT_DEDUP_HIT: session=${id}, request_id=log-hit-cached, mode=cached`),
      );
      assert.ok(match, "expected PROMPT_DEDUP_HIT info log with mode=cached");
    } finally {
      stub.restore();
    }
  });

  it("logs PROMPT_DEDUP_CONFLICT on mismatched message", async () => {
    const stub = stubLogger();
    try {
      const fixture = createTestFixture();
      const id = await fixture.createSession();

      await fixture.store.prompt(id, "first", "log-conflict");
      await assert.rejects(() => fixture.store.prompt(id, "second", "log-conflict"));

      const match = findPromptDedupLog(
        stub.calls,
        "warn",
        new RegExp(`PROMPT_DEDUP_CONFLICT: session=${id}, request_id=log-conflict, status=completed`),
      );
      assert.ok(match, "expected PROMPT_DEDUP_CONFLICT warn log");
    } finally {
      stub.restore();
    }
  });

  it("logs PROMPT_DEDUP_EVICTED with reason=lru_capacity on capacity eviction", async () => {
    const stub = stubLogger();
    try {
      const fixture = createTestFixture();
      const id = await fixture.createSession();

      for (let i = 0; i <= MAX_REQUEST_CACHE_ENTRIES; i++) {
        await fixture.store.prompt(id, `m-${i}`, `log-lru-${i}`);
      }

      const match = findPromptDedupLog(
        stub.calls,
        "debug",
        new RegExp(`PROMPT_DEDUP_EVICTED: session=${id}, request_id=log-lru-0, reason=lru_capacity`),
      );
      assert.ok(match, "expected PROMPT_DEDUP_EVICTED debug log with reason=lru_capacity");
    } finally {
      stub.restore();
    }
  });

  it("logs PROMPT_DEDUP_EVICTED with reason=byte_budget on byte-budget eviction", async () => {
    const stub = stubLogger();
    try {
      const largeReply = "b".repeat(Math.floor(MAX_REQUEST_CACHE_BYTES * 0.4));
      const fixture = createTestFixture(async (_message, emit) => {
        emitStandardReply(emit, largeReply);
      });
      const id = await fixture.createSession();

      await fixture.store.prompt(id, "m1", "log-bytes-1");
      await fixture.store.prompt(id, "m2", "log-bytes-2");
      await fixture.store.prompt(id, "m3", "log-bytes-3");

      const match = findPromptDedupLog(
        stub.calls,
        "debug",
        new RegExp(`PROMPT_DEDUP_EVICTED: session=${id}, request_id=log-bytes-1, reason=byte_budget`),
      );
      assert.ok(match, "expected PROMPT_DEDUP_EVICTED debug log with reason=byte_budget");
    } finally {
      stub.restore();
    }
  });

  it("logs PROMPT_DEDUP_EVICTED with reason=prompt_rejected on rejected prompt", async () => {
    const stub = stubLogger();
    try {
      const fixture = createTestFixture(async () => {
        throw new Error("boom");
      });
      const id = await fixture.createSession();

      await assert.rejects(() => fixture.store.prompt(id, "fail", "log-rejected"));

      const match = findPromptDedupLog(
        stub.calls,
        "debug",
        new RegExp(`PROMPT_DEDUP_EVICTED: session=${id}, request_id=log-rejected, reason=prompt_rejected`),
      );
      assert.ok(match, "expected PROMPT_DEDUP_EVICTED debug log with reason=prompt_rejected");
    } finally {
      stub.restore();
    }
  });

  it("logs PROMPT_DEDUP_EVICTED with reason=turn_failed on failed turn", async () => {
    const stub = stubLogger();
    try {
      const fixture = createTestFixture(async (_message, emit) => {
        emit({ type: "error", error: { message: "provider failure" } });
        emit({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "partial" }],
              usage: { input: 1, output: 1, cost: { total: 0 } },
              stopReason: "error",
            },
          ],
        });
      });
      const id = await fixture.createSession();

      await fixture.store.prompt(id, "err", "log-turn-failed");

      const match = findPromptDedupLog(
        stub.calls,
        "debug",
        new RegExp(`PROMPT_DEDUP_EVICTED: session=${id}, request_id=log-turn-failed, reason=turn_failed`),
      );
      assert.ok(match, "expected PROMPT_DEDUP_EVICTED debug log with reason=turn_failed");
    } finally {
      stub.restore();
    }
  });

  it("logs PROMPT_DEDUP_EVICTED with reason=turn_aborted on aborted turn", async () => {
    const stub = stubLogger();
    try {
      const fixture = createTestFixture(async (_message, emit) => {
        emit({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "partial" }],
              usage: { input: 1, output: 1, cost: { total: 0 } },
              stopReason: "aborted",
            },
          ],
        });
      });
      const id = await fixture.createSession();

      await fixture.store.prompt(id, "abort", "log-turn-aborted");

      const match = findPromptDedupLog(
        stub.calls,
        "debug",
        new RegExp(`PROMPT_DEDUP_EVICTED: session=${id}, request_id=log-turn-aborted, reason=turn_aborted`),
      );
      assert.ok(match, "expected PROMPT_DEDUP_EVICTED debug log with reason=turn_aborted");
    } finally {
      stub.restore();
    }
  });

  it("logs PROMPT_DEDUP_OVERSIZED on oversized single entry", async () => {
    const stub = stubLogger();
    try {
      const oversizedReply = "z".repeat(MAX_REQUEST_CACHE_BYTES + 1);
      const fixture = createTestFixture(async (_message, emit) => {
        emitStandardReply(emit, oversizedReply);
      });
      const id = await fixture.createSession();

      await fixture.store.prompt(id, "big", "log-oversized");

      const match = findPromptDedupLog(
        stub.calls,
        "warn",
        new RegExp(`PROMPT_DEDUP_OVERSIZED: session=${id}, request_id=log-oversized, bytes=\\d+, max_bytes=${MAX_REQUEST_CACHE_BYTES}`),
      );
      assert.ok(match, "expected PROMPT_DEDUP_OVERSIZED warn log");
    } finally {
      stub.restore();
    }
  });

  it("logs PROMPT_DEDUP_INVALID_ID on invalid request_id", async () => {
    const stub = stubLogger();
    try {
      const fixture = createTestFixture();
      const id = await fixture.createSession();

      await assert.rejects(() => fixture.store.prompt(id, "hello", "   "));

      const match = findPromptDedupLog(
        stub.calls,
        "warn",
        new RegExp(`PROMPT_DEDUP_INVALID_ID: session=${id}`),
      );
      assert.ok(match, "expected PROMPT_DEDUP_INVALID_ID warn log");
    } finally {
      stub.restore();
    }
  });
});
