/**
 * ClaudeDriver — ProviderDriver for the Claude Code CLI agent.
 *
 * Adapted from t3code's ClaudeDriver pattern. Owns config schema,
 * binary probe, model discovery (binary catalog scan), session/turn
 * adapter, and managed snapshot refresh.
 *
 * Reuses existing modules:
 * - cli-provider/agents/claude.ts — discovery (scanClaudeBinaryCatalog)
 * - cli-provider/runner.ts — process spawning (runCliAgent)
 * - cli-provider/sessions.ts — session marker management
 * - cli-provider/parsers.ts — output parsing
 * - shared/build-system-prompt.ts — system prompt injection
 *
 * @module providers/claude-driver
 */

import type {
  ConfigSchema,
  DiscoveredModel,
  DriverStreamEvent,
  ProviderAdapterShape,
  ProviderDriver,
  ProviderDriverCreateInput,
  ProviderInstance,
  ProviderProbeResult,
  ProviderSnapshotShape,
  SessionHandle,
  SessionStartOptions,
  TurnOptions,
  TurnResult,
} from "../shared/provider-driver.js";
import { ProviderDriverError } from "../shared/provider-errors.js";
import { makeManagedSnapshot, buildInitialSnapshot } from "../shared/managed-refresh.js";
import { resolveBinary } from "../shared/resolve-binary.js";
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
import { resolveAdapterCwd, adapterMemoryKey, deleteKeysForCwd } from "../shared/session-cwd.js";

const LOG_DOMAIN = "claude-driver";
const DRIVER_KIND = "claude-cli";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ClaudeCliConfig {
  readonly binary: string;
  readonly enabled: boolean;
}

const claudeConfigSchema: ConfigSchema<ClaudeCliConfig> = {
  parse: (raw: unknown): ClaudeCliConfig => {
    if (!raw || typeof raw !== "object") {
      return { binary: "claude", enabled: true };
    }
    const obj = raw as Record<string, unknown>;
    return {
      binary: typeof obj.binary === "string" ? obj.binary : "claude",
      enabled: typeof obj.enabled === "boolean" ? obj.enabled : true,
    };
  },
};

// ---------------------------------------------------------------------------
// Adapter (session / turn runtime)
// ---------------------------------------------------------------------------

function createClaudeAdapter(
  config: ClaudeCliConfig,
  cwd: string,
  instanceId: string,
): ProviderAdapterShape & {
  bindPiSessionId: (sid: string) => void;
  handleSessionStart: (reason: string, sid: string | null, sessionCwd?: string) => void;
} {
  let piSessionId = createProvisionalPiSessionId();
  const systemPromptSent = new Set<string>();
  const storedSystemPrompts = new Map<string, string>();

  function sessionKeyFor(model: string, turnCwd: string = cwd): CliSessionKey {
    return { cwd: turnCwd, agent: "claude", model, piSessionId };
  }

  return {
    bindPiSessionId: (sid: string) => {
      if (sid) piSessionId = sid;
    },

    handleSessionStart: (reason: string, _sid: string | null, sessionCwd?: string) => {
      if (reason === "new" || reason === "resume") {
        const turnCwd = sessionCwd || cwd;
        deleteKeysForCwd(systemPromptSent, turnCwd);
        deleteKeysForCwd(storedSystemPrompts, turnCwd);
      }
    },

    startSession: async (opts: SessionStartOptions): Promise<SessionHandle> => {
      const model = opts.model || "default";
      const turnCwd = resolveAdapterCwd(opts, cwd);
      const memKey = adapterMemoryKey(model, turnCwd);
      if (opts.systemPrompt) storedSystemPrompts.set(memKey, opts.systemPrompt);
      const key = sessionKeyFor(model, turnCwd);
      const existingId = loadCliSessionId(key);
      fileLog(LOG_DOMAIN, "debug", LOG_DOMAIN,
        `startSession model=${model} cwd=${turnCwd} boot=${cwd}`);
      return {
        sessionId: existingId || `claude-${instanceId}-${model}`,
        model,
        cwd: turnCwd,
      };
    },

    sendTurn: async (
      handle: SessionHandle,
      prompt: string,
      opts?: TurnOptions,
    ): Promise<TurnResult> => {
      const turnCwd = resolveAdapterCwd(handle, cwd);
      const key = sessionKeyFor(handle.model, turnCwd);
      const sessionId = loadCliSessionId(key);
      const handleKey = adapterMemoryKey(handle.model, turnCwd);
      const needsSystemPrompt = !systemPromptSent.has(handleKey);

      // Prefer the system prompt stored at startSession over rebuilding
      let systemPrompt: string | undefined;
      if (needsSystemPrompt) {
        systemPrompt =
          storedSystemPrompts.get(handleKey) ||
          buildExternalSystemPrompt({ systemPrompt: undefined }, turnCwd);
      }

      // Apply system prompt to the prompt text
      let finalPrompt = prompt;
      if (needsSystemPrompt && systemPrompt) {
        finalPrompt = applySystemPromptToCliPrompt(prompt, systemPrompt);
      }

      // Build event handler that bridges to DriverStreamEvent
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
          agent: "claude",
          model: handle.model === "default" ? "default" : handle.model,
          cwd: turnCwd,
          prompt: p,
          sessionId: sid,
          signal: opts?.signal,
          binary: config.binary,
          onEvent,
        });

      try {
        const result = await runOnce(sessionId, finalPrompt);

        // Save session id from result
        if (result.sessionId) {
          saveCliSessionId(key, result.sessionId);
        }

        // Mark system prompt sent on success
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
        // Resume recovery: if --resume fails, clear marker and retry
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
      const turnCwd = resolveAdapterCwd(handle, cwd);
      const key = sessionKeyFor(handle.model, turnCwd);
      clearCliSessionId(key);
      const handleKey = adapterMemoryKey(handle.model, turnCwd);
      systemPromptSent.delete(handleKey);
      storedSystemPrompts.delete(handleKey);
    },

    stopAll: async (): Promise<void> => {
      systemPromptSent.clear();
      storedSystemPrompts.clear();
    },

    hasSession: (_sessionId: string): boolean => {
      // Check if any session key maps to this session id
      return false; // CLI sessions are stateless from adapter perspective
    },
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export const ClaudeDriver: ProviderDriver<ClaudeCliConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude CLI",
    supportsMultipleInstances: false,
  },
  configSchema: claudeConfigSchema,
  defaultConfig: () => ({ binary: "claude", enabled: true }),

  probe: async (config: ClaudeCliConfig): Promise<ProviderProbeResult> => {
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
    input: ProviderDriverCreateInput<ClaudeCliConfig>,
  ): Promise<ProviderInstance> => {
    const { instanceId, config, cwd } = input;

    // Discover models
    let discoveredModels: DiscoveredModel[] = [];
    try {
      const detailed = await discoverCliModelsDetailed("claude");
      discoveredModels = detailed.map((m) => ({ id: m.id, name: m.name }));
    } catch (err) {
      fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
        `model discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Create managed snapshot with periodic refresh
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
          const next = await discoverCliModelsDetailed("claude");
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

    // Create adapter
    const adapter = createClaudeAdapter(config, cwd, instanceId);

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName || "Claude CLI",
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
