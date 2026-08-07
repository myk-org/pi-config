/**
 * AcpxDriver — ProviderDriver for agents via ACP runtime.
 *
 * Wraps the acpx runtime for ACP-based session management. Owns
 * ensureHandle, model discovery via runtime.getStatus, and event
 * stream from turn.events.
 *
 * Reuses existing modules:
 * - acpx-provider/load-runtime.ts — dynamic acpx import
 * - shared/build-system-prompt.ts — system prompt injection
 *
 * @module providers/acpx-driver
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
import { resolveBinary } from "../shared/resolve-binary.js";

const LOG_DOMAIN = "acpx-driver";
const DRIVER_KIND = "acpx";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AcpxConfig {
  readonly agent: string;
  readonly enabled: boolean;
}

const acpxConfigSchema: ConfigSchema<AcpxConfig> = {
  parse: (raw: unknown): AcpxConfig => {
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

function createAcpxAdapter(
  config: AcpxConfig,
  cwd: string,
  runtime: AcpxRuntime,
  cwdSlug: string,
  initialHandle?: AcpRuntimeHandle,
): ProviderAdapterShape {
  const handles = new Map<string, AcpRuntimeHandle>();
  const prevCumulative = new Map<string, { inputTokens?: number; outputTokens?: number; totalTokens?: number }>();
  // Seed with the discovery handle so the first turn reuses it
  if (initialHandle) {
    handles.set("default", initialHandle);
  }
  const pendingHandles = new Map<string, Promise<AcpRuntimeHandle>>();
  const systemPromptSent = new Set<string>();

  function sessionKey(modelId?: string): string {
    const model = modelId && modelId !== "default"
      ? `-${modelId.replace(/[^a-zA-Z0-9.-]/g, "_")}`
      : "";
    return `pi-${config.agent}${model}-${cwdSlug}`;
  }

  async function ensureHandle(
    acpxModelId: string | undefined,
    systemPrompt?: string,
  ): Promise<AcpRuntimeHandle> {
    const key = acpxModelId || "default";

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

        const handle = await runtime.ensureSession({
          sessionKey: sessionKey(acpxModelId),
          agent: config.agent,
          mode: "persistent",
          cwd,
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
      const systemPrompt = opts.systemPrompt
        ? opts.systemPrompt
        : buildExternalSystemPrompt({ systemPrompt: undefined }, cwd);
      const handle = await ensureHandle(model, systemPrompt);
      return {
        sessionId: sessionKey(model),
        model,
      };
    },

    sendTurn: async (
      handle: SessionHandle,
      prompt: string,
      opts?: TurnOptions,
    ): Promise<TurnResult> => {
      const handleKey = handle.model || "default";
      const needsSystemPrompt = !systemPromptSent.has(handleKey);
      const systemPrompt = needsSystemPrompt
        ? buildExternalSystemPrompt({ systemPrompt: undefined }, cwd)
        : undefined;

      const acpxHandle = await ensureHandle(handle.model, systemPrompt);
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

      let lastBreakdown: any = undefined;
      let lastCost: any = undefined;
      let lastUsed: number | undefined;

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
        } else if (event.type === "status") {
          if ((event as any).breakdown) {
            lastBreakdown = (event as any).breakdown;
          }
          if ((event as any).cost) {
            lastCost = (event as any).cost;
          }
          if (typeof (event as any).used === "number") {
            lastUsed = (event as any).used;
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

      // Build usage: prefer stream breakdown, fall back to getStatus() cumulative
      let usage: {
        inputTokens?: number;
        outputTokens?: number;
        cachedReadTokens?: number;
        cachedWriteTokens?: number;
        thoughtTokens?: number;
        totalTokens?: number;
        costUsd?: number;
      } | undefined;

      if (lastBreakdown) {
        // Stream carried per-turn breakdown (Claude Code adapter does this)
        usage = {
          inputTokens: lastBreakdown.inputTokens ?? undefined,
          outputTokens: lastBreakdown.outputTokens ?? undefined,
          cachedReadTokens: lastBreakdown.cachedReadTokens ?? undefined,
          cachedWriteTokens: lastBreakdown.cachedWriteTokens ?? undefined,
          thoughtTokens: lastBreakdown.thoughtTokens ?? undefined,
          totalTokens: lastBreakdown.totalTokens ?? undefined,
          costUsd: lastCost?.total ?? lastCost?.usd ?? undefined,
        };
      } else if (lastUsed !== undefined) {
        // Stream carried total token count via status.used (Cursor adapter)
        usage = {
          totalTokens: lastUsed,
          costUsd: lastCost?.total ?? lastCost?.usd ?? undefined,
        };
      } else {
        // Fall back to session-level usage from getStatus()
        try {
          const status = await runtime.getStatus({ handle: acpxHandle });
          const su = status.usage;
          if (su?.cumulative) {
            const c = su.cumulative;
            const key = handle.model || "default";
            const prev = prevCumulative.get(key) || { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
            const deltaInput = (c.inputTokens ?? 0) - (prev.inputTokens ?? 0);
            const deltaOutput = (c.outputTokens ?? 0) - (prev.outputTokens ?? 0);
            const deltaTotal = (c.totalTokens ?? 0) - (prev.totalTokens ?? 0);
            prevCumulative.set(key, {
              inputTokens: c.inputTokens ?? 0,
              outputTokens: c.outputTokens ?? 0,
              totalTokens: c.totalTokens ?? 0,
            });
            if (deltaInput > 0 || deltaOutput > 0 || deltaTotal > 0) {
              usage = {
                inputTokens: deltaInput > 0 ? deltaInput : undefined,
                outputTokens: deltaOutput > 0 ? deltaOutput : undefined,
                totalTokens: deltaTotal > 0 ? deltaTotal : undefined,
                costUsd: su.cost?.total ?? su.cost?.usd ?? undefined,
              };
            }
          }
        } catch {
          // Usage is best-effort — don't fail the turn
        }
      }

      return { text, thinking: thinking || undefined, stopReason, usage };
    },

    stopSession: async (handle: SessionHandle): Promise<void> => {
      const key = handle.model || "default";
      const acpxHandle = handles.get(key);
      if (acpxHandle) {
        await runtime.close({ handle: acpxHandle, reason: "session stop" }).catch((err: unknown) => {
          fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
            `session close failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        handles.delete(key);
      }
      systemPromptSent.delete(key);
      prevCumulative.delete(key);
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
      prevCumulative.clear();
    },

    hasSession: (sessionId: string): boolean => {
      for (const key of handles.keys()) {
        if (sessionKey(key === "default" ? undefined : key) === sessionId) {
          return true;
        }
      }
      return false;
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

export const AcpxDriver: ProviderDriver<AcpxConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "ACPX",
    supportsMultipleInstances: false,
  },
  configSchema: acpxConfigSchema,
  defaultConfig: () => ({ agent: "cursor", enabled: true }),

  probe: async (config: AcpxConfig): Promise<ProviderProbeResult> => {
    // Check that the underlying CLI binary is installed (e.g. cursor, claude, gemini)
    const binaryName = config.agent === "cursor" ? "agent" : config.agent;
    const binary = resolveBinary(binaryName);
    if (!binary) {
      return {
        available: false,
        reason: `CLI binary '${binaryName}' for acpx agent '${config.agent}' not found on PATH`,
      };
    }
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
    input: ProviderDriverCreateInput<AcpxConfig>,
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

    // Discover models — reuse the session for the adapter (no throwaway)
    let discoveredModelIds: string[] = [];
    let initialHandle: AcpRuntimeHandle | undefined;
    try {
      initialHandle = await runtime.ensureSession({
        sessionKey: `pi-${config.agent}-default`,
        agent: config.agent,
        mode: "persistent",
        cwd,
      });
      const status = await runtime.getStatus({ handle: initialHandle });
      discoveredModelIds = status.models?.availableModelIds || [];
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
      skipInitialRefresh: true,
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
    const adapter = createAcpxAdapter(config, cwd, runtime, cwdSlug, initialHandle);

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
