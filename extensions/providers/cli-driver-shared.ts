/**
 * Shared CLI driver/adapter factory for Claude, Gemini, and Cursor CLI drivers.
 *
 * @module providers/cli-driver-shared
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
  SessionHandle,
  SessionStartOptions,
  TurnOptions,
  TurnResult,
} from "../shared/provider-driver.js";
import { makeManagedSnapshot, buildInitialSnapshot } from "../shared/managed-refresh.js";
import { resolveBinary } from "../shared/resolve-binary.js";
import { discoverCliModelsDetailed } from "../cli-provider/discover.js";
import type { CliStreamEvent } from "../cli-provider/parsers.js";
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
import type { Logger } from "../shared/logger.js";
import { resolveAdapterCwd, adapterMemoryKey, deleteKeysForCwd } from "../shared/session-cwd.js";

export interface CliDriverConfig {
  readonly binary: string;
  readonly enabled: boolean;
}

export function createCliConfigSchema(defaultBinary: string): ConfigSchema<CliDriverConfig> {
  return {
    parse: (raw: unknown): CliDriverConfig => {
      if (!raw || typeof raw !== "object") {
        return { binary: defaultBinary, enabled: true };
      }
      const obj = raw as Record<string, unknown>;
      return {
        binary: typeof obj.binary === "string" ? obj.binary : defaultBinary,
        enabled: typeof obj.enabled === "boolean" ? obj.enabled : true,
      };
    },
  };
}

export function createCliStreamEventForwarder(
  key: CliSessionKey,
  saveMarker: (key: CliSessionKey, sessionId: string) => unknown,
  onDriverEvent?: (ev: DriverStreamEvent) => void,
): ((ev: CliStreamEvent) => void) | undefined {
  if (!onDriverEvent) return undefined;
  return (ev: CliStreamEvent) => {
    if (ev.kind === "session" && ev.sessionId) {
      saveMarker(key, ev.sessionId);
      onDriverEvent(ev);
    } else if ((ev.kind === "thinking_delta" || ev.kind === "text_delta") && ev.text) {
      onDriverEvent(ev);
    }
  };
}

export interface SimpleCliAdapterShape extends ProviderAdapterShape {
  bindPiSessionId: (sid: string) => void;
  handleSessionStart: (reason: string, sid: string | null, sessionCwd?: string) => void;
}

export function createSimpleCliAdapter(opts: {
  agent: "claude" | "gemini";
  config: CliDriverConfig;
  cwd: string;
  instanceId: string;
  log: Logger;
}): SimpleCliAdapterShape {
  const { agent, config, cwd, instanceId, log } = opts;
  let piSessionId = createProvisionalPiSessionId();
  const appliedSystemPrompts = new Map<string, string | undefined>();
  const storedSystemPrompts = new Map<string, string>();

  function sessionKeyFor(model: string, turnCwd: string = cwd): CliSessionKey {
    return { cwd: turnCwd, agent, model, piSessionId };
  }

  return {
    bindPiSessionId: (sid: string) => {
      if (sid) piSessionId = sid;
    },

    handleSessionStart: (reason: string, _sid: string | null, sessionCwd?: string) => {
      if (reason === "new" || reason === "resume") {
        const turnCwd = sessionCwd || cwd;
        deleteKeysForCwd(appliedSystemPrompts, turnCwd);
        deleteKeysForCwd(storedSystemPrompts, turnCwd);
      }
    },

    startSession: async (sessionOpts: SessionStartOptions): Promise<SessionHandle> => {
      const model = sessionOpts.model || "default";
      const turnCwd = resolveAdapterCwd(sessionOpts, cwd);
      const memKey = adapterMemoryKey(model, turnCwd);
      const key = sessionKeyFor(model, turnCwd);
      log.debug("starting CLI session", { model, cwd: turnCwd, hasSystemPrompt: sessionOpts.systemPrompt !== undefined, boot: cwd });
      if (sessionOpts.systemPrompt === undefined) {
        storedSystemPrompts.delete(memKey);
        if (appliedSystemPrompts.get(memKey) !== undefined) clearCliSessionId(key);
      } else {
        storedSystemPrompts.set(memKey, sessionOpts.systemPrompt);
      }
      const existingId = loadCliSessionId(key);
      return {
        sessionId: existingId || `${agent}-${instanceId}-${model}`,
        model,
        cwd: turnCwd,
      };
    },

    sendTurn: async (
      handle: SessionHandle,
      prompt: string,
      turnOpts?: TurnOptions,
    ): Promise<TurnResult> => {
      const turnCwd = resolveAdapterCwd(handle, cwd);
      const key = sessionKeyFor(handle.model, turnCwd);
      const sessionId = loadCliSessionId(key);
      const handleKey = adapterMemoryKey(handle.model, turnCwd);
      const systemPrompt = storedSystemPrompts.get(handleKey);
      const needsSystemPrompt = !appliedSystemPrompts.has(handleKey) || appliedSystemPrompts.get(handleKey) !== systemPrompt;
      log.debug("building turn system prompt", { model: handle.model, turnCwd, changed: needsSystemPrompt });

      let finalPrompt = prompt;
      if (needsSystemPrompt && systemPrompt) {
        finalPrompt = applySystemPromptToCliPrompt(prompt, systemPrompt);
      }

      const onEvent = createCliStreamEventForwarder(key, saveCliSessionId, turnOpts?.onEvent);

      const runOnce = (sid: string | null, p: string) =>
        runCliAgent({
          agent,
          model: handle.model === "default" ? "default" : handle.model,
          cwd: turnCwd,
          prompt: p,
          sessionId: sid,
          signal: turnOpts?.signal,
          binary: config.binary,
          onEvent,
        });

      try {
        const result = await runOnce(sessionId, finalPrompt);
        if (result.sessionId) saveCliSessionId(key, result.sessionId);
        if (needsSystemPrompt) appliedSystemPrompts.set(handleKey, systemPrompt);
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
          log.warn(`resume failed, clearing session and retrying: ${message.slice(0, 200)}`);
          clearCliSessionId(key);
          const retryPrompt = needsSystemPrompt && systemPrompt
            ? applySystemPromptToCliPrompt(prompt, systemPrompt)
            : prompt;
          const result = await runOnce(null, retryPrompt);
          if (result.sessionId) saveCliSessionId(key, result.sessionId);
          if (needsSystemPrompt) appliedSystemPrompts.set(handleKey, systemPrompt);
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
      clearCliSessionId(sessionKeyFor(handle.model, turnCwd));
      const handleKey = adapterMemoryKey(handle.model, turnCwd);
      appliedSystemPrompts.delete(handleKey);
      storedSystemPrompts.delete(handleKey);
    },

    stopAll: async (): Promise<void> => {
      appliedSystemPrompts.clear();
      storedSystemPrompts.clear();
    },

    hasSession: (_sessionId: string): boolean => false,
  };
}

export function createCliDriver(opts: {
  agent: "claude" | "gemini" | "cursor";
  driverKind: string;
  defaultBinary: string;
  defaultDisplayName: string;
  log: Logger;
  createAdapter: (config: CliDriverConfig, cwd: string, instanceId: string) => ProviderAdapterShape;
}): ProviderDriver<CliDriverConfig> {
  const { agent, driverKind, defaultBinary, defaultDisplayName, log, createAdapter } = opts;

  return {
    driverKind,
    metadata: {
      displayName: defaultDisplayName,
      supportsMultipleInstances: false,
    },
    configSchema: createCliConfigSchema(defaultBinary),
    defaultConfig: () => ({ binary: defaultBinary, enabled: true }),

    probe: async (config: CliDriverConfig): Promise<ProviderProbeResult> => {
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
      input: ProviderDriverCreateInput<CliDriverConfig>,
    ): Promise<ProviderInstance> => {
      const { instanceId, config, cwd } = input;

      let discoveredModels: DiscoveredModel[] = [];
      try {
        const detailed = await discoverCliModelsDetailed(agent);
        discoveredModels = detailed.map((m) => ({ id: m.id, name: m.name }));
      } catch (err) {
        log.warn(`model discovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      const managed = makeManagedSnapshot({
        skipInitialRefresh: true,
        initialSnapshot: () => buildInitialSnapshot(true, discoveredModels),
        checkProvider: async () => {
          const binary = resolveBinary(config.binary);
          if (!binary) {
            return buildInitialSnapshot(false, [], undefined, `Binary '${config.binary}' not found`);
          }
          try {
            const next = await discoverCliModelsDetailed(agent);
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

      const adapter = createAdapter(config, cwd, instanceId);

      return {
        instanceId,
        driverKind,
        displayName: input.displayName || defaultDisplayName,
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
}
