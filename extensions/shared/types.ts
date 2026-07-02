/** Session info shared between pidash-server and pidash-ui. */
export interface SessionInfo {
  sessionId: string;
  pid: number;
  cwd: string;
  branch: string;
  model: string;
  startedAt: string;
  lastActivity: number;
  active: boolean;
  sessionFile?: string;
  gitDirty?: boolean;
  gitChanges?: number;
  container?: boolean;
  contextWindow?: number;
  thinkingLevel?: string;
  diffPort?: number | null;
  working?: boolean;
  name?: string;
}
