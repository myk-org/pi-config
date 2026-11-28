import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelLeftOpen, Search } from "lucide-react";
import { SessionSidebar } from "@/components/SessionSidebar";
import { InfoBar } from "@/components/InfoBar";
import { MessageList } from "@/components/MessageList";
import { InputBar } from "@/components/InputBar";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useSessions } from "@/hooks/useSessions";
import { useNotifications } from "@/hooks/useNotifications";
import { useKeybindings } from "@/hooks/useKeybindings";
import { useMessageHandler, nextId } from "@/hooks/useMessageHandler";
import { useKeyboardNavigation } from "@/hooks/useKeyboardNavigation";
import { useSidebarSessionFlags } from "@/hooks/useSidebarSessionFlags";
import { SessionSwitcher } from "@/components/SessionSwitcher";
import { KeybindingSettings } from "@/components/KeybindingSettings";
import { SidePanel, type PanelTab } from "@/components/SidePanel";
import { NewSessionDialog } from "@/components/NewSessionDialog";
import { createLogger } from "@/lib/create-logger";
import {
  DEEP_LINK_INACTIVE_PEER_SETTLE_MS,
  flattenSidebarSessions,
  formatDocumentTitle,
  isDefinitiveDeepLinkMatch,
  matchDeepLinkSession,
  parsePidashDeepLink,
  partitionSidebarSessions,
  shouldPausePromptHotkeys,
  type PidashDeepLinkTarget,
} from "@/lib/pidash-ux-helpers";
import type { SessionInfo } from "@/types";

const log = createLogger("App");

const STORAGE_KEY = "pidash-state";

function loadState(): { sidebarWidth: number; sidebarCollapsed: boolean; watchPid: number | null; watchSessionId: string | null; activePanel?: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { sidebarWidth: 280, sidebarCollapsed: false, watchPid: null, watchSessionId: null, activePanel: null };
}

function saveState(state: { sidebarWidth: number; sidebarCollapsed: boolean; watchPid: number | null; watchSessionId: string | null; activePanel?: string | null }) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

function getBrowserLocationSearch(): string {
  try {
    return typeof window !== "undefined" && typeof window.location?.search === "string"
      ? window.location.search
      : "";
  } catch {
    return "";
  }
}

export function App() {
  const { connected, send, onMessage } = useWebSocket("/ws/browser");
  const sessions = useSessions(connected, onMessage);
  const notifications = useNotifications();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const selectedSession = session && (sessions.find((candidate) => candidate.sessionId === session.sessionId) ?? session);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchType, setSearchType] = useState("all");
  const [scrollKey, setScrollKey] = useState(0);
  const keybindings = useKeybindings();
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewSession, setShowNewSession] = useState(false);
  const saved = useRef(loadState());
  const pendingDeepLinkRef = useRef<PidashDeepLinkTarget | null | undefined>(undefined);
  if (pendingDeepLinkRef.current === undefined) {
    pendingDeepLinkRef.current = parsePidashDeepLink(getBrowserLocationSearch());
    if (pendingDeepLinkRef.current) {
      log.debug("parsed URL deep-link target", pendingDeepLinkRef.current);
    }
  }
  const provisionalDeepLinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearProvisionalDeepLinkTimer = useCallback(() => {
    if (provisionalDeepLinkTimerRef.current !== null) {
      clearTimeout(provisionalDeepLinkTimerRef.current);
      provisionalDeepLinkTimerRef.current = null;
    }
  }, []);
  useEffect(() => () => {
    clearProvisionalDeepLinkTimer();
  }, [clearProvisionalDeepLinkTimer]);
  // Restore the open panel across refreshes — the user's view survives a
  // reload (not on phones, where the drawer is a full-screen overlay).
  const [activePanel, setActivePanel] = useState<PanelTab | null>(() => {
    if (typeof window !== "undefined" && window.innerWidth <= 768) return null;
    const savedPanel = saved.current.activePanel;
    return savedPanel === "tasks" || savedPanel === "worktrees" || savedPanel === "coms" || savedPanel === "memory" || savedPanel === "mcp" || savedPanel === "settings" ? savedPanel : null;
  });
  const [isMobileViewport, setIsMobileViewport] = useState(() => typeof window !== "undefined" && window.innerWidth <= 768);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(isMobileViewport ? true : saved.current.sidebarCollapsed);
  const [sidebarWidth, setSidebarWidth] = useState(saved.current.sidebarWidth);
  const {
    pinned: pinnedSessionIds,
    archived: archivedSessionIds,
    togglePin: handleTogglePin,
    toggleArchive: handleToggleArchive,
    unarchive: unarchiveSession,
  } = useSidebarSessionFlags();
  const sidebarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const onResize = () => setIsMobileViewport(window.innerWidth <= 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const restoredRef = useRef(false);
  const messageCacheRef = useRef(new Map<string, { messages: any[]; model: string; tokens: any }>());
  const MAX_CACHED_SESSIONS = 5;

  const {
    messages, setMessages, addMsg,
    model, setModel,
    tokens, setTokens,
    streaming, setStreaming,
    queuedCount, setQueuedCount,
    availableCommands,
    resetHandlerState,
    setLastUserText,
  } = useMessageHandler(onMessage, session, notifications, setSession);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(200, Math.min(500, ev.clientX));
      setSidebarWidth(w);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  const watchSession = useCallback((s: SessionInfo) => {
    if (s.sessionId === session?.sessionId) return;
    // Save current session messages to cache before switching
    if (session?.sessionId && messages.length > 0) {
      messageCacheRef.current.set(session.sessionId, { messages: [...messages], model, tokens });
      // Evict oldest if over limit
      if (messageCacheRef.current.size > MAX_CACHED_SESSIONS) {
        const oldest = messageCacheRef.current.keys().next().value;
        if (oldest) messageCacheRef.current.delete(oldest);
      }
    }
    setSession(s);
    // Check cache for instant restore
    const cached = messageCacheRef.current.get(s.sessionId);
    if (cached) {
      setMessages(cached.messages);
      setModel(cached.model || s.model || "");
      setTokens(cached.tokens);
    } else {
      setMessages([{ id: nextId(), role: "system", text: `Watching session — ${s.cwd}`, timestamp: Date.now() }]);
      setModel(s.model || "");
      setTokens(null);
    }
    // Adopt the daemon's streaming truth instead of assuming idle: a page
    // reloaded mid-turn never receives the agent_start that would have set
    // this, and the Stop button is the ONLY abort path now that no key is
    // bound to abort — guessing "idle" would strand a running turn.
    setStreaming(s.streaming === true || s.activity === "working");
    setQueuedCount(0);
    setSearchQuery("");
    setSearchType("all");
    setScrollKey(k => k + 1);
    resetHandlerState(s.sessionId);
    send({ type: "watch", sessionId: s.sessionId });
    send({ type: "pidash-command", sessionId: s.sessionId, command: "list-commands" });
    // Auto-collapse sidebar on mobile
    if (typeof window !== 'undefined' && window.innerWidth <= 768) setSidebarCollapsed(true);
  }, [send, session, messages, model, tokens, setMessages, setModel, setTokens, setStreaming, setQueuedCount, resetHandlerState]);

  const selectSession = useCallback((s: SessionInfo) => {
    if (pendingDeepLinkRef.current) {
      log.debug("clearing pending deep-link on manual session selection", {
        selectedSessionId: s.sessionId,
        cancelledTarget: pendingDeepLinkRef.current,
      });
      pendingDeepLinkRef.current = null;
    }
    clearProvisionalDeepLinkTimer();
    restoredRef.current = true;
    watchSession(s);
  }, [clearProvisionalDeepLinkTimer, watchSession]);

  const renameSession = useCallback((sessionId: string, name: string) => {
    send({ type: "pidash-command", command: "rename-session", sessionId, name });
  }, [send]);

  const hasPendingPrompt = useMemo(
    () => messages.some((m) => Boolean(m.className?.startsWith("ask|"))),
    [messages],
  );

  // Sync browser tab title with the watched session and waiting-for-input state
  useEffect(() => {
    document.title = formatDocumentTitle(selectedSession, hasPendingPrompt);
  }, [selectedSession, hasPendingPrompt]);

  useEffect(() => () => {
    document.title = "pidash";
  }, []);

  // Persist UI state to localStorage
  useEffect(() => {
    const mobile = typeof window !== 'undefined' && window.innerWidth <= 768;
    saveState({
      sidebarWidth,
      sidebarCollapsed: mobile ? true : sidebarCollapsed,
      watchPid: session?.pid ?? null,
      watchSessionId: session?.sessionId ?? null,
      activePanel,
    });
  }, [sidebarWidth, sidebarCollapsed, session, activePanel]);

  // Reset restore state on disconnect so we re-watch after server restart
  useEffect(() => {
    if (!connected) restoredRef.current = false;
  }, [connected]);

  // Re-watch the current session on every reconnect — watchSession early-returns
  // for an already-selected session, so a daemon restart would otherwise leave the
  // tab watching nothing (commands still flow, but no events come back).
  // Keyed on sessionId (not the session object): session_updated events replace
  // the object on every stream tick and must not re-fire the watch.
  const watchedSessionIdRef = useRef<string | null>(null);
  watchedSessionIdRef.current = session?.sessionId ?? null;
  useEffect(() => {
    if (connected && watchedSessionIdRef.current) {
      log.debug("watching session", { sessionId: watchedSessionIdRef.current, reconnect: true });
      send({ type: "watch", sessionId: watchedSessionIdRef.current });
      send({ type: "pidash-command", sessionId: watchedSessionIdRef.current, command: "list-commands" });
    }
  }, [connected, send]);

  useEffect(() => {
    if (!connected || !sessions.length) return;
    const pendingDeepLink = pendingDeepLinkRef.current;
    if (pendingDeepLink) {
      const matched = matchDeepLinkSession(sessions, pendingDeepLink);
      if (matched) {
        if (isDefinitiveDeepLinkMatch(matched, pendingDeepLink)) {
          log.info("deep-link matched session", {
            sessionId: matched.sessionId,
            comsName: matched.comsName ?? null,
            comsProject: matched.comsProject ?? null,
            target: pendingDeepLink,
          });
          clearProvisionalDeepLinkTimer();
          pendingDeepLinkRef.current = null;
          restoredRef.current = true;
          watchSession(matched);
          return;
        }
        if (provisionalDeepLinkTimerRef.current === null) {
          log.debug("deep-link provisionally matched inactive peer", {
            sessionId: matched.sessionId,
            comsName: matched.comsName ?? null,
            comsProject: matched.comsProject ?? null,
            settleMs: DEEP_LINK_INACTIVE_PEER_SETTLE_MS,
          });
          provisionalDeepLinkTimerRef.current = setTimeout(() => {
            provisionalDeepLinkTimerRef.current = null;
            if (pendingDeepLinkRef.current) {
              log.info("deep-link settled on inactive peer after timeout", {
                sessionId: watchedSessionIdRef.current,
                target: pendingDeepLinkRef.current,
              });
              pendingDeepLinkRef.current = null;
            }
          }, DEEP_LINK_INACTIVE_PEER_SETTLE_MS);
        }
        restoredRef.current = true;
        watchSession(matched);
        return;
      }
      // Unmatched pending deep-link: fall through to localStorage restore while
      // keeping pendingDeepLinkRef alive for late-arriving session_added/session_updated.
    }
    if (restoredRef.current || watchedSessionIdRef.current) return;
    // Restore from localStorage
    const sid = saved.current.watchSessionId;
    const pid = saved.current.watchPid;
    const s = sid ? sessions.find((x) => x.sessionId === sid) : pid ? sessions.find((x) => x.pid === pid) : null;
    if (s) { restoredRef.current = true; watchSession(s); }
  }, [connected, sessions, watchSession, clearProvisionalDeepLinkTimer]);

  const handleAbort = useCallback(() => {
    if (session) send({ type: "pidash-command", sessionId: session.sessionId, command: "abort" });
  }, [session, send]);

  const handleCompact = useCallback(() => {
    if (session) send({ type: "pidash-command", sessionId: session.sessionId, command: "compact" });
  }, [session, send]);

  // Stable identity — MessageItem is memoized and this is a prop on every
  // item; an inline arrow would defeat the memo and re-render the whole
  // list on every App render.
  const handleAskResponse = useCallback((id: string, value: string) => {
    log.debug("ask response sent", { id, confirmed: value === "__confirmed__" || value === "__denied__" ? value : "value" });
    if (value === "__confirmed__") {
      send({ type: "extension_ui_response", sessionId: sessionRefForAsk.current?.sessionId, id, confirmed: true });
    } else if (value === "__denied__") {
      send({ type: "extension_ui_response", sessionId: sessionRefForAsk.current?.sessionId, id, confirmed: false });
    } else {
      send({ type: "extension_ui_response", sessionId: sessionRefForAsk.current?.sessionId, id, value });
    }
  }, [send]);
  const sessionRefForAsk = useRef(session);
  useEffect(() => { sessionRefForAsk.current = session; }, [session]);

  const handleOpenPanel = useCallback((tab: PanelTab) => {
    setActivePanel((prev) => (prev === tab ? null : tab));
  }, []);

  const rolesRef = useRef<string[]>([]);
  const availableRoles = useMemo(() => {
    const next = [...new Set(messages.map((m) => m.role))].sort();
    const prev = rolesRef.current;
    if (prev.length === next.length && prev.every((r, i) => r === next[i])) {
      return prev;
    }
    rolesRef.current = next;
    return next;
  }, [messages]);

  const extraAttentionIds = useMemo(() => {
    if (selectedSession?.active && hasPendingPrompt) {
      return new Set([selectedSession.sessionId]);
    }
    return undefined;
  }, [selectedSession, hasPendingPrompt]);

  // Flatten sessions matching sidebar visual order: Pinned → project groups → Archived
  const flatSessions = useMemo(
    () => flattenSidebarSessions(partitionSidebarSessions(sessions, {
      pinnedIds: pinnedSessionIds,
      archivedIds: archivedSessionIds,
    })),
    [sessions, pinnedSessionIds, archivedSessionIds],
  );

  useKeyboardNavigation({
    streaming, session, flatSessions, handleAbort, watchSession: selectSession,
    getKey: keybindings.getKey,
    showSwitcher, setShowSwitcher,
    showSettings, setShowSettings,
  });

  const handleSend = useCallback((text: string, images?: Array<{ data: string; mimeType: string; filename: string }>) => {
    if (!session) return;
    unarchiveSession(session.sessionId);
    setLastUserText(text);
    addMsg("user", text + (images ? ` [+${images.length} file(s)]` : ""));
    send({ type: "prompt", sessionId: session.sessionId, text, images: images || undefined });
  }, [session, send, addMsg, setLastUserText, unarchiveSession]);

  return (
    <div className="flex w-screen overflow-hidden" style={{ height: '100dvh' }}>
      {!sidebarCollapsed && (
        <>
          {/* Mobile overlay backdrop */}
          <div
            className="fixed inset-0 bg-black/50 z-10 hidden max-md:block"
            onClick={() => setSidebarCollapsed(true)}
          />
          <div
            className="h-full min-h-0 flex-shrink-0 border-r border-border relative max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-20 max-md:w-[85vw] max-md:max-w-[320px] bg-background"
            style={{ width: typeof window !== 'undefined' && window.innerWidth <= 768 ? undefined : sidebarWidth }}
            ref={sidebarRef}
          >
            <SessionSidebar
            sessions={sessions}
            activeSessionId={session?.sessionId ?? null}
            connected={connected}
            onSelect={selectSession}
            onRename={renameSession}
            onNewSession={() => setShowNewSession(true)}
            collapsed={false}
            onToggle={() => setSidebarCollapsed(true)}
            notifications={notifications}
            onSettings={() => setShowSettings(prev => !prev)}
            pinnedSessionIds={pinnedSessionIds}
            archivedSessionIds={archivedSessionIds}
            extraAttentionIds={extraAttentionIds}
            onTogglePin={handleTogglePin}
            onToggleArchive={handleToggleArchive}
          />
          <div
            className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/30 z-10 max-md:hidden"
            onMouseDown={startResize}
          />
        </div>
        </>
      )}
      {sidebarCollapsed && (
        <div
          className="w-12 md:w-10 flex-shrink-0 border-r border-border flex flex-col items-center pt-[env(safe-area-inset-top,12px)] cursor-pointer hover:bg-accent/30"
          onClick={() => setSidebarCollapsed(false)}
          title="Expand sidebar"
        >
          <PanelLeftOpen className="h-4 w-4 text-muted-foreground" />
        </div>
      )}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {!session ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            ← Select a session
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border">
              <Search className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
              <input
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground min-w-0"
                placeholder="Search messages..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <select
                className="bg-card text-xs text-muted-foreground border border-border rounded px-1.5 py-0.5 outline-none cursor-pointer"
                value={searchType}
                onChange={(e) => setSearchType(e.target.value)}
              >
                <option value="all">All</option>
                {availableRoles.map(role => (
                  <option key={role} value={role}>{role}</option>
                ))}
              </select>
              {(searchQuery || searchType !== "all") && (
                <button className="text-muted-foreground hover:text-foreground text-xs" onClick={() => { setSearchQuery(""); setSearchType("all"); }}>✕</button>
              )}
            </div>
            <MessageList
              messages={messages}
              searchQuery={searchQuery}
              searchType={searchType}
              streaming={streaming}
              scrollKey={scrollKey}
              onAskResponse={handleAskResponse}
              promptHotkeysPaused={shouldPausePromptHotkeys({
                showSwitcher,
                showSettings,
                showNewSession,
                hasActivePanel: Boolean(activePanel),
                sidebarOpen: !sidebarCollapsed,
                isMobileViewport,
              })}
            />
            {queuedCount > 0 && (
              <div className="px-3 py-1.5 bg-yellow-500/10 border-t border-yellow-500/20 text-xs text-yellow-500 flex items-center gap-1.5">
                <span>⏳</span>
                <span>{queuedCount} prompt{queuedCount > 1 ? "s" : ""} queued — will run after current turn</span>
              </div>
            )}
            <InputBar disabled={!session.active} streaming={streaming} onSend={handleSend} onAbort={handleAbort} commands={availableCommands} />
            <InfoBar session={selectedSession!} model={model} tokens={tokens} send={send} onMessage={onMessage} activePanel={activePanel} onOpenPanel={handleOpenPanel} onCompact={handleCompact} />
          </>
        )}
      </div>

      {session && activePanel && (
        <SidePanel
          session={selectedSession!}
          activeTab={activePanel}
          onTabChange={setActivePanel}
          onClose={() => setActivePanel(null)}
          send={send}
          onMessage={onMessage}
          sessions={flatSessions}
          onWatch={selectSession}
        />
      )}

      {session && showNewSession && (
        <NewSessionDialog send={send} onMessage={onMessage} sessionId={session.sessionId} onClose={() => setShowNewSession(false)} />
      )}

      {showSettings && (
        <KeybindingSettings
          bindings={keybindings.bindings}
          onUpdate={keybindings.updateBinding}
          onReset={keybindings.resetToDefaults}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showSwitcher && (
        <SessionSwitcher
          sessions={flatSessions}
          activeSessionId={session?.sessionId ?? null}
          onSelect={selectSession}
          onClose={() => setShowSwitcher(false)}
        />
      )}
    </div>
  );
}
