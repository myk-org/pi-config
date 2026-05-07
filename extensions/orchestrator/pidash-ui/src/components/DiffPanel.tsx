import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import { useFileTree, FileTree } from "@pierre/trees/react";
import { X, GitBranch, GitCommitHorizontal, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { FileChange, DiffMode, GitCommit } from "@/hooks/useDiffData";
import type { GitStatusEntry } from "@pierre/trees";

interface Props {
  staged: string;
  unstaged: string;
  committed: string;
  branch: string;
  files: FileChange[];
  mode: DiffMode;
  fromRef?: string;
  toRef?: string;
  onClose?: () => void;
  onModeChange?: (mode: DiffMode, opts?: { fromRef?: string; toRef?: string }) => void;
  commits?: GitCommit[] | null;
  onRequestCommits?: () => void;
  loading?: boolean;
}

type Layout = "unified" | "split";
type ChangeStyle = "background" | "indicator";

function splitPatchByFile(patch: string): Array<{ path: string; patch: string }> {
  const chunks: Array<{ path: string; patch: string }> = [];
  const parts = patch.split(/(?=^diff --git )/m);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^diff --git a\/(.*?) b\/(.*)/m);
    if (match) {
      chunks.push({ path: match[2], patch: trimmed });
    }
  }
  return chunks;
}

const MODE_LABELS: Record<DiffMode, string> = {
  working: "Working",
  branch: "Branch",
  commits: "Commits",
};

export function DiffPanel({
  staged, unstaged, committed, branch, files, mode, fromRef, toRef,
  onClose, onModeChange, commits, onRequestCommits, loading,
}: Props) {
  const [layout, setLayout] = useState<Layout>("unified");
  const [changeStyle, setChangeStyle] = useState<ChangeStyle>("background");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [commitFrom, setCommitFrom] = useState("");
  const [commitTo, setCommitTo] = useState("");
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const empty = !staged && !unstaged && !committed;

  // Build paths and gitStatus for the file tree
  const paths = useMemo(() => files.map((f) => f.path), [files]);
  const gitStatus: GitStatusEntry[] = useMemo(
    () =>
      files.map((f) => ({
        path: f.path,
        status: f.status === "untracked" ? "added" as const : f.status,
      })),
    [files],
  );

  const handleSelectionChange = useCallback((selectedPaths: readonly string[]) => {
    if (selectedPaths.length > 0) {
      setSelectedFile(selectedPaths[0]);
    }
  }, []);

  const { model } = useFileTree({
    paths,
    flattenEmptyDirectories: true,
    density: "compact" as const,
    icons: "standard",
    initialExpansion: "open",
    gitStatus,
    onSelectionChange: handleSelectionChange,
  });

  useEffect(() => { model.resetPaths(paths); }, [model, paths]);
  useEffect(() => { model.setGitStatus(gitStatus); }, [model, gitStatus]);

  // Scroll to selected file
  useEffect(() => {
    if (!selectedFile || !scrollContainerRef.current) return;
    const el = scrollContainerRef.current.querySelector(
      `[data-diff-file="${CSS.escape(selectedFile)}"]`,
    );
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedFile]);

  // Pre-split patches
  const committedChunks = useMemo(() => splitPatchByFile(committed), [committed]);
  const stagedChunks = useMemo(() => splitPatchByFile(staged), [staged]);
  const unstagedChunks = useMemo(() => splitPatchByFile(unstaged), [unstaged]);

  // Request commits when switching to commits mode — only once
  const commitsRequestedRef = useRef(false);
  useEffect(() => {
    if (mode === "commits" && !commitsRequestedRef.current) {
      commitsRequestedRef.current = true;
      onRequestCommits?.();
    }
    if (mode !== "commits") commitsRequestedRef.current = false;
  }, [mode]);

  const handleModeChange = useCallback((newMode: DiffMode) => {
    onModeChange?.(newMode);
  }, [onModeChange]);

  const handleCommitCompare = useCallback(() => {
    if (commitFrom && commitTo) {
      onModeChange?.("commits", { fromRef: commitFrom, toRef: commitTo });
    }
  }, [commitFrom, commitTo, onModeChange]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 border-b border-border bg-card px-4 py-2">
        {/* Left: branch + mode selector */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <GitBranch className="h-4 w-4" />
            <span className="font-medium">{branch || "unknown"}</span>
          </div>
          <ModeSelector mode={mode} onModeChange={handleModeChange} />
          {mode === "commits" && fromRef && toRef && (
            <span className="text-xs text-muted-foreground">
              {fromRef.slice(0, 7)}..{toRef.slice(0, 7)}
            </span>
          )}
        </div>

        {/* Center: toggles */}
        <div className="flex items-center gap-3">
          <ToggleGroup
            label="Layout"
            value={layout}
            options={[
              { value: "unified", label: "Unified" },
              { value: "split", label: "Split" },
            ]}
            onChange={(v) => setLayout(v as Layout)}
          />
          <ToggleGroup
            label="Style"
            value={changeStyle}
            options={[
              { value: "background", label: "Background" },
              { value: "indicator", label: "Indicator" },
            ]}
            onChange={(v) => setChangeStyle(v as ChangeStyle)}
          />
        </div>

        {/* Right: close */}
        <div className="flex items-center">
          {onClose ? (
            <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7">
              <X className="h-4 w-4" />
            </Button>
          ) : (
            <div className="w-7" />
          )}
        </div>
      </div>

      {/* Commit picker */}
      {mode === "commits" && (
        <div className="border-b border-border bg-card px-4 py-3">
          {commits === undefined ? (
            <span className="text-xs text-muted-foreground animate-pulse">Loading commits…</span>
          ) : commits.length === 0 ? (
            <span className="text-xs text-muted-foreground">No commits on this branch</span>
          ) : (
            <div className="flex items-center gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-medium text-muted-foreground uppercase">From</label>
                <select
                  className="bg-background border border-border rounded px-2 py-1 text-xs w-[320px] outline-none"
                  value={commitFrom}
                  onChange={(e) => setCommitFrom(e.target.value)}
                >
                  <option value="">Select base commit…</option>
                  {commits.map((c) => (
                    <option key={c.hash} value={c.hash}>
                      {c.short} — {c.subject.slice(0, 60)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-medium text-muted-foreground uppercase">To</label>
                <select
                  className="bg-background border border-border rounded px-2 py-1 text-xs w-[320px] outline-none"
                  value={commitTo}
                  onChange={(e) => setCommitTo(e.target.value)}
                >
                  <option value="">Select target commit…</option>
                  {commits.map((c) => (
                    <option key={c.hash} value={c.hash}>
                      {c.short} — {c.subject.slice(0, 60)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-medium text-muted-foreground uppercase">&nbsp;</label>
                <button
                  className={cn(
                    "px-3 py-1 text-xs rounded border",
                    commitFrom && commitTo
                      ? "bg-primary text-primary-foreground border-primary hover:bg-primary/90"
                      : "bg-muted text-muted-foreground border-border cursor-not-allowed",
                  )}
                  onClick={handleCommitCompare}
                  disabled={!commitFrom || !commitTo}
                >
                  Compare
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Body */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="text-sm text-muted-foreground animate-pulse">Loading diff…</span>
        </div>
      ) : empty ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="text-sm text-muted-foreground">
            {mode === "commits" && !fromRef ? "Select commits to compare" : "No changes"}
          </span>
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* Left panel: file tree */}
          <div
            className="flex w-[250px] flex-shrink-0 flex-col border-r border-border"
            style={
              {
                "--trees-bg": "transparent",
                "--trees-color": "var(--foreground, #e6edf3)",
                "--trees-selected-bg-override": "hsl(var(--accent))",
              } as React.CSSProperties
            }
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Changed Files
              </span>
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-medium text-muted-foreground">
                {files.length}
              </span>
            </div>
            <div className="flex-1 overflow-hidden">
              <FileTree model={model} style={{ height: "100%" }} />
            </div>
          </div>

          {/* Right panel: diff view */}
          <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
            <div className="space-y-4 p-4">
              {committedChunks.length > 0 && (
                <DiffSectionByFile
                  title={mode === "commits" ? "Commit Changes" : "Committed (branch vs main)"}
                  chunks={committedChunks}
                  layout={layout}
                  changeStyle={changeStyle}
                />
              )}
              {stagedChunks.length > 0 && (
                <DiffSectionByFile
                  title="Staged Changes"
                  chunks={stagedChunks}
                  layout={layout}
                  changeStyle={changeStyle}
                />
              )}
              {unstagedChunks.length > 0 && (
                <DiffSectionByFile
                  title="Unstaged Changes"
                  chunks={unstagedChunks}
                  layout={layout}
                  changeStyle={changeStyle}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ModeSelector({ mode, onModeChange }: { mode: DiffMode; onModeChange: (m: DiffMode) => void }) {
  return (
    <div className="flex overflow-hidden rounded-md border border-border">
      {(["working", "branch", "commits"] as DiffMode[]).map((m) => (
        <button
          key={m}
          onClick={() => onModeChange(m)}
          className={cn(
            "px-2 py-0.5 text-xs transition-colors",
            mode === m
              ? "bg-primary text-primary-foreground"
              : "bg-card text-muted-foreground hover:bg-muted",
          )}
        >
          {MODE_LABELS[m]}
        </button>
      ))}
    </div>
  );
}

function DiffSectionByFile({
  title,
  chunks,
  layout,
  changeStyle,
}: {
  title: string;
  chunks: Array<{ path: string; patch: string }>;
  layout: Layout;
  changeStyle: ChangeStyle;
}) {
  return (
    <div>
      <div className="mb-2 px-1">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
      </div>
      <div className="space-y-2">
        {chunks.map((chunk) => (
          <div
            key={`${title}-${chunk.path}`}
            data-diff-file={chunk.path}
            className="overflow-hidden rounded-md border border-border"
          >
            <PatchDiff
              patch={chunk.patch}
              theme="github-dark"
              layout={layout}
              changeStyle={changeStyle}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function ToggleGroup({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}:</span>
      <div className="flex overflow-hidden rounded-md border border-border">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={cn(
              "px-2 py-0.5 text-xs transition-colors",
              value === opt.value
                ? "bg-primary text-primary-foreground"
                : "bg-card text-muted-foreground hover:bg-muted",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
