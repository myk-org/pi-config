import { useCallback, useEffect, useRef, useState } from "react";
import type { Logger } from "./create-logger.ts";
import { handleWsClose, queueWsReconnect, trySendWs, wsEffectCleanup } from "./ws-helpers.ts";

export interface UseSharedWebSocketOptions {
  url: string;
  testWs?: WebSocket | null;
  reconnectMs?: number;
  logger?: Logger;
}

export function useSharedWebSocket(options: UseSharedWebSocketOptions) {
  const { url, reconnectMs = 3000, logger: log } = options;
  const skipConnect = "testWs" in options;
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(options.testWs ?? null);
  const listenersRef = useRef<Set<(ev: any) => void>>(new Set());
  // Buffer messages that arrive before any listener is registered
  const earlyMessages = useRef<any[]>([]);
  const hasListeners = useRef(false);

  const tearingDown = useRef(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (skipConnect) {
      log?.debug("ws skipConnect");
      return () => {
        log?.debug("ws skipConnect cleanup");
        setConnected(false);
      };
    }
    tearingDown.current = false;
    log?.debug("ws effect connect", { reconnectMs });
    let cancelled = false;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}${url}`;

    function connect() {
      if (cancelled || tearingDown.current) {
        log?.debug("ws connect skipped teardown", { cancelled });
        return;
      }
      log?.debug("ws connect");
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) {
          log?.debug("ws open ignored cancelled");
          return;
        }
        log?.info("ws open");
        setConnected(true);
      };
      ws.onclose = () => {
        if (cancelled) {
          log?.debug("ws close ignored cancelled");
          return;
        }
        log?.debug("ws close");
        setConnected(false);
        if (wsRef.current === ws) wsRef.current = null;
        handleWsClose(tearingDown.current, () => {
          log?.debug("ws unexpected close reconnect");
          queueWsReconnect(tearingDown, reconnectTimer, connect, reconnectMs, log);
        }, log);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (!hasListeners.current) {
            earlyMessages.current.push(data);
          } else {
            for (const cb of listenersRef.current) cb(data);
          }
        } catch {}
      };
    }

    connect();
    return () => {
      cancelled = true;
      log?.debug("ws effect cleanup");
      setConnected(false);
      wsEffectCleanup(tearingDown, wsRef.current, reconnectTimer, log);
    };
  }, [url, skipConnect, reconnectMs, log]);

  const send = useCallback((data: object) => {
    return trySendWs(wsRef.current, data, WebSocket.OPEN, log);
  }, [log]);

  const onMessage = useCallback((cb: (ev: any) => void) => {
    listenersRef.current.add(cb);

    if (!hasListeners.current) {
      hasListeners.current = true;
      if (earlyMessages.current.length > 0) {
        const buffered = earlyMessages.current.splice(0);
        queueMicrotask(() => {
          for (const msg of buffered) {
            for (const listener of listenersRef.current) listener(msg);
          }
        });
      }
    }

    return () => { listenersRef.current.delete(cb); };
  }, []);

  return { connected, send, onMessage };
}
