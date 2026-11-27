import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger, type Logger } from "./logger.js";
import {
  extractAgentDirFromArgv,
  normalizeAgentDir,
  PI_VALUE_TAKING_FLAGS,
} from "./pi-agent-dir-parser.mjs";

const log = createLogger("pi-agent-dir");

export { extractAgentDirFromArgv, normalizeAgentDir, PI_VALUE_TAKING_FLAGS };
export type { ExtractAgentDirOptions } from "./pi-agent-dir-parser.mjs";

/**
 * Resolve pi agent config directory.
 * Precedence matches Pi 1.7.0: explicit agentDir → CLI `--agent-dir` → `PI_CODING_AGENT_DIR` → `~/.pi/agent`.
 * Relative and tilde paths are normalized to absolute paths so parent extensions and spawned children agree.
 */
export function resolvePiAgentDir(
  agentDir?: string | null,
  argv?: readonly string[],
): string {
  const explicit = typeof agentDir === "string" ? agentDir.trim() : "";
  if (explicit) return normalizeAgentDir(explicit);

  const cliDir = extractAgentDirFromArgv(argv);
  if (cliDir) return normalizeAgentDir(cliDir);

  const envDir = typeof process.env.PI_CODING_AGENT_DIR === "string"
    ? process.env.PI_CODING_AGENT_DIR.trim()
    : "";
  if (envDir) return normalizeAgentDir(envDir);

  return join(homedir(), ".pi", "agent");
}

/**
 * Propagate the parent's CLI `--agent-dir` flag into a child process env as `PI_CODING_AGENT_DIR`.
 * Leaves `PI_CODING_AGENT_DIR` unset when neither `--agent-dir` nor `baseEnv.PI_CODING_AGENT_DIR` is configured.
 */
export function withPropagatedPiAgentDirEnv(
  baseEnv: Record<string, string | undefined> = process.env,
  argv?: readonly string[],
  logger: Pick<Logger, "debug"> = log,
): Record<string, string | undefined> {
  const cliDir = extractAgentDirFromArgv(argv);
  if (!cliDir) return { ...baseEnv };

  const propagated = normalizeAgentDir(cliDir);
  if (baseEnv.PI_CODING_AGENT_DIR !== propagated) {
    logger.debug("propagating_cli_agent_dir", { agentDir: propagated });
  }
  return { ...baseEnv, PI_CODING_AGENT_DIR: propagated };
}
