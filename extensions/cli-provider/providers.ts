/**
 * CLI provider registry — assembles per-agent drivers (t3-style Drivers/*).
 * Add a new CLI: create agents/<name>.ts, register here.
 */

import type { CliAgentName, CliProviderDef } from "./types.js";
import { claudeProvider } from "./agents/claude.js";
import { cursorProvider } from "./agents/cursor.js";
import { geminiProvider } from "./agents/gemini.js";

/**
 * Headless flags (cli-* is a backend LLM — no TTY for prompts):
 *
 * | Concern | cursor | claude | gemini |
 * |---------|--------|--------|--------|
 * | Workspace trust | `--trust` | skipped by `-p` | `--skip-trust` |
 * | Tool/command approve | `--force` (`--yolo` alias) | `--dangerously-skip-permissions` | `--yolo` |
 * | Project MCP | `--approve-mcps` if `CLI_APPROVE_MCPS` or `SIDECAR_PORT` (`startSidecar()` always sets it) | n/a | `GEMINI_CLI_TRUST_WORKSPACE=true` unless parent already set |
 *
 * Trust alone is NOT enough: without auto-approve, tool calls that need
 * confirmation hang or fail (no interactive user).
 */
export const CLI_PROVIDERS: Record<CliAgentName, CliProviderDef> = {
  claude: claudeProvider,
  gemini: geminiProvider,
  cursor: cursorProvider,
};

export type { CliAgentName, CliProviderDef } from "./types.js";

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
  /** Override the default agent binary (from driver config). */
  binary?: string;
}): { binary: string; args: string[]; promptOnStdin: boolean } {
  const def = CLI_PROVIDERS[opts.agent];
  const args = [...def.buildBaseArgs(opts.model, opts.cwd)];
  if (opts.sessionId) {
    args.push(def.resumeFlag, opts.sessionId);
  } else if (opts.continueSession) {
    args.push(...def.continueFlags);
  }
  return {
    binary: opts.binary || def.binary,
    args,
    promptOnStdin: def.promptOnStdin,
  };
}
