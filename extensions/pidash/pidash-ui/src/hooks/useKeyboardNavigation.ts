import { useEffect, type Dispatch, type SetStateAction } from "react";
import { isAbortKey, matchesKeybinding } from "@/hooks/useKeybindings";
import type { SessionInfo } from "@/types";
import { createLogger } from "../lib/create-logger";

const log = createLogger("KeyboardNavigation");

export function useKeyboardNavigation(opts: {
  streaming: boolean;
  session: SessionInfo | null;
  flatSessions: SessionInfo[];
  handleAbort: () => void;
  watchSession: (s: SessionInfo) => void;
  getKey: (id: string) => string;
  showSwitcher: boolean;
  setShowSwitcher: Dispatch<SetStateAction<boolean>>;
  showSettings: boolean;
  setShowSettings: Dispatch<SetStateAction<boolean>>;
}): void {
  const { streaming, session, flatSessions, handleAbort, watchSession, getKey, showSwitcher, setShowSwitcher, showSettings, setShowSettings } = opts;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't intercept when typing in inputs (except Escape)
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      // Overlay dismissal is independent of any binding: Escape always closes an
      // open dialog (this used to live inside the abort branch, so unbinding
      // abort silently made the shortcuts dialog uncloseable by keyboard).
      // KeybindingSettings cancels a recording in the CAPTURE phase and stops
      // propagation, so Escape during recording still cancels only the capture.
      if (e.key === "Escape" && (showSwitcher || showSettings)) {
        log.debug("escape closed an overlay", { switcher: showSwitcher, settings: showSettings });
        e.preventDefault();
        if (showSwitcher) setShowSwitcher(false);
        if (showSettings) setShowSettings(false);
        return;
      }

      // Abort is unbound by default, so this never fires on Escape (menus
      // dismiss with it constantly); the composer's Stop button aborts.
      if (isAbortKey(e, getKey("abort"))) {
        log.debug("abort key matched", { streaming, sessionId: session?.sessionId ?? null, aborted: Boolean(streaming && session) });
        if (streaming && session) { e.preventDefault(); handleAbort(); }
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
