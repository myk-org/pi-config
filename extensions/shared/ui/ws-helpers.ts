import type { Logger } from "./create-logger.ts";

export type WsTimerRef = { current: ReturnType<typeof setTimeout> | null };

/** Send JSON on an open socket. Returns false when the socket cannot take the payload. */
export function trySendWs(
  ws: { readyState: number; send: (payload: string) => void } | null | undefined,
  data: object,
  openState: number,
  log?: Logger,
): boolean {
  const type = (data as { type?: string }).type ?? "";
  const open = Boolean(ws) && ws!.readyState === openState;
  log?.debug("trySendWs", { open, type });
  if (!open || !ws) {
    log?.warn("ws send dropped", { type });
    return false;
  }
  ws.send(JSON.stringify(data));
  return true;
}

/** Schedule reconnect; no-op if cleanup already ran. */
export function scheduleWsReconnect(
  tearingDown: { current: boolean },
  timer: WsTimerRef,
  connect: () => void,
  delayMs: number,
  log?: Logger,
): void {
  log?.debug("scheduleWsReconnect", { delayMs, teardown: tearingDown.current });
  if (timer.current) clearTimeout(timer.current);
  timer.current = setTimeout(() => {
    timer.current = null;
    if (tearingDown.current) {
      log?.debug("ws reconnect aborted");
      return;
    }
    connect();
  }, delayMs);
}

export function clearWsReconnect(timer: WsTimerRef, log?: Logger): void {
  log?.debug("clearWsReconnect");
  if (timer.current) clearTimeout(timer.current);
  timer.current = null;
}

/** Unexpected close: log then queue a reconnect that cleanup can cancel. */
export function queueWsReconnect(
  tearingDown: { current: boolean },
  timer: WsTimerRef,
  connect: () => void,
  delayMs: number,
  log?: Logger,
): void {
  log?.debug("queueWsReconnect", { delayMs, teardown: tearingDown.current });
  scheduleWsReconnect(tearingDown, timer, connect, delayMs, log);
}

/** Cleanup close must not reconnect; unexpected close must. */
export function handleWsClose(teardown: boolean, reconnect: () => void, log?: Logger): boolean {
  log?.debug("handleWsClose", { teardown });
  if (teardown) {
    log?.info("ws cleanup close");
    return false;
  }
  log?.warn("ws disconnected");
  reconnect();
  return true;
}

/** useWebSocket effect cleanup: mark teardown, cancel reconnect, close socket. */
export function wsEffectCleanup(
  tearingDown: { current: boolean },
  ws: { close: () => void } | null | undefined,
  timer?: WsTimerRef,
  log?: Logger,
): void {
  tearingDown.current = true;
  if (timer) clearWsReconnect(timer, log);
  log?.info("ws cleanup");
  ws?.close();
}
