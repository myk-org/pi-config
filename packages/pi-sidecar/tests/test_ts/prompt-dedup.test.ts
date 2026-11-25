/**
 * Unit and HTTP-handler tests for optional `request_id` prompt deduplication (#1397).
 *
 * Drives `SessionStore` through `InMemoryProviderRuntime` and `createRequestHandler`
 * in-process via `invoke()` — no sockets, no temp dirs, no timers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_REQUEST_CACHE_ENTRIES,
  MAX_REQUEST_ID_LENGTH,
  SessionStore,
  isValidRequestId,
  type PromptResult,
} from "../../src/sessions.js";
import { createRequestHandler } from "../../src/request-handler.js";
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

function createTestFixture(onPrompt?: PromptHandler) {
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
        abort: async () => {},
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
    assert.equal(fixture.getPromptCalls(), 3);
  });

  it("coalesces concurrent in-flight prompts with the same request_id and isolates returned results", async () => {
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

    // Mutating one caller's result.usage must not mutate other callers' copies or cached replays.
    r1.usage.input_tokens = 999_999;
    r1.usage.cost_usd = 123.45;
    assert.equal(r2.usage.input_tokens, 42);
    assert.equal(r2.usage.cost_usd, 0.01);

    const replay = await fixture.store.prompt(id, "hello", "req-1");
    assert.equal(fixture.getPromptCalls(), 1);
    assert.equal(replay.usage.input_tokens, 42);
    assert.equal(replay.usage.cost_usd, 0.01);
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

    const replayIdle = await fixture.store.prompt(id, "hello", "req-1");
    assert.deepEqual(replayIdle, first);
    assert.equal(fixture.getPromptCalls(), 1);

    // Start req-2 and keep it in-flight.
    const inFlightReq2 = fixture.store.prompt(id, "second", "req-2");
    await enteredSecond.promise;

    // Replaying req-1 must resolve immediately without waiting for req-2.
    const replayWhileBusy = await fixture.store.prompt(id, "hello", "req-1");
    assert.deepEqual(replayWhileBusy, first);
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
    assert.deepEqual(replay, first);
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
    assert.equal(fixture.getPromptCalls(), 2);

    const cached = await fixture.store.prompt(id, "retry-me", "req-fail");
    assert.deepEqual(cached, retried);
    assert.equal(fixture.getPromptCalls(), 2);
  });

  it("caches HTTP 200 results that contain partial text or SDK errors (including error and stop_reason)", async () => {
    const fixture = createTestFixture(async (_message, emit) => {
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
    });

    const id = await fixture.createSession();

    const first = await fixture.store.prompt(id, "go", "req-partial");
    assert.equal(fixture.getPromptCalls(), 1);
    assert.equal(first.text, "partial output");
    assert.equal(first.stop_reason, "error");
    assert.ok(first.error && first.error.includes("provider stream interrupted"));
    assert.ok(first.error && first.error.includes("rate limit hit"));

    const replayed = await fixture.store.prompt(id, "go", "req-partial");
    assert.equal(fixture.getPromptCalls(), 1);
    assert.deepEqual(replayed, first);
    assert.equal(replayed.error, first.error);
    assert.equal(replayed.stop_reason, "error");
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
    assert.deepEqual(promoted, results[0]);
    assert.equal(fixture.getPromptCalls(), 64);

    // Insert req-64 -> evicts req-1 (not req-0).
    const inserted = await fixture.store.prompt(id, "msg-64", "req-64");
    assert.equal(inserted.text, "reply-65:msg-64");
    assert.equal(fixture.getPromptCalls(), 65);

    // req-0 must still hit cache (0 new model calls).
    const hit0 = await fixture.store.prompt(id, "msg-0", "req-0");
    assert.deepEqual(hit0, results[0]);
    assert.equal(fixture.getPromptCalls(), 65);

    // req-1 must miss cache (1 new model call).
    const miss1 = await fixture.store.prompt(id, "msg-1", "req-1");
    assert.equal(fixture.getPromptCalls(), 66);
    assert.equal(miss1.text, "reply-66:msg-1");
  });

  it("isolates request_id caches across sessions and cleans up on delete, disposeAll, and cleanupStale", async () => {
    // 1. Per-session isolation.
    const isoFixture = createTestFixture();
    const sessionA = await isoFixture.createSession();
    const sessionB = await isoFixture.createSession();

    const resA = await isoFixture.store.prompt(sessionA, "from-A", "shared-req");
    const resB = await isoFixture.store.prompt(sessionB, "from-B", "shared-req");
    assert.equal(isoFixture.getPromptCalls(), 2);
    assert.equal(resA.text, "reply-1:from-A");
    assert.equal(resB.text, "reply-2:from-B");

    assert.deepEqual(await isoFixture.store.prompt(sessionA, "from-A", "shared-req"), resA);
    assert.deepEqual(await isoFixture.store.prompt(sessionB, "from-B", "shared-req"), resB);
    assert.equal(isoFixture.getPromptCalls(), 2);

    // 2. delete() on idle session with cached entries.
    assert.equal(isoFixture.store.delete(sessionA), true);
    await assert.rejects(() => isoFixture.store.prompt(sessionA, "from-A", "shared-req"), /not found/);

    // 3. cleanupStale() removes idle session with cached entries.
    assert.equal(isoFixture.store.cleanupStale(-1), 1);
    assert.equal(isoFixture.store.count(), 0);
    await assert.rejects(() => isoFixture.store.prompt(sessionB, "from-B", "shared-req"), /not found/);

    // 4. delete() while a request_id prompt is in-flight settles cleanly (resolve & reject).
    const enteredResolve = createDeferred();
    const releaseResolve = createDeferred();
    const enteredReject = createDeferred();
    const releaseReject = createDeferred();

    const delFixture = createTestFixture(async (message, emit, callIndex) => {
      if (callIndex === 1) {
        enteredResolve.resolve();
        await releaseResolve.promise;
        emitStandardReply(emit, `done:${message}`);
      } else {
        enteredReject.resolve();
        await releaseReject.promise;
        throw new Error("deleted mid-flight failure");
      }
    });

    const delSession1 = await delFixture.createSession();
    const inFlight1 = delFixture.store.prompt(delSession1, "hi", "req-del-ok");
    await enteredResolve.promise;
    // cleanupStale must skip in-flight sessions.
    assert.equal(delFixture.store.cleanupStale(-1), 0);
    assert.equal(delFixture.store.count(), 1);
    assert.equal(delFixture.store.delete(delSession1), true);
    releaseResolve.resolve();
    const settled1 = await inFlight1;
    assert.equal(settled1.text, "done:hi");
    await assert.rejects(() => delFixture.store.prompt(delSession1, "hi", "req-del-ok"), /not found/);

    const delSession2 = await delFixture.createSession();
    const inFlight2 = delFixture.store.prompt(delSession2, "hi", "req-del-err");
    await enteredReject.promise;
    assert.equal(delFixture.store.delete(delSession2), true);
    releaseReject.resolve();
    await assert.rejects(() => inFlight2, /deleted mid-flight failure/);

    // 5. disposeAll() cleans up cached and in-flight sessions cleanly.
    const enteredDispose = createDeferred();
    const releaseDispose = createDeferred();
    const dispFixture = createTestFixture(async (message, emit, callIndex) => {
      if (callIndex === 2) {
        enteredDispose.resolve();
        await releaseDispose.promise;
      }
      emitStandardReply(emit, `reply-${callIndex}:${message}`);
    });
    const dispSession1 = await dispFixture.createSession();
    const dispSession2 = await dispFixture.createSession();
    await dispFixture.store.prompt(dispSession1, "cached", "req-cached");

    const inFlightDispose = dispFixture.store.prompt(dispSession2, "running", "req-running");
    await enteredDispose.promise;

    await dispFixture.store.disposeAll();
    assert.equal(dispFixture.store.count(), 0);
    await assert.rejects(
      () => dispFixture.store.prompt(dispSession1, "cached", "req-cached"),
      (err: any) => err?.statusCode === 503 && /shutting down/i.test(String(err?.message)),
    );

    releaseDispose.resolve();
    const disposedResult = await inFlightDispose;
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
  it("handles omitted request_id with 200", async () => {
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

  it("coalesces in-flight HTTP requests, replays completed requests, and returns 409 on mismatched message", async () => {
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

    // In-flight coalescing.
    const p1 = invoke(fixture.handler, {
      method: "POST",
      url: `/sessions/${id}/prompt`,
      headers: { "content-type": "application/json" },
      body: { message: "hello", request_id: "http-req-1" },
    });
    await entered.promise;

    let p2Settled = false;
    const p2 = invoke(fixture.handler, {
      method: "POST",
      url: `/sessions/${id}/prompt`,
      headers: { "content-type": "application/json" },
      body: { message: "hello", request_id: "http-req-1" },
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
    assert.equal(fixture.getPromptCalls(), 1);

    // Completed replay.
    const r3 = await invoke(fixture.handler, {
      method: "POST",
      url: `/sessions/${id}/prompt`,
      headers: { "content-type": "application/json" },
      body: { message: "hello", request_id: "http-req-1" },
    });
    assert.equal(r3.status, 200);
    assert.deepEqual(r3.json, r1.json);
    assert.equal(fixture.getPromptCalls(), 1);

    // Mismatched message -> 409.
    const conflict = await invoke(fixture.handler, {
      method: "POST",
      url: `/sessions/${id}/prompt`,
      headers: { "content-type": "application/json" },
      body: { message: "different", request_id: "http-req-1" },
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
    assert.equal(fixture.getPromptCalls(), 2);

    const replayed = await invoke(fixture.handler, {
      method: "POST",
      url: `/sessions/${id}/prompt`,
      headers: { "content-type": "application/json" },
      body: { message: "please retry", request_id: "http-retry-1" },
    });
    assert.equal(replayed.status, 200);
    assert.deepEqual(replayed.json, retried.json);
    assert.equal(fixture.getPromptCalls(), 2);
  });
});
