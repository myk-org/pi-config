/**
 * CLI Provider Extension for pi
 *
 * Registers real CLI tools (claude, gemini, cursor/agent) as native pi providers
 * under the `cli-*` namespace — parallel to `acpx-*`, without using ACP.
 *
 * Configuration:
 *   cli_agents - In pi-config-settings.json or CLI_AGENTS env (comma-separated)
 *                e.g. "cursor" or "claude,gemini,cursor"
 *
 * Unlike acpx-provider, this extension LOADS in subagent children so async
 * agents can inherit cli-* models.
 *
 * Loaded from: extensions/cli-provider/
 */

import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSetting } from "../orchestrator/project-settings.js";
import {
  CLI_PROVIDERS,
  isCliAgentName,
  type CliAgentName,
} from "./providers.js";
import { loadCliSessionId, saveCliSessionId } from "./sessions.js";
import { runCliAgent } from "./runner.js";

let projectCwd = "";
let registeredAgents: string[] = [];

function extractLatestUserMessage(context: Context): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") return msg.content;
      const textParts: string[] = [];
      for (const block of msg.content) {
        if ("text" in block && typeof block.text === "string") {
          textParts.push(block.text);
        }
      }
      if (textParts.length > 0) return textParts.join("\n");
    }
  }
  console.debug("[cli-provider] no user message found in context, using fallback");
  return "hello";
}

function buildSystemPrompt(context: Context): string | undefined {
  if (!context.systemPrompt) return undefined;
  return [
    "You are being used as a backend LLM through pi coding agent.",
    "You have full permission to read, write, edit, and execute any files or commands.",
    "Follow these instructions:",
    "",
    context.systemPrompt,
  ].join("\n");
}

function streamCli(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      stream.push({ type: "start", partial: output });

      const colonIdx = model.id.indexOf(":");
      const agent = colonIdx >= 0 ? model.id.substring(0, colonIdx) : model.id;
      if (!registeredAgents.includes(agent) || !isCliAgentName(agent)) {
        throw new Error(`Unknown cli agent: ${agent}`);
      }
      const cliModelId =
        colonIdx >= 0 ? model.id.substring(colonIdx + 1) : "default";

      let prompt = extractLatestUserMessage(context);
      const system = buildSystemPrompt(context);
      // Prepend system on first turn when we have no session yet
      const sessionKey = {
        cwd: projectCwd,
        agent,
        model: cliModelId,
        piSessionId: process.env.PI_SESSION_ID || null,
      };
      const existingSession = loadCliSessionId(sessionKey);
      if (!existingSession && system) {
        prompt = `${system}\n\n---\n\n${prompt}`;
      }

      const result = await runCliAgent({
        agent: agent as CliAgentName,
        model: cliModelId,
        cwd: projectCwd,
        prompt,
        sessionId: existingSession,
        signal: options?.signal,
      });

      if (result.sessionId) {
        saveCliSessionId(sessionKey, result.sessionId);
      }

      if (result.thinking) {
        output.content.push({ type: "thinking", thinking: result.thinking });
        stream.push({
          type: "thinking_start",
          contentIndex: 0,
          partial: output,
        });
        stream.push({
          type: "thinking_delta",
          contentIndex: 0,
          delta: result.thinking,
          partial: output,
        });
        stream.push({
          type: "thinking_end",
          contentIndex: 0,
          content: result.thinking,
          partial: output,
        });
      }

      const textIndex = output.content.length;
      output.content.push({ type: "text", text: result.text });
      stream.push({
        type: "text_start",
        contentIndex: textIndex,
        partial: output,
      });
      stream.push({
        type: "text_delta",
        contentIndex: textIndex,
        delta: result.text,
        partial: output,
      });
      stream.push({
        type: "text_end",
        contentIndex: textIndex,
        content: result.text,
        partial: output,
      });

      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (err: any) {
      const message = err?.message || String(err);
      console.debug("[cli-provider] turn failed:", message);
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = message;
      stream.push({
        type: "error",
        reason: output.stopReason as "aborted" | "error",
        error: output,
      });
      stream.end();
    }
  })();

  return stream;
}

export default async function (pi: ExtensionAPI) {
  // Intentionally does NOT skip PI_SUBAGENT_CHILD — cli-* must work in async children.

  projectCwd = process.cwd();
  const agentList = getSetting(projectCwd, "cli_agents").filter(isCliAgentName);
  registeredAgents = agentList;
  if (agentList.length === 0) return;

  const makeModel = (
    agent: string,
    m: { id: string; name: string; contextWindow: number; maxTokens: number },
  ) => ({
    id: `${agent}:${m.id}`,
    name: `${m.name} (cli-${agent})`,
    reasoning: false,
    input: ["text" as const, "image" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  });

  for (const agent of agentList) {
    const def = CLI_PROVIDERS[agent];
    const models = def.defaultModels.map((m) => makeModel(agent, m));
    try {
      pi.registerProvider(`cli-${agent}`, {
        baseUrl: "https://localhost",
        apiKey: "cli", // pragma: allowlist secret
        api: "cli",
        models,
        streamSimple: streamCli,
      });
      console.debug(
        `[cli-provider] cli-${agent}: ${models.length} model(s) registered`,
      );
    } catch (err) {
      console.debug(`[cli-provider] cli-${agent}: setup failed:`, err);
    }
  }
}
