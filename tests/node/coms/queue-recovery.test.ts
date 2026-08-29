import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildQueuePreview,
  clearLocalQueue,
  clearRpcQueue,
  previewRpcQueue,
  rpcQueueSnapshot,
  type QueueRecoveryItem,
} from "../../../extensions/coms/queue-recovery.js";

const now = Date.parse("2026-03-01T00:00:10.000Z");
const items: QueueRecoveryItem[] = [
  { id: "one", sender: "alice", target: "bob", queuedAt: "2026-03-01T00:00:00.000Z", position: 1, deliveryState: "queued" },
  { id: "two", sender: "alice", target: "bob", queuedAt: "2026-03-01T00:00:05.000Z", position: 2, deliveryState: "timed_out" },
];

function rpcPreview(steering = ["steering"], followUp = ["follow-up"]) {
  return { steering, followUp };
}

function atomicProvider(initial = rpcPreview()) {
  let current = initial;
  let clearCalls = 0;
  return {
    provider: {
      previewQueue: async () => current,
      clearQueueIfSnapshot: async (expectedSnapshot: string) => {
        clearCalls++;
        return rpcQueueSnapshot(current) === expectedSnapshot ? current : { outcome: "stale_preview" };
      },
    },
    setCurrent: (value: ReturnType<typeof rpcPreview>) => { current = value; },
    get clearCalls() { return clearCalls; },
  };
}

describe("queue recovery previews", () => {
  it("returns auditable metadata without message bodies", () => {
    const preview = buildQueuePreview("local", items, now);
    assert.equal(preview.outcome, "supported");
    assert.equal(preview.items[0].ageMs, 10_000);
    assert.deepEqual(preview.items.map(item => item.id), ["one", "two"]);
    assert.equal("body" in preview.items[0], false);
    assert.ok(preview.previewId);
  });

  it("preserves FIFO positions for untouched messages", () => {
    const result = clearLocalQueue(items, ["one"]);
    assert.equal(result.outcome, "success");
    assert.deepEqual(result.untouched.map(item => [item.id, item.position]), [["two", 2]]);
  });

  it("reports a partial local clear without dropping untouched messages", () => {
    const result = clearLocalQueue(items, ["one", "gone"]);
    assert.equal(result.outcome, "partial");
    assert.deepEqual(result.cleared.map(item => item.id), ["one"]);
    assert.deepEqual(result.untouched.map(item => item.id), ["two"]);
  });
});

describe("RPC queue previews", () => {
  it("reports an unavailable preview provider", async () => {
    const result = await previewRpcQueue(undefined);
    assert.deepEqual(result, { outcome: "unavailable", provider: "rpc", previewId: "", items: [], reason: "RPC queue preview is unavailable" });
  });

  it("reports malformed preview output", async () => {
    const result = await previewRpcQueue({ clearQueueIfSnapshot: async () => ({}), previewQueue: async () => ({ steering: "wrong", followUp: [] }) });
    assert.equal(result.outcome, "malformed");
  });

  it("reports a preview provider exception", async () => {
    const result = await previewRpcQueue({ clearQueueIfSnapshot: async () => ({}), previewQueue: async () => { throw new Error("preview pipe broken"); } });
    assert.deepEqual(result, { outcome: "unavailable", provider: "rpc", previewId: "", items: [], reason: "preview pipe broken" });
  });

  it("returns body-free steering metadata with an unknown enqueue age", async () => {
    const result = await previewRpcQueue({ clearQueueIfSnapshot: async () => ({}), previewQueue: async () => rpcPreview(["secret steering"], []) });
    assert.deepEqual(result.items.map(item => ({ id: item.id, queuedAt: item.queuedAt, ageMs: item.ageMs })), [
      { id: "steering-1", queuedAt: null, ageMs: null },
    ]);
    assert.equal(JSON.stringify(result).includes("secret steering"), false);
  });

  it("returns body-free follow-up metadata", async () => {
    const result = await previewRpcQueue({ clearQueueIfSnapshot: async () => ({}), previewQueue: async () => rpcPreview([], ["secret follow-up"]) });
    assert.deepEqual(result.items.map(item => item.id), ["follow_up-1"]);
    assert.equal(JSON.stringify(result).includes("secret follow-up"), false);
  });

  it("uses a collision-resistant, unambiguously framed digest", () => {
    // These distinct eight-byte messages collide under the replaced 32-bit FNV fingerprint.
    const first = rpcQueueSnapshot(rpcPreview(["jYM91QWw"], []));
    const second = rpcQueueSnapshot(rpcPreview(["WbVUq2c1"], []));
    assert.notEqual(first, second);
    assert.match(first ?? "", /^sha256:[a-f0-9]{64}$/);
  });

  it("distinguishes queue boundaries while digesting", () => {
    assert.notEqual(rpcQueueSnapshot(rpcPreview(["a", "bc"], [])), rpcQueueSnapshot(rpcPreview(["ab", "c"], [])));
  });

  it("expires RPC preview tokens without invoking the host clear", async () => {
    const host = atomicProvider();
    const preview = await previewRpcQueue(host.provider, now);
    const result = await clearRpcQueue(host.provider, preview.previewId, now + 5 * 60 * 1000);
    assert.equal(result.outcome, "invalid_preview");
    assert.equal(host.clearCalls, 0);
  });

  it("evicts the oldest RPC preview after the per-provider limit", async () => {
    const host = atomicProvider();
    const previews = await Promise.all(Array.from({ length: 21 }, (_, index) => previewRpcQueue(host.provider, now + index)));
    const result = await clearRpcQueue(host.provider, previews[0].previewId, now + 21);
    assert.equal(result.outcome, "invalid_preview");
    assert.equal(host.clearCalls, 0);
  });
});

describe("RPC queue clearing", () => {
  it("reports unavailable when the host has no recovery provider", async () => {
    const result = await clearRpcQueue(undefined, "preview-1");
    assert.deepEqual(result, { outcome: "unavailable", cleared: [], untouched: [], reason: "RPC queue recovery is unavailable" });
  });

  for (const previewId of [undefined, "", "fabricated"] as const) {
    it(`rejects ${previewId === undefined ? "an omitted" : previewId === "" ? "an empty" : "a fabricated"} preview token without clearing`, async () => {
      const host = atomicProvider();
      const result = await clearRpcQueue(host.provider, previewId as string);
      assert.equal(result.outcome, "invalid_preview");
      assert.equal(host.clearCalls, 0);
    });
  }

  it("rejects a reused preview token without clearing", async () => {
    const host = atomicProvider();
    const preview = await previewRpcQueue(host.provider);
    await clearRpcQueue(host.provider, preview.previewId);
    const result = await clearRpcQueue(host.provider, preview.previewId);
    assert.equal(result.outcome, "invalid_preview");
    assert.equal(host.clearCalls, 1);
  });

  it("returns previewed items as untouched when the host reports an atomic stale result", async () => {
    const host = atomicProvider();
    const preview = await previewRpcQueue(host.provider);
    host.setCurrent(rpcPreview(["changed"]));
    const result = await clearRpcQueue(host.provider, preview.previewId);
    assert.equal(result.outcome, "stale_preview");
    assert.deepEqual(result.untouched, preview.items.map(({ ageMs: _ageMs, ...item }) => item));
    assert.equal(host.clearCalls, 1);
  });

  it("returns an indeterminate audit result when the host response is malformed after clear", async () => {
    let clearCalls = 0;
    const provider = {
      previewQueue: async () => rpcPreview(["s1"], ["f1"]),
      clearQueueIfSnapshot: async () => { clearCalls++; return { steering: "wrong", followUp: [] }; },
    };
    const preview = await previewRpcQueue(provider);
    const result = await clearRpcQueue(provider, preview.previewId);
    assert.equal(clearCalls, 1);
    assert.equal(result.outcome, "indeterminate");
    assert.deepEqual(result.attempted?.items.map(item => item.id), ["steering-1", "follow_up-1"]);
    assert.match(result.attempted?.snapshot ?? "", /^sha256:[a-f0-9]{64}$/);
  });

  it("reports failures without claiming messages were cleared", async () => {
    const provider = { previewQueue: async () => rpcPreview(), clearQueueIfSnapshot: async () => { throw new Error("broken pipe"); } };
    const preview = await previewRpcQueue(provider);
    const result = await clearRpcQueue(provider, preview.previewId);
    assert.deepEqual(result, { outcome: "failure", cleared: [], untouched: [], reason: "broken pipe" });
  });

  it("clears a valid preview token through the atomic provider operation", async () => {
    const host = atomicProvider(rpcPreview(["s1"], ["f1", "f2"]));
    const preview = await previewRpcQueue(host.provider);
    const result = await clearRpcQueue(host.provider, preview.previewId);
    assert.equal(result.outcome, "success");
    assert.deepEqual(result.cleared.map(item => item.id), ["steering-1", "follow_up-1", "follow_up-2"]);
    assert.equal(host.clearCalls, 1);
  });
});
