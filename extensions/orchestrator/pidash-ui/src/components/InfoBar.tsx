import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, ExternalLink, Brain, Bot, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
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
  send: (data: object) => void;
  onMessage: (handler: (data: any) => void) => () => void;
}

export function InfoBar({ session, model, tokens, send, onMessage }: Props) {
  const inactive = !session.active;
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [thinkingLevel, setThinkingLevel] = useState(session.thinkingLevel || "medium");

  // Sync thinkingLevel from session prop when it changes
  useEffect(() => {
    if (session.thinkingLevel) setThinkingLevel(session.thinkingLevel);
  }, [session.thinkingLevel]);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [asyncAgents, setAsyncAgents] = useState<{
    count: number;
    agents: string;
    jobs: Array<{ id: string; name: string; agent: string; task: string; status: string; startedAt: number }>;
  }>({ count: 0, agents: "", jobs: [] });
  const filterRef = useRef<HTMLInputElement>(null);

  const ctxWin = session.contextWindow || 1000000;
  const input = tokens?.input || 0;
  const output = tokens?.output || 0;
  const cache = tokens?.cacheRead || 0;
  const pct = Math.round((input / ctxWin) * 100);
  const pctColor = pct > 80 ? "text-red-500" : pct > 50 ? "text-orange-400" : "";
  const displayModel = model || session.model || "—";

  // Reset async agents when session changes
  useEffect(() => {
    setAsyncAgents({ count: 0, agents: "", jobs: [] });
  }, [session.sessionId]);

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
        const newCount = ev.count || 0;
        const newAgents = ev.agents || "";
        setAsyncAgents(prev => {
          if (prev.count === newCount && prev.agents === newAgents) return prev;
          return { count: newCount, agents: newAgents, jobs: ev.jobs || [] };
        });
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
    if (name === "models") send({ type: "pidash-command", command: "list-models", sessionId: session.sessionId });
  }, [openMenu, send, session.sessionId]);

  return (
    <div className={cn("flex items-center gap-3 px-4 py-2 border-t border-border text-sm text-muted-foreground relative max-md:flex-wrap max-md:gap-2 max-md:text-xs md:whitespace-nowrap md:scrollbar-none", inactive && "opacity-50 pointer-events-none")}>
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
                  send({ type: "pidash-command", sessionId: session.sessionId, command: "set-model", modelId: m.id });
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
                  send({ type: "pidash-command", sessionId: session.sessionId, command: "set-thinking", level: lvl });
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
      <span className="tabular-nums">
        <span className="inline-block min-w-[3.5em] text-right">↑{fk(input)}</span>
        {" "}
        <span className="inline-block min-w-[3.5em] text-right">↓{fk(output)}</span>
        {cache > 0 && <span className="inline-block min-w-[3.5em] text-right"> 📦{fk(cache)}</span>}
      </span>

      <span className="text-border">|</span>

      {/* Context */}
      <span className={cn("tabular-nums inline-block min-w-[4em] text-right", pctColor)}>ctx {pct}%</span>

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

      {/* Diff viewer */}
      {session.diffPort && (
        <>
          <span className="text-border">|</span>
          <a href={`http://localhost:${session.diffPort}`} target="_blank" rel="noreferrer" className="flex items-center gap-0.5 text-primary hover:underline">
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

      {/* Async agents — always visible, pinned to far right */}
      <div className="relative inline-block ml-auto">
        <Popover>
          <PopoverTrigger className={cn(
            "cursor-pointer text-xs",
            asyncAgents.count > 0 ? "text-yellow-400 hover:text-yellow-300" : "text-muted-foreground/50"
          )}>
            ⏳ {asyncAgents.count} async
          </PopoverTrigger>
          {asyncAgents.count > 0 && (
            <PopoverContent className="w-72 max-h-60 overflow-y-auto">
              <div className="text-xs space-y-1.5">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-foreground">Running Agents ({asyncAgents.count})</span>
                  {asyncAgents.count > 1 && (
                    <button
                      onClick={() => {
                        send({ type: "pidash-command", command: "async-kill", target: "all", sessionId: session.sessionId });
                      }}
                      className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/20 text-red-400 hover:bg-red-500/40"
                    >
                      Kill All
                    </button>
                  )}
                </div>
                {asyncAgents.jobs.length === 0 && asyncAgents.agents && (
                  <div className="text-muted-foreground">
                    {asyncAgents.agents.split(", ").map((name, i) => (
                      <div key={i} className="p-1.5 rounded bg-muted/50 mb-1">
                        <span className="font-medium text-foreground">{name}</span>
                      </div>
                    ))}
                    <div className="text-[10px] mt-1 italic">Relaunch session for full details + kill</div>
                  </div>
                )}
                {asyncAgents.jobs.map((job) => {
                  const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
                  const mins = Math.floor(elapsed / 60);
                  const secs = elapsed % 60;
                  const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
                  return (
                    <div key={job.id} className="flex items-center justify-between gap-2 p-1.5 rounded bg-muted/50">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-foreground truncate">{job.name}</div>
                        <div className="text-muted-foreground truncate text-[10px]">{job.task.slice(0, 60)}</div>
                        <div className="text-muted-foreground text-[10px]">{job.agent} · {duration}</div>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <button
                          onClick={() => {
                            send({ type: "pidash-command", command: "async-kill", target: job.name, sessionId: session.sessionId });
                          }}
                          className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/20 text-red-400 hover:bg-red-500/40"
                          title="Kill this agent"
                        >
                          Kill
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </PopoverContent>
          )}
        </Popover>
      </div>
    </div>
  );
}
