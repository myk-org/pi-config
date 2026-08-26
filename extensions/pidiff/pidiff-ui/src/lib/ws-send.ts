import { createLogger } from "./create-logger.ts";

const log = createLogger("pidiff-ui");

/** Send JSON on an open socket. Returns false when the socket cannot take the payload. */
export function trySendWs(
  ws: { readyState: number; send: (payload: string) => void } | null | undefined,
  data: object,
  openState: number,
): boolean {
  const type = (data as { type?: string }).type ?? "";
  const open = Boolean(ws) && ws!.readyState === openState;
  log.debug("trySendWs", { open, type });
  if (!open || !ws) {
    log.warn("ws send dropped", { type });
    return false;
  }
  ws.send(JSON.stringify(data));
  return true;
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

export type WsTimerRef = { current: ReturnType<typeof setTimeout> | null };

/** Schedule reconnect; no-op if cleanup already ran. */
export function scheduleWsReconnect(
  tearingDown: { current: boolean },
  timer: WsTimerRef,
  connect: () => void,
  delayMs: number,
): void {
  log.debug("scheduleWsReconnect", { delayMs, teardown: tearingDown.current });
  if (timer.current) clearTimeout(timer.current);
  timer.current = setTimeout(() => {
    timer.current = null;
    if (tearingDown.current) {
      log.debug("ws reconnect aborted");
      return;
    }
    connect();
  }, delayMs);
}

export function clearWsReconnect(timer: WsTimerRef): void {
  log.debug("clearWsReconnect");
  if (timer.current) clearTimeout(timer.current);
  timer.current = null;
}

/** Cleanup close must not reconnect; unexpected close must. */
export function handleWsClose(teardown: boolean, reconnect: () => void): boolean {
  log.debug("handleWsClose", { teardown });
  if (teardown) {
    log.info("ws cleanup close");
    return false;
  }
  log.warn("ws disconnected");
  reconnect();
  return true;
}

/** useWebSocket effect cleanup: mark teardown, cancel reconnect, close socket. */
export function wsEffectCleanup(
  tearingDown: { current: boolean },
  ws: { close: () => void } | null | undefined,
  timer?: WsTimerRef,
): void {
  tearingDown.current = true;
  if (timer) clearWsReconnect(timer);
  log.info("ws cleanup");
  ws?.close();
}
