import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { ComsPeer, SessionInfo } from "@/types";

interface Props {
  sendCmd: (command: string, extra?: Record<string, unknown>) => void;
  onMessage: (handler: (data: any) => void) => () => void;
  notify: (msg: string, level?: string) => void;
  /** Sessions known to this daemon — used to jump from a coms peer to its session. */
  sessions?: SessionInfo[];
  onWatch?: (s: SessionInfo) => void;
}

/** #968 C — coms peer list with live state + send message to a peer. */
export function ComsPanel({ sendCmd, onMessage, notify, sessions = [], onWatch }: Props) {
  const [peers, setPeers] = useState<ComsPeer[]>([]);
  const [self, setSelf] = useState<{ name?: string; purpose?: string; project?: string } | null>(null);
  const [selected, setSelected] = useState<ComsPeer | null>(null);
  const [prompt, setPrompt] = useState("");
  const [steer, setSteer] = useState(false);
  const [priority, setPriority] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    sendCmd("coms-peers");
    return onMessage((ev: any) => {
      if (ev.type === "coms-peers") {
        setPeers(ev.peers || []);
        setSelf(ev.self || null);
        // Keep selection fresh with live state
        setSelected((prev) => (prev ? (ev.peers || []).find((p: ComsPeer) => p.name === prev.name) ?? prev : prev));
      }
      if (ev.type === "coms-send-result") {
        setSending(false);
        if (ev.ok) {
          notify(`Sent to ${ev.target} (${ev.msg_id?.slice(-6) ?? "?"})`);
          setPrompt("");
        } else {
          notify(`Send failed: ${ev.error}`, "error");
        }
      }
    });
  }, [sendCmd, onMessage, notify]);

  const sendMsg = () => {
    if (!selected || !prompt.trim() || sending) return;
    setSending(true);
    sendCmd("coms-send", {
      target: selected.name,
      prompt: prompt.trim(),
      steer,
      priority,
      requestId: `send-${Date.now()}`,
    });
  };

  return (
    <div className="p-3 space-y-2">
      <div className="text-xs font-semibold text-foreground">
        Coms
        {self?.project && (
          <span className="ml-1 px-1.5 py-0.5 rounded border border-border text-[10px] font-normal text-cyan-700 dark:text-cyan-400/90" title="Coms project (collaboration namespace, spans repos)">
            ◆ {self.project}
          </span>
        )}
        {self?.name && <span className="text-muted-foreground font-normal"> — you are {self.name}</span>}
      </div>

      {peers.length === 0 && <div className="text-xs text-muted-foreground py-4 text-center">No peers connected</div>}

      <div className="space-y-1">
        {peers.map((p) => {
          // A peer is a coms identity; a pidash session with the same comsName
          // is the thing you can actually watch. Absent when the peer runs
          // outside this daemon (other machine, another project's server).
          const peerSession = sessions.find((s) => s.comsName === p.name);
          return (
          <div
            key={p.name}
            className={cn(
              "w-full text-left rounded-md bg-card border text-xs transition-colors",
              selected?.name === p.name ? "border-primary" : "border-border hover:border-primary/50",
            )}
          >
            <button className="w-full text-left p-2" onClick={() => setSelected(p)}>
              <div className="flex items-center gap-2">
                <span title={p.busy ? "busy" : "idle"}>{p.busy ? "⚙" : "●"}</span>
                <span className="font-medium text-foreground flex-1 truncate">{p.name}</span>
                {p.busy && <span className="text-[10px] text-yellow-600 dark:text-yellow-400">busy</span>}
                {peerSession && onWatch && (
                  <span
                    role="button"
                    tabIndex={0}
                    title={`Watch this peer's session (${peerSession.cwd.split("/").pop()})`}
                    className="text-[10px] text-muted-foreground hover:text-primary px-1 rounded border border-border"
                    onClick={(e) => { e.stopPropagation(); onWatch(peerSession); }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      e.stopPropagation();
                      onWatch(peerSession);
                    }}
                  >
                    ⇢ session
                  </span>
                )}
              </div>
              <div className="text-[10px] text-muted-foreground truncate">{p.model}{p.purpose ? ` — ${p.purpose}` : ""}</div>
              <div className="text-[10px] text-muted-foreground">
                ctx {p.contextUsedPct}%{p.queueDepth > 0 && <span className="text-yellow-600 dark:text-yellow-400"> · queue {p.queueDepth}</span>}
                {!peerSession && <span className="opacity-60"> · no local session</span>}
              </div>
            </button>
          </div>
          );
        })}
      </div>

      {selected && (
        <div className="p-2 rounded-md bg-card border border-border space-y-1.5">
          <div className="text-[11px] font-medium text-foreground">Message → {selected.name}</div>
          <textarea
            className="w-full px-2 py-1.5 text-xs rounded bg-background border border-border outline-none focus:border-primary resize-y min-h-[60px]"
            placeholder="Prompt to send…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={sending}
          />
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
            <label className="flex items-center gap-1 cursor-pointer">
              <input type="checkbox" checked={steer} onChange={(e) => setSteer(e.target.checked)} /> steer
            </label>
            <label className="flex items-center gap-1 cursor-pointer">
              <input type="checkbox" checked={priority} onChange={(e) => setPriority(e.target.checked)} /> priority
            </label>
            <button
              className="ml-auto px-2 py-1 text-[11px] rounded bg-primary text-primary-foreground disabled:opacity-50"
              onClick={sendMsg}
              disabled={!prompt.trim() || sending}
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
