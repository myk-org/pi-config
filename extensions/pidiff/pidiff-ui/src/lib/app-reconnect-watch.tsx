import { useEffect, useRef } from "react";
import { createLogger } from "./create-logger.ts";
import { restoreWatchesOnReconnect } from "./ws-send.ts";

const log = createLogger("pidiff-ui");

/** Restore session then worktree watch only when the socket reconnects. */
export function AppReconnectWatch(props: {
  connected: boolean;
  worktreePath?: string;
  sessionId?: string;
  send: (msg: object) => unknown;
}) {
  log.debug("AppReconnectWatch", { connected: props.connected });
  const wasConnected = useRef(false);
  const worktreePathRef = useRef(props.worktreePath);
  const sessionIdRef = useRef(props.sessionId);
  worktreePathRef.current = props.worktreePath;
  sessionIdRef.current = props.sessionId;
  useEffect(() => {
    log.debug("AppReconnectWatch effect", { connected: props.connected });
    restoreWatchesOnReconnect(
      props.connected,
      wasConnected.current,
      worktreePathRef.current,
      sessionIdRef.current,
      props.send,
    );
    wasConnected.current = props.connected;
  }, [props.connected, props.send]);
  return null;
}
