export type DiffMode = "working" | "branch" | "commits";

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  area: "staged" | "unstaged" | "committed";
}

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

export interface PiSession {
  sessionId: string;
  cwd: string;
  branch: string;
  repo: string;
}

export interface ReviewComment {
  file: string;
  line: number;
  side: "old" | "new";
  body: string;
}
