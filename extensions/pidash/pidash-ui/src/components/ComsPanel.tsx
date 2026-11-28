import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ComsPeer, ComsQueueItem, SessionInfo } from "@/types";
import { createLogger } from "@/lib/create-logger";
import { CopyButton } from "@/components/CopyButton";

const log = createLogger("ComsPanel");

type ComsScope = "project" | "all";

interface Props {
  sendCmd: (command: string, extra?: Record<string, unknown>) => void;
  onMessage: (handler: (data: any) => void) => () => void;
  notify: (msg: string, level?: string) => void;
  /** Sessions known to this daemon — used to jump from a coms peer to its session. */
  sessions?: SessionInfo[];
  onWatch?: (s: SessionInfo) => void;
}

function peerKey(p: Pick<ComsPeer, "name" | "project">): string {
  return `${p.project ?? ""}::${p.name}`;
}

function formatPeerCopyText(p: ComsPeer): string {
  const lines = [`Peer: ${p.name}${p.project ? ` (${p.project})` : ""}`];
  lines.push(`Status: ${p.busy ? "busy" : "idle"} · ctx ${p.contextUsedPct}% · queue ${p.queueDepth}`);
  if (p.model) lines.push(`Model: ${p.model}`);
  if (p.purpose) lines.push(`Purpose: ${p.purpose}`);
  if (p.cwd) lines.push(`CWD: ${p.cwd}`);
  if (p.supervised) lines.push("Supervised: yes");
  return lines.join("\n");
}

function formatQueueItemCopyText(item: ComsQueueItem): string {
  return `From: ${item.sender_name}\nMessage ID: ${item.msg_id}\nStatus: ${item.status}\nPrompt:\n${item.prompt}`;
}

/** #968 C / #1481 — coms peer list with scope toggle, supervised Kill, inbound queue, and Copy buttons. */
export function ComsPanel({ sendCmd, onMessage, notify, sessions = [], onWatch }: Props) {
  const [scope, setScope] = useState<ComsScope>("project");
  const [rawPeers, setRawPeers] = useState<ComsPeer[]>([]);
  const [ownProject, setOwnProject] = useState<string>("");
  const [self, setSelf] = useState<{ name?: string; purpose?: string; project?: string } | null>(null);
  const [buildStatus, setBuildStatus] = useState<{ state: string; targetTag?: string | null; logPath?: string } | null>(null);
  const [confirmKillKey, setConfirmKillKey] = useState<string | null>(null);
  const [killingKey, setKillingKey] = useState<string | null>(null);
  const [queueItems, setQueueItems] = useState<ComsQueueItem[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);
  const [expandedQueueIds, setExpandedQueueIds] = useState<Set<string>>(() => new Set());
  const [cancelingMsgId, setCancelingMsgId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const scopeRef = useRef<ComsScope>(scope);
  scopeRef.current = scope;
  const prevQueueCountRef = useRef(0);
  const userToggledQueueRef = useRef(false);

  const peers = useMemo(() => {
    if (scope === "all") return rawPeers;
    const targetProject = ownProject || self?.project || "";
    if (!targetProject) return rawPeers;
    return rawPeers.filter((p) => !p.project || p.project === targetProject);
  }, [rawPeers, scope, ownProject, self?.project]);

  useEffect(() => {
    sendCmd("coms-peers", { scope, requestId: `peers-${Date.now()}` });
    sendCmd("coms-queue");
  }, [sendCmd, scope]);

  useEffect(() => {
    fetch("/api/podman-build-status")
      .then((r) => (r.ok ? r.json() : null))
      .then((snap) => {
        if (snap && snap.state === "building") setBuildStatus(snap);
      })
      .catch(() => {});
    return onMessage((ev: any) => {
      if (ev.type === "coms-peers") {
        setRefreshing(false);
        const hasAllPeers = Array.isArray(ev.allPeers);
        // If a legacy/partial project-only snapshot arrives from another tab while
        // THIS tab is in "all" scope, ignore it so this tab never loses other projects.
        if (!hasAllPeers && scopeRef.current === "all" && ev.scope === "project") return;
        const nextSource: ComsPeer[] = hasAllPeers
          ? ev.allPeers
          : Array.isArray(ev.peers)
            ? ev.peers
            : [];
        const nextOwnProject =
          typeof ev.ownProject === "string" && ev.ownProject
            ? ev.ownProject
            : typeof ev.self?.project === "string"
              ? ev.self.project
              : "";
        setRawPeers(nextSource);
        if (nextOwnProject) setOwnProject(nextOwnProject);
        setSelf(ev.self || null);
      }
      if (ev.type === "podman-build-status") {
        if (ev.state === "building" || ev.state === "ready") {
          setBuildStatus({ state: ev.state, targetTag: ev.targetTag, logPath: ev.logPath });
        } else {
          setBuildStatus(null);
        }
      }
      if (ev.type === "coms-kill-result") {
        setKillingKey(null);
        setConfirmKillKey(null);
        if (ev.ok) {
          notify(ev.message || `Stopped ${ev.name ?? "peer"}`);
        } else {
          notify(ev.message || "Kill failed", "error");
        }
      }
      if (ev.type === "coms-queue") {
        const items: ComsQueueItem[] = Array.isArray(ev.items) ? ev.items : [];
        setQueueItems(items);
        if (prevQueueCountRef.current === 0 && items.length > 0 && !userToggledQueueRef.current) {
          setQueueOpen(true);
        }
        prevQueueCountRef.current = items.length;
      }
      if (ev.type === "coms-queue-kill-result") {
        setCancelingMsgId(null);
        if (ev.ok) {
          notify(`Cancelled queued message from ${ev.sender_name ?? "peer"}`);
        } else {
          notify(ev.error || "Cancel failed", "error");
        }
      }
    });
  }, [onMessage, notify]);

  const refresh = () => {
    setRefreshing(true);
    log.debug("coms_panel_refresh", { scope: scopeRef.current });
    sendCmd("coms-peers", { scope: scopeRef.current });
    sendCmd("coms-queue");
  };

  const changeScope = (nextScope: ComsScope) => {
    if (nextScope === scope) return;
    log.debug("coms_scope_changed", { from: scope, to: nextScope });
    setConfirmKillKey(null);
    setScope(nextScope);
  };

  const confirmKillPeer = (p: ComsPeer) => {
    const key = peerKey(p);
    setKillingKey(key);
    log.debug("coms_peer_kill_dispatched", { name: p.name, project: p.project ?? null });
    sendCmd("coms-kill", {
      name: p.name,
      ...(p.project ? { project: p.project } : {}),
      scope: scopeRef.current,
      requestId: `kill-${Date.now()}`,
    });
  };

  const cancelQueueItem = (item: ComsQueueItem) => {
    setCancelingMsgId(item.msg_id);
    log.debug("coms_queue_kill_dispatched", { msg_id: item.msg_id });
    sendCmd("coms-queue-kill", {
      msg_id: item.msg_id,
      requestId: `qkill-${Date.now()}`,
    });
  };

  const toggleQueueItem = (msgId: string) => {
    setExpandedQueueIds((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      return next;
    });
  };

  return (
    <div className="p-3 space-y-2.5 min-w-0">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs font-semibold text-foreground min-w-0 flex items-center flex-wrap gap-1">
          <span>Coms</span>
          {self?.project && (
            <span
              className="px-1.5 py-0.5 rounded border border-border text-[10px] font-normal text-cyan-700 dark:text-cyan-400/90 max-w-full truncate"
              title="Coms project (collaboration namespace, spans repos)"
            >
              ◆ {self.project}
            </span>
          )}
          {self?.name && <span className="text-muted-foreground font-normal truncate">— {self.name}</span>}
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded border border-border bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted shrink-0"
          onClick={refresh}
          title="Refresh coms peers and inbound queue"
        >
          <RefreshCw className={cn("h-2.5 w-2.5", refreshing && "animate-spin")} />
          <span>Refresh</span>
        </button>
      </div>

      {buildStatus && (buildStatus.state === "building" || buildStatus.state === "ready") && (
        <div
          data-testid="podman-build-banner"
          className="px-2 py-1 rounded border border-border bg-muted/40 text-[10px] text-foreground flex items-center justify-between gap-2"
          title={buildStatus.logPath ? `Build log: ${buildStatus.logPath}` : undefined}
        >
          <span>{buildStatus.state === "building" ? "🐳 Building peer image…" : "✓ Peer image ready"}</span>
          {buildStatus.targetTag && <span className="text-muted-foreground truncate">{buildStatus.targetTag}</span>}
        </div>
      )}

      <div className="flex items-center gap-1 flex-wrap" role="group" aria-label="Coms project scope">
        <button
          type="button"
          aria-pressed={scope === "project"}
          onClick={() => changeScope("project")}
          className={cn(
            "px-2 py-0.5 text-[10px] rounded-full border transition-colors",
            scope === "project"
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-card text-muted-foreground border-border hover:text-foreground hover:bg-accent/40",
          )}
        >
          This project
        </button>
        <button
          type="button"
          aria-pressed={scope === "all"}
          onClick={() => changeScope("all")}
          className={cn(
            "px-2 py-0.5 text-[10px] rounded-full border transition-colors",
            scope === "all"
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-card text-muted-foreground border-border hover:text-foreground hover:bg-accent/40",
          )}
        >
          All projects
        </button>
      </div>

      {peers.length === 0 && (
        <div className="text-xs text-muted-foreground py-4 text-center">No peers connected</div>
      )}

      <div className="space-y-1.5">
        {peers.map((p) => {
          const key = peerKey(p);
          const peerProject = p.project || self?.project;
          const peerSession =
            sessions.find((s) => s.comsName === p.name && (!peerProject || s.comsProject === peerProject)) ??
            (peerProject ? undefined : sessions.find((s) => s.comsName === p.name));
          if (!peerSession) {
            log.debug("peer has no local session", { peer: p.name, project: peerProject ?? null });
          }
          const isConfirmingKill = confirmKillKey === key;
          const isKilling = killingKey === key;
          return (
            <div
              key={key}
              className="rounded-md bg-card border border-border text-xs transition-colors min-w-0"
            >
              <div className="w-full text-left p-2 min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span title={p.busy ? "busy" : "idle"}>{p.busy ? "⚙" : "●"}</span>
                  <span className="font-medium text-foreground flex-1 truncate">{p.name}</span>
                  {p.container && (
                    <span
                      data-testid="coms-peer-container-badge"
                      className="px-1 py-0.2 rounded border border-border text-[9px] text-cyan-700 dark:text-cyan-400 shrink-0 max-w-[10rem] truncate"
                      title={`Container: ${p.container} — podman exec -it ${p.container} bash`}
                    >
                      🐳 {p.container}
                    </span>
                  )}
                  {p.supervised && (
                    <span className="px-1 py-0 text-[9px] rounded border border-border bg-muted text-muted-foreground shrink-0">
                      supervised
                    </span>
                  )}
                  {p.busy && <span className="text-[10px] text-yellow-600 dark:text-yellow-400 shrink-0">busy</span>}
                </div>
                {scope === "all" && p.project && (
                  <div className="text-[10px] text-cyan-700 dark:text-cyan-400/90 truncate">◆ {p.project}</div>
                )}
                <div className="text-[10px] text-muted-foreground truncate">
                  {p.model}
                  {p.purpose ? `${p.model ? " — " : ""}${p.purpose}` : ""}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  ctx {p.contextUsedPct}%
                  {p.queueDepth > 0 && (
                    <span className="text-yellow-600 dark:text-yellow-400"> · queue {p.queueDepth}</span>
                  )}
                  {!peerSession && <span className="opacity-60"> · no local session</span>}
                </div>
              </div>

              {isConfirmingKill && p.supervised && (
                <div className="mx-2 mb-1.5 p-1.5 rounded bg-red-500/10 border border-red-500/30 flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-[10px] text-red-400 font-medium break-words">Kill {p.name}?</span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="px-1.5 py-0.5 text-[10px] rounded bg-muted/60 hover:bg-muted"
                      disabled={isKilling}
                      onClick={() => setConfirmKillKey(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="px-1.5 py-0.5 text-[10px] rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                      disabled={isKilling}
                      onClick={() => confirmKillPeer(p)}
                    >
                      {isKilling ? "Killing…" : "Confirm Kill"}
                    </button>
                  </div>
                </div>
              )}

              <div className="px-2 pb-1.5 flex items-center gap-1 flex-wrap justify-end">
                {peerSession && onWatch && (
                  <button
                    type="button"
                    title={`Watch this peer's session (${peerSession.cwd})`}
                    className="mr-auto text-[10px] text-muted-foreground hover:text-primary px-1.5 py-0.5 rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary"
                    onClick={() => {
                      log.debug("watching peer session", {
                        peer: p.name,
                        sessionId: peerSession.sessionId,
                        cwd: peerSession.cwd,
                      });
                      onWatch(peerSession);
                    }}
                  >
                    ⇢ watch {peerSession.cwd.split("/").pop()}
                  </button>
                )}
                <CopyButton
                  text={formatPeerCopyText(p)}
                  title={`Copy peer ${p.name}`}
                  onCopied={() => notify(`Copied peer ${p.name}`)}
                />
                {p.supervised && !isConfirmingKill && (
                  <button
                    type="button"
                    className="px-1.5 py-0.5 text-[10px] rounded bg-red-500/20 text-red-400 hover:bg-red-500/40"
                    onClick={() => setConfirmKillKey(key)}
                  >
                    Kill
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="pt-2 border-t border-border space-y-1.5 min-w-0">
        <button
          type="button"
          aria-expanded={queueOpen}
          onClick={() => {
            userToggledQueueRef.current = true;
            setQueueOpen((v) => !v);
          }}
          className="w-full flex items-center gap-1 text-[11px] font-semibold text-foreground hover:text-primary"
        >
          {queueOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          <span>Inbound Queue ({queueItems.length})</span>
        </button>

        {queueOpen && (
          <div className="space-y-1.5">
            {queueItems.length === 0 ? (
              <div className="text-[11px] text-muted-foreground py-1">No queued inbound messages</div>
            ) : (
              queueItems.map((item) => {
                const isExpanded = expandedQueueIds.has(item.msg_id);
                const shortId = item.msg_id.length > 8 ? item.msg_id.slice(-8) : item.msg_id;
                const isCanceling = cancelingMsgId === item.msg_id;
                return (
                  <div
                    key={item.msg_id}
                    data-queue-msg-id={item.msg_id}
                    className="p-2 rounded-md bg-card border border-border text-xs space-y-1 min-w-0"
                  >
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      onClick={() => toggleQueueItem(item.msg_id)}
                      className="w-full text-left flex items-center gap-1.5 min-w-0"
                    >
                      <span className="text-muted-foreground shrink-0">
                        {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      </span>
                      <span
                        className={cn(
                          "px-1 py-0 text-[9px] rounded border shrink-0",
                          item.status === "processing"
                            ? "bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 border-yellow-500/40"
                            : "bg-muted text-muted-foreground border-border",
                        )}
                      >
                        {item.status}
                      </span>
                      <span className="font-medium text-foreground truncate flex-1">{item.sender_name}</span>
                      <span className="text-[10px] text-muted-foreground font-mono shrink-0">{shortId}</span>
                    </button>
                    {isExpanded && (
                      <pre className="text-[10px] text-foreground whitespace-pre-wrap break-words p-1.5 rounded bg-background border border-border max-h-60 overflow-y-auto">
                        {item.prompt}
                      </pre>
                    )}
                    <div className="flex items-center gap-1 justify-end">
                      <CopyButton
                        text={formatQueueItemCopyText(item)}
                        title={`Copy queued message ${shortId}`}
                        onCopied={() => notify("Copied queued message")}
                      />
                      <button
                        type="button"
                        disabled={isCanceling}
                        className="px-1.5 py-0.5 text-[10px] rounded bg-red-500/20 text-red-400 hover:bg-red-500/40 disabled:opacity-50"
                        onClick={() => cancelQueueItem(item)}
                      >
                        {isCanceling ? "Cancelling…" : "Cancel"}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
