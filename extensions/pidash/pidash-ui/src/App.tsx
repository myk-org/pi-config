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
import { SessionSwitcher } from "@/components/SessionSwitcher";
import { KeybindingSettings } from "@/components/KeybindingSettings";
import type { SessionInfo } from "@/types";

const STORAGE_KEY = "pidash-state";

function loadState(): { sidebarWidth: number; sidebarCollapsed: boolean; watchPid: number | null; watchSessionId: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { sidebarWidth: 280, sidebarCollapsed: false, watchPid: null, watchSessionId: null };
}

function saveState(state: { sidebarWidth: number; sidebarCollapsed: boolean; watchPid: number | null; watchSessionId: string | null }) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

export function App() {
  const { connected, send, onMessage } = useWebSocket("/ws/browser");
  const sessions = useSessions(connected, onMessage);
  const notifications = useNotifications();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchType, setSearchType] = useState("all");
  const [scrollKey, setScrollKey] = useState(0);
  const keybindings = useKeybindings();
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const saved = useRef(loadState());
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(isMobile ? true : saved.current.sidebarCollapsed);
  const [sidebarWidth, setSidebarWidth] = useState(saved.current.sidebarWidth);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const restoredRef = useRef(false);

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
    setSession(s);
    setMessages([{ id: nextId(), role: "system", text: `Watching session — ${s.cwd}`, timestamp: Date.now() }]);
    setModel(s.model || "");
    setTokens(null);
    setStreaming(false);
    setQueuedCount(0);
    setSearchQuery("");
    setSearchType("all");
    setScrollKey(k => k + 1);
    resetHandlerState();
    send({ type: "watch", sessionId: s.sessionId });
    send({ type: "pidash-command", sessionId: s.sessionId, command: "list-commands" });
    // Auto-collapse sidebar on mobile
    if (typeof window !== 'undefined' && window.innerWidth <= 768) setSidebarCollapsed(true);
  }, [send, setMessages, setModel, setTokens, setStreaming, setQueuedCount, resetHandlerState]);

  // Persist UI state to localStorage
  useEffect(() => {
    const mobile = typeof window !== 'undefined' && window.innerWidth <= 768;
    saveState({
      sidebarWidth,
      sidebarCollapsed: mobile ? true : sidebarCollapsed,
      watchPid: session?.pid ?? null,
      watchSessionId: session?.sessionId ?? null,
    });
  }, [sidebarWidth, sidebarCollapsed, session]);

  // Reset restore state on disconnect so we re-watch after server restart
  useEffect(() => {
    if (!connected) restoredRef.current = false;
  }, [connected]);

  useEffect(() => {
    if (!connected || !sessions.length || restoredRef.current) return;
    // Restore from localStorage
    const sid = saved.current.watchSessionId;
    const pid = saved.current.watchPid;
    const s = sid ? sessions.find((x) => x.sessionId === sid) : pid ? sessions.find((x) => x.pid === pid) : null;
    if (s) { restoredRef.current = true; watchSession(s); }
  }, [connected, sessions, watchSession]);

  const handleAbort = useCallback(() => {
    if (session) send({ type: "pidash-command", sessionId: session.sessionId, command: "abort" });
  }, [session, send]);

  // Flatten sessions matching sidebar order: active groups first, then alphabetical, active sessions first within groups
  const flatSessions = useMemo(() => {
    const groups = new Map<string, SessionInfo[]>();
    for (const s of sessions) {
      const name = (s.cwd || "").split("/").pop() || s.cwd;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(s);
    }
    // Sort within groups: active first
    for (const g of groups.values()) {
      g.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
    }
    // Sort groups: active groups first, then alphabetical
    const sorted = [...groups.entries()].sort((a, b) => {
      const aActive = a[1].some(s => s.active);
      const bActive = b[1].some(s => s.active);
      if (aActive !== bActive) return bActive ? 1 : -1;
      return a[0].localeCompare(b[0]);
    });
    return sorted.flatMap(([, sessions]) => sessions);
  }, [sessions]);

  useKeyboardNavigation({
    streaming, session, flatSessions, handleAbort, watchSession,
    getKey: keybindings.getKey,
    showSwitcher, setShowSwitcher,
    showSettings, setShowSettings,
  });

  const handleSend = useCallback((text: string, images?: Array<{ data: string; mimeType: string; filename: string }>) => {
    if (!session) return;
    setLastUserText(text);
    addMsg("user", text + (images ? ` [+${images.length} file(s)]` : ""));
    send({ type: "prompt", sessionId: session.sessionId, text, images: images || undefined });
  }, [session, send, addMsg, setLastUserText]);

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
            className="flex-shrink-0 border-r border-border relative max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-20 max-md:w-[85vw] max-md:max-w-[320px] bg-background"
            style={{ width: typeof window !== 'undefined' && window.innerWidth <= 768 ? undefined : sidebarWidth }}
            ref={sidebarRef}
          >
            <SessionSidebar
            sessions={sessions}
            activeSessionId={session?.sessionId ?? null}
            connected={connected}
            onSelect={watchSession}
            collapsed={false}
            onToggle={() => setSidebarCollapsed(true)}
            notifications={notifications}
            onSettings={() => setShowSettings(prev => !prev)}
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
                {[...new Set(messages.map(m => m.role))].sort().map(role => (
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
              onAskResponse={(id, value) => {
                if (value === "__confirmed__") {
                  send({ type: "extension_ui_response", sessionId: session!.sessionId, id, confirmed: true });
                } else if (value === "__denied__") {
                  send({ type: "extension_ui_response", sessionId: session!.sessionId, id, confirmed: false });
                } else {
                  send({ type: "extension_ui_response", sessionId: session!.sessionId, id, value });
                }
              }}
            />
            {queuedCount > 0 && (
              <div className="px-3 py-1.5 bg-yellow-500/10 border-t border-yellow-500/20 text-xs text-yellow-500 flex items-center gap-1.5">
                <span>⏳</span>
                <span>{queuedCount} prompt{queuedCount > 1 ? "s" : ""} queued — will run after current turn</span>
              </div>
            )}
            <InputBar disabled={!session.active} streaming={streaming} onSend={handleSend} onAbort={handleAbort} commands={availableCommands} />
            <InfoBar session={session} model={model} tokens={tokens} send={send} onMessage={onMessage} />
          </>
        )}
      </div>

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
          onSelect={watchSession}
          onClose={() => setShowSwitcher(false)}
        />
      )}
    </div>
  );
}
