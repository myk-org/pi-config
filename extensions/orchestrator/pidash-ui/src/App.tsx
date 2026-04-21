import { useCallback, useEffect, useRef, useState } from "react";
import { PanelLeftOpen, Search } from "lucide-react";
import { SessionSidebar } from "@/components/SessionSidebar";
import { InfoBar } from "@/components/InfoBar";
import { MessageList } from "@/components/MessageList";
import { InputBar } from "@/components/InputBar";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useSessions } from "@/hooks/useSessions";
import type { ChatMessage, PiEvent, SessionInfo, TokenUsage } from "@/types";

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

let counter = 0;
const nextId = () => `m-${++counter}`;
const textFrom = (msg: any): string =>
  (msg?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

export function App() {
  const { connected, send, onMessage } = useWebSocket("/ws/browser");
  const sessions = useSessions(connected, onMessage);

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [model, setModel] = useState("");
  const [tokens, setTokens] = useState<TokenUsage | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchType, setSearchType] = useState("all");
  const [scrollKey, setScrollKey] = useState(0);
  const [availableCommands, setAvailableCommands] = useState<Array<{ name: string; description: string }>>([]);
  const saved = useRef(loadState());
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(isMobile ? true : saved.current.sidebarCollapsed);

  const [sidebarWidth, setSidebarWidth] = useState(saved.current.sidebarWidth);
  const sidebarRef = useRef<HTMLDivElement>(null);

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

  const thinkRef = useRef({ id: "", text: "" });
  const assistRef = useRef({ id: "", text: "" });
  const lastUserRef = useRef("");
  const toolRef = useRef({ id: "", name: "", startTs: 0, callId: "" });
  const restoredRef = useRef(false);
  const replayingRef = useRef(false);

  const addMsg = useCallback((role: ChatMessage["role"], text: string, className?: string): string => {
    const id = nextId();
    setMessages((p) => [...p, { id, role, text, className }]);
    return id;
  }, []);

  const updMsg = useCallback((id: string, text: string) => {
    setMessages((p) => p.map((m) => m.id === id ? { ...m, text } : m));
  }, []);

  const updCls = useCallback((id: string, className?: string) => {
    setMessages((p) => p.map((m) => m.id === id ? { ...m, className } : m));
  }, []);

  useEffect(() => {
    return onMessage((ev: PiEvent) => {
      if (ev.type === "session_added" || ev.type === "session_removed") return;
          if (ev.type === "session_updated" && ev.session) {
            // Update active session if it's the one we're watching
            setSession((prev) => {
              if (prev?.sessionId === ev.session.sessionId) {
                if (ev.session.model !== undefined) setModel(ev.session.model);
                return { ...prev, ...ev.session };
              }
              return prev;
            });
            return;
          }

      switch (ev.type) {
        case "agent_start": setStreaming(true); break;
        case "agent_end":
          setStreaming(false);
          thinkRef.current = { id: "", text: "" };
          assistRef.current = { id: "", text: "" };
          lastUserRef.current = "";
          break;

        case "message_start": {
          const msg = ev.message;
          if (!msg) break;
          if (msg.role === "user") {
            const t = textFrom(msg);
            if (t && t !== lastUserRef.current) { lastUserRef.current = t; addMsg("user", t); }
          }
          if (msg.role === "assistant") {
            thinkRef.current = { id: "", text: "" };
            assistRef.current = { id: "", text: "" };
          }
          if (msg.role === "custom" && msg.display) {
            const content = msg.content || "";
            addMsg("system", typeof content === "string" ? content : JSON.stringify(content));
          }
          break;
        }

        case "message_update": {
          const ae = ev.assistantMessageEvent;
          if (!ae) break;
          if (ae.type === "thinking_delta" && ae.delta) {
            thinkRef.current.text += ae.delta;
            if (!thinkRef.current.id) thinkRef.current.id = addMsg("thinking", thinkRef.current.text);
            else updMsg(thinkRef.current.id, thinkRef.current.text);
          }
          if ((ae.type === "text_start" || ae.type === "text_delta") && thinkRef.current.id && !assistRef.current.id) {
            updCls(thinkRef.current.id, undefined);
          }
          if (ae.type === "text_delta" && ae.delta) {
            assistRef.current.text += ae.delta;
            if (!assistRef.current.id) assistRef.current.id = addMsg("assistant", assistRef.current.text, "streaming");
            else updMsg(assistRef.current.id, assistRef.current.text);
          }
          if (ae.type === "text_end" && assistRef.current.id) updCls(assistRef.current.id, undefined);
          const p = ae.partial;
          if (p?.model) setModel(p.model);
          if (p?.usage) setTokens({ ...p.usage });
          break;
        }

        case "message_end":
          if (thinkRef.current.id) updCls(thinkRef.current.id, undefined);
          if (assistRef.current.id) updCls(assistRef.current.id, undefined);
          thinkRef.current = { id: "", text: "" };
          assistRef.current = { id: "", text: "" };
          if (ev.message?.model) setModel(ev.message.model);
          if (ev.message?.usage) setTokens({ ...ev.message.usage });
          break;

        case "turn_end":
          if (ev.message?.model) setModel(ev.message.model);
          if (ev.message?.usage) setTokens({ ...ev.message.usage });
          break;

        case "tool_execution_start": {
          let name = ev.toolName || "tool";
          let detail = ev.args?.command ? ev.args.command : "";
          // Show agent name for subagent tool calls
          if (name === "subagent" && ev.args) {
            const label = ev.args.name || ev.args.agent;
            if (label) name = `subagent (${label})`;
            if (ev.args.asyncKill) detail = `kill: ${ev.args.asyncKill}`;
            else if (ev.args.task) detail = ev.args.task.slice(0, 150);
            else if (ev.args.tasks) detail = `${ev.args.tasks.length} parallel tasks`;
            else if (ev.args.chain) detail = `${ev.args.chain.length} chain steps`;
          }
          const cid = ev.toolCallId || nextId();
          const id = nextId();
          setMessages((p) => [...p, { id, role: name as any, text: detail, className: "tool-call", meta: { callId: cid } }]);
          toolRef.current = { id, name, startTs: ev.timestamp || Date.now(), callId: cid };
          break;
        }

        case "tool_execution_update":
          if (toolRef.current.id && ev.partialResult?.content?.[0]?.text) {
            updMsg(toolRef.current.id, `${toolRef.current.name}: ${ev.partialResult.content[0].text}`);
          }
          break;

        case "tool_execution_end": {
          const toolName = toolRef.current.name || ev.toolName || "tool";
          const startTs = toolRef.current.startTs;
          const callId = toolRef.current.callId;
          toolRef.current = { id: "", name: "", startTs: 0, callId: "" };
          if (ev.result?.content?.[0]?.text) {
            const t = ev.result.content[0].text;
            const endTs = ev.timestamp || Date.now();
            let meta: ChatMessage["meta"] = startTs ? { startTs, endTs, callId } : { callId };
            const results = ev.result?.details?.results;
            if (results?.length) {
              let totalInput = 0, totalOutput = 0, totalTurns = 0, totalCache = 0, totalCtx = 0, totalCost = 0;
              for (const res of results) {
                if (res.usage) {
                  totalInput += res.usage.input || 0;
                  totalOutput += res.usage.output || 0;
                  totalTurns += res.usage.turns || 0;
                  totalCache += res.usage.cacheRead || 0;
                  totalCtx += res.usage.contextTokens || 0;
                  totalCost += res.usage.cost || 0;
                }
              }
              meta = {
                ...meta,
                turns: totalTurns,
                input: totalInput,
                output: totalOutput,
                cacheRead: totalCache,
                contextTokens: totalCtx,
                cost: totalCost,
                model: results[0]?.model,
              };
            }
            const id = nextId();
            setMessages((p) => [...p, { id, role: toolName as any, text: `${ev.isError ? "✗ " : "✓ "}${t}`, className: "tool-result", meta }]);
          }
          break;
        }

        case "extension_ui_request":
          // Skip stale UI requests from replay (older than 10 seconds)
          if (ev.timestamp && Date.now() - ev.timestamp > 10000) break;
          if (ev.id && (ev.method === "select" || ev.method === "confirm" || ev.method === "input")) {
            // Add as inline message with options
            const askId = ev.id;
            const title = ev.title || "Input needed";
            const opts = ev.method === "confirm" ? ["Yes", "No"] : ev.options || [];
            addMsg("ask_user" as any, `${title}${ev.message ? "\n" + ev.message : ""}`, `ask|${askId}|${ev.method}|${opts.join("|||")}`)
          }
          break;

        case "commands-list":
          if (ev.commands) setAvailableCommands(ev.commands);
          break;

        case "ui-dismiss":
          // Mark the inline ask message as answered
          setMessages((prev) => prev.map((m) => {
            if (m.className?.startsWith(`ask|${ev.id}|`)) {
              return { ...m, className: `ask-answered|${ev.id}` };
            }
            return m;
          }));
          break;
      }
    });
  }, [onMessage, addMsg, updMsg, updCls]);

  const watchSession = useCallback((s: SessionInfo) => {
    setSession(s);
    setMessages([{ id: nextId(), role: "system", text: `Watching session — ${s.cwd}` }]);
    setModel(s.model || "");
    setTokens(null);
    setStreaming(false);
    setSearchQuery("");
    setSearchType("all");
    setScrollKey(k => k + 1);
    thinkRef.current = { id: "", text: "" };
    assistRef.current = { id: "", text: "" };
    lastUserRef.current = "";
    replayingRef.current = true;
    send({ type: "watch", sessionId: s.sessionId });
    send({ type: "pidash-command", sessionId: s.sessionId, command: "list-commands" });
    // Events from buffer replay arrive synchronously — mark replay done after a short delay
    setTimeout(() => { replayingRef.current = false; }, 2000);
    // Session persisted via localStorage — no URL hash needed
    // Auto-collapse sidebar on mobile
    if (typeof window !== 'undefined' && window.innerWidth <= 768) setSidebarCollapsed(true);
  }, [send]);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && streaming && session) handleAbort();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [streaming, session, handleAbort]);

  const handleSend = useCallback((text: string) => {
    if (!session) return;
    lastUserRef.current = text;
    addMsg("user", text);
    send({ type: "prompt", sessionId: session.sessionId, text });
  }, [session, send, addMsg]);

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
            <InputBar disabled={!session.active} streaming={streaming} onSend={handleSend} onAbort={handleAbort} commands={availableCommands} />
            <InfoBar session={session} model={model} tokens={tokens} send={send} onMessage={onMessage} />
          </>
        )}
      </div>

    </div>
  );
}
