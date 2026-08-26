import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { MultiFileDiff, WorkerPoolContextProvider } from "@pierre/diffs/react";
import type { FileContents, WorkerPoolOptions, WorkerInitializationRenderOptions } from "@pierre/diffs/react";
import { useFileTree, FileTree, useFileTreeSelection } from "@pierre/trees/react";
import { GitBranch, X, Send, Pencil } from "lucide-react";
import { themeToTreeStyles } from "@pierre/trees";
import { cn } from "@/lib/utils";
import { pierreFileCacheKey } from "@/lib/file-cache-key";
import { createLogger } from "@/lib/create-logger";
import { runAppRefresh } from "@/lib/request-diffs";
import { appReconnectEffect } from "@/lib/ws-send";
import { AppRefreshActions } from "@/lib/app-refresh-actions";
import { Button } from "@ui/button";
import { Separator } from "@ui/separator";
import { Switch } from "@/components/ui/switch";
import { useWebSocket } from "@/hooks/useWebSocket";
import type { DiffMode, DiffData, FileDiffData, GitCommit, ReviewComment, PiSession, Worktree } from "@/types";

const log = createLogger("pidiff-ui");

// ── WorkerPool (offloads diff computation to web workers) ───────────
const WORKER_POOL_OPTIONS: WorkerPoolOptions = {
  poolSize: Math.min(Math.max(1, (navigator?.hardwareConcurrency ?? 1) - 1), 3),
  workerFactory() {
    return new Worker(new URL("@pierre/diffs/worker/worker.js", import.meta.url));
  },
};

const HIGHLIGHTER_OPTIONS: WorkerInitializationRenderOptions = {
  theme: { dark: "pierre-dark", light: "pierre-light" },
  langs: ["typescript", "tsx", "javascript", "jsx", "css", "json", "markdown", "python", "sh", "yaml", "html"],
};
import type { GitStatusEntry } from "@pierre/trees";

// ── Tree theme (github-dark) ────────────────────────────────────────

const TREE_THEME = themeToTreeStyles({
  type: "dark",
  bg: "#0d1117",
  fg: "#e6edf3",
  colors: {
    "list.activeSelectionBackground": "#1f6feb33",
    "list.activeSelectionForeground": "#e6edf3",
    "list.hoverBackground": "#1f6feb1a",
    "sideBar.background": "#010409",
    "sideBar.foreground": "#e6edf3",
    "sideBarSectionHeader.background": "#010409",
    "gitDecoration.modifiedResourceForeground": "#d29922",
    "gitDecoration.addedResourceForeground": "#3fb950",
    "gitDecoration.deletedResourceForeground": "#f85149",
    "gitDecoration.untrackedResourceForeground": "#3fb950",
    "gitDecoration.renamedResourceForeground": "#d29922",
    "gitDecoration.ignoredResourceForeground": "#484f58",
    "input.background": "#0d1117",
    "input.border": "#30363d",
    "input.foreground": "#e6edf3",
    "focusBorder": "#1f6feb",
  },
});

// ── App ─────────────────────────────────────────────────────────────

export function App() {
  const { connected, send, onMessage } = useWebSocket();

  // Sessions
  const [sessions, setSessions] = useState<PiSession[]>([]);
  const [activeSession, setActiveSession] = useState<PiSession | null>(() => {
    try { const s = localStorage.getItem("pidiff-session"); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [activeWorktree, setActiveWorktree] = useState<Worktree | null>(null);
  const activeWorktreeRef = useRef<Worktree | null>(null);

  const [diffData, setDiffData] = useState<DiffData>({
    mode: "branch", files: [], branch: "",
  });
  const [mode, setMode] = useState<DiffMode>("branch");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [commitFrom, setCommitFrom] = useState("");
  const [commitTo, setCommitTo] = useState("");

  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("split");
  const [diffIndicators, setDiffIndicators] = useState<"bars" | "classic" | "none">("bars");
  const [lineDiffType, setLineDiffType] = useState<"word-alt" | "word" | "char" | "none">("word-alt");
  const [disableBackground, setDisableBackground] = useState(false);
  const [overflow, setOverflow] = useState<"scroll" | "wrap">("scroll");
  const [disableLineNumbers, setDisableLineNumbers] = useState(false);
  const [hunkSeparators, setHunkSeparators] = useState<"line-info" | "line-info-basic" | "metadata" | "simple">("line-info");
  const [fontSize, setFontSize] = useState(13);
  const [theme, setTheme] = useState<string>("pierre-dark");
  const [stale, setStale] = useState(() => {
    const testStale = Boolean((globalThis as { __pidiffTestStale?: boolean }).__pidiffTestStale);
    log.debug("App stale init", { testStale });
    return testStale;
  });
  const [staleWorktrees, setStaleWorktrees] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  // Review comments — persist in localStorage
  const [comments, setComments] = useState<ReviewComment[]>(() => {
    try { const s = localStorage.getItem("pidiff-comments"); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [openForms, setOpenForms] = useState<Array<{ file: string; side: "deletions" | "additions"; lineNumber: number }>>([]);
  const hasOpenForm = openForms.length > 0;

  useEffect(() => {
    try { localStorage.setItem("pidiff-comments", JSON.stringify(comments)); } catch {}
  }, [comments]);

  useEffect(() => {
    try {
      if (activeSession) localStorage.setItem("pidiff-session", JSON.stringify(activeSession));
      else localStorage.removeItem("pidiff-session");
    } catch {}
  }, [activeSession]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const commitsRequested = useRef(false);
  const activeSessionRef = useRef<PiSession | null>(null);
  const loadingTimeout = useRef<ReturnType<typeof setTimeout>>();
  const refreshTimeout = useRef<ReturnType<typeof setTimeout>>();
  const modeRef = useRef(mode);
  const scrollLock = useRef(0); // timestamp until which scroll-sync is paused
  const selectedFileRef = useRef<string | null>(null);
  const explorer = useExplorerWidth(280, 180, 600);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  useEffect(() => {
    appReconnectEffect(
      connected,
      activeWorktreeRef.current?.path,
      activeSessionRef.current?.sessionId,
      send,
    );
  }, [connected, send]);

  // ── WebSocket ─────────────────────────────────────────────────────

  useEffect(() => {
    return onMessage((ev: any) => {
      if (ev.type === "diff_update" && (ev.mode === modeRef.current || !ev.mode)) {
        const committed: FileDiffData[] = (ev.committed || []).map((f: any) => ({ ...f, area: "committed" as const }));
        const staged: FileDiffData[] = (ev.staged || []).map((f: any) => ({ ...f, area: "staged" as const }));
        const unstaged: FileDiffData[] = (ev.unstaged || []).map((f: any) => ({ ...f, area: "unstaged" as const }));
        // Deduplicate: unstaged > staged > committed
        const seen = new Set<string>();
        const allFiles: FileDiffData[] = [];
        for (const f of unstaged) { seen.add(f.name); allFiles.push(f); }
        for (const f of staged) { if (!seen.has(f.name)) { seen.add(f.name); allFiles.push(f); } }
        for (const f of committed) { if (!seen.has(f.name)) allFiles.push(f); }
        setDiffData({ mode: ev.mode || "branch", files: allFiles, branch: ev.branch || "", fromRef: ev.fromRef, toRef: ev.toRef });
        setLoading(false);
        setRefreshing(false);
        // Don't clear stale here — only Refresh button clears it
        if (loadingTimeout.current) clearTimeout(loadingTimeout.current);
        if (refreshTimeout.current) clearTimeout(refreshTimeout.current);
      }
      if (ev.type === "commits-list" && ev.commits) {
        setCommits(ev.commits);
      }
      if (ev.type === "status_changed") {
        if (ev.changedWorktrees && Array.isArray(ev.changedWorktrees)) {
          setStaleWorktrees(prev => {
            const next = new Set(prev);
            for (const p of ev.changedWorktrees) next.add(p);
            return next;
          });
          // Show banner ONLY if the currently active tab is stale
          const activePath = activeWorktreeRef.current?.path || activeSessionRef.current?.cwd;
          if (activePath && ev.changedWorktrees.includes(activePath)) {
            setStale(true);
          }
        } else {
          setStale(true);
        }
      }
      if (ev.type === "sessions-list" && ev.sessions) {
        setSessions(ev.sessions);
        // Restore saved session or auto-select first
        if (!activeSessionRef.current && ev.sessions.length > 0) {
          let saved: PiSession | null = null;
          try { const s = localStorage.getItem("pidiff-session"); if (s) saved = JSON.parse(s); } catch {}
          const target = saved ? ev.sessions.find(s => s.sessionId === saved!.sessionId) || ev.sessions[0] : ev.sessions[0];
          setActiveSession(target);
          activeSessionRef.current = target;
          send({ type: "watch", sessionId: target.sessionId });
          setLoading(true);
        }
      }
      if (ev.type === "session_added" && ev.session) {
        setSessions(prev => {
          if (prev.find(s => s.sessionId === ev.session.sessionId)) return prev;
          const next = [...prev, ev.session];
          // Auto-select if first session
          if (!activeSessionRef.current) {
            setActiveSession(ev.session);
            activeSessionRef.current = ev.session;
            send({ type: "watch", sessionId: ev.session.sessionId });
            setLoading(true);
          }
          return next;
        });
      }
      if (ev.type === "session_removed" && ev.sessionId) {
        setSessions(prev => prev.filter(s => s.sessionId !== ev.sessionId));
        if (activeSessionRef.current?.sessionId === ev.sessionId) {
          setActiveSession(null);
          activeSessionRef.current = null;
          setActiveWorktree(null);
          activeWorktreeRef.current = null;
          setStale(false);
          setRefreshing(false);
          setStaleWorktrees(new Set());
          setDiffData({ mode: "branch", files: [], branch: "" });
        }
      }
      if (ev.type === "session_updated" && ev.session) {
        setSessions(prev => prev.map(s => s.sessionId === ev.session.sessionId ? { ...s, ...ev.session } : s));
        if (activeSessionRef.current?.sessionId === ev.session.sessionId) {
          setActiveSession(prev => prev ? { ...prev, ...ev.session } : prev);
        }
      }
    });
  }, [onMessage]);

  useEffect(() => {
    if (loading) {
      loadingTimeout.current = setTimeout(() => setLoading(false), 10000);
      return () => { if (loadingTimeout.current) clearTimeout(loadingTimeout.current); };
    }
  }, [loading]);

  useEffect(() => {
    if (refreshing) {
      refreshTimeout.current = setTimeout(() => setRefreshing(false), 10000);
      return () => { if (refreshTimeout.current) clearTimeout(refreshTimeout.current); };
    }
  }, [refreshing]);

  // ── Mode switching ────────────────────────────────────────────────

  const switchSession = useCallback((s: PiSession) => {
    setActiveSession(s);
    setActiveWorktree(null);
    activeWorktreeRef.current = null;
    activeSessionRef.current = s;
    setMode("branch");
    modeRef.current = "branch";
    setDiffData({ mode: "branch", files: [], branch: s.branch });
    setCommits(null);
    setCommitFrom("");
    setCommitTo("");
    commitsRequested.current = false;
    setStale(false);
    setRefreshing(false);
    setLoading(true);
    send({ type: "watch", sessionId: s.sessionId });
  }, [send]);

  const switchWorktree = useCallback((wt: Worktree) => {
    setActiveWorktree(wt);
    activeWorktreeRef.current = wt;
    setMode("branch");
    modeRef.current = "branch";
    setCommits(null);
    setCommitFrom("");
    setCommitTo("");
    commitsRequested.current = false;
    // Show stale banner if this tab has pending changes
    setStale(staleWorktrees.has(wt.path));
    // Always load data for the tab (no per-tab caching yet)
    setDiffData({ mode: "branch", files: [], branch: wt.branch });
    setRefreshing(false);
    setLoading(true);
    send({ type: "watch-worktree", worktreePath: wt.path });
  }, [send, staleWorktrees]);

  const switchMode = useCallback((m: DiffMode) => {
    setMode(m);
    modeRef.current = m;
    if (m === "commits") {
      setDiffData(d => ({ ...d, files: [] }));
      if (!commitsRequested.current) {
        commitsRequested.current = true;
        send({ type: "request-commits" });
      }
    } else {
      setLoading(true);
      send({ type: "request-diffs", mode: m });
    }
  }, [send]);

  const compareCommits = useCallback(() => {
    if (!commitFrom || !commitTo) return;
    setLoading(true);
    send({ type: "request-diffs", mode: "commits", fromRef: commitFrom, toRef: commitTo });
  }, [commitFrom, commitTo, send]);

  const requestDiffs = useCallback(() => {
    const result = runAppRefresh(
      connected,
      refreshing,
      send,
      modeRef.current,
      diffData.fromRef,
      diffData.toRef,
      commitFrom,
      commitTo,
    );
    if (result.skipped) return;
    setStale(false);
    const activePath = activeWorktreeRef.current?.path || activeSessionRef.current?.cwd;
    if (activePath) setStaleWorktrees(prev => { const next = new Set(prev); next.delete(activePath); return next; });
    setRefreshing(true);
    log.info("requestDiffs", { mode: modeRef.current, path: activePath || "" });
    if (!result.sent) setRefreshing(false);
  }, [send, connected, refreshing, commitFrom, commitTo, diffData.fromRef, diffData.toRef]);

  // ── File tree ─────────────────────────────────────────────────────

  const paths = useMemo(() => [...new Set(diffData.files.map(f => f.name))], [diffData.files]);
  const gitStatus: GitStatusEntry[] = useMemo(
    () => diffData.files.map(f => ({ path: f.name, status: f.status })),
    [diffData.files],
  );

  const { model } = useFileTree({
    paths,
    flattenEmptyDirectories: true,
    density: "default" as const,
    icons: { set: "complete", colored: true },
    initialExpansion: "open",
    gitStatus,
    search: true,
  });

  useEffect(() => { model.resetPaths(paths); }, [model, paths]);
  useEffect(() => { model.setGitStatus(gitStatus); }, [model, gitStatus]);

  // ── Tree ↔ Diff scroll sync ───────────────────────────────────────
  //
  // Two directions:
  //  A) User clicks file in tree → scroll diff to that file
  //  B) User scrolls diff → highlight file in tree
  //
  // To prevent loops: clicking sets a scrollLock timestamp.
  // Scroll handler skips tree updates while locked.

  // (A) Tree click → scroll diff
  const selectedPaths = useFileTreeSelection(model);
  const prevSelectedRef = useRef<readonly string[]>([]);

  useEffect(() => {
    // Only act on NEW selections (compare by reference — useFileTreeSelection returns new array)
    if (selectedPaths === prevSelectedRef.current) return;
    const prev = new Set(prevSelectedRef.current);
    prevSelectedRef.current = selectedPaths;

    if (!selectedPaths.length || !scrollRef.current) return;

    // Find the newly selected path (one the user just clicked)
    let newPath: string | null = null;
    for (let i = selectedPaths.length - 1; i >= 0; i--) {
      if (!prev.has(selectedPaths[i])) { newPath = selectedPaths[i]; break; }
    }
    if (!newPath) return;

    // Lock scroll-sync for 1 second to prevent the scroll handler from fighting
    scrollLock.current = Date.now() + 1000;
    setSelectedFile(newPath);
    const el = scrollRef.current.querySelector(`[data-diff-file="${CSS.escape(newPath)}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedPaths]);

  // (B) Scroll diff → highlight tree — DISABLED (causes lag)
  // TODO: Re-enable scroll-sync. The working approach uses:
  //   - Debounced scroll listener on the diff container (scrollRef)
  //   - Find topmost visible [data-diff-file] element via getBoundingClientRect
  //   - Update tree selection via model.getItem(path)?.select() + deselect others
  //   - Use scrollLock ref to prevent the tree selection change from
  //     triggering scrollIntoView back (feedback loop)
  // The lag comes from getItem/select/deselect triggering React re-renders
  // on every scroll pause. Need to find a way to update the tree highlight
  // without causing a full re-render (possibly via direct DOM manipulation
  // on the tree's shadow DOM, or a @pierre/trees API that doesn't emit).

  // ── Parsed diffs (using @pierre/diffs parser) ─────────────────────

  const empty = diffData.files.length === 0;

  // ── Review comments ───────────────────────────────────────────────

  const deleteComment = useCallback((index: number) => {
    setComments(prev => prev.filter((_, i) => i !== index));
  }, []);

  const editComment = useCallback((index: number) => {
    const c = comments[index];
    if (c) {
      // Delete the old comment, then open a form at the same location pre-filled
      // For now, delete and re-open a form so the user can re-type
      setComments(prev => prev.filter((_, i) => i !== index));
      const side: "deletions" | "additions" = c.side === "old" ? "deletions" : "additions";
      setOpenForms(prev => {
        if (prev.some(f => f.file === c.file && f.side === side && f.lineNumber === c.line)) return prev;
        return [...prev, { file: c.file, side, lineNumber: c.line }];
      });
    }
  }, [comments]);

  const addCommentForm = useCallback((file: string, side: "deletions" | "additions", lineNumber: number) => {
    setOpenForms(prev => {
      if (prev.some(f => f.file === file && f.side === side && f.lineNumber === lineNumber)) return prev;
      return [...prev, { file, side, lineNumber }];
    });
  }, []);

  const submitComment = useCallback((file: string, side: "deletions" | "additions", lineNumber: number, body: string) => {
    if (!body.trim()) return;
    const branch = activeWorktree?.branch || diffData.branch;
    const worktreePath = activeWorktree?.path;
    setComments(prev => [...prev, { file, line: lineNumber, side: side === "deletions" ? "old" : "new", body: body.trim(), branch, worktreePath }]);
    setOpenForms(prev => prev.filter(f => !(f.file === file && f.side === side && f.lineNumber === lineNumber)));
  }, [activeWorktree, diffData.branch]);

  const cancelCommentForm = useCallback((file: string, side: "deletions" | "additions", lineNumber: number) => {
    setOpenForms(prev => prev.filter(f => !(f.file === file && f.side === side && f.lineNumber === lineNumber)));
  }, []);

  const resolveComment = useCallback((index: number) => {
    setComments(prev => prev.map((c, i) => i === index ? { ...c, resolved: true } : c));
  }, []);

  const replyToComment = useCallback((index: number, body: string) => {
    setComments(prev => prev.map((c, i) => {
      if (i !== index) return c;
      const replies = [...(c.replies || []), { author: "You", body, timestamp: "now" }];
      return { ...c, replies };
    }));
  }, []);

  const publish = useCallback(() => {
    if (!comments.length) return;
    send({ type: "publish-review", comments });
    setComments([]);
    try { localStorage.removeItem("pidiff-comments"); } catch {}
  }, [comments, send, activeWorktree, diffData.branch]);

  // ── Render ────────────────────────────────────────────────────────

  return (
    <WorkerPoolContextProvider poolOptions={WORKER_POOL_OPTIONS} highlighterOptions={HIGHLIGHTER_OPTIONS}>
    <div className="flex h-screen flex-col bg-background text-foreground">

      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="flex-shrink-0 border-b border-border">
        <div className="flex items-center justify-between px-4 h-11 bg-card">
          <div className="flex items-center gap-3 h-full">
            {activeSession && (
              <span className="text-xs font-medium text-foreground">{activeSession.repo}</span>
            )}
            {!activeSession && (
              <span className="text-xs text-muted-foreground">Waiting for session...</span>
            )}
            {activeSession && (
              <div className="flex items-center gap-1.5">
                <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">{activeWorktree?.branch || diffData.branch}</span>
              </div>
            )}
            <Separator orientation="vertical" className="h-5" />
            <div className="flex items-center gap-1">
              <Button variant={mode === "branch" ? "secondary" : "ghost"} size="sm"
                className="h-7 px-3 text-xs" onClick={() => switchMode("branch")}>Branch</Button>
              <Button variant={mode === "commits" ? "secondary" : "ghost"} size="sm"
                className="h-7 px-3 text-xs" onClick={() => switchMode("commits")}>Commits</Button>
            </div>
            {mode === "commits" && diffData.fromRef && diffData.toRef && (
              <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                {diffData.fromRef.slice(0, 7)}..{diffData.toRef.slice(0, 7)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-md border border-border overflow-hidden">
              <Button variant={diffStyle === "split" ? "secondary" : "ghost"} size="sm"
                className="h-6 px-2.5 text-[11px] rounded-none border-0" onClick={() => setDiffStyle("split")}>Split</Button>
              <Separator orientation="vertical" className="h-4" />
              <Button variant={diffStyle === "unified" ? "secondary" : "ghost"} size="sm"
                className="h-6 px-2.5 text-[11px] rounded-none border-0" onClick={() => setDiffStyle("unified")}>Unified</Button>
            </div>
            {!connected && <span className="text-[10px] text-red-400">● disconnected</span>}
            <AppRefreshActions
              hasSession={Boolean(activeSession)}
              stale={false}
              refreshing={refreshing}
              connected={connected}
              onRefresh={requestDiffs}
            />
            {comments.length > 0 && (
              <Button size="sm" className="h-7 gap-1.5 bg-green-600 hover:bg-green-500 text-white text-[11px]" onClick={publish}>
                <Send className="h-3 w-3" /> Publish ({comments.length})
              </Button>
            )}
          </div>
        </div>

        {/* Settings toolbar */}
        <div className="flex items-center gap-3 px-4 py-1.5 bg-background/50 border-t border-border flex-wrap">
          {/* Indicators */}
          <div className="flex items-center rounded-md border border-border overflow-hidden">
            {(["bars", "classic", "none"] as const).map(v => (
              <button key={v} onClick={() => setDiffIndicators(v)}
                className={cn("h-6 px-2 text-[10px] capitalize", diffIndicators === v ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")}>
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>

          {/* Line diff type */}
          <select value={lineDiffType} onChange={e => setLineDiffType(e.target.value as any)}
            className="h-6 bg-card border border-border rounded-md px-1.5 text-[10px] text-foreground outline-none">
            {(["word-alt", "word", "char", "none"] as const).map(v => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>

          {/* Hunk separators */}
          <select value={hunkSeparators} onChange={e => setHunkSeparators(e.target.value as any)}
            className="h-6 bg-card border border-border rounded-md px-1.5 text-[10px] text-foreground outline-none">
            {(["line-info", "line-info-basic", "metadata", "simple"] as const).map(v => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>

          {/* Theme */}
          <select value={theme} onChange={e => setTheme(e.target.value)}
            className="h-6 bg-card border border-border rounded-md px-1.5 text-[10px] text-foreground outline-none">
            <optgroup label="Pierre">
              <option value="pierre-dark">pierre-dark</option>
              <option value="pierre-light">pierre-light</option>
            </optgroup>
            <optgroup label="GitHub">
              <option value="github-dark">github-dark</option>
              <option value="github-dark-default">github-dark-default</option>
              <option value="github-dark-dimmed">github-dark-dimmed</option>
              <option value="github-light">github-light</option>
              <option value="github-light-default">github-light-default</option>
            </optgroup>
            <optgroup label="Popular">
              <option value="dracula">dracula</option>
              <option value="dracula-soft">dracula-soft</option>
              <option value="monokai">monokai</option>
              <option value="nord">nord</option>
              <option value="one-dark-pro">one-dark-pro</option>
              <option value="tokyo-night">tokyo-night</option>
              <option value="night-owl">night-owl</option>
              <option value="vitesse-dark">vitesse-dark</option>
              <option value="vitesse-light">vitesse-light</option>
              <option value="poimandres">poimandres</option>
              <option value="rose-pine">rose-pine</option>
              <option value="rose-pine-moon">rose-pine-moon</option>
              <option value="catppuccin-mocha">catppuccin-mocha</option>
              <option value="catppuccin-frappe">catppuccin-frappe</option>
              <option value="solarized-dark">solarized-dark</option>
              <option value="solarized-light">solarized-light</option>
              <option value="min-dark">min-dark</option>
              <option value="min-light">min-light</option>
              <option value="synthwave-84">synthwave-84</option>
              <option value="houston">houston</option>
              <option value="vesper">vesper</option>
            </optgroup>
            <optgroup label="Material">
              <option value="material-theme">material-theme</option>
              <option value="material-theme-darker">material-theme-darker</option>
              <option value="material-theme-ocean">material-theme-ocean</option>
              <option value="material-theme-palenight">material-theme-palenight</option>
            </optgroup>
          </select>

          {/* Font size */}
          <select value={fontSize} onChange={e => setFontSize(Number(e.target.value))}
            className="h-6 bg-card border border-border rounded-md px-1.5 text-[10px] text-foreground outline-none">
            {[11, 12, 13, 14, 15, 16].map(v => (
              <option key={v} value={v}>{v}px</option>
            ))}
          </select>

          <Separator orientation="vertical" className="h-4" />

          {/* Toggles with proper Switch */}
          <label className="flex items-center gap-1.5 text-[10px] text-foreground cursor-pointer">
            <Switch checked={!disableBackground} onCheckedChange={c => setDisableBackground(!c)} />
            Backgrounds
          </label>
          <label className="flex items-center gap-1.5 text-[10px] text-foreground cursor-pointer">
            <Switch checked={overflow === "wrap"} onCheckedChange={c => setOverflow(c ? "wrap" : "scroll")} />
            Wrapping
          </label>
          <label className="flex items-center gap-1.5 text-[10px] text-foreground cursor-pointer">
            <Switch checked={!disableLineNumbers} onCheckedChange={c => setDisableLineNumbers(!c)} />
            Line Numbers
          </label>
        </div>

        {mode === "commits" && (
          <div className="flex items-end gap-3 px-4 py-2.5 bg-background/50 border-t border-border">
            {commits === null ? (
              <span className="text-xs text-muted-foreground animate-pulse py-1">Loading commits…</span>
            ) : commits.length === 0 ? (
              <span className="text-xs text-muted-foreground py-1">No commits on this branch</span>
            ) : (<>
              <CommitSelect label="Base (older)" value={commitFrom} onChange={setCommitFrom} commits={commits} />
              <CommitSelect label="Head (newer)" value={commitTo} onChange={setCommitTo} commits={commits} />
              <Button size="sm" className="h-8" onClick={compareCommits} disabled={!commitFrom || !commitTo}>Compare</Button>
            </>)}
          </div>
        )}
        {/* Workspace tabs — always shown. Each branch/worktree is a tab. */}
        {activeSession && (() => {
          const tabs = activeSession.worktrees && activeSession.worktrees.length > 0
            ? activeSession.worktrees
            : [{ path: activeSession.cwd, branch: diffData.branch || activeSession.branch, head: "", isMain: true }];
          return (
            <div className="flex items-center gap-1 px-4 py-1 bg-card border-t border-border overflow-x-auto">
              {tabs.map(wt => {
                const isActive = activeWorktree ? activeWorktree.path === wt.path : wt.isMain;
                const isStale = staleWorktrees.has(wt.path);
                return (
                  <button key={wt.path} onClick={() => switchWorktree(wt)}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-1 rounded-md text-xs whitespace-nowrap transition-colors",
                      isActive ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-secondary/50",
                    )}>
                    <GitBranch className="h-3 w-3" />
                    {wt.branch}
                    {wt.isMain && tabs.length > 1 && <span className="text-[9px] text-muted-foreground">(root)</span>}
                    {isStale && !isActive && <span className="h-2 w-2 rounded-full bg-amber-400 flex-shrink-0" />}
                  </button>
                );
              })}
            </div>
          );
        })()}
      </header>

      {/* Stale banner */}
      <AppRefreshActions
        hasSession={false}
        stale={stale}
        refreshing={refreshing}
        connected={connected}
        onRefresh={requestDiffs}
      />

      {/* ── Body ────────────────────────────────────────────────── */}
      {!activeSession ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="text-sm text-muted-foreground">{sessions.length === 0 ? "Waiting for pi sessions…" : "Select a session"}</span>
        </div>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-2">
            <div className="h-5 w-5 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-muted-foreground">Loading…</span>
          </div>
        </div>
      ) : empty ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="text-sm text-muted-foreground">
            {mode === "commits" && !diffData.fromRef ? "Select two commits to compare" : "No changes"}
          </span>
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* ── File tree panel ─────────────────────────────────── */}
          <aside className="flex flex-shrink-0 flex-col overflow-hidden" style={{ width: explorer.width }}>
            <div className="flex-1 overflow-hidden p-2">
              <FileTree
                className="dark min-h-0 flex-1 overflow-auto rounded-lg py-3 border border-neutral-200 dark:border-neutral-800"
                model={model}
                style={{ ...TREE_THEME as React.CSSProperties, height: "100%", colorScheme: "dark", "--trees-search-bg-override": "oklch(14.5% 0 0)" } as React.CSSProperties}
              />
            </div>

            {/* Pending comments */}
            {comments.length > 0 && (
              <div className="border-t border-border bg-card">
                <div className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center justify-between">
                  <span>Pending ({comments.length})</span>
                  <Button size="sm" variant="ghost" className="h-5 text-[10px] text-green-400 hover:text-green-300 px-1.5"
                    onClick={publish}>Publish</Button>
                </div>
                <div className="max-h-[200px] overflow-y-auto divide-y divide-border">
                  {comments.map((c, i) => (
                    <div key={i} className="flex items-start gap-1.5 px-3 py-1.5 text-[11px] group">
                      <div className="flex-1 min-w-0 cursor-pointer" onClick={() => editComment(i)}>
                        <div className="text-muted-foreground font-mono text-[10px]">{c.file.split("/").pop()}:{c.line}</div>
                        <div className="text-foreground truncate">{c.body}</div>
                      </div>
                      <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => editComment(i)} className="text-muted-foreground hover:text-foreground p-0.5">
                          <Pencil className="h-2.5 w-2.5" />
                        </button>
                        <button onClick={() => deleteComment(i)} className="text-muted-foreground hover:text-red-400 p-0.5">
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </aside>

          {/* Resize handle (from @pierre/trees TreeApp pattern) */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize explorer"
            onPointerDown={explorer.onPointerDown}
            onPointerMove={explorer.onPointerMove}
            onPointerUp={explorer.onPointerUp}
            onPointerCancel={explorer.onPointerUp}
            className="relative block w-px shrink-0 cursor-col-resize bg-white/0 after:absolute after:inset-y-0 after:-left-1 after:w-2 after:content-['']" />

          {/* ── Diff panes ─────────────────────────────────────── */}
          <main ref={scrollRef} className="flex-1 overflow-y-auto">
            <div className="p-4 space-y-4">
              {(() => {
                const sorted = [...diffData.files].sort((a, b) => {
                  const aParts = a.name.split("/");
                  const bParts = b.name.split("/");
                  const len = Math.min(aParts.length, bParts.length);
                  for (let i = 0; i < len; i++) {
                    const aIsDir = i < aParts.length - 1;
                    const bIsDir = i < bParts.length - 1;
                    if (aIsDir && !bIsDir) return -1;
                    if (!aIsDir && bIsDir) return 1;
                    const cmp = aParts[i].localeCompare(bParts[i]);
                    if (cmp !== 0) return cmp;
                  }
                  return aParts.length - bParts.length;
                });

                return sorted.map(file => {
                  const oldContents = file.oldContents || "";
                  const newContents = file.newContents || "";
                  const oldKey = pierreFileCacheKey(file.name, oldContents);
                  const newKey = pierreFileCacheKey(file.name, newContents);
                  return (
                    <FileBlock key={`${file.area}-${file.name}`}
                      oldFile={{ name: file.name, contents: oldContents, cacheKey: oldKey }}
                      newFile={{ name: file.name, contents: newContents, cacheKey: newKey }}
                      path={file.name}
                      diffStyle={diffStyle}
                      diffIndicators={diffIndicators}
                      lineDiffType={lineDiffType}
                      disableBackground={disableBackground}
                      overflow={overflow}
                      disableLineNumbers={disableLineNumbers}
                      hunkSeparators={hunkSeparators}
                      fontSize={fontSize}
                      theme={theme}
                      area={file.area !== "committed" ? file.area : undefined}
                      comments={comments} openForms={openForms} hasOpenForm={hasOpenForm}
                      onAddCommentForm={addCommentForm} onSubmitComment={submitComment} onCancelCommentForm={cancelCommentForm}
                      onEditComment={editComment} onDeleteComment={deleteComment}
                      onResolveComment={resolveComment} onReplyComment={replyToComment} />
                  );
                });
              })()}
            </div>
          </main>
        </div>
      )}


    </div>
    </WorkerPoolContextProvider>
  );
}

// ── CommitSelect ────────────────────────────────────────────────────

function CommitSelect({ label, value, onChange, commits }: {
  label: string; value: string; onChange: (v: string) => void; commits: GitCommit[];
}) {
  return (
    <div className="flex-1 min-w-0">
      <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full bg-card border border-border rounded-md px-2.5 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring">
        <option value="">Select commit…</option>
        {commits.map(c => <option key={c.hash} value={c.hash}>{c.short} — {c.subject.slice(0, 80)}</option>)}
      </select>
    </div>
  );
}

// ── useExplorerWidth (from @pierre/trees TreeApp) ───────────────────

function useExplorerWidth(initial: number, min: number, max: number) {
  const clamp = useCallback(
    (value: number) => Math.max(min, Math.min(max, value)),
    [max, min],
  );
  const [width, setWidth] = useState(() => clamp(initial));
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragStateRef.current = { startWidth: width, startX: event.clientX };
    },
    [width],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const dragState = dragStateRef.current;
      if (dragState == null) return;
      const delta = event.clientX - dragState.startX;
      setWidth(clamp(dragState.startWidth + delta));
    },
    [clamp],
  );

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current == null) return;
    dragStateRef.current = null;
    const handle = event.currentTarget;
    if (handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp: endDrag, width };
}

// ── FileBlock ───────────────────────────────────────────────────────

function FileBlock({ oldFile, newFile, path, diffStyle, diffIndicators, lineDiffType, disableBackground, overflow, disableLineNumbers, hunkSeparators, fontSize, theme, area, comments, openForms, hasOpenForm, onAddCommentForm, onSubmitComment, onCancelCommentForm, onEditComment, onDeleteComment, onResolveComment, onReplyComment }: {
  oldFile: FileContents;
  newFile: FileContents;
  path: string;
  diffStyle: "unified" | "split";
  diffIndicators: "bars" | "classic" | "none";
  lineDiffType: "word-alt" | "word" | "char" | "none";
  disableBackground: boolean;
  overflow: "scroll" | "wrap";
  disableLineNumbers: boolean;
  hunkSeparators: "line-info" | "line-info-basic" | "metadata" | "simple";
  fontSize: number;
  theme: string;
  area?: "staged" | "unstaged";
  comments: ReviewComment[];
  openForms: Array<{ file: string; side: "deletions" | "additions"; lineNumber: number }>;
  hasOpenForm: boolean;
  onAddCommentForm: (file: string, side: "deletions" | "additions", lineNumber: number) => void;
  onSubmitComment: (file: string, side: "deletions" | "additions", lineNumber: number, body: string) => void;
  onCancelCommentForm: (file: string, side: "deletions" | "additions", lineNumber: number) => void;
  onEditComment: (index: number) => void;
  onDeleteComment: (index: number) => void;
  onResolveComment: (index: number) => void;
  onReplyComment: (index: number, body: string) => void;
}) {
  const [selectedRange, setSelectedRange] = useState<{ start: number; end: number; side?: string; endSide?: string } | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Build lineAnnotations: combine open forms + submitted comments
  const lineAnnotations = useMemo(() => {
    const annotations: Array<{ side: "deletions" | "additions"; lineNumber: number; metadata: any }> = [];

    // Open comment forms for this file
    for (const form of openForms) {
      if (form.file === path) {
        annotations.push({
          side: form.side,
          lineNumber: form.lineNumber,
          metadata: { type: "form" as const, file: path, side: form.side, lineNumber: form.lineNumber },
        });
      }
    }

    // Submitted comments for this file
    comments.forEach((c, i) => {
      if (c.file === path && !c.resolved) {
        annotations.push({
          side: "additions" as const,
          lineNumber: c.line,
          metadata: { type: "thread" as const, comment: c, globalIndex: i },
        });
      }
    });

    return annotations;
  }, [openForms, comments, path]);

  const handleLineSelectionEnd = useCallback((range: { start: number; end: number; side?: string; endSide?: string } | null) => {
    setSelectedRange(range);
    if (!range) return;
    const derivedSide = range.endSide ?? range.side;
    const side: "deletions" | "additions" = derivedSide === "deletions" ? "deletions" : "additions";
    onAddCommentForm(path, side, Math.max(range.end, range.start));
  }, [path, onAddCommentForm]);

  const options = useMemo(() => ({
    theme: theme as any,
    themeType: "dark" as const,
    diffStyle,
    diffIndicators,
    lineDiffType,
    disableBackground,
    overflow,
    disableLineNumbers,
    hunkSeparators,
    expandUnchanged: false,
    collapsed,
    enableLineSelection: !hasOpenForm,
    enableGutterUtility: !hasOpenForm,
    onLineSelectionEnd: handleLineSelectionEnd,
    onGutterUtilityClick: handleLineSelectionEnd,
  }), [diffStyle, diffIndicators, lineDiffType, disableBackground, overflow, disableLineNumbers, hunkSeparators, collapsed, theme, hasOpenForm, handleLineSelectionEnd]);

  return (
    <div data-diff-file={path} className="overflow-hidden rounded-lg border border-neutral-800">
      <MultiFileDiff
        oldFile={oldFile}
        newFile={newFile}
        options={options}
        style={{ fontSize }}
        selectedLines={selectedRange}
        lineAnnotations={lineAnnotations}
        renderHeaderMetadata={() => (
          <div className="ml-auto flex items-center gap-2 pr-2">
            {area && (
              <span className={cn(
                "rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider",
                area === "staged" ? "bg-green-500/15 text-green-400" : "bg-yellow-500/15 text-yellow-400",
              )}>
                {area}
              </span>
            )}
            <button onClick={() => setCollapsed(c => !c)}
              className="cursor-pointer px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground">
              {collapsed ? "Expand" : "Collapse"}
            </button>
          </div>
        )}
        renderAnnotation={(annotation) => {
          const meta = (annotation as any).metadata;
          if (!meta) return null;

          if (meta.type === "form") {
            return <InlineCommentForm
              file={meta.file} side={meta.side} lineNumber={meta.lineNumber}
              onSubmit={onSubmitComment} onCancel={onCancelCommentForm} />;
          }

          if (meta.type === "thread") {
            return <InlineComment comment={meta.comment} globalIndex={meta.globalIndex}
              onEdit={onEditComment} onDelete={onDeleteComment} onResolve={onResolveComment} onReply={onReplyComment} />;
          }

          return null;
        }}
      />
    </div>
  );
}

// Annotation components following @pierre/diffs Annotations example pattern.
// Outer wrapper uses inline styles (required by @pierre/diffs annotation slot),
// inner content uses tailwind classes exclusively.

function InlineCommentForm({ file, side, lineNumber, onSubmit, onCancel }: {
  file: string;
  side: "deletions" | "additions";
  lineNumber: number;
  onSubmit: (file: string, side: "deletions" | "additions", lineNumber: number, body: string) => void;
  onCancel: (file: string, side: "deletions" | "additions", lineNumber: number) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");

  useEffect(() => {
    setTimeout(() => { textareaRef.current?.focus(); }, 0);
  }, []);

  const handleSubmit = useCallback(() => {
    onSubmit(file, side, lineNumber, text);
  }, [file, side, lineNumber, text, onSubmit]);

  const handleCancel = useCallback(() => {
    onCancel(file, side, lineNumber);
  }, [file, side, lineNumber, onCancel]);

  return (
    <div style={{ overflow: "hidden", display: "flex", flexDirection: "row", gap: 1 }}>
      <div style={{ width: "100%" }}>
        <div className="max-w-[95%] sm:max-w-[70%]" style={{ whiteSpace: "normal", margin: 20, fontFamily: "Geist Variable, sans-serif" }}>
          <div className="bg-card rounded-lg border p-5 shadow-sm">
            <div className="flex gap-2">
              <div className="relative -mt-0.5 flex-shrink-0">
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-500 text-xs font-bold text-white">Y</div>
              </div>
              <div className="flex-1">
                <textarea
                  ref={textareaRef}
                  value={text}
                  onChange={e => setText(e.target.value)}
                  placeholder="Leave a comment"
                  className="min-h-[60px] w-full resize-none rounded-md border bg-background p-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  onKeyDown={e => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit();
                    if (e.key === "Escape") handleCancel();
                  }}
                />
                <div className="mt-3 flex items-center gap-2">
                  <Button size="sm" className="cursor-pointer" onClick={handleSubmit} disabled={!text.trim()}>
                    Comment
                  </Button>
                  <button onClick={handleCancel}
                    className="cursor-pointer px-3 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function InlineComment({ comment, globalIndex, onEdit, onDelete, onResolve, onReply }: {
  comment: ReviewComment;
  globalIndex: number;
  onEdit: (index: number) => void;
  onDelete: (index: number) => void;
  onResolve: (index: number) => void;
  onReply: (index: number, body: string) => void;
}) {
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState("");
  const replyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (replying) setTimeout(() => replyRef.current?.focus(), 0);
  }, [replying]);

  const handleSubmitReply = useCallback(() => {
    if (!replyText.trim()) return;
    onReply(globalIndex, replyText.trim());
    setReplyText("");
    setReplying(false);
  }, [globalIndex, replyText, onReply]);

  return (
    <div className="max-w-[95%] sm:max-w-[70%]" style={{ whiteSpace: "normal", margin: 20, fontFamily: "Geist Variable, sans-serif" }}>
      <div className="bg-card rounded-lg border p-5 shadow-sm">
        {/* Main comment */}
        <div className="flex gap-2">
          <div className="relative -mt-0.5 flex-shrink-0">
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-500 text-xs font-bold text-white">Y</div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="font-semibold text-foreground">You</span>
              <span className="text-sm text-muted-foreground">now</span>
            </div>
            <p className="leading-relaxed text-foreground">{comment.body}</p>
          </div>
        </div>

        {/* Replies */}
        {comment.replies && comment.replies.length > 0 && (
          <div className="ml-8 mt-4 space-y-4 sm:ml-[32px]">
            {comment.replies.map((reply, i) => (
              <div key={i} className="flex gap-2">
                <div className="relative -mt-0.5 flex-shrink-0">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-600 text-xs font-bold text-white">
                    {(reply.author || "pi")[0].toUpperCase()}
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-semibold text-foreground">{reply.author || "pi"}</span>
                    <span className="text-sm text-muted-foreground">{reply.timestamp || ""}</span>
                  </div>
                  <p className="leading-relaxed text-foreground">{reply.body}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Reply form */}
        {replying && (
          <div className="ml-8 mt-4 sm:ml-[32px]">
            <textarea
              ref={replyRef}
              value={replyText}
              onChange={e => setReplyText(e.target.value)}
              placeholder="Write a reply..."
              className="min-h-[60px] w-full resize-none rounded-md border bg-background p-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              onKeyDown={e => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmitReply();
                if (e.key === "Escape") { setReplying(false); setReplyText(""); }
              }}
            />
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" className="cursor-pointer" onClick={handleSubmitReply} disabled={!replyText.trim()}>Reply</Button>
              <button onClick={() => { setReplying(false); setReplyText(""); }}
                className="cursor-pointer px-3 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground">Cancel</button>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="ml-8 mt-4 flex items-center gap-4 sm:ml-[32px]">
          {!replying && (
            <button onClick={() => setReplying(true)}
              className="cursor-pointer text-sm text-blue-600 transition-colors hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300">
              Add reply...
            </button>
          )}
          <button onClick={() => onEdit(globalIndex)}
            className="cursor-pointer text-sm text-blue-600 transition-colors hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300">
            Edit
          </button>
          <button onClick={() => onDelete(globalIndex)}
            className="cursor-pointer text-sm text-blue-600 transition-colors hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300">
            Delete
          </button>
          <button onClick={() => onResolve(globalIndex)}
            className="cursor-pointer text-sm text-blue-600 transition-colors hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300">
            Resolve
          </button>
        </div>
      </div>
    </div>
  );
}
