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
    log.info("restoreWatchMessages session", { sessionId });
    msgs.push({ type: "watch", sessionId });
  }
  if (worktreePath) {
    log.info("restoreWatchMessages worktree", { worktreePath });
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
