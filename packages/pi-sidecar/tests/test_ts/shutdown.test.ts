/**
 * Sidecar shutdown sequence (#1126): `performShutdown` runs the order
 * `startSidecar` used inline, so a regression — streams not closed first, a
 * mis-wired timeout, a dispose that never runs — fails here without a socket.
 * Every dependency is a fake; nothing binds a port or spawns a process.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { logger } from "../../src/logger.js";
import {
  performShutdown,
  SHUTDOWN_DRAIN_TIMEOUT_MS,
  type ClosableServer,
  type ShutdownDeps,
} from "../../src/shutdown.js";

/** Capture the `[sidecar] SHUTDOWN_*` lines the sequence must keep emitting. */
function stubLogger(): { lines: string[]; restore: () => void } {
  const orig = { info: logger.info, warn: logger.warn, error: logger.error, debug: logger.debug };
  const lines: string[] = [];
  const capture = (...args: unknown[]) => { lines.push(String(args[0])); };
  logger.info = capture;
  logger.warn = capture;
  logger.error = capture;
  logger.debug = capture;
  return {
    lines,
    restore: () => {
      logger.info = orig.info;
      logger.warn = orig.warn;
      logger.error = orig.error;
      logger.debug = orig.debug;
    },
  };
}

/**
 * Deps double: each step appends to `order`. `hang` makes `server.close()` call
 * back only when force-dropped — the connection that never closes on its own.
 */
function fakeDeps(
  order: string[],
  { hang = false, closeError, ...overrides }: Partial<ShutdownDeps> & { hang?: boolean; closeError?: Error } = {},
) {
  const calls: string[] = [];
  const server: ClosableServer = {
    close(callback) {
      calls.push("server.close");
      order.push("server.close");
      if (!hang) callback(closeError);
      return undefined;
    },
    closeAllConnections() {
      calls.push("server.closeAllConnections");
      order.push("server.closeAllConnections");
    },
  };
  const deps: ShutdownDeps = {
    reason: "close",
    server,
    timeoutMs: 1_000,
    closeStreams: () => { order.push("closeStreams"); },
    waitForIdleRequests: async (timeoutMs) => { order.push(`waitForIdleRequests:${timeoutMs}`); },
    disposeStore: async () => { order.push("disposeStore"); },
    ...overrides,
  };
  return { deps, calls };
}

/** `performShutdown` with the log capture around it. */
async function shutdownWithLogs(deps: ShutdownDeps): Promise<string[]> {
  const log = stubLogger();
  try {
    await performShutdown(deps);
  } finally {
    log.restore();
  }
  return log.lines;
}

describe("performShutdown (#1126)", () => {
  it("closes the streams first, then the server, then waits for in-flight requests, then disposes", async () => {
    const order: string[] = [];
    const { deps, calls } = fakeDeps(order);

    const lines = await shutdownWithLogs(deps);

    // An open SSE feed holds its socket, so closing the feeds before waiting
    // for connections is what keeps shutdown off the drain timeout (#1019).
    // Disposing before in-flight handlers finish races prompt/abort.
    assert.deepEqual(order, ["closeStreams", "server.close", "waitForIdleRequests:1000", "disposeStore"]);
    assert.deepEqual(calls, ["server.close"], "no force-drop when the server closes on its own");
    assert.deepEqual(lines, [
      "[sidecar] SHUTDOWN_START: reason=close",
      "[sidecar] SHUTDOWN_COMPLETE: reason=close",
    ]);
  });

  it("force-drops a connection that never closes, once, at the timeout — and still disposes", async () => {
    const order: string[] = [];
    const { deps, calls } = fakeDeps(order, { hang: true, timeoutMs: 20, reason: "watchdog" });

    const started = Date.now();
    const lines = await shutdownWithLogs(deps);
    const elapsed = Date.now() - started;

    assert.deepEqual(calls, ["server.close", "server.closeAllConnections"], "exactly one force-drop, not a loop");
    assert.deepEqual(
      order,
      ["closeStreams", "server.close", "server.closeAllConnections", "waitForIdleRequests:20", "disposeStore"],
      "the force-drop happens before the idle wait, and teardown continues",
    );
    assert.ok(elapsed >= 20, `the wait honours its timeout (took ${elapsed}ms)`);
    assert.ok(elapsed < 5_000, `a stuck connection must not hang shutdown (took ${elapsed}ms)`);
    assert.deepEqual(lines, [
      "[sidecar] SHUTDOWN_START: reason=watchdog",
      "[sidecar] SHUTDOWN_CLOSE_TIMEOUT: reason=watchdog, waited_ms=20",
      "[sidecar] SHUTDOWN_COMPLETE: reason=watchdog",
    ]);
  });

  it("keeps the spec's 30s drain timeout as the default", async () => {
    assert.equal(SHUTDOWN_DRAIN_TIMEOUT_MS, 30_000);
    const order: string[] = [];
    const { deps } = fakeDeps(order, { timeoutMs: undefined });
    await shutdownWithLogs(deps);
    assert.deepEqual(order, ["closeStreams", "server.close", "waitForIdleRequests:30000", "disposeStore"]);
  });

  it("a throwing closeStreams is logged and the teardown continues", async () => {
    const order: string[] = [];
    const { deps } = fakeDeps(order, {
      closeStreams: () => { throw new Error("stream hub exploded"); },
    });
    const lines = await shutdownWithLogs(deps);
    assert.deepEqual(order, ["server.close", "waitForIdleRequests:1000", "disposeStore"]);
    assert.ok(
      lines.includes("[sidecar] SHUTDOWN_STREAM_CLOSE_FAILED: reason=close"),
      `expected a stream-close failure line, got ${JSON.stringify(lines)}`,
    );
    assert.equal(lines.at(-1), "[sidecar] SHUTDOWN_COMPLETE: reason=close");
  });

  it("a failing dispose is logged, swallowed, and shutdown still completes", async () => {
    const order: string[] = [];
    const { deps } = fakeDeps(order, {
      disposeStore: async () => { throw new Error("dispose failed"); },
    });
    const lines = await shutdownWithLogs(deps);
    assert.deepEqual(order, ["closeStreams", "server.close", "waitForIdleRequests:1000"], "dispose ran and threw");
    assert.ok(
      lines.includes("[sidecar] SHUTDOWN_DISPOSE_FAILED: reason=close"),
      `expected a dispose failure line, got ${JSON.stringify(lines)}`,
    );
    assert.equal(lines.at(-1), "[sidecar] SHUTDOWN_COMPLETE: reason=close");
  });

  it("warns about a server close error, except ERR_SERVER_NOT_RUNNING", async () => {
    for (const [code, warned] of [["EIO", true], ["ERR_SERVER_NOT_RUNNING", false]] as const) {
      const order: string[] = [];
      const { deps } = fakeDeps(order, { closeError: Object.assign(new Error(code), { code }) });
      const lines = await shutdownWithLogs(deps);
      assert.deepEqual(order, ["closeStreams", "server.close", "waitForIdleRequests:1000", "disposeStore"]);
      assert.equal(
        lines.includes("[sidecar] SHUTDOWN_CLOSE_FAILED: reason=close"),
        warned,
        `code=${code}: ${JSON.stringify(lines)}`,
      );
    }
  });
});
