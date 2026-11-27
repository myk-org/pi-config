import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@ui/collapsible";
import { ChevronRight, ChevronDown, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/types";
import {
  findActiveSelectHotkeyId,
  formatToolCallSummary,
  isEditableTarget,
  resolvePromptOptionIndex,
  shouldSubmitMultilineAnswer,
  stripToolResultPrefix,
} from "@/lib/pidash-ux-helpers";

import { createLogger } from "@/lib/create-logger";

const log = createLogger("MessageList");

interface Props {
  messages: ChatMessage[];
  searchQuery?: string;
  searchType?: string;
  streaming?: boolean;
  scrollKey?: number;
  onAskResponse?: (id: string, value: string) => void;
  promptHotkeysPaused?: boolean;
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

export function MessageList({ messages, searchQuery, searchType, streaming, scrollKey, onAskResponse, promptHotkeysPaused = false }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Grouping memoized: it ran per render — during streaming that is every
  // text delta over the whole (large) history (Qodo UX: slow UI).
  const grouped = useMemo(() => {
    const q = searchQuery?.toLowerCase();
    const filtered = messages.filter((msg) => {
      if (searchType && searchType !== "all" && msg.role !== searchType) return false;
      if (q && !msg.text.toLowerCase().includes(q) && !msg.meta?.partialOutput?.toLowerCase().includes(q)) {
        return false;
      }
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
    const out: Array<{ call?: ChatMessage; result?: ChatMessage } | ChatMessage> = [];
    for (const msg of filtered) {
      if (msg.className === "tool-call" && msg.meta?.callId) {
        const result = resultByCallId.get(msg.meta.callId);
        if (result) {
          out.push({ call: msg, result });
          usedResults.add(result.id);
          continue;
        }
      }
      // Skip results that were already grouped with their call
      if (msg.className === "tool-result" && msg.meta?.callId && usedResults.has(msg.id)) continue;
      out.push(msg);
    }
    return out;
  }, [messages, searchQuery, searchType]);

  const [locallyAnsweredIds, setLocallyAnsweredIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setLocallyAnsweredIds(new Set());
  }, [scrollKey]);

  useEffect(() => {
    setLocallyAnsweredIds((prev) => {
      if (prev.size === 0) return prev;
      const activeAskIds = new Set(
        messages.filter((m) => m.className?.startsWith("ask|")).map((m) => m.id),
      );
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (activeAskIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [messages]);

  const handleLocalAskAnswer = useCallback((msgId: string) => {
    setLocallyAnsweredIds((prev) => {
      if (prev.has(msgId)) return prev;
      const next = new Set(prev);
      next.add(msgId);
      return next;
    });
  }, []);

  // Only the newest unanswered prompt in the unfiltered transcript owns global 1-9
  // hotkeys, and only when that same prompt is a currently visible select card.
  const activeAskHotkeyId = useMemo(() => {
    const visibleIds = new Set<string>();
    for (const item of grouped) {
      if (!("call" in item)) visibleIds.add((item as ChatMessage).id);
    }
    return findActiveSelectHotkeyId(messages, visibleIds, locallyAnsweredIds, promptHotkeysPaused);
  }, [messages, grouped, locallyAnsweredIds, promptHotkeysPaused]);

  const [replaying, setReplaying] = useState(false);
  const autoScrollRef = useRef(true);
  useEffect(() => { autoScrollRef.current = autoScroll; }, [autoScroll]);
  const scrollFrameRef = useRef<number | null>(null);
  const replayingRef = useRef(false);
  useEffect(() => { replayingRef.current = replaying; }, [replaying]);

  useEffect(() => {
    if (autoScroll && !replaying) {
      // rAF-throttled direct scrollTop write, deduplicated: multiple deltas
      // before a frame share ONE callback, and the callback re-checks
      // autoScroll so a user scrolling up mid-frame is never yanked back to
      // the bottom (Qodo R3).
      if (scrollFrameRef.current !== null) return;
      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        if (autoScrollRef.current && !replayingRef.current && viewportRef.current) {
          viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
        }
      });
    }
  }, [messages, autoScroll, replaying]);

  // On session switch: show spinner overlay while messages replay invisibly,
  // then scroll to bottom and reveal the messages.
  useLayoutEffect(() => {
    const replayStart = performance.now();
    setAutoScroll(true);
    setReplaying(true);
    const container = viewportRef.current;
    if (container) container.style.visibility = "hidden";
    let revealed = false;
    const reveal = (reason: string) => {
      if (revealed) return;
      revealed = true;
      clearTimeout(fallback);
      if (container) {
        // ONE jump, then one more after a frame: images/code blocks can settle
        // late and change scrollHeight after the first write.
        container.scrollTop = container.scrollHeight;
        requestAnimationFrame(() => {
          if (!container) return;
          container.scrollTop = container.scrollHeight;
          container.style.visibility = "";
        });
      }
      setReplaying(false);
      log.debug("replay revealed", { ms: Math.round(performance.now() - replayStart), reason });
    };
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    // No scrollTop write per mutation: on a large transcript that forced a
    // layout on every appended event and was the visible crawl. Only the settle
    // timer restarts; the single jump happens at reveal.
    const observer = container ? new MutationObserver(() => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => reveal("settled"), 200);
    }) : null;
    if (observer && container) {
      observer.observe(container, { childList: true, subtree: true });
    }
    // Safety net for a session with nothing to replay. It is CANCELLED as soon
    // as the replay settles — previously this fired at 1.5s even mid-replay,
    // which revealed the list while the backlog was still streaming in, so the
    // user watched the rest of the history scroll past.
    const fallback = setTimeout(() => reveal("fallback"), 1500);
    return () => { observer?.disconnect(); clearTimeout(settleTimer); clearTimeout(fallback); };
  }, [scrollKey]);

  return (
    <div className="flex-1 relative min-h-0">
      {replaying && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background">
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <div className="flex gap-1">
              <span className="w-2 h-2 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-2 h-2 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="w-2 h-2 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
            <span className="text-xs">Loading session...</span>
          </div>
        </div>
      )}
      <div
        className="h-full overflow-y-auto overflow-x-hidden"
        ref={viewportRef}
      onScroll={() => {
        const el = viewportRef.current;
        if (el) setAutoScroll(el.scrollTop + el.clientHeight >= el.scrollHeight - 50);
      }}
    >
      <div className="p-4 space-y-2">
        {grouped.map((item) => {
          if ('call' in item) {
            return <ToolGroup key={item.call!.id} call={item.call!} result={item.result!} searchQuery={searchQuery} />;
          }
          const msg = item as ChatMessage;
          return (
            <MessageItem
              key={msg.id}
              msg={msg}
              searchQuery={searchQuery}
              onAskResponse={onAskResponse}
              onLocalAskAnswer={handleLocalAskAnswer}
              hotkeyEnabled={msg.id === activeAskHotkeyId}
            />
          );
        })}
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
    </div>
  );
}

export function CopyOutputButton({
  text,
  compact = false,
  label = "Copy output",
}: {
  text: string;
  compact?: boolean;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      log.debug("copied section content", { label, chars: text.length });
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setCopied(false);
      }, 2000);
    } catch (err) {
      log.warn("failed to copy section content", { label, error: String(err) });
    }
  };

  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-1 rounded text-[10px] font-medium transition-colors cursor-pointer shrink-0",
        compact
          ? "px-1.5 py-0.5 text-muted-foreground hover:text-foreground hover:bg-accent/60"
          : "px-1.5 py-0.5 bg-background/80 border border-border/70 text-muted-foreground hover:text-foreground hover:bg-accent/60 absolute top-1.5 right-1.5",
        copied && "text-green-500 hover:text-green-500",
      )}
      onClick={handleCopy}
      title={label}
      aria-label={label}
    >
      {copied ? <Check className="h-3 w-3 shrink-0" /> : <Copy className="h-3 w-3 shrink-0" />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

export function AskPromptCard({
  msg,
  onAskResponse,
  onLocalAskAnswer,
  hotkeyEnabled = true,
}: {
  msg: ChatMessage;
  onAskResponse?: (id: string, value: string) => void;
  onLocalAskAnswer?: (msgId: string) => void;
  hotkeyEnabled?: boolean;
}) {
  const className = msg.className || "";
  const isAnswered = className.startsWith("ask-answered|");
  const parts = className.split("|");
  const askId = parts[1];
  const method = parts[2] || "select";
  const options = useMemo(
    () => (isAnswered ? [] : parts.slice(3).join("|").split("|||").filter(Boolean)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [className, isAnswered],
  );
  const [answered, setAnswered] = useState(isAnswered);
  const [selectedOpt, setSelectedOpt] = useState("");
  const cardRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isDone = answered || isAnswered;

  const submitOption = useCallback((opt: string) => {
    setAnswered(true);
    setSelectedOpt(opt);
    onLocalAskAnswer?.(msg.id);
    log.debug("prompt option selected", { askId, method });
    if (method === "confirm") {
      onAskResponse?.(askId, opt === "Yes" ? "__confirmed__" : "__denied__");
    } else {
      onAskResponse?.(askId, opt);
    }
  }, [askId, method, msg.id, onAskResponse, onLocalAskAnswer]);

  const submitCustomAnswer = useCallback(() => {
    const raw = textareaRef.current?.value ?? "";
    if (!raw.trim()) return;
    setAnswered(true);
    setSelectedOpt(raw);
    onLocalAskAnswer?.(msg.id);
    log.debug("prompt custom answer submitted", { askId, lines: raw.split("\n").length });
    onAskResponse?.(askId, raw);
  }, [askId, msg.id, onAskResponse, onLocalAskAnswer]);

  // Global 1-9 hotkeys apply only to select prompts; confirm prompts handle
  // 1/2 only when focus is explicitly inside the card container.
  useEffect(() => {
    if (isDone || !hotkeyEnabled || method !== "select" || options.length === 0) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target, typeof document !== "undefined" ? document.activeElement : null)) {
        return;
      }
      const idx = resolvePromptOptionIndex(e, options.length);
      if (idx === null) return;
      e.preventDefault();
      submitOption(options[idx]);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isDone, hotkeyEnabled, method, options, submitOption]);

  const handleConfirmCardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isDone || method !== "confirm" || options.length === 0) return;
    const activeEl = typeof document !== "undefined" ? document.activeElement : null;
    if (!cardRef.current?.contains(activeEl as Node | null)) return;
    if (isEditableTarget(e.target, activeEl)) return;
    const idx = resolvePromptOptionIndex(
      {
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        repeat: e.repeat,
        defaultPrevented: e.defaultPrevented,
      },
      options.length,
    );
    if (idx === null) return;
    e.preventDefault();
    submitOption(options[idx]);
  };

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-1.5 min-w-0 mb-0.5">
        <div className={cn("text-[10px] font-bold uppercase tracking-wider min-w-0 truncate", getRoleColor("ask_user"))}>
          {msg.timestamp && <span className="text-muted-foreground font-normal normal-case tracking-normal mr-1.5">[{formatClock(msg.timestamp)}]</span>}
          action required
        </div>
        <CopyOutputButton text={msg.text} compact label="Copy prompt" />
      </div>
      <div
        ref={cardRef}
        tabIndex={method === "confirm" && !isDone ? -1 : undefined}
        onKeyDown={method === "confirm" ? handleConfirmCardKeyDown : undefined}
        className="rounded-md bg-card p-3 text-[13px] whitespace-pre-wrap break-words border-l-2 border-cyan-400 outline-none"
      >
        <div className="mb-2">{msg.text}</div>
        {isDone ? (
          <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">✓ Answered: {selectedOpt || "dismissed"}</div>
        ) : method === "input" ? (
          <form
            className="flex flex-col sm:flex-row items-stretch sm:items-end gap-2 mt-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitCustomAnswer();
            }}
          >
            <textarea
              ref={textareaRef}
              name="answer"
              rows={2}
              onKeyDown={(e) => {
                if (
                  shouldSubmitMultilineAnswer({
                    key: e.key,
                    shiftKey: e.shiftKey,
                    isComposing: Boolean(e.nativeEvent?.isComposing || e.keyCode === 229),
                    keyCode: e.keyCode,
                  })
                ) {
                  e.preventDefault();
                  submitCustomAnswer();
                }
              }}
              placeholder="Type your answer... (Enter to send, Shift+Enter for new line)"
              className="flex-1 min-w-0 px-2.5 py-1.5 text-sm rounded-md bg-background border border-border outline-none focus:border-primary font-mono resize-y max-h-40"
              autoFocus
            />
            <button
              type="submit"
              className="px-3 py-1.5 text-sm rounded-md bg-accent/50 hover:bg-accent transition-colors shrink-0 cursor-pointer"
            >
              Submit
            </button>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2 mt-2">
            {options.map((opt, idx) => (
              <button
                key={opt}
                type="button"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-accent/50 hover:bg-accent transition-colors cursor-pointer max-w-full"
                onClick={() => submitOption(opt)}
              >
                {idx < 9 && (
                  <kbd
                    className="inline-flex items-center justify-center min-w-[1.125rem] h-[1.125rem] px-1 text-[10px] font-mono rounded bg-background/70 border border-border/70 text-muted-foreground shrink-0"
                    aria-hidden="true"
                  >
                    {idx + 1}
                  </kbd>
                )}
                <span className="break-words text-left">{opt}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Memoized: during streaming every text delta updates ONE message — without
// memo the whole (potentially 1000+ item) list re-rendered per delta.
export const MessageItem = memo(function MessageItem({
  msg,
  searchQuery,
  onAskResponse,
  onLocalAskAnswer,
  hotkeyEnabled = true,
}: {
  msg: ChatMessage;
  searchQuery?: string;
  onAskResponse?: (id: string, value: string) => void;
  onLocalAskAnswer?: (msgId: string) => void;
  hotkeyEnabled?: boolean;
}) {
  // Inline ask_user with clickable options
  if (msg.className?.startsWith("ask|") || msg.className?.startsWith("ask-answered|")) {
    return <AskPromptCard msg={msg} onAskResponse={onAskResponse} onLocalAskAnswer={onLocalAskAnswer} hotkeyEnabled={hotkeyEnabled} />;
  }

  if (msg.role !== "user" && msg.role !== "assistant") {
    return <CollapsibleMessage msg={msg} searchQuery={searchQuery} />;
  }

  return (
    <div className="min-w-0" style={{ contentVisibility: "auto", containIntrinsicSize: "auto 90px" }}>
      <div className="flex items-center justify-between gap-1.5 min-w-0 mb-0.5">
        <div className={cn("text-[10px] font-bold uppercase tracking-wider min-w-0 truncate", getRoleColor(msg.role))}>
          {msg.timestamp && <span className="text-muted-foreground font-normal normal-case tracking-normal mr-1.5">[{formatClock(msg.timestamp)}]</span>}
          {msg.role}
        </div>
        <CopyOutputButton text={msg.text} compact label="Copy message" />
      </div>
      <div className={cn(
        "rounded-md bg-card p-2.5 text-[13px] whitespace-pre-wrap break-words [overflow-wrap:anywhere] min-w-0",
        msg.className === "streaming" && "border-l-2 border-cyan-400",
      )}>
        <HighlightText text={msg.text} query={searchQuery} />
      </div>
    </div>
  );
});

export const ToolGroup = memo(function ToolGroup({ call, result, searchQuery }: { call: ChatMessage; result: ChatMessage; searchQuery?: string }) {
  const [open, setOpen] = useState(false);
  const matchesSearch = searchQuery && (
    call.text.toLowerCase().includes(searchQuery.toLowerCase()) ||
    result.text.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const isExpanded = open || !!matchesSearch;
  const color = getRoleColor(call.role);
  const isError = result.text.startsWith("✗");
  const borderColor = isError ? "border-red-500" : "border-green-600";
  const cv = { contentVisibility: "auto" as const, containIntrinsicSize: "auto 40px" };

  const meta = result.meta;
  const statusIcon = isError ? "✗" : "✓";
  const statusColor = isError ? "text-red-500" : "text-green-500";
  const callSummary = formatToolCallSummary(call.text, 120);
  const copyableOutput = stripToolResultPrefix(result.text);

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
    <Collapsible open={isExpanded} onOpenChange={setOpen} style={cv}>
      <div className="flex items-center gap-1.5 min-w-0">
        <CollapsibleTrigger className={cn(
          "flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider cursor-pointer select-none hover:opacity-80 flex-1 min-w-0 text-left",
          color,
        )}>
          {isExpanded ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
          {call.timestamp && <span className="font-normal normal-case tracking-normal text-muted-foreground flex-shrink-0">[{formatClock(call.timestamp)}]</span>}
          <span className="flex-shrink-0">{call.role}</span>
          <span className={cn("flex-shrink-0", statusColor)}>{statusIcon}</span>
          {!isExpanded && statsStr && (
            <span className="font-normal normal-case tracking-normal text-muted-foreground ml-1 text-[10px] flex-shrink-0">
              {statsStr}
            </span>
          )}
          {!isExpanded && callSummary && (
            <span className="font-normal normal-case tracking-normal text-muted-foreground ml-1 truncate">{callSummary}</span>
          )}
        </CollapsibleTrigger>
        {!isExpanded && <CopyOutputButton text={copyableOutput} compact label="Copy output" />}
      </div>
      <CollapsibleContent>
        <div className={cn(
          "mt-1 rounded-md bg-card p-2.5 text-[11px] whitespace-pre-wrap break-words [overflow-wrap:anywhere] border-l-2 min-w-0",
          "border-orange-500",
        )}>
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-[9px] font-bold uppercase text-muted-foreground">call</span>
            <CopyOutputButton text={call.text} compact label="Copy call" />
          </div>
          {call.text
            ? <HighlightText text={call.text} query={searchQuery} />
            : <span className="text-muted-foreground italic">(no arguments)</span>}
        </div>
        <div className={cn(
          "mt-1 rounded-md bg-card p-2.5 text-[11px] whitespace-pre-wrap break-words [overflow-wrap:anywhere] border-l-2 min-w-0",
          borderColor,
        )}>
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-[9px] font-bold uppercase text-muted-foreground">result</span>
            <CopyOutputButton text={copyableOutput} compact label="Copy output" />
          </div>
          <HighlightText text={result.text} query={searchQuery} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});

export function CollapsibleMessage({ msg, searchQuery }: { msg: ChatMessage; searchQuery?: string }) {
  const [open, setOpen] = useState(false);
  const matchesSearch = searchQuery && (
    msg.text.toLowerCase().includes(searchQuery.toLowerCase()) ||
    Boolean(msg.meta?.partialOutput?.toLowerCase().includes(searchQuery.toLowerCase()))
  );
  const isExpanded = open || !!matchesSearch;
  const color = getRoleColor(msg.role);
  const isResult = msg.className === "tool-result";
  const isCall = msg.className === "tool-call";
  const isError = isResult && msg.text.startsWith("✗");
  const borderColor = msg.role === "thinking" ? "border-purple-500" : isResult ? (isError ? "border-red-500" : "border-green-600") : "border-orange-500";
  // content-visibility: the browser skips layout/paint for offscreen items —
  // with 1000+ history messages this is the difference between janky and
  // instant scrolling.
  const cv = { contentVisibility: "auto" as const, containIntrinsicSize: "auto 40px" };

  const summary = formatToolCallSummary(msg.text, 100);
  const copyableOutput = isResult ? stripToolResultPrefix(msg.text) : msg.text;
  const copyLabel = isResult ? "Copy output" : isCall ? "Copy call" : "Copy content";
  const partialOutput = isCall ? msg.meta?.partialOutput : undefined;

  return (
    <Collapsible open={isExpanded} onOpenChange={setOpen} style={cv}>
      <div className="flex items-center gap-1.5 min-w-0">
        <CollapsibleTrigger className={cn(
          "flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider cursor-pointer select-none hover:opacity-80 flex-1 min-w-0 text-left",
          color,
        )}>
          {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          {msg.timestamp && <span className="font-normal normal-case tracking-normal text-muted-foreground shrink-0">[{formatClock(msg.timestamp)}]</span>}
          <span className="shrink-0">{msg.role}</span>
          {!isExpanded && msg.meta?.startTs && msg.meta?.endTs && (
            <span className="font-normal normal-case tracking-normal text-muted-foreground ml-1 flex-shrink-0">
              {formatDuration(msg.meta.endTs - msg.meta.startTs)}
            </span>
          )}
          {!isExpanded && summary && <span className="font-normal normal-case tracking-normal text-muted-foreground ml-1 truncate">{summary}</span>}
        </CollapsibleTrigger>
        <CopyOutputButton text={copyableOutput} compact label={copyLabel} />
      </div>
      <CollapsibleContent>
        <div className={cn(
          "mt-1 rounded-md bg-card p-2.5 text-[13px] whitespace-pre-wrap break-words [overflow-wrap:anywhere] border-l-2 min-w-0",
          borderColor,
          msg.role === "thinking" && "text-muted-foreground italic",
          (isCall || isResult) && "text-[11px]",
        )}>
          {msg.text
            ? <HighlightText text={msg.text} query={searchQuery} />
            : <span className="text-muted-foreground italic">(empty)</span>}
        </div>
        {partialOutput && (
          <div className="mt-1 rounded-md bg-card p-2.5 text-[11px] whitespace-pre-wrap break-words [overflow-wrap:anywhere] border-l-2 border-cyan-500 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-[9px] font-bold uppercase text-muted-foreground">progress</span>
              <CopyOutputButton text={partialOutput} compact label="Copy output" />
            </div>
            <HighlightText text={partialOutput} query={searchQuery} />
          </div>
        )}
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
