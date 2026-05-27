import { useCallback, useEffect, useState } from "react";
import type { SessionInfo } from "../types";

export function useSessions(wsConnected: boolean, onMessage: (h: (d: any) => void) => () => void) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  const load = useCallback(async () => {
    try {
      setSessions(await (await fetch("/api/sessions")).json());
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

  useEffect(() => { const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);

  return sessions;
}
