import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("pi-agent-dir");

const AGENT_DIR_FLAG = "--agent-dir";
const AGENT_DIR_PREFIX = "--agent-dir=";

function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

/**
 * Extract the Pi 1.7.0 `--agent-dir` CLI flag value from argv (defaults to `process.argv.slice(2)`).
 * Supports both `--agent-dir <dir>` and `--agent-dir=<dir>`, stops at `--`, applies last-wins
 * for repeated flags, trims whitespace, and ignores missing or empty values.
 */
export function extractAgentDirFromArgv(argv?: readonly string[]): string | undefined {
  const args = argv ?? process.argv.slice(2);
  let found: string | undefined;

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
    }
  }

  return found;
}

/**
 * Resolve pi agent config directory.
 * Precedence matches Pi 1.7.0: explicit agentDir → CLI `--agent-dir` → `PI_CODING_AGENT_DIR` → `~/.pi/agent`.
 */
export function resolvePiAgentDir(
  agentDir?: string | null,
  argv?: readonly string[],
): string {
  const explicit = typeof agentDir === "string" ? agentDir.trim() : "";
  if (explicit) return expandTilde(explicit);

  const cliDir = extractAgentDirFromArgv(argv);
  if (cliDir) return expandTilde(cliDir);

  const envDir = typeof process.env.PI_CODING_AGENT_DIR === "string"
    ? process.env.PI_CODING_AGENT_DIR.trim()
    : "";
  if (envDir) return expandTilde(envDir);

  return join(homedir(), ".pi", "agent");
}

/**
 * Propagate the parent's CLI `--agent-dir` flag into a child process env as `PI_CODING_AGENT_DIR`.
 * Leaves `PI_CODING_AGENT_DIR` unset when neither `--agent-dir` nor `baseEnv.PI_CODING_AGENT_DIR` is configured.
 */
export function withPropagatedPiAgentDirEnv(
  baseEnv: Record<string, string | undefined> = process.env,
  argv?: readonly string[],
): Record<string, string | undefined> {
  const cliDir = extractAgentDirFromArgv(argv);
  if (!cliDir) return { ...baseEnv };

  const expanded = expandTilde(cliDir);
  const propagated = isAbsolute(expanded) ? expanded : resolve(expanded);
  if (baseEnv.PI_CODING_AGENT_DIR !== propagated) {
    log.debug("propagating_cli_agent_dir", { agentDir: propagated });
  }
  return { ...baseEnv, PI_CODING_AGENT_DIR: propagated };
}
