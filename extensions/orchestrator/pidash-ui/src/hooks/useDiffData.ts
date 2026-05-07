import { useCallback, useEffect, useState } from "react";

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  area: "staged" | "unstaged" | "committed";
}

export type DiffMode = "working" | "branch" | "commits";

export interface GitCommit {
  hash: string;
  short: string;
  subject: string;
  date: string;
}

export interface DiffData {
  mode: DiffMode;
  staged: string;
  unstaged: string;
  committed: string;
  branch: string;
  files: FileChange[];
  fromRef?: string;
  toRef?: string;
}

/**
 * Parse a unified diff patch string to extract file paths and their change statuses.
 */
function parseFilesFromPatch(patch: string, area: FileChange["area"]): FileChange[] {
  const files: FileChange[] = [];
  const diffRegex = /^diff --git a\/(.*?) b\/(.*)$/gm;
  let match: RegExpExecArray | null;

  while ((match = diffRegex.exec(patch)) !== null) {
    const oldPath = match[1];
    const newPath = match[2];
    const afterMatch = patch.slice(match.index + match[0].length, match.index + match[0].length + 200);

    let status: FileChange["status"] = "modified";
    if (afterMatch.includes("new file mode")) {
      status = "added";
    } else if (afterMatch.includes("deleted file mode")) {
      status = "deleted";
    } else if (oldPath !== newPath || afterMatch.includes("rename from")) {
      status = "renamed";
    }

    files.push({ path: newPath, status, area });
  }

  return files;
}

/**
 * Hook that listens for diff_update events from the WebSocket onMessage handler.
 */
export function useDiffData(
  onMessage: (cb: (ev: any) => void) => () => void,
): DiffData & { loading: boolean; clearDiff: () => void } {
  const [data, setData] = useState<DiffData>({
    mode: "working", staged: "", unstaged: "", committed: "", branch: "", files: [],
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    return onMessage((ev: any) => {
      if (ev.type === "diff_update") {
        const staged = ev.staged || "";
        const unstaged = ev.unstaged || "";
        const committed = ev.committed || "";
        const mode: DiffMode = ev.mode || "working";

        // Parse files from all patch sources
        const committedFiles = parseFilesFromPatch(committed, "committed");
        const stagedFiles = parseFilesFromPatch(staged, "staged");
        const unstagedFiles = parseFilesFromPatch(unstaged, "unstaged");

        // Deduplicate: committed < staged < unstaged priority
        const seen = new Set<string>();
        const files: FileChange[] = [];
        for (const f of committedFiles) {
          seen.add(f.path);
          files.push(f);
        }
        for (const f of stagedFiles) {
          if (!seen.has(f.path)) {
            seen.add(f.path);
            files.push(f);
          }
        }
        for (const f of unstagedFiles) {
          if (!seen.has(f.path)) {
            files.push(f);
          }
        }

        setData({
          mode,
          staged,
          unstaged,
          committed,
          branch: ev.branch || "",
          files,
          fromRef: ev.fromRef,
          toRef: ev.toRef,
        });
        setLoading(false);
      }
    });
  }, [onMessage]);

  const clearDiff = useCallback(() => {
    setData(d => ({ ...d, staged: "", unstaged: "", committed: "", files: [] }));
    setLoading(true);
  }, []);

  const resetDiff = useCallback(() => {
    setData({ mode: "working", staged: "", unstaged: "", committed: "", branch: "", files: [] });
    setLoading(false);
  }, []);

  return { ...data, loading, clearDiff, resetDiff };
}
