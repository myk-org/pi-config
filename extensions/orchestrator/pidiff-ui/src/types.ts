export type DiffMode = "branch" | "commits";

export interface FileDiffData {
  name: string;
  oldContents: string;
  newContents: string;
  status: "added" | "modified" | "deleted" | "renamed";
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
  files: FileDiffData[];
  branch: string;
  fromRef?: string;
  toRef?: string;
}

export interface PiSession {
  sessionId: string;
  cwd: string;
  branch: string;
  repo: string;
}

export interface ReviewCommentReply {
  author: string;
  body: string;
  timestamp?: string;
}

export interface ReviewComment {
  file: string;
  line: number;
  side: "old" | "new";
  body: string;
  replies?: ReviewCommentReply[];
  resolved?: boolean;
}
