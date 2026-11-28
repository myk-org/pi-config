/**
 * Shared Pi 1.7.0 `--agent-dir` CLI flag parser and path normalizer.
 *
 * Plain ESM JavaScript so both TypeScript extensions (`pi-agent-dir.ts`) and
 * standalone Node scripts (`scripts/coms-peer-supervisor.mjs`) share one
 * authoritative implementation with zero drift.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const AGENT_DIR_FLAG = "--agent-dir";
const AGENT_DIR_PREFIX = "--agent-dir=";

/**
 * Value-taking CLI options accepted by Pi (`@earendil-works/pi-coding-agent`
 * `dist/cli/args.js`, synced with `extensions/shared/oneshot.ts`) plus COMS
 * peer options. Each consumes the following argv token even if it starts with `-`.
 */
export const PI_VALUE_TAKING_FLAGS = new Set([
  "--mode",
  "--model",
  "--models",
  "--provider",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--name",
  "-n",
  "--session",
  "--session-id",
  "--fork",
  "--session-dir",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--thinking",
  "--export",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
  "--use-theme",
  "--tui-mode",
  "--cname",
  "--project",
  "--purpose",
]);

/** Expand a leading `~` / `~/` / `~\\` to the current user's home directory. */
export function expandTilde(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

/** Expand leading tilde and resolve relative paths to an absolute path. */
export function normalizeAgentDir(value) {
  const expanded = expandTilde(value);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/**
 * Extract the Pi 1.7.0 `--agent-dir` CLI flag value from argv (defaults to `process.argv.slice(2)`).
 * Supports `--agent-dir <dir>` and `--agent-dir=<dir>`, skips values consumed by other
 * value-taking options, stops at `--`, applies last-wins for repeated flags, trims whitespace,
 * and ignores missing or empty values.
 */
export function extractAgentDirFromArgv(argv, options = {}) {
  const args = argv ?? process.argv.slice(2);
  const valueFlags = options.valueFlags ?? PI_VALUE_TAKING_FLAGS;
  let found;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== "string") continue;
    if (arg === "--") break;

    if (arg === AGENT_DIR_FLAG) {
      const next = args[i + 1];
      if (next === undefined || next === "--") break;
      if (next.startsWith("-")) continue;
      i++;
      const trimmed = next.trim();
      if (trimmed) found = trimmed;
      continue;
    }

    if (arg.startsWith(AGENT_DIR_PREFIX)) {
      const trimmed = arg.slice(AGENT_DIR_PREFIX.length).trim();
      if (trimmed) found = trimmed;
      continue;
    }

    if (valueFlags.has(arg)) {
      i++;
    }
  }

  return found;
}
