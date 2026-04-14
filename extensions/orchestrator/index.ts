/**
 * Orchestrator Extension for pi
 *
 * Bundles:
 * - Subagent tool (based on pi's subagent example, with package agent discovery)
 * - Enforcement handlers (python/pip, git protection, dangerous commands)
 * - Rule injection (before_agent_start)
 * - Slash commands (/btw, /async-status)
 * - Notifications and status line
 * - Session validation (required tools check)
 * - Async agent infrastructure
 * - ask_user tool
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerAskUser } from "./ask-user.js";
import { registerAsyncAgents } from "./async-agents.js";
import { registerBtw } from "./btw.js";
import { registerDiffity } from "./diffity.js";
import { registerEnforcement } from "./enforcement.js";
import { registerRules } from "./rules.js";
import { registerSessionValidation } from "./session-validation.js";
import { registerStatusLine } from "./status-line.js";
import { registerSubagentTool } from "./subagent-tool.js";
import { ensureGitSshTimeout, isRunningInContainer, terminalNotify } from "./utils.js";

const IN_CONTAINER = isRunningInContainer();
ensureGitSshTimeout();

export default function (pi: ExtensionAPI) {
  registerAskUser(pi, terminalNotify);
  const { spawnAsyncAgent } = registerAsyncAgents(pi, terminalNotify);
  registerSubagentTool(pi, spawnAsyncAgent);
  registerEnforcement(pi, IN_CONTAINER);
  registerRules(pi);
  const { setDiffityStatus } = registerStatusLine(pi, IN_CONTAINER, terminalNotify) as any;
  registerBtw(pi);
  registerDiffity(pi, setDiffityStatus);
  registerSessionValidation(pi);
}
