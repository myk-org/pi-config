import { useEffect } from "react";
import { matchesKeybinding } from "@/hooks/useKeybindings";
import type { SessionInfo } from "@/types";

export function useKeyboardNavigation(opts: {
  streaming: boolean;
  session: SessionInfo | null;
  flatSessions: SessionInfo[];
  handleAbort: () => void;
  watchSession: (s: SessionInfo) => void;
  getKey: (id: string) => string;
  showSwitcher: boolean;
  setShowSwitcher: React.Dispatch<React.SetStateAction<boolean>>;
  showSettings: boolean;
  setShowSettings: React.Dispatch<React.SetStateAction<boolean>>;
}): void {
  const { streaming, session, flatSessions, handleAbort, watchSession, getKey, showSwitcher, setShowSwitcher, showSettings, setShowSettings } = opts;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't intercept when typing in inputs (except Escape)
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      if (matchesKeybinding(e, getKey("abort"))) {
        if (streaming && session) { e.preventDefault(); handleAbort(); }
        if (showSwitcher) { e.preventDefault(); setShowSwitcher(false); }
        if (showSettings) { e.preventDefault(); setShowSettings(false); }
        return;
      }

      if (isInput) return;

      if (matchesKeybinding(e, getKey("session-switcher"))) {
        e.preventDefault();
        setShowSwitcher(prev => !prev);
        return;
      }

      if (matchesKeybinding(e, getKey("prev-session"))) {
        e.preventDefault();
        if (flatSessions.length < 2 || !session) return;
        const idx = flatSessions.findIndex(s => s.sessionId === session.sessionId);
        const prev = idx <= 0 ? flatSessions[flatSessions.length - 1] : flatSessions[idx - 1];
        if (prev) watchSession(prev);
        return;
      }

      if (matchesKeybinding(e, getKey("next-session"))) {
        e.preventDefault();
        if (flatSessions.length < 2 || !session) return;
        const idx = flatSessions.findIndex(s => s.sessionId === session.sessionId);
        const next = idx >= flatSessions.length - 1 ? flatSessions[0] : flatSessions[idx + 1];
        if (next) watchSession(next);
        return;
      }

      for (let n = 1; n <= 9; n++) {
        if (matchesKeybinding(e, getKey(`session-${n}`))) {
          e.preventDefault();
          if (flatSessions[n - 1]) watchSession(flatSessions[n - 1]);
          return;
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [streaming, session, handleAbort, getKey, flatSessions, watchSession, showSwitcher, showSettings]);
}
