import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

describe("startWatchdog", () => {
  let intervalCallbacks: Array<() => void>;
  let timeoutCallbacks: Array<{ cb: () => void; ms: number }>;
  let originalSetInterval: typeof globalThis.setInterval;
  let originalSetTimeout: typeof globalThis.setTimeout;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    intervalCallbacks = [];
    timeoutCallbacks = [];
    originalSetInterval = globalThis.setInterval;
    originalSetTimeout = globalThis.setTimeout;
    originalFetch = globalThis.fetch;

    (globalThis as any).setInterval = (cb: () => void, _ms: number) => {
      intervalCallbacks.push(cb);
      return 999 as unknown as NodeJS.Timeout;
    };

    // Capture setTimeout but execute immediately for startDelay
    (globalThis as any).setTimeout = (cb: (...args: any[]) => void, ms: number, ...args: any[]) => {
      if (ms === 0) {
        // startDelayMs: 0 — execute immediately
        cb(...args);
        return 998 as unknown as NodeJS.Timeout;
      }
      timeoutCallbacks.push({ cb: cb as () => void, ms });
      return 997 as unknown as NodeJS.Timeout;
    };
  });

  afterEach(() => {
    globalThis.setInterval = originalSetInterval;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.fetch = originalFetch;
  });

  async function loadWatchdog() {
    const { startWatchdog } = await import("../../src/watchdog.js");
    return startWatchdog;
  }

  // Use startDelayMs: 0 and maxFailures: 3 for fast tests
  const TEST_OPTIONS = { startDelayMs: 0, maxFailures: 3, intervalMs: 10_000, timeoutMs: 5000 };

  it("calls onDead after maxFailures consecutive failures", async () => {
    globalThis.fetch = mock.fn(async () => {
      throw new Error("Connection refused");
    }) as any;

    const onDead = mock.fn();
    const startWatchdog = await loadWatchdog();
    startWatchdog("http://localhost:8000/health", onDead, TEST_OPTIONS);

    assert.equal(intervalCallbacks.length, 1);
    const tick = intervalCallbacks[0];

    await tick();
    assert.equal(onDead.mock.callCount(), 0);

    await tick();
    assert.equal(onDead.mock.callCount(), 0);

    await tick();
    assert.equal(onDead.mock.callCount(), 1);
  });

  it("resets failure count on successful health check", async () => {
    let callCount = 0;
    globalThis.fetch = mock.fn(async () => {
      callCount++;
      if (callCount <= 2) throw new Error("Connection refused");
      if (callCount === 3) return { ok: true } as Response;
      throw new Error("Connection refused");
    }) as any;

    const onDead = mock.fn();
    const startWatchdog = await loadWatchdog();
    startWatchdog("http://localhost:8000/health", onDead, TEST_OPTIONS);

    const tick = intervalCallbacks[0];

    await tick(); // failure #1
    assert.equal(onDead.mock.callCount(), 0);

    await tick(); // failure #2
    assert.equal(onDead.mock.callCount(), 0);

    await tick(); // success → resets counter
    assert.equal(onDead.mock.callCount(), 0);

    await tick(); // failure #1 (reset)
    assert.equal(onDead.mock.callCount(), 0);

    await tick(); // failure #2
    assert.equal(onDead.mock.callCount(), 0);

    // Still not dead — only 2 consecutive failures after reset
    assert.equal(onDead.mock.callCount(), 0);
  });

  it("handles non-OK responses as failures", async () => {
    globalThis.fetch = mock.fn(async () => {
      return { ok: false, status: 500 } as Response;
    }) as any;

    const onDead = mock.fn();
    const startWatchdog = await loadWatchdog();
    startWatchdog("http://localhost:8000/health", onDead, TEST_OPTIONS);

    const tick = intervalCallbacks[0];

    await tick();
    assert.equal(onDead.mock.callCount(), 0);

    await tick();
    assert.equal(onDead.mock.callCount(), 0);

    await tick();
    assert.equal(onDead.mock.callCount(), 1);
  });

  it("uses default options when none provided", async () => {
    globalThis.fetch = mock.fn(async () => {
      throw new Error("Connection refused");
    }) as any;

    const onDead = mock.fn();
    const startWatchdog = await loadWatchdog();
    // No options — uses defaults (startDelayMs: 60s, maxFailures: 6)
    startWatchdog("http://localhost:8000/health", onDead);

    // With default startDelayMs, setTimeout is called with 60000
    // intervalCallbacks should be empty since polling hasn't started
    assert.equal(intervalCallbacks.length, 0);
    assert.equal(timeoutCallbacks.length, 1);
    assert.equal(timeoutCallbacks[0].ms, 60_000);
  });

  it("respects custom maxFailures", async () => {
    globalThis.fetch = mock.fn(async () => {
      throw new Error("Connection refused");
    }) as any;

    const onDead = mock.fn();
    const startWatchdog = await loadWatchdog();
    startWatchdog("http://localhost:8000/health", onDead, { startDelayMs: 0, maxFailures: 2 });

    const tick = intervalCallbacks[0];

    await tick(); // failure #1
    assert.equal(onDead.mock.callCount(), 0);

    await tick(); // failure #2 → onDead (maxFailures: 2)
    assert.equal(onDead.mock.callCount(), 1);
  });
});
