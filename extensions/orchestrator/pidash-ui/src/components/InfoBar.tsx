import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, Circle, ExternalLink, Brain, Bot, ChevronDown } from "lucide-react";
import type { SessionInfo, TokenUsage } from "@/types";

function fk(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];

interface Props {
  session: SessionInfo;
  model: string;
  tokens: TokenUsage | null;
  streaming: boolean;
  send: (data: object) => void;
  onMessage: (handler: (data: any) => void) => () => void;
}

export function InfoBar({ session, model, tokens, streaming, send, onMessage }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [thinkingLevel, setThinkingLevel] = useState(session.thinkingLevel || "medium");

  // Sync thinkingLevel from session prop when it changes
  useEffect(() => {
    if (session.thinkingLevel) setThinkingLevel(session.thinkingLevel);
  }, [session.thinkingLevel]);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [asyncAgents, setAsyncAgents] = useState<{ count: number; agents: string }>({ count: 0, agents: "" });
  const filterRef = useRef<HTMLInputElement>(null);

  const ctxWin = session.contextWindow || 1000000;
  const input = tokens?.input || 0;
  const output = tokens?.output || 0;
  const cache = tokens?.cacheRead || 0;
  const pct = Math.round((input / ctxWin) * 100);
  const pctColor = pct > 80 ? "text-red-500" : pct > 50 ? "text-orange-400" : "";
  const displayModel = model || session.model || "—";

  useEffect(() => {
    return onMessage((ev: any) => {
      if (ev.type === "models-list" && ev.models) {
        setModels(ev.models);
        setOpenMenu("models"); // Auto-open the models dropdown
      }
      if (ev.type === "update_info") {
        if (ev.thinkingLevel) setThinkingLevel(ev.thinkingLevel);
      }
      if (ev.type === "async-status") {
        setAsyncAgents({ count: ev.count || 0, agents: ev.agents || "" });
      }
    });
  }, [onMessage]);

  // Close menu on outside click
  useEffect(() => {
    if (!openMenu) { setFilter(""); return; }
    // Focus the filter input when dropdown opens
    setTimeout(() => filterRef.current?.focus(), 50);
    const close = () => { setOpenMenu(null); setFilter(""); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [openMenu]);

  const toggleMenu = useCallback((name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (openMenu === name) { setOpenMenu(null); return; }
    setOpenMenu(name);
    if (name === "models") send({ type: "pidash-command", command: "list-models", pid: session.pid });
  }, [openMenu, send, session.pid]);

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-t border-border text-sm text-muted-foreground relative max-md:flex-wrap max-md:gap-2 max-md:text-xs md:overflow-x-auto md:whitespace-nowrap md:scrollbar-none">
      {/* Model */}
      <div className="relative">
        <button
          className="flex items-center gap-1 font-semibold text-foreground hover:text-primary transition-colors"
          onClick={(e) => toggleMenu("models", e)}
        >
          <Bot className="h-3.5 w-3.5" /> {displayModel} <ChevronDown className="h-3 w-3" />
        </button>
        {openMenu === "models" && (
          <div className="absolute bottom-full left-0 mb-1 z-50 bg-card border border-border rounded-lg shadow-xl py-1 min-w-[200px] max-h-60 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-2 py-1">
              <input
                ref={openMenu === "models" ? filterRef : undefined}
                className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded outline-none focus:border-primary font-mono"
                placeholder="Search models..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
            {models.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">Loading...</div>}
            {models.filter((m) => {
              if (!filter) return true;
              const f = filter.toLowerCase();
              return m.name?.toLowerCase().includes(f) || m.id?.toLowerCase().includes(f) || m.provider?.toLowerCase().includes(f);
            }).map((m) => (
              <button
                key={m.id}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors flex justify-between ${(m.name === displayModel || m.id === displayModel) ? "bg-accent/50" : ""}`}
                onClick={() => {
                  send({ type: "pidash-command", pid: session.pid, command: "set-model", modelId: m.id });
                  setOpenMenu(null);
                }}
              >
                <span className="truncate">{m.name || m.id}</span>
                <span className="text-[10px] text-muted-foreground ml-2">{m.provider}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <span className="text-border">|</span>

      {/* Thinking */}
      <div className="relative">
        <button
          className="flex items-center gap-1 hover:text-primary transition-colors"
          onClick={(e) => toggleMenu("thinking", e)}
        >
          <Brain className="h-3.5 w-3.5" /> {thinkingLevel} <ChevronDown className="h-3 w-3" />
        </button>
        {openMenu === "thinking" && (
          <div className="absolute bottom-full left-0 mb-1 z-50 bg-card border border-border rounded-lg shadow-xl py-1 min-w-[120px]" onClick={(e) => e.stopPropagation()}>
            <div className="px-3 py-1 text-xs text-muted-foreground font-medium">Thinking level</div>
            {THINKING_LEVELS.map((lvl) => (
              <button
                key={lvl}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors ${lvl === thinkingLevel ? "bg-accent/50" : ""}`}
                onClick={() => {
                  setThinkingLevel(lvl);
                  send({ type: "pidash-command", pid: session.pid, command: "set-thinking", level: lvl });
                  setOpenMenu(null);
                }}
              >
                {lvl}
              </button>
            ))}
          </div>
        )}
      </div>

      <span className="text-border">|</span>

      {/* Tokens */}
      <span>↑{fk(input)} ↓{fk(output)}{cache > 0 && ` 📦${fk(cache)}`}</span>

      <span className="text-border">|</span>

      {/* Context */}
      <span className={pctColor}>ctx {pct}%</span>

      {/* Git */}
      {session.branch && (
        <>
          <span className="text-border">|</span>
          <span className="flex items-center gap-1">
            <GitBranch className="h-3.5 w-3.5" />
            <span className={session.gitDirty ? "text-red-500" : "text-green-500"}>
              {session.gitDirty ? "●" : "✓"}
            </span>
            {session.branch}
            {session.gitChanges ? ` ~${session.gitChanges}` : ""}
          </span>
        </>
      )}

      {/* Diffity */}
      {session.diffityPort && (
        <>
          <span className="text-border">|</span>
          <a href={`http://localhost:${session.diffityPort}?theme=dark`} target="_blank" rel="noreferrer" className="flex items-center gap-0.5 text-primary hover:underline">
             diff <ExternalLink className="h-3 w-3" />
          </a>
        </>
      )}

      {/* Container */}
      {session.container && (
        <>
          <span className="text-border">|</span>
          <span className="text-[10px] px-1.5 py-0.5 border border-border rounded">📦</span>
        </>
      )}

      {/* Async agents */}
      {asyncAgents.count > 0 && (
        <>
          <span className="text-border">|</span>
          <span className="text-yellow-400">⏳ {asyncAgents.count} async: {asyncAgents.agents}</span>
        </>
      )}

      {/* Status */}
      <span className="flex items-center gap-1">
        <Circle className={`h-2 w-2 fill-current ${streaming ? "text-cyan-400" : "text-green-500"}`} />
        {streaming ? "streaming" : "idle"}
      </span>
    </div>
  );
}
