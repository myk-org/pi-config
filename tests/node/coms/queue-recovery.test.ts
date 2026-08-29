import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildQueuePreview,
  clearLocalQueue,
  clearRpcQueue,
  previewRpcQueue,
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
    const result = await previewRpcQueue({ clearQueue: async () => ({}), previewQueue: async () => ({ steering: "wrong", followUp: [] }) });
    assert.equal(result.outcome, "malformed");
  });

  it("reports a preview provider exception", async () => {
    const result = await previewRpcQueue({ clearQueue: async () => ({}), previewQueue: async () => { throw new Error("preview pipe broken"); } });
    assert.deepEqual(result, { outcome: "unavailable", provider: "rpc", previewId: "", items: [], reason: "preview pipe broken" });
  });

  it("returns body-free steering metadata", async () => {
    const result = await previewRpcQueue({ clearQueue: async () => ({}), previewQueue: async () => rpcPreview(["secret steering"], []) });
    assert.deepEqual(result.items.map(item => item.id), ["steering-1"]);
    assert.equal(JSON.stringify(result).includes("secret steering"), false);
  });

  it("returns body-free follow-up metadata", async () => {
    const result = await previewRpcQueue({ clearQueue: async () => ({}), previewQueue: async () => rpcPreview([], ["secret follow-up"]) });
    assert.deepEqual(result.items.map(item => item.id), ["follow_up-1"]);
    assert.equal(JSON.stringify(result).includes("secret follow-up"), false);
  });
});

describe("RPC queue clearing", () => {
  it("reports unavailable when the host has no recovery provider", async () => {
    const result = await clearRpcQueue(undefined, "preview-1");
    assert.deepEqual(result, { outcome: "unavailable", cleared: [], untouched: [], reason: "RPC queue recovery is unavailable" });
  });

  it("rejects an omitted preview token without clearing", async () => {
    let clearCalls = 0;
    const provider = { previewQueue: async () => rpcPreview(), clearQueue: async () => { clearCalls++; return rpcPreview(); } };
    const result = await clearRpcQueue(provider, undefined as unknown as string);
    assert.equal(result.outcome, "invalid_preview");
    assert.equal(clearCalls, 0);
  });

  it("rejects an empty preview token without clearing", async () => {
    let clearCalls = 0;
    const provider = { previewQueue: async () => rpcPreview(), clearQueue: async () => { clearCalls++; return rpcPreview(); } };
    const result = await clearRpcQueue(provider, "");
    assert.equal(result.outcome, "invalid_preview");
    assert.equal(clearCalls, 0);
  });

  it("rejects a fabricated preview token without clearing", async () => {
    let clearCalls = 0;
    const provider = { previewQueue: async () => rpcPreview(), clearQueue: async () => { clearCalls++; return rpcPreview(); } };
    const result = await clearRpcQueue(provider, "fabricated");
    assert.equal(result.outcome, "invalid_preview");
    assert.equal(clearCalls, 0);
  });

  it("rejects a reused preview token without clearing", async () => {
    let clearCalls = 0;
    const provider = { previewQueue: async () => rpcPreview(), clearQueue: async () => { clearCalls++; return rpcPreview(); } };
    const preview = await previewRpcQueue(provider);
    await clearRpcQueue(provider, preview.previewId);
    const result = await clearRpcQueue(provider, preview.previewId);
    assert.equal(result.outcome, "invalid_preview");
    assert.equal(clearCalls, 1);
  });

  it("rejects a stale preview token without clearing", async () => {
    let clearCalls = 0;
    let current = rpcPreview();
    const provider = { previewQueue: async () => current, clearQueue: async () => { clearCalls++; return rpcPreview(); } };
    const preview = await previewRpcQueue(provider);
    current = rpcPreview(["changed"]);
    const result = await clearRpcQueue(provider, preview.previewId);
    assert.equal(result.outcome, "stale_preview");
    assert.equal(clearCalls, 0);
  });

  it("rejects malformed clear_queue responses", async () => {
    const provider = { previewQueue: async () => rpcPreview(), clearQueue: async () => ({ steering: "wrong", followUp: [] }) };
    const preview = await previewRpcQueue(provider);
    const result = await clearRpcQueue(provider, preview.previewId);
    assert.equal(result.outcome, "malformed");
    assert.equal(result.cleared.length, 0);
  });

  it("reports failures without claiming messages were cleared", async () => {
    const provider = { previewQueue: async () => rpcPreview(), clearQueue: async () => { throw new Error("broken pipe"); } };
    const preview = await previewRpcQueue(provider);
    const result = await clearRpcQueue(provider, preview.previewId);
    assert.deepEqual(result, { outcome: "failure", cleared: [], untouched: [], reason: "broken pipe" });
  });

  it("clears a valid preview token", async () => {
    const provider = { previewQueue: async () => rpcPreview(["s1"], ["f1", "f2"]), clearQueue: async () => rpcPreview(["s1"], ["f1", "f2"]) };
    const preview = await previewRpcQueue(provider);
    const result = await clearRpcQueue(provider, preview.previewId);
    assert.equal(result.outcome, "success");
    assert.deepEqual(result.cleared.map(item => item.id), ["steering-1", "follow_up-1", "follow_up-2"]);
  });
});
