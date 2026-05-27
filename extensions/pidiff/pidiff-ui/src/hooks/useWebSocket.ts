import { useCallback, useEffect, useRef, useState } from "react";

export function useWebSocket() {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<Set<(ev: any) => void>>(new Set());
  // Buffer messages that arrive before any listener is registered
  const earlyMessages = useRef<any[]>([]);
  const hasListeners = useRef(false);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws/browser`;

    function connect() {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        setTimeout(connect, 3000);
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
    return () => { wsRef.current?.close(); };
  }, []);

  const send = useCallback((data: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
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
