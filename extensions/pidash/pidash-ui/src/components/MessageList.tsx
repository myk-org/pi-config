import { useEffect, useRef, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { ChevronRight, ChevronDown, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/types";

interface Props {
  messages: ChatMessage[];
  searchQuery?: string;
  searchType?: string;
  streaming?: boolean;
  scrollKey?: number;
  onAskResponse?: (id: string, value: string) => void;
}

function formatClock(ts?: number): string {
  if (ts == null) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const roleColors: Record<string, string> = {
  user: "text-green-500",
  assistant: "text-blue-400",
  thinking: "text-purple-400",
  system: "text-cyan-400",
  // Tool types
  bash: "text-orange-400",
  read: "text-yellow-500",
  edit: "text-yellow-400",
  write: "text-yellow-300",
  subagent: "text-pink-400",
  ask_user: "text-cyan-300",
  tool: "text-orange-400",
};

function getRoleColor(role: string): string {
  return roleColors[role] || "text-orange-400";
}

function fk(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}

export function MessageList({ messages, searchQuery, searchType, streaming, scrollKey, onAskResponse }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, autoScroll]);

  // Force scroll to bottom on session switch — keep scrolling during replay
  useEffect(() => {
    setAutoScroll(true);
    // Scroll multiple times during replay (messages arrive over ~2s)
    const times = [50, 200, 500, 1000, 2000, 3000];
    const timers = times.map(ms =>
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "instant" }), ms)
    );
    return () => timers.forEach(clearTimeout);
  }, [scrollKey]);

  return (
    <div
      className="flex-1 overflow-y-auto"
      ref={viewportRef}
      onScroll={() => {
        const el = viewportRef.current;
        if (el) setAutoScroll(el.scrollTop + el.clientHeight >= el.scrollHeight - 50);
      }}
    >
      <div className="p-4 space-y-2">
        {(() => {
          const filtered = messages.filter((msg) => {
            if (searchType && searchType !== "all" && msg.role !== searchType) return false;
            if (searchQuery && !msg.text.toLowerCase().includes(searchQuery.toLowerCase())) return false;
            return true;
          });

          // Group tool-call + tool-result by correlation ID (callId in meta)
          const resultByCallId = new Map<string, ChatMessage>();
          for (const msg of filtered) {
            if (msg.className === "tool-result" && msg.meta?.callId) {
              resultByCallId.set(msg.meta.callId, msg);
            }
          }
          const usedResults = new Set<string>();
          const grouped: Array<{ call?: ChatMessage; result?: ChatMessage } | ChatMessage> = [];
          for (const msg of filtered) {
            if (msg.className === "tool-call" && msg.meta?.callId) {
              const result = resultByCallId.get(msg.meta.callId);
              if (result) {
                grouped.push({ call: msg, result });
                usedResults.add(result.id);
                continue;
              }
            }
            // Skip results that were already grouped with their call
            if (msg.className === "tool-result" && msg.meta?.callId && usedResults.has(msg.id)) continue;
            grouped.push(msg);
          }

          return grouped.map((item, idx) => {
            if ('call' in item) {
              return <ToolGroup key={item.call!.id} call={item.call!} result={item.result!} searchQuery={searchQuery} />;
            }
            const msg = item as ChatMessage;
            return <MessageItem key={msg.id} msg={msg} searchQuery={searchQuery} onAskResponse={onAskResponse} />;
          });
        })()}
        {streaming && (
          <div className="flex items-center gap-2 py-2 text-muted-foreground text-xs">
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
            AI is working...
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity absolute top-1.5 right-1.5 text-muted-foreground hover:text-foreground"
      onClick={handleCopy}
      title="Copy"
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </Button>
  );
}

function MessageItem({ msg, searchQuery, onAskResponse }: { msg: ChatMessage; searchQuery?: string; onAskResponse?: (id: string, value: string) => void }) {
  // Inline ask_user with clickable options
  if (msg.className?.startsWith("ask|") || msg.className?.startsWith("ask-answered|")) {
    const isAnswered = msg.className?.startsWith("ask-answered|");
    const parts = msg.className.split("|");
    const askId = parts[1];
    const method = parts[2] || "select";
    const options = isAnswered ? [] : parts.slice(3).join("|").split("|||").filter(Boolean);
    const [answered, setAnswered] = useState(isAnswered || false);
    const [selectedOpt, setSelectedOpt] = useState("");

    return (
      <div>
        <div className={cn("text-[10px] font-bold uppercase tracking-wider mb-0.5", getRoleColor("ask_user"))}>
          {msg.timestamp && <span className="text-muted-foreground font-normal normal-case tracking-normal mr-1.5">[{formatClock(msg.timestamp)}]</span>}
          action required
        </div>
        <div className="rounded-md bg-card p-3 text-[13px] whitespace-pre-wrap break-words border-l-2 border-cyan-400">
          <div className="mb-2">{msg.text}</div>
          {answered ? (
            <div className="text-xs text-muted-foreground">✓ Answered: {selectedOpt || "dismissed"}</div>
          ) : method === "input" ? (
            <form className="flex gap-2 mt-2" onSubmit={(e) => {
              e.preventDefault();
              const input = (e.target as HTMLFormElement).elements.namedItem("answer") as HTMLInputElement;
              const val = input?.value.trim();
              if (val) { setAnswered(true); setSelectedOpt(val); onAskResponse?.(askId, val); }
            }}>
              <input name="answer" className="flex-1 px-2 py-1.5 text-sm rounded-md bg-background border border-border outline-none focus:border-primary font-mono" autoFocus />
              <button type="submit" className="px-3 py-1.5 text-sm rounded-md bg-accent/50 hover:bg-accent transition-colors">Submit</button>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2 mt-2">
              {options.map((opt) => (
                <button
                  key={opt}
                  className="px-3 py-1.5 text-sm rounded-md bg-accent/50 hover:bg-accent transition-colors"
                  onClick={() => {
                    setAnswered(true);
                    setSelectedOpt(opt);
                    if (method === "confirm") {
                      onAskResponse?.(askId, opt === "Yes" ? "__confirmed__" : "__denied__");
                    } else {
                      onAskResponse?.(askId, opt);
                    }
                  }}
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (msg.role !== "user" && msg.role !== "assistant") {
    return <CollapsibleMessage msg={msg} searchQuery={searchQuery} />;
  }

  if (msg.role === "system") {
    return <div className="text-xs text-muted-foreground py-1">{msg.text}</div>;
  }

  return (
    <div>
      <div className={cn("text-[10px] font-bold uppercase tracking-wider mb-0.5", getRoleColor(msg.role))}>
        {msg.timestamp && <span className="text-muted-foreground font-normal normal-case tracking-normal mr-1.5">[{formatClock(msg.timestamp)}]</span>}
        {msg.role}
      </div>
      <div className={cn(
        "rounded-md bg-card p-2.5 text-[13px] whitespace-pre-wrap break-words relative group",
        msg.className === "streaming" && "border-l-2 border-cyan-400",
      )}>
        <HighlightText text={msg.text} query={searchQuery} />
        <CopyBtn text={msg.text} />
      </div>
    </div>
  );
}

function ToolGroup({ call, result, searchQuery }: { call: ChatMessage; result: ChatMessage; searchQuery?: string }) {
  const [open, setOpen] = useState(false);
  const matchesSearch = searchQuery && (
    call.text.toLowerCase().includes(searchQuery.toLowerCase()) ||
    result.text.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const color = getRoleColor(call.role);
  const isError = result.text.startsWith("✗");
  const borderColor = isError ? "border-red-500" : "border-green-600";

  const meta = result.meta;
  const statusIcon = isError ? "✗" : "✓";
  const statusColor = isError ? "text-red-500" : "text-green-500";
  const callSummary = call.text.split("\n")[0].slice(0, 120);

  // Build stats string from meta
  let statsStr = "";
  if (meta) {
    const parts: string[] = [];
    if (meta.turns) parts.push(`${meta.turns} turn${meta.turns > 1 ? "s" : ""}`);
    if (meta.input) parts.push(`↑${fk(meta.input)}`);
    if (meta.output) parts.push(`↓${fk(meta.output)}`);
    if (meta.cacheRead) parts.push(`R${fk(meta.cacheRead)}`);
    if (meta.contextTokens) parts.push(`ctx:${fk(meta.contextTokens)}`);
    if (meta.cost) parts.push(`$${meta.cost.toFixed(4)}`);
    if (meta.model) parts.push(meta.model);
    if (meta.startTs && meta.endTs) parts.push(formatDuration(meta.endTs - meta.startTs));
    statsStr = parts.join(" ");
  }

  return (
    <Collapsible open={open || !!matchesSearch} onOpenChange={setOpen}>
      <CollapsibleTrigger className={cn(
        "flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider cursor-pointer select-none hover:opacity-80 w-full text-left",
        color,
      )}>
        {open ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
        {call.timestamp && <span className="font-normal normal-case tracking-normal text-muted-foreground flex-shrink-0">[{formatClock(call.timestamp)}]</span>}
        <span className="flex-shrink-0">{call.role}</span>
        <span className={cn("flex-shrink-0", statusColor)}>{statusIcon}</span>
        {!open && statsStr && (
          <span className="font-normal normal-case tracking-normal text-muted-foreground ml-1 text-[10px] truncate">
            {statsStr}
          </span>
        )}
        {!open && !statsStr && (
          <span className="font-normal normal-case tracking-normal text-muted-foreground ml-1 truncate">{callSummary}</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className={cn(
          "mt-1 rounded-md bg-card p-2.5 text-[11px] whitespace-pre-wrap break-words border-l-2 relative group",
          "border-orange-500",
        )}>
          <div className="text-[9px] font-bold uppercase text-muted-foreground mb-1">call</div>
          <HighlightText text={call.text} query={searchQuery} />
        </div>
        <div className={cn(
          "mt-1 rounded-md bg-card p-2.5 text-[11px] whitespace-pre-wrap break-words border-l-2 relative group",
          borderColor,
        )}>
          <div className="text-[9px] font-bold uppercase text-muted-foreground mb-1">result</div>
          <HighlightText text={result.text} query={searchQuery} />
          <CopyBtn text={result.text} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function CollapsibleMessage({ msg, searchQuery }: { msg: ChatMessage; searchQuery?: string }) {
  const [open, setOpen] = useState(false);
  const matchesSearch = searchQuery && msg.text.toLowerCase().includes(searchQuery.toLowerCase());
  const color = getRoleColor(msg.role);
  const isResult = msg.className === "tool-result";
  const isError = isResult && msg.text.startsWith("✗");
  const borderColor = msg.role === "thinking" ? "border-purple-500" : isResult ? (isError ? "border-red-500" : "border-green-600") : "border-orange-500";

  const summary = msg.text.split("\n")[0].slice(0, 100);

  return (
    <Collapsible open={open || !!matchesSearch} onOpenChange={setOpen}>
      <CollapsibleTrigger className={cn(
        "flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider cursor-pointer select-none hover:opacity-80 w-full text-left",
        color,
      )}>
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {msg.timestamp && <span className="font-normal normal-case tracking-normal text-muted-foreground">[{formatClock(msg.timestamp)}]</span>}
        {msg.role}
        {!open && msg.meta?.startTs && msg.meta?.endTs && (
          <span className="font-normal normal-case tracking-normal text-muted-foreground ml-1 flex-shrink-0">
            {formatDuration(msg.meta.endTs - msg.meta.startTs)}
          </span>
        )}
        {!open && <span className="font-normal normal-case tracking-normal text-muted-foreground ml-1 truncate">{summary}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className={cn(
          "mt-1 rounded-md bg-card p-2.5 text-[13px] whitespace-pre-wrap break-words border-l-2 relative group",
          borderColor,
          msg.role === "thinking" && "text-muted-foreground italic",
          (msg.className === "tool-call" || msg.className === "tool-result") && "text-[11px]",
        )}>
          <HighlightText text={msg.text} query={searchQuery} />
          <CopyBtn text={msg.text} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function HighlightText({ text, query }: { text: string; query?: string }) {
  if (!query) return <>{text}</>;
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className="bg-yellow-500/30 text-inherit rounded-sm px-0.5">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}
