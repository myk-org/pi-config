/**
 * CLI Provider Extension for pi
 *
 * Routes pi LLM requests through real CLI tools (claude, gemini, cursor/agent)
 * under the `cli-*` namespace — parallel to `acpx-*`, without using ACP.
 *
 * How it works (matches acpx-provider flow):
 * 1. During extension load, discover models from each agent driver (CLI only)
 * 2. On each LLM request, resume CLI session when possible; recover if resume dies
 * 3. System prompt is applied once per model session (first turn)
 * 4. Session reaper cleans idle markers; shutdown clears in-memory state only
 *
 * Configuration:
 *   cli_agents - In pi-config-settings.json or CLI_AGENTS env (comma-separated)
 *                e.g. "cursor" or "claude,gemini,cursor"
 *
 * Unlike acpx-provider, this extension LOADS in subagent children so async
 * agents can inherit cli-* models.
 *
 * Model ids are CLI `--model` values (from CLI discovery), not acpx
 * availableModelIds — those namespaces differ (see dev-docs/cli-provider.md).
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
import { asStringArray, getSetting } from "../orchestrator/project-settings.js";
import { isCliAgentName, type CliAgentName } from "./providers.js";
import {
  clearCliSessionId,
  loadCliSessionId,
  saveCliSessionId,
  shouldRetryWithoutResume,
  touchCliSession,
  type CliSessionKey,
} from "./sessions.js";
import {
  startCliSessionReaper,
  stopCliSessionReaper,
} from "./session-reaper.js";
import { runCliAgent } from "./runner.js";
import {
  discoverCliModelsDetailed,
  discoverCliModelIds,
  discoverCliModels,
  isCliBinaryAvailable,
  modelIdToDisplayName,
  type DiscoveredCliModel,
} from "./discover.js";

export {
  discoverCliModels,
  discoverCliModelIds,
  discoverCliModelsDetailed,
  modelIdToDisplayName,
};

// =============================================================================
// Types
// =============================================================================

interface AgentState {
  agent: CliAgentName;
  /** Model ids discovered at load time */
  availableModelIds: string[];
  /** Keys that already received the system prompt (once per model session) */
  systemPromptSent: Set<string>;
  /** Session keys for shutdown cleanup */
  sessionKeys: Map<string, CliSessionKey>;
  ready: Promise<void>;
  signalReady: () => void;
}

// =============================================================================
// State
// =============================================================================

let projectCwd = "";
let registeredAgents: string[] = [];
const agents = new Map<string, AgentState>();

// =============================================================================
// Session ensure (acpx ensureHandle analogue)
// =============================================================================

function sessionKeyFor(
  agent: string,
  model: string,
): CliSessionKey {
  return {
    cwd: projectCwd,
    agent,
    model,
    piSessionId: process.env.PI_SESSION_ID || null,
  };
}

/**
 * Run CLI turn with resume recovery: if --resume fails, clear marker,
 * re-seed history, retry once without resume (t3 recover pattern).
 */
async function runCliTurnWithResumeRecover(opts: {
  agent: CliAgentName;
  model: string;
  key: CliSessionKey;
  sessionId: string | null;
  prompt: string;
  systemPrompt?: string;
  signal?: AbortSignal;
  onEvent?: Parameters<typeof runCliAgent>[0]["onEvent"];
  rebuildPromptWithoutSession: () => string;
}): Promise<Awaited<ReturnType<typeof runCliAgent>>> {
  const runOnce = (sessionId: string | null, prompt: string) =>
    runCliAgent({
      agent: opts.agent,
      model: opts.model,
      cwd: projectCwd,
      prompt,
      sessionId,
      signal: opts.signal,
      onEvent: opts.onEvent,
    });

  try {
    const result = await runOnce(opts.sessionId, opts.prompt);
    if (result.sessionId) saveCliSessionId(opts.key, result.sessionId);
    else if (opts.sessionId) touchCliSession(opts.key);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!opts.sessionId || !shouldRetryWithoutResume(message)) {
      throw err;
    }
    console.debug(
      `[cli-provider] resume failed for ${opts.agent}; clearing session and retrying: ${message.slice(0, 200)}`,
    );
    clearCliSessionId(opts.key);
    let prompt = opts.rebuildPromptWithoutSession();
    if (opts.systemPrompt) {
      prompt = `${opts.systemPrompt}\n\n---\n\n${prompt}`;
    }
    const result = await runOnce(null, prompt);
    if (result.sessionId) saveCliSessionId(opts.key, result.sessionId);
    return result;
  }
}

/**
 * Ensure a CLI session marker exists for this agent/model.
 * Returns the resume id (if any) and whether system prompt should be sent.
 * Does NOT mark systemPromptSent — caller must mark only after a successful turn.
 */
function ensureSession(
  state: AgentState,
  cliModelId: string,
  systemPrompt: string | undefined,
): { sessionId: string | null; needsSystemPrompt: boolean; key: CliSessionKey } {
  const handleKey = cliModelId || "default";
  const key = sessionKeyFor(state.agent, handleKey);
  state.sessionKeys.set(handleKey, key);

  const sessionId = loadCliSessionId(key);
  const needsSystemPrompt =
    !state.systemPromptSent.has(handleKey) && !!systemPrompt;

  return { sessionId, needsSystemPrompt, key };
}

// =============================================================================
// Context Helpers (same contract as acpx-provider)
// =============================================================================

/**
 * Build the system prompt to send on first session creation.
 * CLI sessions maintain their own conversation history via --resume,
 * so we set the system prompt once at first turn.
 */
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

function messageText(msg: { role: string; content: any }): string {
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  const textParts: string[] = [];
  for (const block of msg.content) {
    if ("text" in block && typeof block.text === "string") {
      textParts.push(block.text);
    }
  }
  return textParts.join("\n");
}

/**
 * Extract the latest user message from pi's context.
 * When a CLI session already exists (--resume), only this message is sent.
 */
function extractLatestUserMessage(context: Context): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i];
    if (msg.role === "user") {
      const text = messageText(msg);
      if (text) return text;
    }
  }
  console.debug("[cli-provider] no user message found in context, using fallback");
  return "hello";
}

/**
 * When starting a NEW CLI session (no --resume), inject prior pi turns so
 * switching mid-session does not drop conversation history.
 * Pi's own session history is never deleted — this only seeds the CLI.
 */
function buildPromptWithHistory(context: Context, hasCliSession: boolean): string {
  const latest = extractLatestUserMessage(context);
  if (hasCliSession) return latest;

  const prior: string[] = [];
  // Find last user message index (the one we send as "current")
  let lastUser = -1;
  for (let i = context.messages.length - 1; i >= 0; i--) {
    if (context.messages[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  for (let i = 0; i < lastUser; i++) {
    const msg = context.messages[i];
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = messageText(msg).trim();
    if (!text) continue;
    // Cap history seed to keep prompts reasonable
    const clipped = text.length > 4000 ? `${text.slice(0, 4000)}\n…[truncated]` : text;
    prior.push(`${msg.role === "user" ? "User" : "Assistant"}: ${clipped}`);
  }

  if (prior.length === 0) return latest;

  return [
    "Prior conversation in this pi session (for context — continue from here):",
    "",
    ...prior,
    "",
    "---",
    "",
    "Current user message:",
    latest,
  ].join("\n");
}

// =============================================================================
// Stream Implementation
// =============================================================================

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

      // Parse agent and model from pi model id: "agent:modelId"
      const colonIdx = model.id.indexOf(":");
      const agent = colonIdx >= 0 ? model.id.substring(0, colonIdx) : model.id;
      if (!registeredAgents.includes(agent) || !isCliAgentName(agent)) {
        throw new Error(`Unknown cli agent: ${agent}`);
      }
      const cliModelId =
        colonIdx >= 0 ? model.id.substring(colonIdx + 1) : "default";

      const state = agents.get(agent);
      if (!state) {
        throw new Error(`Agent not initialized: ${agent}`);
      }

      // Wait for discovery to complete before first use
      await state.ready;

      const handleKey = cliModelId || "default";
      const needsSystemPromptFlag = !state.systemPromptSent.has(handleKey);
      const systemPrompt = needsSystemPromptFlag
        ? buildSystemPrompt(context)
        : undefined;

      const { sessionId, needsSystemPrompt, key } = ensureSession(
        state,
        cliModelId,
        systemPrompt,
      );

      let prompt = buildPromptWithHistory(context, !!sessionId);
      if (needsSystemPrompt && systemPrompt) {
        prompt = `${systemPrompt}\n\n---\n\n${prompt}`;
      }

      let thinkingIndex = -1;
      let textIndex = -1;
      let thinkingClosed = false;

      const result = await runCliTurnWithResumeRecover({
        agent,
        model: cliModelId === "default" ? "default" : cliModelId,
        key,
        sessionId,
        prompt,
        systemPrompt: needsSystemPrompt ? systemPrompt : undefined,
        signal: options?.signal,
        rebuildPromptWithoutSession: () =>
          buildPromptWithHistory(context, false),
        onEvent: (ev) => {
          if (ev.kind === "session") {
            saveCliSessionId(key, ev.sessionId);
            return;
          }
          if (ev.kind === "thinking_delta") {
            if (thinkingIndex < 0) {
              output.content.push({ type: "thinking", thinking: "" });
              thinkingIndex = output.content.length - 1;
              stream.push({
                type: "thinking_start",
                contentIndex: thinkingIndex,
                partial: output,
              });
            }
            const block = output.content[thinkingIndex];
            if (block.type === "thinking") {
              block.thinking += ev.text;
              stream.push({
                type: "thinking_delta",
                contentIndex: thinkingIndex,
                delta: ev.text,
                partial: output,
              });
            }
            return;
          }
          if (ev.kind === "text_delta") {
            if (thinkingIndex >= 0 && !thinkingClosed) {
              thinkingClosed = true;
              const thinkBlock = output.content[thinkingIndex];
              if (thinkBlock.type === "thinking") {
                stream.push({
                  type: "thinking_end",
                  contentIndex: thinkingIndex,
                  content: thinkBlock.thinking,
                  partial: output,
                });
              }
            }
            if (textIndex < 0) {
              output.content.push({ type: "text", text: "" });
              textIndex = output.content.length - 1;
              stream.push({
                type: "text_start",
                contentIndex: textIndex,
                partial: output,
              });
            }
            const block = output.content[textIndex];
            if (block.type === "text") {
              block.text += ev.text;
              stream.push({
                type: "text_delta",
                contentIndex: textIndex,
                delta: ev.text,
                partial: output,
              });
            }
          }
        },
      });

      if (result.sessionId) {
        saveCliSessionId(key, result.sessionId);
      } else if (sessionId) {
        touchCliSession(key);
      }

      // Mark only after a successful turn — failed first turns must retry system prompt.
      if (needsSystemPrompt) {
        state.systemPromptSent.add(handleKey);
      }

      // Close open blocks if stream ended without deltas (fallback)
      if (thinkingIndex >= 0 && !thinkingClosed) {
        const thinkBlock = output.content[thinkingIndex];
        if (thinkBlock.type === "thinking") {
          if (!thinkBlock.thinking && result.thinking) {
            thinkBlock.thinking = result.thinking;
            stream.push({
              type: "thinking_delta",
              contentIndex: thinkingIndex,
              delta: result.thinking,
              partial: output,
            });
          }
          stream.push({
            type: "thinking_end",
            contentIndex: thinkingIndex,
            content: thinkBlock.thinking,
            partial: output,
          });
        }
      }
      if (textIndex < 0 && result.text) {
        output.content.push({ type: "text", text: result.text });
        textIndex = output.content.length - 1;
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
      }
      if (textIndex >= 0) {
        const block = output.content[textIndex];
        if (block.type === "text") {
          // Prefer authoritative final text from parser if it differs
          if (result.text && result.text !== block.text) {
            const missing = result.text.startsWith(block.text)
              ? result.text.slice(block.text.length)
              : "";
            if (missing) {
              block.text = result.text;
              stream.push({
                type: "text_delta",
                contentIndex: textIndex,
                delta: missing,
                partial: output,
              });
            } else {
              block.text = result.text;
            }
          }
          stream.push({
            type: "text_end",
            contentIndex: textIndex,
            content: block.text,
            partial: output,
          });
        }
      }

      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
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

// =============================================================================
// Extension Entry Point
// =============================================================================

export default async function (pi: ExtensionAPI) {
  // Intentionally does NOT skip PI_SUBAGENT_CHILD — cli-* must work in async children.

  // Capture cwd at extension load time, before pi potentially changes directory.
  projectCwd = process.cwd();

  // Defensive: stale/mismatched getSetting may return non-array (issue #651).
  const agentList = asStringArray(getSetting(projectCwd, "cli_agents")).filter(
    isCliAgentName,
  );
  registeredAgents = agentList;

  // Skip sync discovery if no agents configured
  if (agentList.length === 0) return;

  startCliSessionReaper({ cwd: projectCwd });

  const DISCOVERY_TIMEOUT_MS = 30_000;

  const makeModel = (id: string, name: string) => ({
    id,
    name,
    reasoning: false,
    input: ["text" as const, "image" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 32768,
  });

  // Discover models synchronously during extension load (same pattern as acpx).
  // Pi awaits async extension factories, so models are registered before
  // the model resolver runs — preventing silent fallback to default model.
  const results = await Promise.allSettled(
    agentList.map(async (agent) => {
      try {
        let timer: ReturnType<typeof setTimeout>;
        let timedOut = false;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(
              new Error(
                `discovery timed out after ${DISCOVERY_TIMEOUT_MS / 1000}s`,
              ),
            );
          }, DISCOVERY_TIMEOUT_MS);
          if (timer.unref) timer.unref();
        });

        const discovery = (async () => {
          if (!isCliBinaryAvailable(agent)) {
            console.debug(
              `[cli-provider] ${agent}: binary not found, skip registration`,
            );
            return { agent, models: [] as DiscoveredCliModel[] };
          }

          let signalReady!: () => void;
          const ready = new Promise<void>((resolve) => {
            signalReady = resolve;
          });
          const state: AgentState = {
            agent,
            availableModelIds: [],
            systemPromptSent: new Set(),
            sessionKeys: new Map(),
            ready,
            signalReady,
          };
          agents.set(agent, state);

          const models = await discoverCliModelsDetailed(agent);
          if (timedOut) {
            signalReady();
            return { agent, models: [] as DiscoveredCliModel[] };
          }
          state.availableModelIds = models.map((m) => m.id);
          signalReady();
          return { agent, models };
        })();

        const result = await Promise.race([discovery, timeout]);
        clearTimeout(timer!);
        return result;
      } catch (err) {
        console.debug(`[cli-provider] discovery failed for ${agent}:`, err);
        const state = agents.get(agent);
        if (state) state.signalReady();
        return { agent, models: [] as DiscoveredCliModel[] };
      }
    }),
  );

  for (const result of results) {
    if (result.status === "rejected") continue;

    const { agent, models: discovered } = result.value;
    // Skip registration if probe failed (no AgentState) — prevents
    // registering a provider whose streamCli would always throw.
    if (!agents.has(agent)) {
      console.debug(
        `[cli-provider] cli-${agent}: skipped registration (no binary/state)`,
      );
      continue;
    }

    try {
      const models =
        discovered.length > 0
          ? discovered.map((m) =>
              makeModel(`${agent}:${m.id}`, `${m.name} (${agent})`),
            )
          : [makeModel(`${agent}:default`, `${agent} (default)`)];

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

  // Clear in-memory state on shutdown. Keep ~/.pi/cli-sessions/ on disk so
  // --resume can continue after reload (unlike wiping markers every exit).
  // Reaper stops; stale files cleaned on next start via inactivity threshold.
  pi.on("session_shutdown", () => {
    stopCliSessionReaper();
    for (const [, state] of agents) {
      state.sessionKeys.clear();
      state.systemPromptSent.clear();
    }
    agents.clear();
  });
}
