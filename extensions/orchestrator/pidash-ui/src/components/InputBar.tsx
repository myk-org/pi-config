import { useRef, useCallback, useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Send, Square } from "lucide-react";

interface Props {
  disabled: boolean;
  streaming?: boolean;
  onSend: (text: string) => void;
  onAbort?: () => void;
  commands?: Array<{ name: string; description: string }>;
}

export function InputBar({ disabled, streaming, onSend, onAbort, commands = [] }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<Array<{ name: string; description: string }>>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [savedInput, setSavedInput] = useState("");

  const handleSend = useCallback(() => {
    const text = ref.current?.value.trim();
    if (!text) return;
    setHistory((prev) => [text, ...prev.filter(h => h !== text)].slice(0, 50));
    setHistoryIdx(-1);
    onSend(text);
    if (ref.current) {
      ref.current.value = "";
      ref.current.style.height = "auto";
    }
    setShowSuggestions(false);
  }, [onSend]);

  const autoResize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, []);

  const updateSuggestions = useCallback(() => {
    const text = ref.current?.value || "";
    if (text.startsWith("/") && !text.includes(" ")) {
      const query = text.slice(1).toLowerCase();
      const filtered = commands.filter(c => c.name.toLowerCase().includes(query));
      setSuggestions(filtered.slice(0, 10));
      setShowSuggestions(filtered.length > 0);
      setSelectedIdx(0);
    } else {
      setShowSuggestions(false);
    }
  }, [commands]);

  const selectSuggestion = useCallback((cmd: { name: string; description: string }) => {
    if (ref.current) {
      ref.current.value = `/${cmd.name} `;
      ref.current.focus();
    }
    setShowSuggestions(false);
  }, []);

  return (
    <div className="relative">
      {showSuggestions && suggestions.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mx-3 mb-1 bg-card border border-border rounded-lg shadow-xl py-1 max-h-48 overflow-y-auto z-50">
          {suggestions.map((cmd, i) => (
            <button
              key={cmd.name}
              className={`w-full text-left px-3 py-1.5 hover:bg-accent transition-colors ${i === selectedIdx ? "bg-accent" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); selectSuggestion(cmd); }}
            >
              <span className="text-sm font-mono text-foreground">/{cmd.name}</span>
              {cmd.description && <span className="text-xs text-muted-foreground ml-2">{cmd.description}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 p-3 border-t border-border">
        <textarea
          ref={ref}
          rows={1}
          placeholder={disabled ? "Session inactive" : streaming ? "Press Esc to stop..." : "Send a message... (/ for commands)"}
          disabled={disabled}
          autoComplete="off"
          className="flex-1 font-mono text-sm bg-card border border-border rounded-md px-3 py-2 outline-none focus:border-primary resize-none text-base md:text-sm"
          onKeyDown={(e) => {
            if (showSuggestions) {
              if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, suggestions.length - 1)); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); return; }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                if (suggestions[selectedIdx]) selectSuggestion(suggestions[selectedIdx]);
                return;
              }
              if (e.key === "Escape") { setShowSuggestions(false); return; }
            }
            if (e.key === "ArrowUp" && !showSuggestions && ref.current?.selectionStart === 0) {
              e.preventDefault();
              if (historyIdx === -1) setSavedInput(ref.current?.value || "");
              const newIdx = Math.min(historyIdx + 1, history.length - 1);
              setHistoryIdx(newIdx);
              if (ref.current && history[newIdx]) ref.current.value = history[newIdx];
              return;
            }
            if (e.key === "ArrowDown" && !showSuggestions && ref.current?.selectionStart === (ref.current?.value.length || 0)) {
              e.preventDefault();
              if (historyIdx <= 0) {
                setHistoryIdx(-1);
                if (ref.current) ref.current.value = savedInput;
              } else {
                const newIdx = historyIdx - 1;
                setHistoryIdx(newIdx);
                if (ref.current && history[newIdx]) ref.current.value = history[newIdx];
              }
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          onInput={() => { autoResize(); updateSuggestions(); }}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
        />
        {streaming ? (
          <Button size="sm" variant="destructive" onClick={onAbort} title="Stop (Esc)" className="mb-0.5">
            <Square className="h-4 w-4" />
          </Button>
        ) : (
          <Button size="sm" onClick={handleSend} disabled={disabled} className="mb-0.5">
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
