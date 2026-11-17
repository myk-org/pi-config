/**
 * Sidecar shutdown sequence, lifted out of `startSidecar` (issue #1126) so a
 * unit test can assert the order without a socket. Behaviour is unchanged —
 * same order, same log lines.
 *
 * The order is what keeps shutdown bounded (#1019): an open SSE feed holds its
 * socket, so the feeds are closed BEFORE waiting for connections to drain;
 * in-flight handlers are then allowed to finish before the store is disposed,
 * because disposing under a running prompt/abort races it.
 *
 * What stays in `startSidecar` is process-local state: the draining flag, the
 * watchdog/cleanup timers, memoization of concurrent shutdowns, and settling
 * the `stopped` promise.
 */
import { logger } from "./logger.js";
import { settlesWithin } from "./settle-within.js";

/** Drain timeout for shutdown (`server.close()` and the in-flight wait). */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;

/** The slice of `http.Server` the sequence touches. */
export interface ClosableServer {
  close(callback: (err?: Error) => void): unknown;
  /** Optional on old runtimes; absent means a stuck close cannot be force-dropped. */
  closeAllConnections?: () => void;
}

export interface ShutdownDeps {
  /** Goes into every log line, like the old `shutdownSidecar(reason)` argument. */
  reason: string;
  server: ClosableServer;
  /** Defaults to {@link SHUTDOWN_DRAIN_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** End open event streams. Runs first. */
  closeStreams: () => void;
  /** Resolves once in-flight handlers reach zero, or after `timeoutMs`. */
  waitForIdleRequests: (timeoutMs: number) => Promise<void>;
  disposeStore: () => Promise<void>;
}

/** Runs the shutdown sequence, never throwing: a failed teardown is logged. */
export async function performShutdown(deps: ShutdownDeps): Promise<void> {
  const { reason, server } = deps;
  const timeoutMs = deps.timeoutMs ?? SHUTDOWN_DRAIN_TIMEOUT_MS;
  logger.info(`[sidecar] SHUTDOWN_START: reason=${reason}`);
  try {
    deps.closeStreams();
  } catch (err) {
    logger.warn(`[sidecar] SHUTDOWN_STREAM_CLOSE_FAILED: reason=${reason}`, err);
  }
  // Stop accepting new connections, then wait for in-flight handlers, then
  // dispose the store. Always continue to disposeStore even if close() fails —
  // otherwise sessions and the internal AgentSessionRuntime stay undisposed.
  const closed = new Promise<void>((resolve) => {
    server.close((err) => {
      if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        logger.warn(`[sidecar] SHUTDOWN_CLOSE_FAILED: reason=${reason}`, err);
      }
      resolve();
    });
  });
  try {
    await settlesWithin(closed, timeoutMs, () => {
      logger.warn(`[sidecar] SHUTDOWN_CLOSE_TIMEOUT: reason=${reason}, waited_ms=${timeoutMs}`);
      // Force-drop remaining connections so close() can finish and disposeStore runs.
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
    });
    await deps.waitForIdleRequests(timeoutMs);
    try {
      await deps.disposeStore();
    } catch (err) {
      // Once draining, do not abort mid-shutdown — that would leave requests
      // permanently rejected with teardown incomplete.
      logger.error(`[sidecar] SHUTDOWN_DISPOSE_FAILED: reason=${reason}`, err);
    }
    logger.info(`[sidecar] SHUTDOWN_COMPLETE: reason=${reason}`);
  } catch (err) {
    logger.error(`[sidecar] SHUTDOWN_FAILED: reason=${reason}`, err);
    // Callers still settle their own promises; draining stays true.
  }
}
