import type { SessionInfo } from "../../../shared/types.ts";
export type { SessionInfo };

export interface PiEvent {
  type: string;
  message?: any;
  behavior?: string;
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
  reasoning?: number;
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

// ── #968 parity surfaces ──────────────────────────────────────────

export interface TaskItem {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  activeForm?: string;
  createdBy?: { origin?: string };
  statusHistory?: Record<string, string>;
}

export interface ComsPeer {
  name: string;
  purpose?: string;
  model?: string;
  busy: boolean;
  queueDepth: number;
  contextUsedPct: number;
  tasksSummary?: string | null;
}

export interface MemoryStatus {
  topics: Array<{ name: string; entryCount: number; hotness: number; newestEntry: string }>;
  usagePct: number | null;
  report: string;
  error?: string;
}

export interface McpServerInfo {
  name?: string;
  server?: string;
  status?: string;
  state?: string;
  tools?: number | Array<{ name: string }>;
  error?: string;
  [key: string]: unknown;
}

export interface SettingsKey {
  key: string;
  description: string;
  type: string;
  env?: string;
  default: unknown;
  group: string;
  enum?: string[];
  min?: number;
  max?: number;
  stored: unknown;
}

export interface SettingsData {
  scope: "project" | "global";
  keys: SettingsKey[];
  error?: string;
}
