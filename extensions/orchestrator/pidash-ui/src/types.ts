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
  diffPort?: number | null;
  contextWindow?: number;
  thinkingLevel?: string;
  working?: boolean;
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
  toolCallId?: string;
  toolName?: string;
  args?: { command?: string; agent?: string; name?: string; task?: string; tasks?: any[]; chain?: any[]; asyncKill?: string; async?: boolean };
  result?: {
    content?: Array<{ type: string; text: string }>;
    details?: {
      mode?: string;
      results?: Array<{
        agent?: string;
        usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number; contextTokens?: number; turns?: number };
        model?: string;
        exitCode?: number;
      }>;
    };
  };
  isError?: boolean;
  // session_notification fields
  sessionId?: string;
  cwd?: string;
  isSubagent?: boolean;
  agentName?: string;
  resultText?: string;
  partialResult?: { content?: Array<{ type: string; text: string }> };
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export interface NotificationPreferences {
  turnComplete: boolean;
  agentComplete: boolean;
  testResults: boolean;
  sessionError: boolean;
  toolComplete: boolean;
  inputNeeded: boolean;
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
