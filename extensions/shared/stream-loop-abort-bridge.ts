/**
 * Cross-extension bridge coordinating stream-loop aborts with COMS (#1374).
 *
 * The orchestrator's stream-loop guard calls `ctx.abort()` when a provider
 * degenerates mid-stream, while COMS finalizes active inbound peer requests on
 * `turn_end` / `agent_end`. Keyed per session via `session-bridge-map` so
 * concurrent sessions in multi-session hosts (`pi-sidecar`) stay isolated.
 */
import { createLogger } from "./logger.js";
import {
  clearBridgeSessionEntry,
  getBridgeSessionEntry,
  resetBridgeMapForTests,
  setBridgeSessionEntry,
} from "./session-bridge-map.js";

const log = createLogger("stream-loop-abort-bridge");

export const STREAM_LOOP_ABORT_BRIDGE_SYMBOL = Symbol.for("pi-config.streamLoopAbortBridge");

/** Record that the active assistant turn in `sessionKey` was aborted by stream-loop-guard. */
export function markStreamLoopAborted(sessionKey?: string): void {
  setBridgeSessionEntry(STREAM_LOOP_ABORT_BRIDGE_SYMBOL, true, sessionKey);
  log.debug("stream_loop_abort_marked", { sessionKey });
}

/** Check whether `sessionKey` currently has an unconsumed stream-loop abort mark. */
export function hasStreamLoopAborted(sessionKey?: string): boolean {
  return getBridgeSessionEntry<boolean>(STREAM_LOOP_ABORT_BRIDGE_SYMBOL, sessionKey) === true;
}

/** Consume and clear the stream-loop abort mark for `sessionKey`, returning true if it was set. */
export function consumeStreamLoopAborted(sessionKey?: string): boolean {
  if (!hasStreamLoopAborted(sessionKey)) return false;
  clearBridgeSessionEntry(STREAM_LOOP_ABORT_BRIDGE_SYMBOL, sessionKey);
  log.debug("stream_loop_abort_consumed", { sessionKey });
  return true;
}

/** Clear any stream-loop abort mark for `sessionKey`. */
export function clearStreamLoopAborted(sessionKey?: string): void {
  clearBridgeSessionEntry(STREAM_LOOP_ABORT_BRIDGE_SYMBOL, sessionKey);
}

/** Wipe the global stream-loop abort bridge map between tests. */
export function resetStreamLoopAbortBridgeForTests(): void {
  resetBridgeMapForTests(STREAM_LOOP_ABORT_BRIDGE_SYMBOL);
}
