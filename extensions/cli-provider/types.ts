/**
 * Shared types for cli-provider agents.
 */

export type CliAgentName = "claude" | "gemini" | "cursor";

export interface DiscoveredCliModel {
  id: string;
  name: string;
}

export interface CliProviderDef {
  /** Settings / registration name (claude, gemini, cursor) */
  name: CliAgentName;
  binary: string;
  /** Build argv before prompt/session flags (excludes resume/continue). */
  buildBaseArgs: (model: string, cwd: string) => string[];
  resumeFlag: string;
  continueFlags: string[];
  /** Value for --output-format sent to the CLI */
  outputFormat: string;
  /** Pass prompt on stdin (true) or as final argv (false) */
  promptOnStdin: boolean;
  /** Discover models via this agent's CLI only (no API keys). */
  discoverModels: () => DiscoveredCliModel[];
}

export interface CliSessionKey {
  cwd: string;
  agent: string;
  model: string;
  /** Pi session id: real UUID, per-process provisional `tmp-…`, or legacy `"default"`. */
  piSessionId?: string | null;
}

export type CliSessionStatus = "running" | "stopped";

export interface CliSessionRecord {
  sessionId: string;
  agent: string;
  model: string;
  cwd: string;
  piSessionId: string;
  status: CliSessionStatus;
  createdAt: string;
  lastSeenAt: string;
  resumeFailures?: number;
}
