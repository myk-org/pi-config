import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import { useFileTree, FileTree } from "@pierre/trees/react";
import { GitBranch, X, Send, MessageSquarePlus, Pencil } from "lucide-react";
import { themeToTreeStyles } from "@pierre/trees";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useWebSocket } from "@/hooks/useWebSocket";
import type { DiffMode, DiffData, FileChange, GitCommit, ReviewComment, PiSession } from "@/types";
import type { GitStatusEntry } from "@pierre/trees";

// ── Helpers ─────────────────────────────────────────────────────────

function parseFilesFromPatch(patch: string, area: FileChange["area"]): FileChange[] {
  const files: FileChange[] = [];
  const diffRegex = /^diff --git a\/(.*?) b\/(.*)$/gm;
  let match: RegExpExecArray | null;
  while ((match = diffRegex.exec(patch)) !== null) {
    const oldPath = match[1];
    const newPath = match[2];
    const after = patch.slice(match.index + match[0].length, match.index + match[0].length + 200);
    let status: FileChange["status"] = "modified";
    if (after.includes("new file mode")) status = "added";
    else if (after.includes("deleted file mode")) status = "deleted";
    else if (oldPath !== newPath || after.includes("rename from")) status = "renamed";
    files.push({ path: newPath, status, area });
  }
  return files;
}

function splitPatchByFile(patch: string): Array<{ path: string; patch: string }> {
  const chunks: Array<{ path: string; patch: string }> = [];
  for (const part of patch.split(/(?=^diff --git )/m)) {
    const t = part.trim();
    if (!t) continue;
    const m = t.match(/^diff --git a\/(.*?) b\/(.*)/m);
    if (m) chunks.push({ path: m[2], patch: t });
  }
  return chunks;
}

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
  const [activeSession, setActiveSession] = useState<PiSession | null>(null);

  const [diffData, setDiffData] = useState<DiffData>({
    mode: "branch", staged: "", unstaged: "", committed: "", branch: "", files: [],
  });
  const [mode, setMode] = useState<DiffMode>("branch");
  const [loading, setLoading] = useState(false);

  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [commitFrom, setCommitFrom] = useState("");
  const [commitTo, setCommitTo] = useState("");

  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("split");
  const [stale, setStale] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  // Review comments — persist in localStorage
  const [comments, setComments] = useState<ReviewComment[]>(() => {
    try { const s = localStorage.getItem("pidiff-comments"); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [commentDraft, setCommentDraft] = useState<{ file: string; line: number; editIndex?: number } | null>(null);
  const [commentText, setCommentText] = useState("");

  useEffect(() => {
    try { localStorage.setItem("pidiff-comments", JSON.stringify(comments)); } catch {}
  }, [comments]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const commitsRequested = useRef(false);
  const activeSessionRef = useRef<PiSession | null>(null);
  const loadingTimeout = useRef<ReturnType<typeof setTimeout>>();
  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  // ── WebSocket ─────────────────────────────────────────────────────

  useEffect(() => {
    return onMessage((ev: any) => {
      if (ev.type === "diff_update" && (ev.mode === modeRef.current || !ev.mode)) {
        const staged = ev.staged || "";
        const unstaged = ev.unstaged || "";
        const committed = ev.committed || "";

        const allFiles: FileChange[] = [];
        const seen = new Set<string>();
        for (const f of parseFilesFromPatch(committed, "committed")) { seen.add(f.path); allFiles.push(f); }
        for (const f of parseFilesFromPatch(staged, "staged")) { if (!seen.has(f.path)) { seen.add(f.path); allFiles.push(f); } }
        for (const f of parseFilesFromPatch(unstaged, "unstaged")) { if (!seen.has(f.path)) allFiles.push(f); }

        setDiffData({
          mode: ev.mode || "branch", staged, unstaged, committed,
          branch: ev.branch || "", files: allFiles,
          fromRef: ev.fromRef, toRef: ev.toRef,
        });
        setLoading(false);
        setStale(false);
        if (loadingTimeout.current) clearTimeout(loadingTimeout.current);
      }
      if (ev.type === "commits-list" && ev.commits) {
        setCommits(ev.commits);
      }
      if (ev.type === "status_changed") {
        setStale(true);
      }
      if (ev.type === "sessions-list" && ev.sessions) {
        setSessions(ev.sessions);
        // Auto-select first session if none selected
        if (!activeSessionRef.current && ev.sessions.length > 0) {
          const first = ev.sessions[0];
          setActiveSession(first);
          activeSessionRef.current = first;
          send({ type: "watch", sessionId: first.sessionId });
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
          setDiffData({ mode: "branch", staged: "", unstaged: "", committed: "", branch: "", files: [] });
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

  // ── Mode switching ────────────────────────────────────────────────

  const switchSession = useCallback((s: PiSession) => {
    setActiveSession(s);
    activeSessionRef.current = s;
    setMode("branch");
    modeRef.current = "branch";
    setDiffData({ mode: "branch", staged: "", unstaged: "", committed: "", branch: s.branch, files: [] });
    setCommits(null);
    commitsRequested.current = false;
    setStale(false);
    setLoading(true);
    send({ type: "watch", sessionId: s.sessionId });
  }, [send]);

  const switchMode = useCallback((m: DiffMode) => {
    setMode(m);
    modeRef.current = m;
    if (m === "commits") {
      setDiffData(d => ({ ...d, committed: "", staged: "", unstaged: "", files: [] }));
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

  // ── File tree ─────────────────────────────────────────────────────

  const paths = useMemo(() => diffData.files.map(f => f.path), [diffData.files]);
  const gitStatus: GitStatusEntry[] = useMemo(
    () => diffData.files.map(f => ({ path: f.path, status: f.status === "untracked" ? "added" as const : f.status })),
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
    onSelectionChange: useCallback((sel: readonly string[]) => { if (sel.length) setSelectedFile(sel[0]); }, []),
  });

  useEffect(() => { model.resetPaths(paths); }, [model, paths]);
  useEffect(() => { model.setGitStatus(gitStatus); }, [model, gitStatus]);

  useEffect(() => {
    if (!selectedFile || !scrollRef.current) return;
    const el = scrollRef.current.querySelector(`[data-diff-file="${CSS.escape(selectedFile)}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedFile]);

  // ── Patches ───────────────────────────────────────────────────────

  const committedChunks = useMemo(() => splitPatchByFile(diffData.committed), [diffData.committed]);
  const stagedChunks = useMemo(() => splitPatchByFile(diffData.staged), [diffData.staged]);
  const unstagedChunks = useMemo(() => splitPatchByFile(diffData.unstaged), [diffData.unstaged]);
  const empty = !diffData.staged && !diffData.unstaged && !diffData.committed;

  // ── Review comments ───────────────────────────────────────────────

  const saveComment = useCallback(() => {
    if (!commentDraft || !commentText.trim()) return;
    if (commentDraft.editIndex !== undefined) {
      // Edit existing
      setComments(prev => prev.map((c, i) => i === commentDraft.editIndex ? { ...c, body: commentText.trim() } : c));
    } else {
      // Add new
      setComments(prev => [...prev, { file: commentDraft.file, line: commentDraft.line, side: "new", body: commentText.trim() }]);
    }
    setCommentDraft(null);
    setCommentText("");
  }, [commentDraft, commentText]);

  const deleteComment = useCallback((index: number) => {
    setComments(prev => prev.filter((_, i) => i !== index));
  }, []);

  const editComment = useCallback((index: number) => {
    const c = comments[index];
    if (c) {
      setCommentDraft({ file: c.file, line: c.line, editIndex: index });
      setCommentText(c.body);
    }
  }, [comments]);

  const publish = useCallback(() => {
    if (!comments.length) return;
    send({ type: "publish-review", comments });
    setComments([]);
    try { localStorage.removeItem("pidiff-comments"); } catch {}
  }, [comments, send]);

  const openComment = useCallback((file: string, line: number) => {
    setCommentDraft({ file, line });
    setCommentText("");
  }, []);

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">

      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="flex-shrink-0 border-b border-border">
        <div className="flex items-center justify-between px-4 h-11 bg-card">
          <div className="flex items-center gap-3 h-full">
            {/* Session selector — always show dropdown */}
            <select
              value={activeSession?.sessionId || ""}
              onChange={e => {
                const s = sessions.find(s => s.sessionId === e.target.value);
                if (s) switchSession(s);
              }}
              className="bg-card border border-border rounded-md px-2 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring max-w-[220px]"
            >
              {sessions.length === 0 && <option value="">No sessions</option>}
              {sessions.map(s => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.repo}
                </option>
              ))}
            </select>
            {activeSession && (
              <div className="flex items-center gap-1.5">
                <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">{diffData.branch}</span>
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
            {!connected && <span className="text-[10px] text-red-400">● offline</span>}
            {comments.length > 0 && (
              <Button size="sm" className="h-7 gap-1.5 bg-green-600 hover:bg-green-500 text-white text-[11px]" onClick={publish}>
                <Send className="h-3 w-3" /> Publish ({comments.length})
              </Button>
            )}
          </div>
        </div>

        {mode === "commits" && (
          <div className="flex items-end gap-3 px-4 py-2.5 bg-background/50 border-t border-border">
            {commits === null ? (
              <span className="text-xs text-muted-foreground animate-pulse py-1">Loading commits…</span>
            ) : commits.length === 0 ? (
              <span className="text-xs text-muted-foreground py-1">No commits on this branch</span>
            ) : (<>
              <div className="flex-1 min-w-0">
                <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Base (older)</label>
                <select value={commitFrom} onChange={e => setCommitFrom(e.target.value)}
                  className="w-full bg-card border border-border rounded-md px-2.5 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring">
                  <option value="">Select commit…</option>
                  {commits.map(c => <option key={c.hash} value={c.hash}>{c.short} — {c.subject.slice(0, 80)}</option>)}
                </select>
              </div>
              <div className="flex-1 min-w-0">
                <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Head (newer)</label>
                <select value={commitTo} onChange={e => setCommitTo(e.target.value)}
                  className="w-full bg-card border border-border rounded-md px-2.5 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring">
                  <option value="">Select commit…</option>
                  {commits.map(c => <option key={c.hash} value={c.hash}>{c.short} — {c.subject.slice(0, 80)}</option>)}
                </select>
              </div>
              <Button size="sm" className="h-8" onClick={compareCommits} disabled={!commitFrom || !commitTo}>Compare</Button>
            </>)}
          </div>
        )}
      </header>

      {/* Stale banner */}
      {stale && (
        <div className="flex items-center justify-between px-4 py-1.5 bg-amber-500/10 border-b border-amber-500/20">
          <span className="text-xs text-amber-400">Files have changed since this diff was loaded</span>
          <Button size="sm" variant="outline" className="h-6 text-[11px] border-amber-500/30 text-amber-400 hover:bg-amber-500/20"
            onClick={() => {
              setStale(false);
              setLoading(true);
              send({ type: "request-diffs", mode: modeRef.current });
            }}>
            Refresh
          </Button>
        </div>
      )}

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
          <aside className="flex w-[280px] flex-shrink-0 flex-col overflow-hidden">
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

          {/* ── Diff panes ─────────────────────────────────────── */}
          <main ref={scrollRef} className="flex-1 overflow-y-auto">
            <div className="p-4 space-y-4">
              {committedChunks.map(chunk => (
                <FileBlock key={`c-${chunk.path}`} chunk={chunk} diffStyle={diffStyle}
                  comments={comments} onComment={openComment}
                  onEditComment={editComment} onDeleteComment={deleteComment} />
              ))}
              {stagedChunks.length > 0 && (
                <div className="px-4 py-1.5 bg-card text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Staged</div>
              )}
              {stagedChunks.map(chunk => (
                <FileBlock key={`s-${chunk.path}`} chunk={chunk} diffStyle={diffStyle}
                  comments={comments} onComment={openComment}
                  onEditComment={editComment} onDeleteComment={deleteComment} />
              ))}
              {unstagedChunks.length > 0 && (
                <div className="px-4 py-1.5 bg-card text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Unstaged</div>
              )}
              {unstagedChunks.map(chunk => (
                <FileBlock key={`u-${chunk.path}`} chunk={chunk} diffStyle={diffStyle}
                  comments={comments} onComment={openComment}
                  onEditComment={editComment} onDeleteComment={deleteComment} />
              ))}
            </div>
          </main>
        </div>
      )}

      {/* ── Comment modal ──────────────────────────────────────── */}
      {commentDraft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setCommentDraft(null)}>
          <div className="w-[480px] rounded-lg border border-border bg-card shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div>
                <div className="text-sm font-medium">{commentDraft.editIndex !== undefined ? "Edit comment" : "Add comment"}</div>
                <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                  {commentDraft.file}{commentDraft.line > 0 ? ` line ${commentDraft.line}` : ""}
                </div>
              </div>
              <button onClick={() => setCommentDraft(null)} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4">
              <textarea
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring resize-none"
                rows={4} value={commentText} onChange={e => setCommentText(e.target.value)}
                placeholder="Write your comment…" autoFocus
                onKeyDown={e => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveComment();
                  if (e.key === "Escape") setCommentDraft(null);
                }}
              />
            </div>
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
              <span className="text-[10px] text-muted-foreground">⌘+Enter to submit</span>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setCommentDraft(null)}>Cancel</Button>
                <Button size="sm" onClick={saveComment} disabled={!commentText.trim()}>
                  {commentDraft.editIndex !== undefined ? "Save" : "Add"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── FileBlock ───────────────────────────────────────────────────────

function FileBlock({ chunk, diffStyle, comments, onComment, onEditComment, onDeleteComment }: {
  chunk: { path: string; patch: string };
  diffStyle: "unified" | "split";
  comments: ReviewComment[];
  onComment: (file: string, line: number) => void;
  onEditComment: (index: number) => void;
  onDeleteComment: (index: number) => void;
}) {
  const [selectedRange, setSelectedRange] = useState<{ start: number; end: number; side?: string; endSide?: string } | null>(null);
  const fileComments = useMemo(
    () => comments.map((c, i) => ({ ...c, globalIndex: i })).filter(c => c.file === chunk.path),
    [comments, chunk.path],
  );

  // Build lineAnnotations for @pierre/diffs — inserts comments at the correct line
  const lineAnnotations = useMemo(() =>
    fileComments.map(c => ({
      side: "additions" as const,
      lineNumber: c.line,
      metadata: c,
    })),
    [fileComments],
  );

  const options = useMemo(() => ({
    theme: "min-dark" as const,
    themeType: "dark" as const,
    diffStyle,
    disableFileHeader: true,
    overflow: "scroll" as const,
    unsafeCSS: `pre, [data-code], [data-gutter], [data-content], [data-separator-wrapper], [data-gutter-buffer] { background-color: oklch(0.145 0 0) !important; }
[data-separator], [data-separator-content] { background-color: oklch(0.178 0 0) !important; }
[data-line][data-line-type] { background-color: transparent !important; }
[data-diff-type="split"] [data-code][data-additions]::-webkit-scrollbar-track { margin-right: 6px }
[data-diff-type="split"] [data-code][data-deletions]::-webkit-scrollbar-track { margin-left: 6px }
[data-file] [data-code]::-webkit-scrollbar-track, [data-diff-type="single"] [data-code]::-webkit-scrollbar-track { margin-inline: 6px; }`,
    enableLineSelection: true,
    enableGutterUtility: true,
    onLineSelectionEnd: (range: { start: number; end: number; side?: string; endSide?: string } | null) => {
      setSelectedRange(range);
      if (!range) return;
      const line = Math.max(range.start, range.end);
      onComment(chunk.path, line);
    },
  }), [diffStyle, chunk.path, onComment]);

  return (
    <div data-diff-file={chunk.path} className="overflow-hidden rounded-lg border border-neutral-800">
      {/* File header */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-card border-b border-neutral-800 sticky top-0 z-[1]">
        <span className="text-xs font-mono text-foreground">{chunk.path}</span>
        <Button variant="ghost" size="sm" className="h-6 gap-1 text-[10px] text-muted-foreground"
          onClick={() => onComment(chunk.path, 0)}>
          <MessageSquarePlus className="h-3 w-3" /> Comment
        </Button>
      </div>

      {/* Diff with inline annotations */}
      <PatchDiff
        patch={chunk.patch}
        options={options}
        selectedLines={selectedRange}
        lineAnnotations={lineAnnotations}
        renderAnnotation={(annotation) => {
          const c = (annotation as any).metadata;
          if (!c) return null;
          return (
            <div style={{ overflow: "hidden", display: "flex", flexDirection: "row", gap: 1 }}>
              <div style={{ width: "100%" }}>
                <div className="max-w-[95%] sm:max-w-[70%]" style={{ whiteSpace: "normal", margin: 20, fontFamily: "Geist Variable, sans-serif" }}>
                  <div className="bg-card rounded-lg border p-4 shadow-sm group">
                    <div className="flex gap-2">
                      <MessageSquarePlus className="h-4 w-4 text-blue-400 mt-0.5 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-foreground text-sm leading-relaxed">{c.body}</p>
                        <div className="mt-2 flex items-center gap-2">
                          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground"
                            onClick={() => onEditComment(c.globalIndex)}>Edit</Button>
                          <button onClick={() => onDeleteComment(c.globalIndex)}
                            className="text-muted-foreground hover:text-red-400 text-xs px-2 py-1 transition-colors">Delete</button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        }}
      />
    </div>
  );
}
