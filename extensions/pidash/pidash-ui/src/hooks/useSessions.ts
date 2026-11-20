import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionInfo } from "../types";

export function useSessions(wsConnected: boolean, onMessage: (h: (d: any) => void) => () => void) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const sessionsRef = useRef<SessionInfo[]>(sessions);
  sessionsRef.current = sessions;

  const load = useCallback(async () => {
    try {
      const next: SessionInfo[] = await (await fetch("/api/sessions")).json();
      if (JSON.stringify(next) === JSON.stringify(sessionsRef.current)) return;
      setSessions(next);
    } catch {}
  }, []);

  useEffect(() => { if (wsConnected) load(); }, [wsConnected, load]);

  useEffect(() => {
    return onMessage((ev) => {
      if (ev.type === "session_added" || ev.type === "session_removed") load();
      if (ev.type === "session_updated" && ev.session) {
        setSessions((prev) => prev.map((s) =>
          s.sessionId === ev.session.sessionId ? { ...s, ...ev.session } : s
        ));
      }
    });
  }, [onMessage, load]);

  useEffect(() => {
    if (wsConnected) return;
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [wsConnected, load]);

  return sessions;
}
