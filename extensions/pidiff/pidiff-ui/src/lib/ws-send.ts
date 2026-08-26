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

/** After reconnect, restore the selected worktree watch or the session root watch. */
export function restoreWatchMessage(
  worktreePath: string | undefined,
  sessionId: string | undefined,
): { type: string; worktreePath?: string; sessionId?: string } | null {
  if (worktreePath) {
    log.info("restoreWatchMessage worktree", { worktreePath });
    return { type: "watch-worktree", worktreePath };
  }
  if (sessionId) {
    log.info("restoreWatchMessage session", { sessionId });
    return { type: "watch", sessionId };
  }
  log.debug("restoreWatchMessage skipped");
  return null;
}
