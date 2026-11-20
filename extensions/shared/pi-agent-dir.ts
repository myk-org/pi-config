import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve pi agent config directory.
 * Prefer explicit agentDir; else PI_CODING_AGENT_DIR; else ~/.pi/agent.
 */
export function resolvePiAgentDir(agentDir?: string | null): string {
  const explicit = typeof agentDir === "string" ? agentDir.trim() : "";
  if (explicit) return explicit;
  const envDir = typeof process.env.PI_CODING_AGENT_DIR === "string"
    ? process.env.PI_CODING_AGENT_DIR.trim()
    : "";
  if (envDir) return envDir;
  return join(homedir(), ".pi", "agent");
}
