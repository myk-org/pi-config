import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  GitFork,
  Lock,
  Radio,
  RefreshCw,
  Scissors,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/create-logger";
import {
  computeOpTimeoutMs,
  copyTextInBrowser,
  getRemovableWorktrees,
  isSafePrUrl,
  pruneSelectedWorktreePaths,
  shouldAcceptWorktreesList,
} from "@/lib/worktrees-panel-helpers";
import type { WorktreeDetailPayload, WorktreeItem, WorktreeOpResult } from "@/types";

const log = createLogger("WorktreesPanel");

const LIST_REQUEST_TIMEOUT_MS = 15_000;
const DETAIL_REQUEST_TIMEOUT_MS = 15_000;

let requestSeq = 0;
function nextRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++requestSeq}`;
}

interface Props {
  sessionId: string;
  cwd: string;
  sendCmd: (command: string, extra?: Record<string, unknown>) => void;
  onMessage: (handler: (data: any) => void) => () => void;
  notify: (msg: string, level?: string) => void;
}

/**
 * #1427 — PiDash Worktrees panel with full feature parity to TUI `/worktree`.
 * Reuses backend worktree helpers (single source of truth) and synchronizes across
 * same-repository sessions via minimal `worktrees-changed` notices.
 */
export function WorktreesPanel({ sessionId, cwd, sendCmd, onMessage, notify }: Props) {
  const [worktrees, setWorktrees] = useState<WorktreeItem[] | null>(null);
  const [linkedCount, setLinkedCount] = useState(0);
  const [dirtyCount, setDirtyCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyOp, setBusyOp] = useState<"prune" | "remove" | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [detailsByPath, setDetailsByPath] = useState<Record<string, WorktreeDetailPayload>>({});
  const [loadingDetailPath, setLoadingDetailPath] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [confirmTargets, setConfirmTargets] = useState<WorktreeItem[] | null>(null);

  const expandedPathRef = useRef<string | null>(null);
  const latestListReqRef = useRef<{ requestId: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const latestDetailReqRef = useRef<{ requestId: string; path: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const pendingOpRef = useRef<{ requestId: string; op: "prune" | "remove"; timer: ReturnType<typeof setTimeout> } | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    expandedPathRef.current = expandedPath;
  }, [expandedPath]);

  const clearListTimer = useCallback(() => {
    if (latestListReqRef.current) {
      clearTimeout(latestListReqRef.current.timer);
      latestListReqRef.current = null;
    }
  }, []);

  const clearDetailTimer = useCallback(() => {
    if (latestDetailReqRef.current) {
      clearTimeout(latestDetailReqRef.current.timer);
      latestDetailReqRef.current = null;
    }
  }, []);

  const clearPendingOp = useCallback(() => {
    if (pendingOpRef.current) {
      clearTimeout(pendingOpRef.current.timer);
      pendingOpRef.current = null;
    }
    setBusyOp(null);
  }, []);

  const requestDetail = useCallback(
    (wtPath: string) => {
      clearDetailTimer();
      const requestId = nextRequestId("wt-detail");
      const timer = setTimeout(() => {
        if (latestDetailReqRef.current?.requestId !== requestId) return;
        latestDetailReqRef.current = null;
        setLoadingDetailPath((prev) => (prev === wtPath ? null : prev));
        setDetailsByPath((prev) => ({
          ...prev,
          [wtPath]: {
            path: wtPath,
            headSubject: "",
            statusLines: [],
            truncatedCount: 0,
            statusOk: false,
            error: "Timed out loading worktree status — no response from session.",
          },
        }));
        log.warn("worktree detail request timed out", { path: wtPath, requestId });
      }, DETAIL_REQUEST_TIMEOUT_MS);
      latestDetailReqRef.current = { requestId, path: wtPath, timer };
      setLoadingDetailPath(wtPath);
      sendCmd("worktrees-detail", { path: wtPath, requestId });
    },
    [sendCmd, clearDetailTimer],
  );

  const requestList = useCallback(
    (opts: { forceRefreshPrs?: boolean; refreshExpanded?: boolean } = {}) => {
      clearListTimer();
      const requestId = nextRequestId("wt-list");
      const timer = setTimeout(() => {
        if (latestListReqRef.current?.requestId !== requestId) return;
        latestListReqRef.current = null;
        setRefreshing(false);
        setError("Timed out loading worktrees — no response from session.");
        log.warn("worktrees list request timed out", { sessionId, requestId });
      }, LIST_REQUEST_TIMEOUT_MS);
      latestListReqRef.current = { requestId, timer };
      setRefreshing(true);
      log.debug("requesting worktrees list", { sessionId, requestId, forceRefreshPrs: !!opts.forceRefreshPrs });
      sendCmd("worktrees-list", {
        forceRefresh: true,
        forceRefreshPrs: opts.forceRefreshPrs === true,
        requestId,
      });
      if (opts.refreshExpanded && expandedPathRef.current) {
        requestDetail(expandedPathRef.current);
      }
    },
    [sendCmd, sessionId, clearListTimer, requestDetail],
  );

  useEffect(() => {
    // Reset state on session / cwd switch so stale repo data never leaks across projects.
    clearListTimer();
    clearDetailTimer();
    clearPendingOp();
    setWorktrees(null);
    setLinkedCount(0);
    setDirtyCount(0);
    setError(null);
    setSelectedPaths(new Set());
    setExpandedPath(null);
    setDetailsByPath({});
    setLoadingDetailPath(null);
    setConfirmTargets(null);

    requestList({ forceRefreshPrs: false });

    const unsub = onMessage((ev: any) => {
      if (ev.type === "worktrees-changed") {
        log.debug("same-repo worktrees-changed notice received; refetching", {
          sessionId,
          sourceSessionId: ev.sourceSessionId,
        });
        requestList({ forceRefreshPrs: false, refreshExpanded: true });
        return;
      }

      if (ev.type === "worktrees-list") {
        if (!shouldAcceptWorktreesList(ev, sessionId, cwd, latestListReqRef.current?.requestId ?? null)) {
          log.debug("ignoring stale or mismatched worktrees-list", {
            evCwd: ev.cwd,
            cwd,
            evRequestId: ev.requestId,
            expectedRequestId: latestListReqRef.current?.requestId ?? null,
          });
          return;
        }
        clearListTimer();
        setRefreshing(false);
        if (typeof ev.error === "string" && ev.error) {
          setError(ev.error);
          log.warn("worktrees list error received", { error: ev.error });
          return;
        }
        const items: WorktreeItem[] = Array.isArray(ev.worktrees) ? ev.worktrees : [];
        setWorktrees(items);
        setLinkedCount(typeof ev.linkedCount === "number" ? ev.linkedCount : 0);
        setDirtyCount(typeof ev.dirtyCount === "number" ? ev.dirtyCount : 0);
        setError(null);
        setSelectedPaths((prev) => pruneSelectedWorktreePaths(prev, items));
        if (expandedPathRef.current && !items.some((w) => w.path === expandedPathRef.current)) {
          setExpandedPath(null);
        }
        log.debug("worktrees list received", { count: items.length, linkedCount: ev.linkedCount, dirtyCount: ev.dirtyCount });
      }

      if (ev.type === "worktrees-detail" && typeof ev.path === "string") {
        const pendingDetail = latestDetailReqRef.current;
        if (pendingDetail && ev.requestId && ev.requestId !== pendingDetail.requestId) {
          log.debug("ignoring stale worktrees-detail reply", { evRequestId: ev.requestId, expected: pendingDetail.requestId });
          return;
        }
        if (expandedPathRef.current && ev.path !== expandedPathRef.current && pendingDetail?.path !== ev.path) {
          return;
        }
        if (pendingDetail && (!ev.requestId || pendingDetail.requestId === ev.requestId)) {
          clearDetailTimer();
        }
        setDetailsByPath((prev) => ({ ...prev, [ev.path]: ev as WorktreeDetailPayload }));
        setLoadingDetailPath((prev) => (prev === ev.path ? null : prev));
      }

      if (ev.type === "worktrees-op-result") {
        const res = ev as WorktreeOpResult;
        const pending = pendingOpRef.current;
        // Retain mutation notifications only for the operation initiated by this panel instance.
        if (!pending) return;
        if (res.requestId && pending.requestId !== res.requestId) return;
        clearPendingOp();
        notify(res.message || `${res.op} ${res.ok ? "succeeded" : "failed"}`, res.ok ? "info" : "error");
        if (res.op === "remove" && Array.isArray(res.removed) && res.removed.length > 0) {
          const removedSet = new Set(res.removed);
          setSelectedPaths((prev) => {
            const next = new Set(prev);
            for (const p of removedSet) next.delete(p);
            return next;
          });
          if (expandedPathRef.current && removedSet.has(expandedPathRef.current)) {
            setExpandedPath(null);
          }
        }
      }
    });

    return () => {
      unsub();
      clearListTimer();
      clearDetailTimer();
      clearPendingOp();
    };
  }, [sessionId, cwd, onMessage, notify, requestList, clearListTimer, clearDetailTimer, clearPendingOp]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  // Close confirmation modal on Escape
  useEffect(() => {
    if (!confirmTargets) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setConfirmTargets(null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirmTargets]);

  const armPendingOp = (op: "prune" | "remove", targetCount = 1): string => {
    clearPendingOp();
    const requestId = nextRequestId(`wt-${op}`);
    const timeoutMs = computeOpTimeoutMs(op, targetCount);
    const timer = setTimeout(() => {
      if (pendingOpRef.current?.requestId !== requestId) return;
      log.warn("worktree operation timed out", { op, requestId, timeoutMs });
      clearPendingOp();
      notify(`Worktree ${op} timed out — no response from session`, "error");
    }, timeoutMs);
    pendingOpRef.current = { requestId, op, timer };
    setBusyOp(op);
    return requestId;
  };

  const handlePrune = () => {
    if (busyOp) return;
    const requestId = armPendingOp("prune", 1);
    log.info("triggering worktree prune", { sessionId, requestId });
    sendCmd("worktrees-prune", { requestId });
  };

  const handleConfirmRemove = () => {
    if (!confirmTargets || confirmTargets.length === 0 || busyOp) return;
    const paths = confirmTargets.map((w) => w.path);
    setConfirmTargets(null);
    const requestId = armPendingOp("remove", paths.length);
    log.info("triggering guarded worktree remove", { sessionId, count: paths.length, requestId });
    sendCmd("worktrees-remove", { paths, requestId });
  };

  const handleToggleExpand = (wt: WorktreeItem) => {
    if (expandedPath === wt.path) {
      clearDetailTimer();
      setLoadingDetailPath(null);
      setExpandedPath(null);
      return;
    }
    setExpandedPath(wt.path);
    requestDetail(wt.path);
  };

  const handleCopyPath = async (wtPath: string) => {
    const ok = await copyTextInBrowser(wtPath);
    if (ok) {
      setCopiedPath(wtPath);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopiedPath(null), 2000);
      notify(`Copied path: ${wtPath}`);
    } else {
      notify(`Copy unavailable — path: ${wtPath}`, "error");
    }
  };

  const toggleSelect = (wt: WorktreeItem) => {
    if (!wt.canRemove) return;
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(wt.path)) next.delete(wt.path);
      else next.add(wt.path);
      return next;
    });
  };

  const removableWorktrees = useMemo(() => getRemovableWorktrees(worktrees ?? []), [worktrees]);
  const selectedWorktrees = useMemo(
    () => (worktrees ?? []).filter((w) => selectedPaths.has(w.path) && w.canRemove),
    [worktrees, selectedPaths],
  );

  const selectAllRemovable = () => {
    setSelectedPaths(new Set(removableWorktrees.map((w) => w.path)));
  };

  return (
    <div className="p-3 space-y-2.5">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <GitFork className="h-3.5 w-3.5 text-primary shrink-0" />
            <span>Worktrees</span>
            {worktrees && (
              <span className="text-[11px] font-normal text-muted-foreground">
                ({worktrees.length})
              </span>
            )}
          </div>
          {worktrees && worktrees.length > 0 && (
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {linkedCount} linked
              {dirtyCount > 0 && (
                <span className="text-amber-500"> · {dirtyCount} dirty</span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-accent/50 hover:bg-accent text-foreground disabled:opacity-50"
            onClick={handlePrune}
            disabled={busyOp !== null}
            title="Prune stale worktree metadata (git worktree prune -v)"
          >
            <Scissors className="h-3 w-3" />
            <span>{busyOp === "prune" ? "Pruning…" : "Prune"}</span>
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-accent/50 hover:bg-accent text-foreground disabled:opacity-50"
            onClick={() => requestList({ forceRefreshPrs: true, refreshExpanded: true })}
            disabled={refreshing || busyOp !== null}
            title="Refresh worktrees, dirty counts, peers, and open PRs"
          >
            <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Bulk action bar */}
      {removableWorktrees.length > 0 && (
        <div className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md bg-muted/40 border border-border text-[11px]">
          <div className="flex items-center gap-2 text-muted-foreground">
            {selectedWorktrees.length > 0 ? (
              <span>{selectedWorktrees.length} selected</span>
            ) : (
              <span>{removableWorktrees.length} removable</span>
            )}
            {selectedWorktrees.length < removableWorktrees.length && (
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={selectAllRemovable}
              >
                Select removable
              </button>
            )}
            {selectedWorktrees.length > 0 && (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setSelectedPaths(new Set())}
              >
                Clear
              </button>
            )}
          </div>
          {selectedWorktrees.length > 0 && (
            <button
              type="button"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/35 disabled:opacity-50"
              disabled={busyOp !== null}
              onClick={() => setConfirmTargets(selectedWorktrees)}
            >
              <Trash2 className="h-3 w-3" />
              <span>Remove ({selectedWorktrees.length})</span>
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between gap-2 text-xs text-red-400 p-2 rounded-md bg-red-500/10 border border-red-500/30 break-words">
          <span className="flex-1 min-w-0">{error}</span>
          <button
            type="button"
            className="px-2 py-0.5 text-[10px] rounded bg-red-500/20 hover:bg-red-500/35 text-red-300 shrink-0"
            onClick={() => requestList({ forceRefreshPrs: true, refreshExpanded: true })}
          >
            Retry
          </button>
        </div>
      )}

      {worktrees === null && !error && (
        <div className="text-xs text-muted-foreground py-6 text-center">Loading worktrees…</div>
      )}

      {worktrees && worktrees.length === 0 && !error && (
        <div className="text-xs text-muted-foreground py-6 text-center">
          Not in a git repository (no worktrees found).
        </div>
      )}

      {/* Worktree rows */}
      <div className="space-y-1.5">
        {(worktrees ?? []).map((wt) => {
          const isDirty = (wt.dirty?.total ?? 0) > 0;
          const isExpanded = expandedPath === wt.path;
          const isSelected = selectedPaths.has(wt.path);
          const detail = detailsByPath[wt.path];
          const isLoadingDetail = loadingDetailPath === wt.path;

          const statusDotClass = wt.prunable
            ? "text-red-400"
            : wt.bare
              ? "text-muted-foreground"
              : isDirty
                ? "text-amber-400"
                : "text-green-500";
          const statusGlyph = wt.prunable ? "◌" : wt.bare ? "○" : "●";

          const dirtyBadgeClass =
            wt.dirtyText === "clean"
              ? "text-green-500 bg-green-500/10 border-green-500/20"
              : wt.dirtyText === "prunable"
                ? "text-red-400 bg-red-500/10 border-red-500/30"
                : wt.dirtyText === "bare" || wt.dirtyText === "unknown"
                  ? "text-muted-foreground bg-muted/40 border-border"
                  : "text-amber-500 bg-amber-500/10 border-amber-500/30";

          return (
            <div
              key={wt.id}
              className={cn(
                "rounded-md bg-card border text-xs transition-colors",
                isSelected ? "border-primary" : isExpanded ? "border-primary/60" : "border-border",
              )}
            >
              <div className="p-2 space-y-1.5">
                {/* Top line: checkbox + status dot + branch/label + row actions */}
                <div className="flex items-start gap-1.5">
                  <input
                    type="checkbox"
                    aria-label={`Select worktree ${wt.label}`}
                    className="mt-0.5 shrink-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                    checked={isSelected}
                    disabled={!wt.canRemove || busyOp !== null}
                    title={wt.canRemove ? "Select for bulk removal" : wt.removeBlockedReason}
                    onChange={() => toggleSelect(wt)}
                  />
                  <button
                    type="button"
                    className="flex-1 min-w-0 text-left flex items-start gap-1.5 group"
                    onClick={() => handleToggleExpand(wt)}
                    aria-expanded={isExpanded}
                    title="Toggle worktree details and git status"
                  >
                    <span className="mt-0.5 text-muted-foreground group-hover:text-foreground shrink-0">
                      {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    </span>
                    <span className={cn("shrink-0 leading-4", statusDotClass)} aria-hidden="true">
                      {statusGlyph}
                    </span>
                    <span className="font-medium text-foreground break-all leading-4">
                      {wt.label}
                    </span>
                  </button>
                  {/* Row quick actions — siblings, never nested inside toggle button */}
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40"
                      onClick={() => void handleCopyPath(wt.path)}
                      title={`Copy path: ${wt.path}`}
                      aria-label={`Copy path for ${wt.label}`}
                    >
                      {copiedPath === wt.path ? (
                        <Check className="h-3 w-3 text-green-500" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                    <button
                      type="button"
                      className={cn(
                        "p-1 rounded transition-colors",
                        wt.canRemove
                          ? "text-muted-foreground hover:text-red-400 hover:bg-red-500/15"
                          : "text-muted-foreground/35 cursor-not-allowed",
                      )}
                      disabled={!wt.canRemove || busyOp !== null}
                      onClick={() => wt.canRemove && setConfirmTargets([wt])}
                      title={wt.canRemove ? `Remove worktree ${wt.relativePath}` : wt.removeBlockedReason}
                      aria-label={wt.canRemove ? `Remove worktree ${wt.label}` : `Cannot remove ${wt.label}: ${wt.removeBlockedReason}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                {/* Relative path */}
                <div className="pl-5 text-[10px] font-mono text-muted-foreground truncate" title={wt.path}>
                  {wt.relativePath}
                </div>

                {/* Badges: tags, dirty count, PR link, COMS peers */}
                <div className="pl-5 flex flex-wrap items-center gap-1">
                  {wt.isCurrent && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-primary/15 text-primary border border-primary/30">
                      current
                    </span>
                  )}
                  {wt.isMain && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-muted/60 text-muted-foreground border border-border">
                      main
                    </span>
                  )}
                  {wt.bare && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-muted/60 text-muted-foreground border border-border">
                      bare
                    </span>
                  )}
                  {wt.locked && (
                    <span
                      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-500 border border-amber-500/30"
                      title={wt.lockedReason ? `Locked: ${wt.lockedReason}` : "Locked worktree"}
                    >
                      <Lock className="h-2.5 w-2.5" />
                      locked
                    </span>
                  )}
                  {wt.prunable && (
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/15 text-red-400 border border-red-500/30"
                      title={wt.prunableReason || "Missing/prunable worktree directory"}
                    >
                      prunable
                    </span>
                  )}
                  <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-mono border", dirtyBadgeClass)}>
                    {wt.dirtyText}
                  </span>
                  {wt.pr && isSafePrUrl(wt.pr.url) && (
                    <a
                      href={wt.pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] bg-primary/10 text-primary border border-primary/25 hover:bg-primary/20"
                      title={`Open PR #${wt.pr.number}: ${wt.pr.url}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span>#{wt.pr.number}</span>
                      <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  )}
                  {wt.peers.map((peer) => (
                    <span
                      key={`${peer.project}:${peer.name}`}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border border-cyan-500/30"
                      title={`${peer.name} (${peer.busy ? "busy" : "idle"}${peer.pid ? `, pid:${peer.pid}` : ""})${peer.purpose ? ` — ${peer.purpose}` : ""}`}
                    >
                      <Radio className="h-2.5 w-2.5" />
                      <span>{peer.name}</span>
                      {peer.busy && <span className="text-amber-500">●</span>}
                    </span>
                  ))}
                </div>
              </div>

              {/* Expandable detail drawer */}
              {isExpanded && (
                <div className="border-t border-border px-2.5 py-2 bg-muted/20 space-y-2 text-[11px]">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground shrink-0">Path</span>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-accent/50 hover:bg-accent text-foreground"
                        onClick={() => void handleCopyPath(wt.path)}
                      >
                        {copiedPath === wt.path ? <Check className="h-2.5 w-2.5 text-green-500" /> : <Copy className="h-2.5 w-2.5" />}
                        <span>{copiedPath === wt.path ? "Copied" : "Copy Path"}</span>
                      </button>
                    </div>
                    <div className="font-mono text-[10px] text-foreground break-all select-all bg-background/60 px-1.5 py-1 rounded border border-border/60">
                      {wt.path}
                    </div>
                  </div>

                  <div className="grid grid-cols-[64px_1fr] gap-y-1 gap-x-2 text-[10px]">
                    <span className="text-muted-foreground">HEAD</span>
                    <span className="font-mono text-foreground break-words">
                      {wt.head ? wt.head.slice(0, 10) : "(none)"}
                      {detail?.headSubject ? ` — ${detail.headSubject}` : ""}
                    </span>

                    {wt.peers.length > 0 && (
                      <>
                        <span className="text-muted-foreground">COMS</span>
                        <span className="text-cyan-600 dark:text-cyan-400 break-words">
                          {wt.peers
                            .map((p) => `${p.name} (${p.busy ? "busy" : "idle"}${p.pid ? `, pid:${p.pid}` : ""})${p.purpose ? ` — ${p.purpose}` : ""}`)
                            .join("; ")}
                        </span>
                      </>
                    )}

                    <span className="text-muted-foreground">Remove</span>
                    <span className={wt.canRemove ? "text-muted-foreground" : "text-amber-500"}>
                      {wt.canRemove ? "Allowed (confirmation required)" : `Blocked — ${wt.removeBlockedReason}`}
                    </span>
                  </div>

                  {/* git status --short */}
                  <div className="space-y-1">
                    <div className="text-[10px] text-muted-foreground font-medium">
                      Working tree status
                    </div>
                    {isLoadingDetail && !detail ? (
                      <div className="text-[10px] text-muted-foreground italic">Loading git status…</div>
                    ) : wt.prunable ? (
                      <div className="text-[10px] text-red-400">
                        Worktree directory is missing/prunable — use Prune.
                      </div>
                    ) : wt.bare ? (
                      <div className="text-[10px] text-muted-foreground">Bare repository worktree.</div>
                    ) : detail?.error ? (
                      <div className="flex items-center justify-between gap-2 text-[10px] text-red-400">
                        <span className="flex-1 min-w-0">{detail.error}</span>
                        <button
                          type="button"
                          className="px-1.5 py-0.5 rounded bg-red-500/20 hover:bg-red-500/35 text-red-300 shrink-0"
                          onClick={() => requestDetail(wt.path)}
                        >
                          Retry
                        </button>
                      </div>
                    ) : detail && !detail.statusOk ? (
                      <div className="text-[10px] text-amber-500">
                        Working tree status unavailable{detail.statusError ? ` (${detail.statusError})` : ""}.
                      </div>
                    ) : detail && detail.statusLines.length === 0 ? (
                      <div className="text-[10px] text-green-500">Working tree clean.</div>
                    ) : detail ? (
                      <div className="space-y-1">
                        <pre className="text-[10px] font-mono bg-background/80 border border-border rounded p-1.5 max-h-48 overflow-auto whitespace-pre">
                          {detail.statusLines.join("\n")}
                        </pre>
                        {detail.truncatedCount > 0 && (
                          <div className="text-[10px] text-muted-foreground">
                            … +{detail.truncatedCount} more file{detail.truncatedCount === 1 ? "" : "s"}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Explicit confirmation modal for guarded single/bulk remove */}
      {confirmTargets && confirmTargets.length > 0 && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm worktree removal"
          onClick={() => setConfirmTargets(null)}
        >
          <div
            className="w-[400px] max-w-[92vw] rounded-lg bg-card border border-border shadow-xl p-4 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-foreground">
                {confirmTargets.length === 1
                  ? "Remove worktree?"
                  : `Remove ${confirmTargets.length} worktrees?`}
              </span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setConfirmTargets(null)}
                aria-label="Close confirmation dialog"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="text-xs text-muted-foreground">
              Runs guarded <code className="font-mono text-foreground">git worktree remove</code>. The session re-verifies clean state and active COMS peers right before removal.
            </div>

            <div className="max-h-48 overflow-y-auto space-y-1.5 rounded border border-border bg-background/50 p-2">
              {confirmTargets.map((wt) => (
                <div key={wt.path} className="text-xs">
                  <div className="font-medium text-foreground truncate">{wt.label}</div>
                  <div className="font-mono text-[10px] text-muted-foreground break-all">{wt.path}</div>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1.5 text-xs rounded bg-muted/50 hover:bg-muted text-foreground"
                onClick={() => setConfirmTargets(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-3 py-1.5 text-xs rounded bg-red-600 hover:bg-red-500 text-white font-medium"
                onClick={handleConfirmRemove}
              >
                Remove{confirmTargets.length > 1 ? ` (${confirmTargets.length})` : ""}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
