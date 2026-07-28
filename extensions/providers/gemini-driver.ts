/**
 * GeminiDriver — ProviderDriver for the Gemini CLI agent.
 *
 * Adapted from t3code's driver pattern. Owns config schema,
 * binary probe, model discovery (bundle parsing), session/turn
 * adapter, and managed snapshot refresh.
 *
 * Reuses existing modules:
 * - cli-provider/agents/gemini.ts — discovery (parseGeminiCliVisibleModels)
 * - cli-provider/runner.ts — process spawning (runCliAgent)
 * - cli-provider/sessions.ts — session marker management
 * - shared/build-system-prompt.ts — system prompt injection
 *
 * @module providers/gemini-driver
 */

import type {
  ConfigSchema,
  DiscoveredModel,
  ProviderAdapterShape,
  ProviderDriver,
  ProviderDriverCreateInput,
  ProviderInstance,
  ProviderProbeResult,
  SessionHandle,
  SessionStartOptions,
  TurnOptions,
  TurnResult,
} from "../shared/provider-driver.js";
import { makeManagedSnapshot, buildInitialSnapshot } from "../shared/managed-refresh.js";
import { resolveBinary } from "../cli-provider/shared/discover-cache.js";
import { discoverCliModelsDetailed } from "../cli-provider/discover.js";
import { runCliAgent } from "../cli-provider/runner.js";
import {
  loadCliSessionId,
  saveCliSessionId,
  clearCliSessionId,
  applySystemPromptToCliPrompt,
  shouldRetryWithoutResume,
  createProvisionalPiSessionId,
  type CliSessionKey,
} from "../cli-provider/sessions.js";
import { buildExternalSystemPrompt } from "../shared/build-system-prompt.js";
import { fileLog } from "../shared/file-logger.js";

const LOG_DOMAIN = "gemini-driver";
const DRIVER_KIND = "gemini-cli";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GeminiCliConfig {
  readonly binary: string;
  readonly enabled: boolean;
}

const geminiConfigSchema: ConfigSchema<GeminiCliConfig> = {
  parse: (raw: unknown): GeminiCliConfig => {
    if (!raw || typeof raw !== "object") {
      return { binary: "gemini", enabled: true };
    }
    const obj = raw as Record<string, unknown>;
    return {
      binary: typeof obj.binary === "string" ? obj.binary : "gemini",
      enabled: typeof obj.enabled === "boolean" ? obj.enabled : true,
    };
  },
};

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function createGeminiAdapter(
  config: GeminiCliConfig,
  cwd: string,
  instanceId: string,
): ProviderAdapterShape & {
  bindPiSessionId: (sid: string) => void;
  handleSessionStart: (reason: string, sid: string | null) => void;
} {
  let piSessionId = createProvisionalPiSessionId();
  const systemPromptSent = new Set<string>();
  const storedSystemPrompts = new Map<string, string>();

  function sessionKeyFor(model: string): CliSessionKey {
    return { cwd, agent: "gemini", model, piSessionId };
  }

  return {
    bindPiSessionId: (sid: string) => {
      if (sid) piSessionId = sid;
    },

    handleSessionStart: (reason: string, _sid: string | null) => {
      if (reason === "new" || reason === "resume") {
        systemPromptSent.clear();
        storedSystemPrompts.clear();
      }
    },

    startSession: async (opts: SessionStartOptions): Promise<SessionHandle> => {
      const model = opts.model || "default";
      if (opts.systemPrompt) storedSystemPrompts.set(model, opts.systemPrompt);
      const key = sessionKeyFor(model);
      const existingId = loadCliSessionId(key);
      return {
        sessionId: existingId || `gemini-${instanceId}-${model}`,
        model,
      };
    },

    sendTurn: async (
      handle: SessionHandle,
      prompt: string,
      opts?: TurnOptions,
    ): Promise<TurnResult> => {
      const key = sessionKeyFor(handle.model);
      const sessionId = loadCliSessionId(key);
      const handleKey = handle.model || "default";
      const needsSystemPrompt = !systemPromptSent.has(handleKey);

      let systemPrompt: string | undefined;
      if (needsSystemPrompt) {
        systemPrompt =
          storedSystemPrompts.get(handleKey) ||
          buildExternalSystemPrompt({ systemPrompt: undefined }, cwd);
      }

      let finalPrompt = prompt;
      if (needsSystemPrompt && systemPrompt) {
        finalPrompt = applySystemPromptToCliPrompt(prompt, systemPrompt);
      }

      const onEvent = opts?.onEvent
        ? (ev: { kind: string; text?: string; sessionId?: string }) => {
            if (ev.kind === "session" && ev.sessionId) {
              saveCliSessionId(key, ev.sessionId);
              opts.onEvent!({ kind: "session", sessionId: ev.sessionId });
            } else if (ev.kind === "thinking_delta" && ev.text) {
              opts.onEvent!({ kind: "thinking_delta", text: ev.text });
            } else if (ev.kind === "text_delta" && ev.text) {
              opts.onEvent!({ kind: "text_delta", text: ev.text });
            }
          }
        : undefined;

      const runOnce = (sid: string | null, p: string) =>
        runCliAgent({
          agent: "gemini",
          model: handle.model === "default" ? "default" : handle.model,
          cwd,
          prompt: p,
          sessionId: sid,
          signal: opts?.signal,
          binary: config.binary,
          onEvent,
        });

      try {
        const result = await runOnce(sessionId, finalPrompt);
        if (result.sessionId) {
          saveCliSessionId(key, result.sessionId);
        }
        if (needsSystemPrompt) {
          systemPromptSent.add(handleKey);
        }
        return {
          text: result.text,
          thinking: result.thinking,
          sessionId: result.sessionId,
          stopReason: "stop",
          usage: result.usage,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (sessionId && shouldRetryWithoutResume(message)) {
          fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
            `resume failed, clearing session and retrying: ${message.slice(0, 200)}`);
          clearCliSessionId(key);
          const retryPrompt = needsSystemPrompt && systemPrompt
            ? applySystemPromptToCliPrompt(prompt, systemPrompt)
            : prompt;
          const result = await runOnce(null, retryPrompt);
          if (result.sessionId) {
            saveCliSessionId(key, result.sessionId);
          }
          if (needsSystemPrompt) {
            systemPromptSent.add(handleKey);
          }
          return {
            text: result.text,
            thinking: result.thinking,
            sessionId: result.sessionId,
            stopReason: "stop",
            usage: result.usage,
          };
        }
        throw err;
      }
    },

    stopSession: async (handle: SessionHandle): Promise<void> => {
      const key = sessionKeyFor(handle.model);
      clearCliSessionId(key);
      const handleKey = handle.model || "default";
      systemPromptSent.delete(handleKey);
      storedSystemPrompts.delete(handleKey);
    },

    stopAll: async (): Promise<void> => {
      systemPromptSent.clear();
      storedSystemPrompts.clear();
    },

    hasSession: (_sessionId: string): boolean => {
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export const GeminiDriver: ProviderDriver<GeminiCliConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Gemini CLI",
    supportsMultipleInstances: false,
  },
  configSchema: geminiConfigSchema,
  defaultConfig: () => ({ binary: "gemini", enabled: true }),

  probe: async (config: GeminiCliConfig): Promise<ProviderProbeResult> => {
    const binary = resolveBinary(config.binary);
    if (!binary) {
      return {
        available: false,
        reason: `Binary '${config.binary}' not found on PATH`,
      };
    }
    return { available: true };
  },

  create: async (
    input: ProviderDriverCreateInput<GeminiCliConfig>,
  ): Promise<ProviderInstance> => {
    const { instanceId, config, cwd } = input;

    let discoveredModels: DiscoveredModel[] = [];
    try {
      const detailed = await discoverCliModelsDetailed("gemini");
      discoveredModels = detailed.map((m) => ({ id: m.id, name: m.name }));
    } catch (err) {
      fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
        `model discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const managed = makeManagedSnapshot({
      skipInitialRefresh: true,
      initialSnapshot: () =>
        buildInitialSnapshot(true, discoveredModels),
      checkProvider: async () => {
        const binary = resolveBinary(config.binary);
        if (!binary) {
          return buildInitialSnapshot(false, [], undefined, `Binary '${config.binary}' not found`);
        }
        try {
          const next = await discoverCliModelsDetailed("gemini");
          const models = next.map((m) => ({ id: m.id, name: m.name }));
          return buildInitialSnapshot(true, models);
        } catch {
          return buildInitialSnapshot(true, discoveredModels);
        }
      },
      getSettings: () => config,
      haveSettingsChanged: (prev, next) =>
        prev.binary !== next.binary || prev.enabled !== next.enabled,
    });

    const adapter = createGeminiAdapter(config, cwd, instanceId);

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName || "Gemini CLI",
      enabled: input.enabled,
      snapshot: {
        getSnapshot: managed.getSnapshot,
        refresh: managed.refresh,
        dispose: managed.dispose,
      },
      adapter,
      dispose: async () => {
        managed.dispose();
        await adapter.stopAll();
      },
    };
  },
};
