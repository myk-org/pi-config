import { useEffect, useRef, useState } from "react";
import type { SessionInfo } from "@/types";

interface Props {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  onSelect: (session: SessionInfo) => void;
  onClose: () => void;
}

export function SessionSwitcher({ sessions, activeSessionId, onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = sessions.filter(s => {
    if (!query) return true;
    const q = query.toLowerCase();
    const name = (s.cwd || "").split("/").pop() || "";
    return name.toLowerCase().includes(q) || (s.model || "").toLowerCase().includes(q) || (s.branch || "").toLowerCase().includes(q);
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query, filtered.length]);

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as HTMLElement;
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (filtered.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, filtered.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[selectedIdx]) { onSelect(filtered[selectedIdx]); onClose(); }
      return;
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center pt-[15vh] z-50" onClick={onClose} role="dialog" aria-modal="true" aria-label="Session switcher">
      <div className="w-[520px] bg-card border border-border rounded-lg shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()} onKeyDown={handleKey}>
        <div className="p-3 border-b border-border">
          <input
            ref={inputRef}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground font-mono"
            placeholder="Switch session..."
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
        <div ref={listRef} className="max-h-[300px] overflow-y-auto">
          {filtered.length === 0 && (
            <div className="p-4 text-center text-muted-foreground text-sm">No matching sessions</div>
          )}
          {filtered.map((s, i) => {
            const name = (s.cwd || "").split("/").pop() || s.cwd;
            const isActive = s.sessionId === activeSessionId;
            const isSelected = i === selectedIdx;
            return (
              <div
                key={s.sessionId}
                className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer border-l-[3px] transition-colors ${
                  isSelected ? "bg-accent border-l-primary" : "border-l-transparent hover:bg-accent/50"
                }`}
                onClick={() => { onSelect(s); onClose(); }}
                onMouseEnter={() => setSelectedIdx(i)}
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${s.active ? (s.working ? "bg-yellow-400 animate-pulse" : "bg-green-500") : "bg-orange-400"}`} />
                <span className="text-sm font-medium flex-1 truncate">{name}</span>
                <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                  {s.model || "—"}{s.branch ? ` · ${s.branch}` : ""}
                </span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  s.active ? (s.working ? "bg-yellow-500/15 text-yellow-400" : "bg-green-500/15 text-green-500") : "bg-orange-400/15 text-orange-400"
                }`}>
                  {s.active ? (s.working ? "active" : "idle") : "offline"}
                </span>
                {isActive && <span className="text-primary text-sm">✓</span>}
              </div>
            );
          })}
        </div>
        <div className="px-4 py-2 border-t border-border text-[11px] text-muted-foreground flex gap-4">
          <span><kbd className="bg-accent px-1 rounded text-[10px]">↑</kbd><kbd className="bg-accent px-1 rounded text-[10px] ml-0.5">↓</kbd> navigate</span>
          <span><kbd className="bg-accent px-1 rounded text-[10px]">Enter</kbd> select</span>
          <span><kbd className="bg-accent px-1 rounded text-[10px]">Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
