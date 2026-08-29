import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildQueuePreview,
  clearLocalQueue,
  clearRpcQueue,
  type QueueRecoveryItem,
} from "../../../extensions/coms/queue-recovery.js";

const now = Date.parse("2026-03-01T00:00:10.000Z");
const items: QueueRecoveryItem[] = [
  { id: "one", sender: "alice", target: "bob", queuedAt: "2026-03-01T00:00:00.000Z", position: 1, deliveryState: "queued" },
  { id: "two", sender: "alice", target: "bob", queuedAt: "2026-03-01T00:00:05.000Z", position: 2, deliveryState: "timed_out" },
];

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

describe("RPC queue recovery", () => {
  it("reports unavailable when the host has no recovery provider", async () => {
    const result = await clearRpcQueue(undefined, "preview-1");
    assert.deepEqual(result, { outcome: "unavailable", cleared: [], untouched: [], reason: "RPC queue recovery is unavailable" });
  });

  it("rejects malformed clear_queue responses", async () => {
    const result = await clearRpcQueue({ clearQueue: async () => ({ steering: "wrong", followUp: [] }) }, "preview-1");
    assert.equal(result.outcome, "malformed");
    assert.equal(result.cleared.length, 0);
  });

  it("reports failures without claiming messages were cleared", async () => {
    const result = await clearRpcQueue({ clearQueue: async () => { throw new Error("broken pipe"); } }, "preview-1");
    assert.deepEqual(result, { outcome: "failure", cleared: [], untouched: [], reason: "broken pipe" });
  });

  it("reports all clear_queue steering and follow-up results", async () => {
    const result = await clearRpcQueue({ clearQueue: async () => ({ steering: ["s1"], followUp: ["f1", "f2"] }) }, "preview-1");
    assert.equal(result.outcome, "success");
    assert.deepEqual(result.cleared.map(item => item.id), ["steering-1", "follow_up-1", "follow_up-2"]);
    assert.deepEqual(result.untouched, []);
  });
});
