import { createLogger } from "./create-logger.ts";
import {
  clearWsReconnect as sharedClearWsReconnect,
  handleWsClose as sharedHandleWsClose,
  queueWsReconnect as sharedQueueWsReconnect,
  scheduleWsReconnect as sharedScheduleWsReconnect,
  trySendWs as sharedTrySendWs,
  wsEffectCleanup as sharedWsEffectCleanup,
  type WsTimerRef,
} from "../../../../shared/ui/ws-helpers.ts";

const log = createLogger("pidiff-ui");

export type { WsTimerRef };

/** Send JSON on an open socket. Returns false when the socket cannot take the payload. */
export function trySendWs(
  ws: { readyState: number; send: (payload: string) => void } | null | undefined,
  data: object,
  openState: number,
): boolean {
  return sharedTrySendWs(ws, data, openState, log);
}

/** Schedule reconnect; no-op if cleanup already ran. */
export function scheduleWsReconnect(
  tearingDown: { current: boolean },
  timer: WsTimerRef,
  connect: () => void,
  delayMs: number,
): void {
  sharedScheduleWsReconnect(tearingDown, timer, connect, delayMs, log);
}

export function clearWsReconnect(timer: WsTimerRef): void {
  sharedClearWsReconnect(timer, log);
}

/** Unexpected close: log then queue a reconnect that cleanup can cancel. */
export function queueWsReconnect(
  tearingDown: { current: boolean },
  timer: WsTimerRef,
  connect: () => void,
  delayMs: number,
): void {
  sharedQueueWsReconnect(tearingDown, timer, connect, delayMs, log);
}

/** Cleanup close must not reconnect; unexpected close must. */
export function handleWsClose(teardown: boolean, reconnect: () => void): boolean {
  return sharedHandleWsClose(teardown, reconnect, log);
}

/** useWebSocket effect cleanup: mark teardown, cancel reconnect, close socket. */
export function wsEffectCleanup(
  tearingDown: { current: boolean },
  ws: { close: () => void } | null | undefined,
  timer?: WsTimerRef,
): void {
  sharedWsEffectCleanup(tearingDown, ws, timer, log);
}

/** After reconnect, bind the active session first, then the worktree. */
export function restoreWatchMessages(
  worktreePath: string | undefined,
  sessionId: string | undefined,
): Array<{ type: string; worktreePath?: string; sessionId?: string }> {
  const msgs: Array<{ type: string; worktreePath?: string; sessionId?: string }> = [];
  if (sessionId) {
    log.debug("restoreWatchMessages session", { sessionId });
    msgs.push({ type: "watch", sessionId });
  }
  if (worktreePath) {
    log.debug("restoreWatchMessages worktree", { worktreePath });
    msgs.push({ type: "watch-worktree", worktreePath });
  }
  if (msgs.length === 0) log.debug("restoreWatchMessages skipped");
  return msgs;
}

/** App reconnect effect: send session watch, then worktree watch. */
export function runReconnectWatch(
  connected: boolean,
  worktreePath: string | undefined,
  sessionId: string | undefined,
  send: (msg: object) => unknown,
): void {
  log.info("runReconnectWatch", {
    connected,
    hasWorktree: Boolean(worktreePath),
    sessionId: sessionId || "",
  });
  if (!connected) return;
  for (const msg of restoreWatchMessages(worktreePath, sessionId)) send(msg);
}

/** Restore watches only on a disconnected→connected edge. Selection changes must not resend. */
export function restoreWatchesOnReconnect(
  connected: boolean,
  wasConnected: boolean,
  worktreePath: string | undefined,
  sessionId: string | undefined,
  send: (msg: object) => unknown,
): boolean {
  log.debug("restoreWatchesOnReconnect", { connected, wasConnected });
  if (!connected || wasConnected) return false;
  runReconnectWatch(true, worktreePath, sessionId, send);
  return true;
}

/** App.tsx reconnect useEffect body. disconnected then connected is a reconnect. */
export function appReconnectEffect(
  connected: boolean,
  worktreePath: string | undefined,
  sessionId: string | undefined,
  send: (msg: object) => unknown,
): void {
  log.debug("App reconnect effect", { connected });
  runReconnectWatch(connected, worktreePath, sessionId, send);
}
