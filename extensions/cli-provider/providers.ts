/**
 * CLI provider definitions — binaries, flags, default models.
 */

export type CliAgentName = "claude" | "gemini" | "cursor";

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
  defaultModels: { id: string; name: string; contextWindow: number; maxTokens: number }[];
}

export const CLI_PROVIDERS: Record<CliAgentName, CliProviderDef> = {
  claude: {
    name: "claude",
    binary: "claude",
    buildBaseArgs: (model) => [
      "--model",
      model,
      "-p",
      "--output-format",
      "json",
    ],
    resumeFlag: "--resume",
    continueFlags: ["--continue"],
    outputFormat: "json",
    promptOnStdin: true,
    defaultModels: [
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", contextWindow: 200000, maxTokens: 64000 },
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", contextWindow: 200000, maxTokens: 64000 },
      { id: "claude-haiku-4-20250514", name: "Claude Haiku 4", contextWindow: 200000, maxTokens: 64000 },
    ],
  },
  gemini: {
    name: "gemini",
    binary: "gemini",
    buildBaseArgs: (model) => ["--model", model, "--output-format", "json"],
    resumeFlag: "--resume",
    continueFlags: ["--resume"],
    outputFormat: "json",
    promptOnStdin: true,
    defaultModels: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1048576, maxTokens: 65536 },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1048576, maxTokens: 65536 },
    ],
  },
  cursor: {
    name: "cursor",
    binary: "agent",
    buildBaseArgs: (model, cwd) => [
      "--model",
      model,
      "--print",
      "--output-format",
      "stream-json",
      "--workspace",
      cwd,
    ],
    resumeFlag: "--resume",
    continueFlags: ["--continue"],
    outputFormat: "stream-json",
    promptOnStdin: true,
    defaultModels: [
      { id: "composer-2", name: "Composer 2", contextWindow: 200000, maxTokens: 64000 },
      { id: "gpt-5.4", name: "GPT-5.4", contextWindow: 200000, maxTokens: 64000 },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6 (cursor)", contextWindow: 200000, maxTokens: 64000 },
    ],
  },
};

export const VALID_CLI_AGENTS = new Set<string>(Object.keys(CLI_PROVIDERS));

export function isCliAgentName(name: string): name is CliAgentName {
  return VALID_CLI_AGENTS.has(name);
}

/** Build full command argv for a turn. */
export function buildCliCommand(opts: {
  agent: CliAgentName;
  model: string;
  cwd: string;
  sessionId?: string | null;
  continueSession?: boolean;
}): { binary: string; args: string[]; promptOnStdin: boolean } {
  const def = CLI_PROVIDERS[opts.agent];
  const args = [...def.buildBaseArgs(opts.model, opts.cwd)];
  if (opts.sessionId) {
    args.push(def.resumeFlag, opts.sessionId);
  } else if (opts.continueSession) {
    args.push(...def.continueFlags);
  }
  return { binary: def.binary, args, promptOnStdin: def.promptOnStdin };
}
