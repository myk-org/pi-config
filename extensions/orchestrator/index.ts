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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerAskUser } from "./ask-user.js";
import { registerAsyncAgents } from "./async-agents.js";
import { registerBtw } from "./btw.js";
import { registerDreaming } from "./dreaming.js";
import { registerEnforcement } from "./enforcement.js";
import { registerProjectSettings } from "./project-settings.js";
import { registerRules } from "./rules.js";
import { registerSessionValidation } from "./session-validation.js";
import { registerStatusLine } from "./status-line.js";
import { registerSubagentTool } from "./subagent-tool.js";
import { registerGithubAutocomplete } from "./github-autocomplete.js";
import { registerExtendedAutocomplete } from "./extended-autocomplete.js";
import { registerCron } from "./cron.js";
import { registerStatus } from "./status.js";
import { registerNvim } from "./nvim.js";
import { registerPreferenceExtractor } from "./preference-extractor.js";
import { registerMemoryTools } from "./memory-tools.js";
import { registerReviewUI } from "./review-ui.js";
import { registerSessionSearch } from "./session-search.js";
import { registerMarkdownTransformer } from "./markdown-transformer.js";
import { ensureGitSshTimeout, isRunningInContainer, terminalNotify } from "./utils.js";

const IN_CONTAINER = isRunningInContainer();
ensureGitSshTimeout();

// Shared command handler registry — pidash uses this to execute commands from the browser
export const commandHandlerRegistry = new Map<string, (args: string, ctx: any) => Promise<void>>();

// Latest ExtensionCommandContext captured from any command handler.
// Commands provide the full context (switchSession, newSession, etc.)
// while session_start only provides basic ExtensionContext.
export let latestCommandCtx: any = null;

export default function (pi: ExtensionAPI) {
  // Wrap registerCommand to capture all handler functions AND command context.
  // Any command the user runs upgrades latestCommandCtx to a real ExtensionCommandContext
  // which has switchSession()/newSession() methods.
  const originalRegisterCommand = pi.registerCommand.bind(pi);
  pi.registerCommand = (name: string, options: any) => {
    if (options?.handler) {
      const origHandler = options.handler;
      options.handler = async (args: string, ctx: any) => {
        latestCommandCtx = ctx;
        pi.events.emit("pidash:command-ctx", ctx);
        return origHandler(args, ctx);
      };
      commandHandlerRegistry.set(name, options.handler);
      // Notify pidash extension about new command handler
      pi.events.emit("pidash:register-command", { name, handler: options.handler });
    }
    return originalRegisterCommand(name, options);
  };

  // Replay all registered command handlers when pidash requests them
  // (handles extension load order — pidash may load after orchestrator)
  pi.events.on("pidash:request-commands", () => {
    for (const [name, handler] of commandHandlerRegistry) {
      pi.events.emit("pidash:register-command", { name, handler });
    }
  });

  // Extended autocomplete must register FIRST — it wraps registerCommand
  // to inject getArgumentCompletions before other modules register their commands.
  registerExtendedAutocomplete(pi);

  registerAskUser(pi, terminalNotify);
  const { spawnAsyncAgent, killAsyncAgent, getAsyncJobs } = registerAsyncAgents(pi, terminalNotify);
  registerSubagentTool(pi, spawnAsyncAgent, killAsyncAgent);
  registerProjectSettings(pi);
  registerEnforcement(pi, IN_CONTAINER);
  registerReviewUI(pi);
  registerRules(pi, getAsyncJobs);

  registerStatusLine(pi, IN_CONTAINER, terminalNotify);
  registerBtw(pi);
  registerDreaming(pi, spawnAsyncAgent);
  const { getCronTasks } = registerCron(pi, spawnAsyncAgent);
  registerSessionValidation(pi);
  registerGithubAutocomplete(pi);
  registerStatus(pi, IN_CONTAINER, getAsyncJobs, getCronTasks);
  registerNvim(pi);
  registerPreferenceExtractor(pi);
  registerMemoryTools(pi);
  registerSessionSearch(pi);
  registerMarkdownTransformer(pi);

  // ── list_models tool — LLM-callable model discovery ──
  pi.registerTool({
    name: "list_models",
    label: "List Models",
    description: "List available models and providers. Use when the user asks to run an agent with a specific model, or when you need to discover available models for the subagent model parameter. Returns provider/model pairs that can be passed to subagent(model=\"provider/model-id\").",
    parameters: Type.Object({
      provider: Type.Optional(Type.String({ description: "Filter by provider name (e.g., 'litellm', 'cli-cursor', 'google')" })),
    }),
    async execute(_callId, params, _signal, _onUpdate, ctx) {
      let models: any[];
      try {
        const registry = ctx.modelRegistry;
        if (!registry) {
          return {
            content: [{ type: "text" as const, text: "Model registry not available." }],
          };
        }
        models = registry.getAvailable?.() || registry.getAll?.() || [];
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Failed to list models: ${e?.message || e}` }],
        };
      }
      // Filter out acpx-* providers — they cannot work in subagent children
      // (PI_SUBAGENT_CHILD=1 skips acpx registration)
      const filtered = (params.provider
        ? models.filter((m: any) => m.provider === params.provider)
        : models
      ).filter((m: any) => !(m.provider || "").startsWith("acpx-"));
      if (filtered.length === 0) {
        return {
          content: [{ type: "text" as const, text: params.provider ? `No models found for provider "${params.provider}".` : "No models available." }],
        };
      }
      // Group by provider for readability
      const byProvider = new Map<string, string[]>();
      for (const m of filtered) {
        const list = byProvider.get(m.provider) || [];
        list.push(m.id);
        byProvider.set(m.provider, list);
      }
      const lines: string[] = [];
      for (const [prov, ids] of byProvider) {
        lines.push(`## ${prov}`);
        for (const id of ids) {
          lines.push(`- ${prov}/${id}`);
        }
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  });
}
