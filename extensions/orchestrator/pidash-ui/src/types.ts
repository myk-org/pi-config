export interface SessionInfo {
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
  diffPort?: number | null;
  contextWindow?: number;
  thinkingLevel?: string;
}

export interface PiEvent {
  type: string;
  message?: any;
  id?: string;
  method?: string;
  title?: string;
  options?: string[];
  sessions?: any[];
  session?: SessionInfo;
  models?: any[];
  timestamp?: number;
  assistantMessageEvent?: {
    type: string;
    delta?: string;
    partial?: { model?: string; usage?: TokenUsage };
  };
  toolName?: string;
  args?: { command?: string };
  result?: { content?: Array<{ type: string; text: string }> };
  isError?: boolean;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export type MessageRole = "user" | "assistant" | "tool" | "thinking" | "system";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
  className?: string;
}
