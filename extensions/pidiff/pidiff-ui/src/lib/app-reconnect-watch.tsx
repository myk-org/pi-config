import { useEffect, type DependencyList, type EffectCallback } from "react";
import { createLogger } from "./create-logger.ts";
import { appReconnectEffect } from "./ws-send.ts";

const log = createLogger("pidiff-ui");

export type EffectHook = (effect: EffectCallback, deps?: DependencyList) => void;

/** App reconnect watch: runs the same effect App mounts on connected changes. */
export function AppReconnectWatch(props: {
  connected: boolean;
  worktreePath?: string;
  sessionId?: string;
  send: (msg: object) => unknown;
  effectHook?: EffectHook;
}) {
  log.debug("AppReconnectWatch", { connected: props.connected });
  const effectHook = props.effectHook ?? useEffect;
  effectHook(() => {
    appReconnectEffect(props.connected, props.worktreePath, props.sessionId, props.send);
  }, [props.connected, props.worktreePath, props.sessionId, props.send]);
  return null;
}
