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
import { makeManagedSnapshot, buildInitialSnapshot } from "../shared/managed-refresh.js";
import { loadAcpxRuntime, type AcpxRuntimeModule } from "../acpx-provider/load-runtime.js";
import { modelIdToDisplayName } from "../acpx-provider/runtime-models.js";
import { buildExternalSystemPrompt, createEmptyTranscriptContext } from "../shared/build-system-prompt.js";
import { fileLog } from "../shared/file-logger.js";
import { createLogger } from "../shared/logger.js";
import { resolveAdapterCwd, adapterMemoryKey } from "../shared/session-cwd.js";
import { resolveBinary } from "../shared/resolve-binary.js";

const LOG_DOMAIN = "acpx-driver";
const log = createLogger(LOG_DOMAIN);
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

export function createAcpxAdapter(
  config: AcpxConfig,
  cwd: string,
  runtime: AcpxRuntime,
  initialHandle?: AcpRuntimeHandle,
): ProviderAdapterShape {
  fileLog(LOG_DOMAIN, "debug", LOG_DOMAIN,
    `createAcpxAdapter bootCwdBound=${Boolean(cwd)} agent=${config.agent}`);
  const handles = new Map<string, AcpRuntimeHandle>();
  const prevCumulative = new Map<string, { inputTokens?: number; outputTokens?: number; totalTokens?: number }>();
  // Seed with the discovery handle so the first turn reuses it when cwd matches boot
  if (initialHandle) {
    handles.set(adapterMemoryKey("default", cwd), initialHandle);
  }
  const handleQueues = new Map<string, Promise<void>>();
  const activeTurnControllers = new Map<string, AbortController>();
  const handleEpochs = new Map<string, number>();
  const stoppingKeys = new Set<string>();
  const handleSystemPrompts = new Map<string, string | undefined>();
  let disposed = false;
  const requestedSystemPrompts = new Map<string, string | undefined>();
  const appliedSystemPrompts = new Map<string, string | undefined>();
  if (initialHandle) appliedSystemPrompts.set(adapterMemoryKey("default", cwd), undefined);
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

  async function runExclusive<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (disposed) throw new Error("ACPX adapter disposed");
    signal?.throwIfAborted();
    const queued = handleQueues.has(key);
    const result = (handleQueues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (disposed) throw new Error("ACPX adapter disposed");
      signal?.throwIfAborted();
      return operation();
    });
    const tail = result.then(() => {}, () => {});
    handleQueues.set(key, tail);
    log.debug("queued ACPX operation", { key, queued });
    let rejectAborted!: (reason: unknown) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
    const onAbort = () => rejectAborted(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    void tail.then(() => {
      if (handleQueues.get(key) === tail) handleQueues.delete(key);
    });
    try {
      return await (signal ? Promise.race([result, aborted]) : result);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  function assertCurrent(key: string, epoch: number, signal?: AbortSignal): void {
    if (disposed) throw new Error("ACPX adapter disposed");
    signal?.throwIfAborted();
    if (stoppingKeys.has(key) || (handleEpochs.get(key) ?? 0) !== epoch) {
      throw new Error("ACPX session stopped before queued operation started");
    }
  }

  async function ensureHandle(
    acpxModelId: string | undefined,
    systemPrompt: string | undefined,
    turnCwd: string,
    epoch: number,
    signal?: AbortSignal,
  ): Promise<AcpRuntimeHandle> {
    const key = handleMapKey(acpxModelId, turnCwd);
    const existing = handles.get(key);
    const replacement = Boolean(existing && handleSystemPrompts.get(key) !== systemPrompt);
    log.debug("ensuring ACPX handle", {
      model: acpxModelId || "default", key, replacement, queued: handleQueues.has(key),
    });
    assertCurrent(key, epoch, signal);
    if (existing && !replacement) return existing;
    if (existing) {
      await runtime.close({ handle: existing, reason: "system prompt changed" });
      if (handles.get(key) === existing) {
        handles.delete(key);
        handleSystemPrompts.delete(key);
      }
    }
    assertCurrent(key, epoch, signal);
    const sessionOpts: { model?: string; systemPrompt?: string } = {};
    if (acpxModelId && acpxModelId !== "default") sessionOpts.model = acpxModelId;
    if (systemPrompt) sessionOpts.systemPrompt = systemPrompt;
    const result = await runtime.ensureSession({
      sessionKey: sessionKey(acpxModelId, turnCwd), agent: config.agent, mode: "persistent", cwd: turnCwd,
      ...(Object.keys(sessionOpts).length > 0 ? { sessionOptions: sessionOpts } : {}),
    });
    try {
      assertCurrent(key, epoch, signal);
    } catch (error) {
      await runtime.close({ handle: result, reason: "session invalidated during creation" }).catch(() => {});
      throw error;
    }
    handles.set(key, result);
    handleSystemPrompts.set(key, systemPrompt);
    return result;
  }

  return {
    startSession: async (opts: SessionStartOptions): Promise<SessionHandle> => {
      const model = opts.model || "default";
      const turnCwd = resolveAdapterCwd(opts, cwd);
      log.debug("building start-session system prompt", { model, turnCwd, supplied: Boolean(opts.systemPrompt) });
      const systemPrompt = opts.systemPrompt
        ? opts.systemPrompt
        : buildExternalSystemPrompt(createEmptyTranscriptContext(), turnCwd);
      const key = handleMapKey(model, turnCwd);
      const epoch = handleEpochs.get(key) ?? 0;
      await runExclusive(key, async () => {
        assertCurrent(key, epoch);
        requestedSystemPrompts.set(key, systemPrompt);
        await ensureHandle(model, systemPrompt, turnCwd, epoch);
      });
      const sessionId = sessionKey(model, turnCwd);
      if (!disposed) knownSessionIds.add(sessionId);
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
      const epoch = handleEpochs.get(handleKey) ?? 0;
      return runExclusive(handleKey, async () => {
      assertCurrent(handleKey, epoch, opts?.signal);
      const systemPrompt = requestedSystemPrompts.get(handleKey) ?? buildExternalSystemPrompt(createEmptyTranscriptContext(), turnCwd);
      const promptChanged = appliedSystemPrompts.has(handleKey) && appliedSystemPrompts.get(handleKey) !== systemPrompt;
      log.debug("building turn system prompt", { model: handle.model, turnCwd, promptChanged });
      const acpxHandle = await ensureHandle(handle.model, systemPrompt, turnCwd, epoch, opts?.signal);

      assertCurrent(handleKey, epoch, opts?.signal);
      const abortController = new AbortController();
      const forwardAbort = () => abortController.abort(opts?.signal?.reason);
      opts?.signal?.addEventListener("abort", forwardAbort, { once: true });
      opts?.signal?.throwIfAborted();
      activeTurnControllers.set(handleKey, abortController);
      try {
      assertCurrent(handleKey, epoch, opts?.signal);
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
      if (result.status === "completed") appliedSystemPrompts.set(handleKey, systemPrompt);
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
            const key = handleMapKey(handle.model, turnCwd);
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
      } finally {
        opts?.signal?.removeEventListener("abort", forwardAbort);
        if (activeTurnControllers.get(handleKey) === abortController) activeTurnControllers.delete(handleKey);
      }
      }, opts?.signal);
    },

    stopSession: async (handle: SessionHandle): Promise<void> => {
      const turnCwd = resolveAdapterCwd(handle, cwd);
      const key = handleMapKey(handle.model, turnCwd);
      log.debug("stopping ACPX session", { model: handle.model, key, queued: handleQueues.has(key) });
      handleEpochs.set(key, (handleEpochs.get(key) ?? 0) + 1);
      stoppingKeys.add(key);
      activeTurnControllers.get(key)?.abort();
      await runExclusive(key, async () => {
      const acpxHandle = handles.get(key);
      if (acpxHandle) {
        await runtime.close({ handle: acpxHandle, reason: "session stop" }).catch((err: unknown) => {
          log.error("ACPX session close failed", {
            model: handle.model, key, error: err instanceof Error ? err.message : String(err),
          });
        });
        if (handles.get(key) === acpxHandle) {
          handles.delete(key);
          handleSystemPrompts.delete(key);
        }
      }
      requestedSystemPrompts.delete(key);
      appliedSystemPrompts.delete(key);
      prevCumulative.delete(key);
      knownSessionIds.delete(sessionKey(handle.model, turnCwd));
      }).finally(() => stoppingKeys.delete(key));
    },

    stopAll: async (): Promise<void> => {
      log.info("stopping all ACPX sessions", { handles: handles.size, queues: handleQueues.size });
      disposed = true;
      const knownKeys = new Set([...handles.keys(), ...handleQueues.keys(), ...handleEpochs.keys(), ...requestedSystemPrompts.keys()]);
      for (const key of knownKeys) handleEpochs.set(key, (handleEpochs.get(key) ?? 0) + 1);
      for (const controller of activeTurnControllers.values()) controller.abort();
      await Promise.allSettled(handleQueues.values());
      const closePromises: Promise<void>[] = [];
      for (const [key, acpxHandle] of handles) {
        closePromises.push(
          runtime.close({ handle: acpxHandle, reason: "stop all" }).catch((err: unknown) => {
            log.error("ACPX stop-all close failed", {
              model: key.split("\x1f", 1)[0], key, error: err instanceof Error ? err.message : String(err),
            });
          }),
        );
      }
      await Promise.allSettled(closePromises);
      handles.clear();
      handleSystemPrompts.clear();
      handleQueues.clear();
      activeTurnControllers.clear();
      stoppingKeys.clear();
      requestedSystemPrompts.clear();
      appliedSystemPrompts.clear();
      prevCumulative.clear();
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

export const AcpxDriver: ProviderDriver<AcpxConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "ACPX",
    supportsMultipleInstances: true,
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
    const adapter = createAcpxAdapter(config, cwd, runtime, initialHandle);

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
