import { useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "../lib/create-logger.ts";
import { handleWsClose, queueWsReconnect, trySendWs, wsEffectCleanup } from "../lib/ws-send.ts";

const log = createLogger("pidiff-ui");

export function useWebSocket(options?: { testWs?: WebSocket | null; reconnectMs?: number }) {
  const skipConnect = Boolean(options && "testWs" in options);
  const reconnectMs = options?.reconnectMs ?? 3000;
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(options?.testWs ?? null);
  const listenersRef = useRef<Set<(ev: any) => void>>(new Set());
  // Buffer messages that arrive before any listener is registered
  const earlyMessages = useRef<any[]>([]);
  const hasListeners = useRef(false);

  const tearingDown = useRef(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (skipConnect) {
      log.debug("ws skipConnect");
      return () => {
        log.debug("ws skipConnect cleanup");
        setConnected(false);
      };
    }
    tearingDown.current = false;
    log.debug("ws effect connect", { reconnectMs });
    let cancelled = false;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws/browser`;

    function connect() {
      if (cancelled || tearingDown.current) {
        log.debug("ws connect skipped teardown", { cancelled });
        return;
      }
      log.debug("ws connect");
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) {
          log.debug("ws open ignored cancelled");
          return;
        }
        log.info("ws open");
        setConnected(true);
      };
      ws.onclose = () => {
        if (cancelled) {
          log.debug("ws close ignored cancelled");
          return;
        }
        log.debug("ws close");
        setConnected(false);
        if (wsRef.current === ws) wsRef.current = null;
        handleWsClose(tearingDown.current, () => {
          log.debug("ws unexpected close reconnect");
          queueWsReconnect(tearingDown, reconnectTimer, connect, reconnectMs);
        });
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (!hasListeners.current) {
            // No listeners yet — buffer for replay
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
      log.debug("ws effect cleanup");
      setConnected(false);
      wsEffectCleanup(tearingDown, wsRef.current, reconnectTimer);
    };
  }, [skipConnect, reconnectMs]);

  const send = useCallback((data: object) => {
    return trySendWs(wsRef.current, data, WebSocket.OPEN);
  }, []);

  const onMessage = useCallback((cb: (ev: any) => void) => {
    listenersRef.current.add(cb);

    // First listener — replay any buffered early messages
    if (!hasListeners.current) {
      hasListeners.current = true;
      if (earlyMessages.current.length > 0) {
        const buffered = earlyMessages.current.splice(0);
        // Use microtask to ensure React state updates batch properly
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
