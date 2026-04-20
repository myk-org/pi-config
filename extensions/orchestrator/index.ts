/**
 * Orchestrator Extension for pi
 *
 * Bundles:
 * - Subagent tool (based on pi's subagent example, with package agent discovery)
 * - Enforcement handlers (python/pip, git protection, dangerous commands)
 * - Rule injection & memory loading (before_agent_start)
 * - Slash commands (/btw, /async-status, /dream-auto)
 * - Notifications and status line
 * - Session validation (required tools check)
 * - Async agent infrastructure
 * - ask_user tool
 * - Memory dreaming (background consolidation)
 * - Pidash web UI (live session viewer)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerAskUser } from "./ask-user.js";
import { registerAsyncAgents } from "./async-agents.js";
import { registerBtw } from "./btw.js";
import { registerDiffity } from "./diffity.js";
import { registerDreaming } from "./dreaming.js";
import { registerPidash } from "./pidash.js";
import { registerEnforcement } from "./enforcement.js";
import { registerRules } from "./rules.js";
import { registerSessionValidation } from "./session-validation.js";
import { registerStatusLine } from "./status-line.js";
import { registerSubagentTool } from "./subagent-tool.js";
import { ensureGitSshTimeout, isRunningInContainer, terminalNotify } from "./utils.js";

const IN_CONTAINER = isRunningInContainer();
ensureGitSshTimeout();

// Shared command handler registry — pidash uses this to execute commands from the browser
export const commandHandlerRegistry = new Map<string, (args: string, ctx: any) => Promise<void>>();

export default function (pi: ExtensionAPI) {
  // Wrap registerCommand to capture all handler functions
  const originalRegisterCommand = pi.registerCommand.bind(pi);
  pi.registerCommand = (name: string, options: any) => {
    if (options?.handler) {
      commandHandlerRegistry.set(name, options.handler);
    }
    return originalRegisterCommand(name, options);
  };

  registerAskUser(pi, terminalNotify);
  const { spawnAsyncAgent, killAsyncAgent } = registerAsyncAgents(pi, terminalNotify);
  registerSubagentTool(pi, spawnAsyncAgent, killAsyncAgent);
  registerEnforcement(pi, IN_CONTAINER);
  registerRules(pi);
  registerStatusLine(pi, IN_CONTAINER, terminalNotify);
  registerBtw(pi);
  registerDiffity(pi);
  registerDreaming(pi, spawnAsyncAgent);
  registerPidash(pi);
  registerSessionValidation(pi);
}
