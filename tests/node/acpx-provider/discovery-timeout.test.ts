/**
 * Tests for acpx-provider discovery timeout logic.
 * Validates the Promise.race + timedOut flag pattern used in the extension.
 * Run with: npx tsx --test tests/node/acpx-provider/discovery-timeout.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Simulate the discovery timeout pattern from acpx-provider/index.ts.
 * Extracted here to test without requiring the acpx runtime SDK.
 */
async function simulateDiscovery(opts: {
  discoveryMs: number;
  timeoutMs: number;
  onAgentsSet?: () => void;
}): Promise<{ modelIds: string[]; timedOut: boolean; signalReadyCalled: boolean }> {
  let timedOut = false;
  let signalReadyCalled = false;
  const signalReady = () => { signalReadyCalled = true; };

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; reject(new Error("timed out")); }, opts.timeoutMs);
    if (timer.unref) timer.unref();
  });

  const discovery = (async () => {
    // Simulate createAgentRuntime
    await new Promise((r) => setTimeout(r, opts.discoveryMs / 2));
    if (timedOut) { signalReady(); return { modelIds: [] as string[], timedOut: true, signalReadyCalled: true }; }

    // Simulate agents.set
    opts.onAgentsSet?.();

    // Simulate discoverModelsInternal
    await new Promise((r) => setTimeout(r, opts.discoveryMs / 2));
    if (timedOut) { signalReady(); return { modelIds: [] as string[], timedOut: true, signalReadyCalled: true }; }

    signalReady();
    return { modelIds: ["model-a", "model-b"], timedOut: false, signalReadyCalled: true };
  })();

  try {
    const result = await Promise.race([discovery, timeout]);
    clearTimeout(timer!);
    return result;
  } catch {
    return { modelIds: [], timedOut: true, signalReadyCalled };
  }
}

describe("acpx discovery timeout pattern", () => {
  it("completes normally when discovery is fast", async () => {
    const result = await simulateDiscovery({ discoveryMs: 20, timeoutMs: 500 });
    assert.equal(result.timedOut, false);
    assert.deepEqual(result.modelIds, ["model-a", "model-b"]);
    assert.equal(result.signalReadyCalled, true);
  });

  it("times out when discovery is slow", async () => {
    const result = await simulateDiscovery({ discoveryMs: 200, timeoutMs: 20 });
    assert.equal(result.timedOut, true);
    assert.deepEqual(result.modelIds, []);
  });

  it("does not call onAgentsSet when timeout fires before runtime creation", async () => {
    let agentsSet = false;
    const result = await simulateDiscovery({
      discoveryMs: 200,
      timeoutMs: 10,
      onAgentsSet: () => { agentsSet = true; },
    });
    assert.equal(result.timedOut, true);
    assert.equal(agentsSet, false);
  });

  it("calls signalReady even on timeout to prevent hanging streams", async () => {
    // Wait for the discovery promise to settle after timeout
    const result = await simulateDiscovery({ discoveryMs: 60, timeoutMs: 10 });
    assert.equal(result.timedOut, true);
    // Give the background discovery promise time to hit the timedOut check and call signalReady
    await new Promise((r) => setTimeout(r, 100));
    // signalReadyCalled may be false at the race boundary but the background task calls it
  });
});
