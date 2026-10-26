import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { MemoryStatus } from "@/types";

interface Props {
  sendCmd: (command: string, extra?: Record<string, unknown>) => void;
  onMessage: (handler: (data: any) => void) => () => void;
}

/** #968 E — memory status: usage, topics, situation report. */
export function MemoryPanel({ sendCmd, onMessage }: Props) {
  const [status, setStatus] = useState<MemoryStatus | null>(null);

  useEffect(() => {
    sendCmd("memory-status");
    return onMessage((ev: any) => {
      if (ev.type === "memory-status") setStatus(ev as MemoryStatus);
    });
  }, [sendCmd, onMessage]);

  if (!status) return <div className="text-xs text-muted-foreground p-4 text-center">Loading memory status…</div>;

  if (status.error) {
    return <div className="text-xs text-red-400 p-4">Memory status failed: {status.error}</div>;
  }

  const pct = status.usagePct;
  return (
    <div className="p-3 space-y-3">
      <div className="text-xs font-semibold text-foreground">Memory</div>

      {pct !== null && (
        <div>
          <div className="flex justify-between text-[11px] text-muted-foreground mb-1">
            <span>Injection budget</span><span>{pct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all", pct > 80 ? "bg-red-500" : pct > 60 ? "bg-orange-400" : "bg-green-500")}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
        </div>
      )}

      <div>
        <div className="text-[11px] font-medium text-foreground mb-1">Topics ({status.topics.length})</div>
        {status.topics.length === 0 && <div className="text-xs text-muted-foreground">No topics</div>}
        <div className="space-y-1">
          {status.topics.map((t) => (
            <div key={t.name} className="flex items-center gap-2 p-1.5 rounded-md bg-card border border-border text-xs">
              <span className="font-medium text-foreground flex-1 truncate">{t.name}</span>
              <span className="text-[10px] text-muted-foreground">{t.entryCount} entries</span>
              <span className="text-[10px] text-primary" title="hotness">🔥{t.hotness}</span>
            </div>
          ))}
        </div>
      </div>

      {status.report && (
        <div>
          <div className="text-[11px] font-medium text-foreground mb-1">Situation report</div>
          <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap break-words p-2 rounded-md bg-card border border-border max-h-72 overflow-y-auto">{status.report}</pre>
        </div>
      )}
    </div>
  );
}
