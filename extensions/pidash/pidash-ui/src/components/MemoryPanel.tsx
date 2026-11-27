import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/create-logger";
import { CopyButton } from "@/components/CopyButton";
import type { MemoryStatus } from "@/types";

const log = createLogger("MemoryPanel");

interface Props {
  sendCmd: (command: string, extra?: Record<string, unknown>) => void;
  onMessage: (handler: (data: any) => void) => () => void;
  notify?: (msg: string, level?: string) => void;
}

/** #968 E / #1481 — memory status: usage, topics, situation report with Refresh and Copy buttons. */
export function MemoryPanel({ sendCmd, onMessage, notify }: Props) {
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reportOpen, setReportOpen] = useState(true);

  useEffect(() => {
    sendCmd("memory-status");
    return onMessage((ev: any) => {
      if (ev.type === "memory-status") {
        setRefreshing(false);
        setStatus(ev as MemoryStatus);
      }
    });
  }, [sendCmd, onMessage]);

  const refresh = () => {
    setRefreshing(true);
    log.debug("memory_status_refresh");
    sendCmd("memory-status");
  };

  const topicsCopyText = useMemo(() => {
    if (!status?.topics?.length) return "";
    return status.topics
      .map((t) => `${t.name} — ${t.entryCount} entries (hotness ${t.hotness})`)
      .join("\n");
  }, [status?.topics]);

  const header = (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-semibold text-foreground">Memory</span>
      <button
        type="button"
        className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded border border-border bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted"
        onClick={refresh}
        title="Refresh memory status"
      >
        <RefreshCw className={cn("h-2.5 w-2.5", refreshing && "animate-spin")} />
        <span>Refresh</span>
      </button>
    </div>
  );

  if (!status) {
    return (
      <div className="p-3 space-y-2 min-w-0">
        {header}
        <div className="text-xs text-muted-foreground py-4 text-center">Loading memory status…</div>
      </div>
    );
  }

  if (status.error) {
    return (
      <div className="p-3 space-y-2 min-w-0">
        {header}
        <div className="text-xs text-red-400 p-2 rounded bg-red-500/10 border border-red-500/30 space-y-1.5">
          <div className="flex items-center justify-between gap-1">
            <span className="font-medium">Memory status failed</span>
            <CopyButton
              text={status.error}
              title="Copy memory error"
              onCopied={() => notify?.("Copied memory error")}
            />
          </div>
          <pre className="text-[10px] whitespace-pre-wrap break-words max-h-60 overflow-y-auto">{status.error}</pre>
        </div>
      </div>
    );
  }

  const pct = status.usagePct;
  return (
    <div className="p-3 space-y-3 min-w-0">
      {header}

      {pct !== null && (
        <div>
          <div className="flex justify-between text-[11px] text-muted-foreground mb-1">
            <span>Injection budget</span>
            <span>{pct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                pct > 80 ? "bg-red-500" : pct > 60 ? "bg-orange-400" : "bg-green-500",
              )}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
        </div>
      )}

      <div className="min-w-0">
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-[11px] font-medium text-foreground">Topics ({status.topics.length})</span>
          {status.topics.length > 0 && (
            <CopyButton
              text={topicsCopyText}
              title="Copy topics list"
              onCopied={() => notify?.("Copied topics list")}
            />
          )}
        </div>
        {status.topics.length === 0 && <div className="text-xs text-muted-foreground">No topics</div>}
        <div className="space-y-1">
          {status.topics.map((t) => (
            <div key={t.name} className="flex items-center gap-2 p-1.5 rounded-md bg-card border border-border text-xs min-w-0">
              <span className="font-medium text-foreground flex-1 truncate">{t.name}</span>
              <span className="text-[10px] text-muted-foreground shrink-0">{t.entryCount} entries</span>
              <span className="text-[10px] text-primary shrink-0" title="hotness">
                🔥{t.hotness}
              </span>
            </div>
          ))}
        </div>
      </div>

      {status.report && (
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <button
              type="button"
              aria-expanded={reportOpen}
              onClick={() => setReportOpen((v) => !v)}
              className="flex items-center gap-1 text-[11px] font-medium text-foreground hover:underline min-w-0"
            >
              {reportOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
              <span className="truncate">Situation report</span>
            </button>
            <CopyButton
              text={status.report}
              title="Copy situation report"
              onCopied={() => notify?.("Copied situation report")}
            />
          </div>
          {reportOpen && (
            <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap break-words p-2 rounded-md bg-card border border-border max-h-72 overflow-y-auto">
              {status.report}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
