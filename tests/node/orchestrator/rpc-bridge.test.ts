/**
 * Tests for the subagents:rpc:* bridge pattern in async-agents.ts.
 * Tests the handleRpc request/reply contract without importing internal functions.
 * Run with: npx tsx --test tests/node/orchestrator/rpc-bridge.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

// Replicate the handleRpc pattern from async-agents.ts for testing
function handleRpc<P extends { requestId: string }>(
  events: EventEmitter,
  channel: string,
  fn: (params: P) => unknown | Promise<unknown>,
): () => void {
  const handler = async (raw: unknown) => {
    const params = raw as P;
    try {
      const data = await fn(params);
      const reply: { success: true; data?: unknown } = { success: true };
      if (data !== undefined) reply.data = data;
      events.emit(`${channel}:reply:${params.requestId}`, reply);
    } catch (err: any) {
      events.emit(`${channel}:reply:${params.requestId}`, {
        success: false, error: err?.message ?? String(err),
      });
    }
  };
  events.on(channel, handler);
  return () => { events.off(channel, handler); };
}

describe("handleRpc pattern", () => {
  it("replies with success on the scoped channel", async () => {
    const events = new EventEmitter();
    handleRpc<{ requestId: string }>(events, "test:rpc", () => ({ version: 2 }));

    const replyPromise = new Promise<any>((resolve) => {
      events.once("test:rpc:reply:req-1", resolve);
    });
    events.emit("test:rpc", { requestId: "req-1" });

    const reply = await replyPromise;
    assert.equal(reply.success, true);
    assert.deepEqual(reply.data, { version: 2 });
  });

  it("replies with error when handler throws", async () => {
    const events = new EventEmitter();
    handleRpc<{ requestId: string }>(events, "test:rpc:fail", () => {
      throw new Error("something broke");
    });

    const replyPromise = new Promise<any>((resolve) => {
      events.once("test:rpc:fail:reply:req-2", resolve);
    });
    events.emit("test:rpc:fail", { requestId: "req-2" });

    const reply = await replyPromise;
    assert.equal(reply.success, false);
    assert.equal(reply.error, "something broke");
  });

  it("omits data key when handler returns undefined", async () => {
    const events = new EventEmitter();
    handleRpc<{ requestId: string }>(events, "test:rpc:void", () => undefined);

    const replyPromise = new Promise<any>((resolve) => {
      events.once("test:rpc:void:reply:req-3", resolve);
    });
    events.emit("test:rpc:void", { requestId: "req-3" });

    const reply = await replyPromise;
    assert.equal(reply.success, true);
    assert.equal("data" in reply, false);
  });

  it("handles async handler functions", async () => {
    const events = new EventEmitter();
    handleRpc<{ requestId: string }>(events, "test:rpc:async", async () => {
      return new Promise((resolve) => setTimeout(() => resolve({ result: "ok" }), 10));
    });

    const replyPromise = new Promise<any>((resolve) => {
      events.once("test:rpc:async:reply:req-4", resolve);
    });
    events.emit("test:rpc:async", { requestId: "req-4" });

    const reply = await replyPromise;
    assert.equal(reply.success, true);
    assert.deepEqual(reply.data, { result: "ok" });
  });

  it("routes replies to correct requestId", async () => {
    const events = new EventEmitter();
    let callCount = 0;
    handleRpc<{ requestId: string; value: number }>(events, "test:rpc:multi", (params) => {
      callCount++;
      return { doubled: params.value * 2 };
    });

    const reply1Promise = new Promise<any>((resolve) => {
      events.once("test:rpc:multi:reply:a", resolve);
    });
    const reply2Promise = new Promise<any>((resolve) => {
      events.once("test:rpc:multi:reply:b", resolve);
    });

    events.emit("test:rpc:multi", { requestId: "a", value: 5 });
    events.emit("test:rpc:multi", { requestId: "b", value: 10 });

    const [reply1, reply2] = await Promise.all([reply1Promise, reply2Promise]);
    assert.deepEqual(reply1.data, { doubled: 10 });
    assert.deepEqual(reply2.data, { doubled: 20 });
    assert.equal(callCount, 2);
  });

  it("cleanup function removes the handler", async () => {
    const events = new EventEmitter();
    let callCount = 0;
    const cleanup = handleRpc<{ requestId: string }>(events, "test:rpc:clean", () => {
      callCount++;
      return "ok";
    });

    // First call works
    const reply1 = new Promise<any>((resolve) => events.once("test:rpc:clean:reply:r1", resolve));
    events.emit("test:rpc:clean", { requestId: "r1" });
    await reply1;
    assert.equal(callCount, 1);

    // After cleanup, no more handling
    cleanup();
    let gotReply = false;
    events.once("test:rpc:clean:reply:r2", () => { gotReply = true; });
    events.emit("test:rpc:clean", { requestId: "r2" });
    // Give it a tick
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(gotReply, false);
    assert.equal(callCount, 1);
  });
});
