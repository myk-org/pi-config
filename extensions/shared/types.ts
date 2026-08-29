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
  /** Activity is distinct from transport streaming and queued browser prompts. */
  activity?: "working" | "waiting_for_input" | "idle";
  activitySequence?: number;
  /** Activity restored when a prompt opened outside the agent lifecycle closes. */
  activityBeforePrompt?: "working" | "waiting_for_input" | "idle";
  /** Transport/response streaming is independent from activity. */
  streaming?: boolean;
  working?: boolean;
  name?: string;
  comsName?: string;
  comsPurpose?: string;
  comsProject?: string;
}
