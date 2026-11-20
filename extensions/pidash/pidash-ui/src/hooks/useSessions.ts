import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionInfo } from "../types";

const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 10000;

export function useSessions(wsConnected: boolean, onMessage: (h: (d: any) => void) => () => void) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const sessionsRef = useRef<SessionInfo[]>(sessions);
  sessionsRef.current = sessions;
  const inFlightRef = useRef(false);
  const pendingReloadRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(RETRY_BASE_MS);
  const mountedRef = useRef(true);
  const wsConnectedRef = useRef(wsConnected);
  wsConnectedRef.current = wsConnected;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, []);

  const load = useCallback(async () => {
    if (inFlightRef.current) {
      pendingReloadRef.current = true;
      return;
    }
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    inFlightRef.current = true;
    try {
      const res = await fetch("/api/sessions");
      if ("ok" in res && !res.ok) throw new Error(`HTTP ${res.status}`);
      const next: SessionInfo[] = await res.json();
      if (!mountedRef.current) return;
      retryDelayRef.current = RETRY_BASE_MS;
      if (JSON.stringify(next) !== JSON.stringify(sessionsRef.current)) {
        setSessions(next);
      }
    } catch {
      if (mountedRef.current && wsConnectedRef.current) {
        const delay = retryDelayRef.current;
        retryDelayRef.current = Math.min(delay * 2, RETRY_MAX_MS);
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          if (mountedRef.current) void load();
        }, delay);
      }
    } finally {
      inFlightRef.current = false;
      if (pendingReloadRef.current && mountedRef.current) {
        pendingReloadRef.current = false;
        void load();
      }
    }
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
