/**
 * CursorAcpxDriver — ProviderDriver for the Cursor Agent via ACP runtime.
 *
 * Wraps the acpx runtime for ACP-based session management. Owns
 * ensureHandle, model discovery via runtime.getStatus, and event
 * stream from turn.events.
 *
 * Reuses existing modules:
 * - acpx-provider/load-runtime.ts — dynamic acpx import
 * - shared/build-system-prompt.ts — system prompt injection
 *
 * @module providers/cursor-acpx-driver
 */

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { rm } from "node:fs/promises";
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
import { ProviderDriverError } from "../shared/provider-errors.js";
import { makeManagedSnapshot, buildInitialSnapshot } from "../shared/managed-refresh.js";
import { loadAcpxRuntime, type AcpxRuntimeModule } from "../acpx-provider/load-runtime.js";
import { modelIdToDisplayName } from "../acpx-provider/runtime-models.js";
import { buildExternalSystemPrompt } from "../shared/build-system-prompt.js";
import { fileLog } from "../shared/file-logger.js";
import { resolveAdapterCwd, adapterMemoryKey } from "../shared/session-cwd.js";

const LOG_DOMAIN = "cursor-acpx-driver";
const DRIVER_KIND = "cursor-acpx";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CursorAcpxConfig {
  readonly agent: string;
  readonly enabled: boolean;
}

const cursorAcpxConfigSchema: ConfigSchema<CursorAcpxConfig> = {
  parse: (raw: unknown): CursorAcpxConfig => {
    if (!raw || typeof raw !== "object") {
      return { agent: "cursor", enabled: true };
    }
    const obj = raw as Record<string, unknown>;
    return {
      agent: typeof obj.agent === "string" ? obj.agent : "cursor",
      enabled: typeof obj.enabled === "boolean" ? obj.enabled : true,
    };
  },
};

// ---------------------------------------------------------------------------
// Runtime types
// ---------------------------------------------------------------------------

type AcpxRuntime = ReturnType<AcpxRuntimeModule["createAcpRuntime"]>;
type AcpRuntimeHandle = Awaited<ReturnType<AcpxRuntime["ensureSession"]>>;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function createCursorAcpxAdapter(
  config: CursorAcpxConfig,
  cwd: string,
  runtime: AcpxRuntime,
): ProviderAdapterShape {
  const handles = new Map<string, AcpRuntimeHandle>();
  const pendingHandles = new Map<string, Promise<AcpRuntimeHandle>>();
  const systemPromptSent = new Set<string>();
  const knownSessionIds = new Set<string>();

  function handleMapKey(modelId: string | undefined, turnCwd: string): string {
    return adapterMemoryKey(modelId, turnCwd);
  }

  function sessionKey(modelId: string | undefined, turnCwd: string): string {
    const slug = createHash("sha256").update(turnCwd).digest("hex").slice(0, 12);
    const model = modelId && modelId !== "default"
      ? `-${modelId.replace(/[^a-zA-Z0-9.-]/g, "_")}`
      : "";
    return `pi-${config.agent}${model}-${slug}`;
  }

  async function ensureHandle(
    acpxModelId: string | undefined,
    systemPrompt: string | undefined,
    turnCwd: string,
  ): Promise<AcpRuntimeHandle> {
    const key = handleMapKey(acpxModelId, turnCwd);

    const existing = handles.get(key);
    if (existing) return existing;

    const pending = pendingHandles.get(key);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const sessionOpts: { model?: string; systemPrompt?: string } = {};
        if (acpxModelId && acpxModelId !== "default") {
          sessionOpts.model = acpxModelId;
        }
        if (systemPrompt) {
          sessionOpts.systemPrompt = systemPrompt;
        }

        fileLog(LOG_DOMAIN, "debug", LOG_DOMAIN,
          `ensureSession agent=${config.agent} cwd=${turnCwd} boot=${cwd} model=${acpxModelId || "default"}`);
        const handle = await runtime.ensureSession({
          sessionKey: sessionKey(acpxModelId, turnCwd),
          agent: config.agent,
          mode: "persistent",
          cwd: turnCwd,
          ...(Object.keys(sessionOpts).length > 0
            ? { sessionOptions: sessionOpts }
            : {}),
        });

        handles.set(key, handle);
        return handle;
      } finally {
        pendingHandles.delete(key);
      }
    })();

    pendingHandles.set(key, promise);
    return promise;
  }

  return {
    startSession: async (opts: SessionStartOptions): Promise<SessionHandle> => {
      const model = opts.model || "default";
      const turnCwd = resolveAdapterCwd(opts, cwd);
      const systemPrompt = opts.systemPrompt
        ? opts.systemPrompt
        : buildExternalSystemPrompt({ systemPrompt: undefined }, turnCwd);
      await ensureHandle(model, systemPrompt, turnCwd);
      const sessionId = sessionKey(model, turnCwd);
      knownSessionIds.add(sessionId);
      return {
        sessionId,
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
      const handleKey = handleMapKey(handle.model, turnCwd);
      const needsSystemPrompt = !systemPromptSent.has(handleKey);
      const systemPrompt = needsSystemPrompt
        ? buildExternalSystemPrompt({ systemPrompt: undefined }, turnCwd)
        : undefined;

      const acpxHandle = await ensureHandle(handle.model, systemPrompt, turnCwd);
      if (needsSystemPrompt) {
        systemPromptSent.add(handleKey);
      }

      const abortController = new AbortController();
      if (opts?.signal) {
        if (opts.signal.aborted) {
          abortController.abort();
        } else {
          opts.signal.addEventListener("abort", () => abortController.abort(), { once: true });
        }
      }

      const turn = runtime.startTurn({
        handle: acpxHandle,
        text: prompt,
        mode: "prompt",
        requestId: `pi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        signal: abortController.signal,
      });

      let text = "";
      let thinking = "";

      for await (const event of turn.events) {
        if (abortController.signal.aborted) break;

        if (event.type === "text_delta" && event.text) {
          if (event.stream === "thought") {
            thinking += event.text;
            opts?.onEvent?.({ kind: "thinking_delta", text: event.text });
          } else {
            text += event.text;
            opts?.onEvent?.({ kind: "text_delta", text: event.text });
          }
        }
      }

      const result = await turn.result;
      let stopReason = "stop";
      if (result.status === "completed") {
        stopReason = result.stopReason === "end_turn" ? "stop" : (result.stopReason || "stop");
      } else if (result.status === "failed") {
        throw new Error(`acpx turn failed: ${result.error.message}`);
      }

      return { text, thinking: thinking || undefined, stopReason };
    },

    stopSession: async (handle: SessionHandle): Promise<void> => {
      const turnCwd = resolveAdapterCwd(handle, cwd);
      const key = handleMapKey(handle.model, turnCwd);
      const acpxHandle = handles.get(key);
      if (acpxHandle) {
        await runtime.close({ handle: acpxHandle, reason: "session stop" }).catch((err: unknown) => {
          fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
            `session close failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        handles.delete(key);
      }
      systemPromptSent.delete(key);
      knownSessionIds.delete(sessionKey(handle.model, turnCwd));
    },

    stopAll: async (): Promise<void> => {
      const closePromises: Promise<void>[] = [];
      for (const [key, acpxHandle] of handles) {
        closePromises.push(
          runtime.close({ handle: acpxHandle, reason: "stop all" }).catch((err: unknown) => {
            fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
              `session close failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
          }),
        );
      }
      await Promise.allSettled(closePromises);
      handles.clear();
      pendingHandles.clear();
      systemPromptSent.clear();
      knownSessionIds.clear();
    },

    hasSession: (sessionId: string): boolean => {
      return knownSessionIds.has(sessionId);
    },
  };
}

// ---------------------------------------------------------------------------
// Discovery helper
// ---------------------------------------------------------------------------

async function discoverAcpxModelsInternal(
  agent: string,
  cwd: string,
): Promise<string[]> {
  const { createAcpRuntime, createFileSessionStore, createAgentRegistry } =
    await loadAcpxRuntime();

  const uid = randomUUID().slice(0, 8);
  const stateDir = path.join(os.homedir(), ".acpx", `discover-${process.pid}-${uid}`);
  const runtime = createAcpRuntime({
    cwd,
    sessionStore: createFileSessionStore({ stateDir }),
    agentRegistry: createAgentRegistry(),
    permissionMode: "deny-all",
  });

  let handle: AcpRuntimeHandle | undefined;
  try {
    handle = await runtime.ensureSession({
      sessionKey: `discover-${agent}-${uid}`,
      agent,
      mode: "oneshot",
      cwd,
    });

    const status = await runtime.getStatus({ handle });
    return status.models?.availableModelIds || [];
  } catch (err) {
    fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
      `model discovery failed for ${agent}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  } finally {
    if (handle) {
      await runtime.close({ handle, reason: "discovery complete" }).catch(() => {});
    }
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export const CursorAcpxDriver: ProviderDriver<CursorAcpxConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Cursor ACPX",
    supportsMultipleInstances: false,
  },
  configSchema: cursorAcpxConfigSchema,
  defaultConfig: () => ({ agent: "cursor", enabled: true }),

  probe: async (_config: CursorAcpxConfig): Promise<ProviderProbeResult> => {
    try {
      await loadAcpxRuntime();
      return { available: true };
    } catch (err) {
      return {
        available: false,
        reason: `acpx runtime not available: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },

  create: async (
    input: ProviderDriverCreateInput<CursorAcpxConfig>,
  ): Promise<ProviderInstance> => {
    const { instanceId, config, cwd } = input;
    const cwdSlug = createHash("sha256").update(cwd).digest("hex").slice(0, 12);

    // Load runtime
    const { createAcpRuntime, createFileSessionStore, createAgentRegistry } =
      await loadAcpxRuntime();

    const stateDir = path.join(os.homedir(), ".acpx", `pi-${cwdSlug}`);
    const runtime = createAcpRuntime({
      cwd,
      sessionStore: createFileSessionStore({ stateDir }),
      agentRegistry: createAgentRegistry(),
      permissionMode: "approve-all",
    });

    // Discover models
    let discoveredModelIds: string[] = [];
    try {
      // Use the runtime's own status to discover models
      const tmpHandle = await runtime.ensureSession({
        sessionKey: `discover-${config.agent}-init`,
        agent: config.agent,
        mode: "oneshot",
        cwd,
      });
      const status = await runtime.getStatus({ handle: tmpHandle });
      discoveredModelIds = status.models?.availableModelIds || [];
      await runtime.close({ handle: tmpHandle, reason: "initial discovery" }).catch(() => {});
    } catch (err) {
      fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
        `initial model discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const discoveredModels: DiscoveredModel[] = discoveredModelIds.map((id) => ({
      id,
      name: modelIdToDisplayName(id),
    }));

    // Managed snapshot with periodic refresh
    const managed = makeManagedSnapshot({
      initialSnapshot: () => buildInitialSnapshot(true, discoveredModels),
      checkProvider: async () => {
        try {
          const modelIds = await discoverAcpxModelsInternal(config.agent, cwd);
          const models = modelIds.map((id) => ({
            id,
            name: modelIdToDisplayName(id),
          }));
          return buildInitialSnapshot(true, models);
        } catch {
          return buildInitialSnapshot(true, discoveredModels);
        }
      },
      getSettings: () => config,
      haveSettingsChanged: (prev, next) =>
        prev.agent !== next.agent || prev.enabled !== next.enabled,
    });

    // Create adapter
    const adapter = createCursorAcpxAdapter(config, cwd, runtime);

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName || `ACPX ${config.agent}`,
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
