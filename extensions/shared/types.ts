/** Session info shared between pidash-server and pidash-ui. */
export interface SessionInfo {
  sessionId: string;
  pid: number;
  cwd: string;
  branch: string;
  model: string;
  /** Explicit capability of the active Pi model. */
  reasoning?: boolean;
  /**
   * Whether the active model accepts image input. A chat client uses this to
   * warn instead of forwarding an image the model cannot read.
   */
  supportsImages?: boolean;
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
  /** Exact authoritative Trail savings for this parent Pi session. */
  trailTokenSavings?: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  reasoning?: number;
}

export type MessageRole = "user" | "assistant" | "tool" | "thinking" | "system";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
  className?: string;
  timestamp?: number;
  meta?: {
    turns?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    contextTokens?: number;
    model?: string;
    startTs?: number;
    endTs?: number;
    cost?: number;
    callId?: string;
  };
}

export interface SessionCommandInfo {
  name: string;
  description: string;
}

export interface PendingUiRequestPayload {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input";
  title?: string;
  message?: string;
  options?: string[];
  timestamp?: number;
  [key: string]: unknown;
}

export interface SessionLiveState {
  think: { id: string; text: string; startTs: number };
  assist: { id: string; text: string };
  tool: { id: string; name: string; startTs: number; callId: string };
  asyncMsgs: Record<string, { msgId: string; text: string }>;
  lastUserText: string;
}

/** Canonical server-side snapshot sent to a browser on watch / reconnect. */
export interface SessionSnapshotPayload {
  type: "session_snapshot";
  sessionId: string;
  messages: ChatMessage[];
  live: SessionLiveState;
  model: string;
  tokens: TokenUsage | null;
  streaming: boolean;
  queuedCount: number;
  streamingBehavior: string | null;
  availableCommands: SessionCommandInfo[];
  pendingUiRequests: PendingUiRequestPayload[];
}
