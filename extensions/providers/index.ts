/**
 * Unified Provider Extension for pi
 *
 * Single extension that replaces both cli-provider/index.ts and
 * acpx-provider/index.ts. Uses the driver-based architecture inspired
 * by t3code's ProviderDriver SPI.
 *
 * Registers via createProvider() (pi >= 0.81): /login, fetchModels,
 * filterModels, and native ProviderStreams.
 *
 * How it works:
 * 1. Read cli_agents and acpx_agents from settings
 * 2. For each agent, find the matching driver from BUILT_IN_DRIVERS
 * 3. Use ProviderDriverRegistry to probe + create instances
 * 4. Register each instance as a pi provider via createRuntimeProvider
 * 5. Unified session_start/shutdown/before_agent_start handlers
 *
 * Loaded from: extensions/providers/
 */

import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  TranscriptContext,
  SimpleStreamOptions,
  StreamOptions,
} from "@earendil-works/pi-ai";
import { createLogger } from "../shared/logger.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { asStringArray, getSetting } from "../orchestrator/project-settings.js";
import { buildExternalSystemPrompt, messageText } from "../shared/build-system-prompt.js";
import {
  checkMinPiVersion,
  isPiMetaInvocation,
} from "../orchestrator/utils.js";
import {
  buildAmbientLoginAuth,
  createRuntimeProvider,
  filterModelsWhenConfigured,
} from "../shared/create-runtime-provider.js";
import {
  applyThinkingLevelFromModel,
  loadModelsDevCatalog,
  type ModelsDevCatalog,
} from "../shared/models-dev.js";
import { StreamAssembler, createAssistantMessageOutput } from "../shared/stream-builder.js";
import { ProviderDriverRegistry } from "../shared/provider-registry.js";
import type { DiscoveredModel, ProviderInstance } from "../shared/provider-driver.js";
import { BUILT_IN_DRIVERS, CLI_AGENT_TO_DRIVER, ACPX_AGENT_TO_DRIVER } from "./built-in-drivers.js";
import { mapCliDiscoveredModels } from "../cli-provider/runtime-models.js";
import { mapAcpxDiscoveredModels } from "../acpx-provider/runtime-models.js";
import {
  startCliSessionReaper,
} from "../cli-provider/session-reaper.js";
import {
  readPiSessionIdFromManager,
} from "../cli-provider/sessions.js";
import {
  enterSessionCwd,
  resolveProviderStreamCwd,
} from "../shared/session-cwd.js";
import { isCliAgentName } from "../cli-provider/providers.js";
import {
  isProvidersInitialized,
  markProvidersInitialized,
} from "./initialized-guard.js";
import { registerModelRestoreOnSessionStart } from "./model-restore-wiring.js";
import { registerLastThinkingLevel } from "./last-thinking-level.js";
import { teardownProvidersOnSessionShutdown } from "./session-shutdown.js";

const LOG_DOMAIN = "providers";
const log = createLogger(LOG_DOMAIN);
log.debug("providers module loaded");
const DISCOVERY_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const registry = new ProviderDriverRegistry();

let createAssistantMessageEventStream: () => AssistantMessageEventStream;

/** Track which instances are CLI vs ACPX for configured gates. */
const cliInstances = new Map<string, ProviderInstance>();
const acpxInstances = new Map<string, ProviderInstance>();

let projectCwd = "";

interface ProviderDiscoverySummary {
  summary: string;
}

/** Render durable discovery entries without adding a TUI package dependency. */
function providerDiscoverySummaryComponent(
  summary: string,
  theme: { fg: (color: "muted", text: string) => string },
) {
  log.debug("rendering CLI/ACPX discovery summary", { summary });
  return {
    render: (_width: number): string[] => {
      log.debug("rendered CLI/ACPX discovery summary");
      return [theme.fg("muted", summary)];
    },
    invalidate: (): void => {
      log.debug("invalidated CLI/ACPX discovery summary");
    },
  };
}

// ---------------------------------------------------------------------------
// Context Helpers
// ---------------------------------------------------------------------------

function extractLatestUserMessage(context: TranscriptContext): string {
  log.debug("extracting latest user message", { messageCount: context.messages.length });
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i];
    if (msg.role === "user") {
      const text = messageText(msg);
      if (text) return text;
    }
  }
  return "hello";
}

// ---------------------------------------------------------------------------
// Stream Factory
// ---------------------------------------------------------------------------

function makeStreamFunction(
  kind: "cli" | "acpx",
  agent: string,
  getInstance: () => ProviderInstance | undefined,
) {
  log.debug("creating provider stream function", { kind, agent });
  return function streamProvider(
    model: Model<any>,
    context: TranscriptContext,
    options?: SimpleStreamOptions | StreamOptions,
  ): AssistantMessageEventStream {
    log.debug("starting provider stream", { kind, agent, modelId: model.id, messageCount: context.messages.length });
    const stream = createAssistantMessageEventStream();
    const output = createAssistantMessageOutput(model);
    const assembler = new StreamAssembler(output, stream);

    (async () => {
      try {
        stream.push({ type: "start", partial: output });

        const instance = getInstance();
        if (!instance) {
          throw new Error(`${kind}-${agent}: driver instance not available`);
        }

        // Parse model from pi model id: "agent:modelId"
        const colonIdx = model.id.indexOf(":");
        const driverModelId = colonIdx >= 0 ? model.id.substring(colonIdx + 1) : "default";

        const turnCwd = resolveProviderStreamCwd(projectCwd);
        log.debug(
          `${kind}-${agent} stream cwd=${turnCwd} boot=${projectCwd} model=${driverModelId}`,
        );

        // Build system prompt
        const systemPrompt = buildExternalSystemPrompt(context, turnCwd);

        // Ensure session
        const handle = await instance.adapter.startSession({
          model: driverModelId,
          systemPrompt,
          cwd: turnCwd,
        });

        // Extract latest user message
        const prompt = extractLatestUserMessage(context);

        // Send turn with event bridging
        const result = await instance.adapter.sendTurn(handle, prompt, {
          signal: options?.signal,
          context: { messages: context.messages },
          onEvent: (event) => assembler.handleEvent(event),
        });

        assembler.finalize({
          finalText: result.text,
          finalThinking: result.thinking,
          stopReason: result.stopReason,
          usage: result.usage,
        });
      } catch (error) {
        assembler.emitError(error, options?.signal?.aborted);
      }
    })();

    return stream;
  };
}

// ---------------------------------------------------------------------------
// Registration Helpers
// ---------------------------------------------------------------------------

async function registerDriverAgent(opts: {
  pi: ExtensionAPI;
  kind: "cli" | "acpx";
  agent: string;
  instance: ProviderInstance;
  instances: Map<string, ProviderInstance>;
  catalog: ModelsDevCatalog | null;
  mapModels: (agent: string, discovered: readonly DiscoveredModel[], catalog: ModelsDevCatalog | null) => ReturnType<typeof mapCliDiscoveredModels>;
}): Promise<void> {
  const { pi, kind, agent, instance, instances, catalog, mapModels } = opts;
  const providerId = `${kind}-${agent}`;
  const displayName = `${kind === "cli" ? "CLI" : "ACPX"} ${agent}`;
  const sourceLabel = kind === "cli" ? `${agent} CLI on PATH` : `${agent} acpx runtime`;
  const snapshot = instance.snapshot.getSnapshot();
  const models = mapModels(agent, snapshot.models, catalog);
  const streamFn = makeStreamFunction(kind, agent, () => instances.get(agent));
  const isConfigured = () => instances.has(agent);

  const provider = await createRuntimeProvider({
    id: providerId,
    name: displayName,
    auth: {
      apiKey: buildAmbientLoginAuth({
        displayName,
        isConfigured,
        sourceLabel,
      }),
    },
    models,
    fetchModels: async () => {
      if (!isConfigured()) return [];
      const inst = instances.get(agent);
      if (!inst) return [];
      const snap = await inst.snapshot.refresh();
      const fresh = await loadModelsDevCatalog();
      return mapModels(agent, snap.models, fresh);
    },
    filterModels: (cat, credential) =>
      filterModelsWhenConfigured(cat, credential, isConfigured),
    api: { stream: streamFn, streamSimple: streamFn },
  });
  pi.registerProvider(provider);
  log.info(`${providerId}: ${models.length} model(s) registered`);
}

// ---------------------------------------------------------------------------
// Extension Entry Point
// ---------------------------------------------------------------------------

const cwdHookBound = new WeakSet<object>();

export default async function (
  pi: ExtensionAPI,
  testOptions?: {
    providerSummaryParts?: readonly string[];
    thinkingStatePath?: string;
    argv?: string[];
  },
) {
  if (typeof pi.registerEntryRenderer === "function") {
    pi.registerEntryRenderer<ProviderDiscoverySummary>(
      "provider-discovery-summary",
      (entry, _options, theme) => providerDiscoverySummaryComponent(entry.data?.summary ?? "", theme),
    );
  }

  // pi --help / --version — skip discovery
  if (isPiMetaInvocation()) return;

  // Always bind this AgentSession's cwd, even when the factory early-returns.
  // Sidecar user sessions load this extension after the internal registrar
  // already marked initialized — without this hook they never stash cwd (#768).
  if (!cwdHookBound.has(pi)) {
    cwdHookBound.add(pi);
    pi.on("before_agent_start", (_event, ctx) => {
      enterSessionCwd(typeof ctx.cwd === "string" ? ctx.cwd : "");
    });
  }

  // Idempotency guard — shims re-export this default, so it may be called
  // multiple times (cli-provider shim, acpx-provider shim, providers dir).
  // Only run once per session; session_shutdown resets so /new|/resume|/fork
  // re-registers providers on the next factory invocation.
  if (isProvidersInitialized()) {
    log.debug(
      "providers factory early-return: already initialized (same-session double-load)",
    );
    return;
  }
  markProvidersInitialized();
  if (!testOptions?.providerSummaryParts) {
    ({ createAssistantMessageEventStream } = await import("@earendil-works/pi-ai"));
  }
  log.debug(
    "providers factory: proceeding after reset / first load — re-entering discovery",
  );

  const versionCheck = checkMinPiVersion();
  if (!versionCheck.ok && versionCheck.installed !== null) {
    log.error(`pi ${versionCheck.installed} below minimum ${versionCheck.required}; skipping`);
    return;
  }

  projectCwd = process.cwd();
  const isSubagent = process.env.PI_SUBAGENT_CHILD === "1";

  // Register all built-in drivers with the registry
  for (const driver of BUILT_IN_DRIVERS) {
    registry.registerDriver(driver);
  }

  // ---------------------------------------------------------------------------
  // CLI agents (load in subagent children too)
  // ---------------------------------------------------------------------------
  const cliAgentList = asStringArray(getSetting(projectCwd, "cli_agents")).filter(isCliAgentName);
  const acpxAgentList = asStringArray(getSetting(projectCwd, "acpx_agents"));
  const modelsDevCatalogPromise: Promise<ModelsDevCatalog | null> =
    cliAgentList.length > 0 || acpxAgentList.length > 0
      ? loadModelsDevCatalog().then((catalog) => {
          if (catalog) {
            log.info("models.dev catalog loaded for cli/acpx model fill");
          }
          return catalog;
        })
      : Promise.resolve(null);

  if (cliAgentList.length > 0) {
    startCliSessionReaper({
      cwd: projectCwd,
      getActivePiSessionId: () => null, // Managed by driver adapters
    });

    // Bind pi session on before_agent_start (same as old cli-provider)
    pi.on("before_agent_start", (_event, ctx) => {
      const { readPiSessionId: sid } = readPiSessionIdFromManager(ctx.sessionManager);
      if (sid) {
        for (const inst of cliInstances.values()) {
          const adapter = inst.adapter as any;
          if (typeof adapter.bindPiSessionId === "function") {
            adapter.bindPiSessionId(sid);
          }
        }
      }
    });

    // Session lifecycle (same as old cli-provider)
    pi.on("session_start", (event, ctx) => {
      const reason = typeof (event as any)?.reason === "string"
        ? (event as any).reason : "";
      const { readPiSessionId: sid } = readPiSessionIdFromManager(ctx.sessionManager);

      for (const inst of cliInstances.values()) {
        const adapter = inst.adapter as any;
        if (typeof adapter.handleSessionStart === "function") {
          adapter.handleSessionStart(reason, sid, ctx.cwd);
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Discovery — CLI and ACPX in parallel (on main these were separate
  // extensions loaded concurrently by pi; keep the same parallelism)
  // ---------------------------------------------------------------------------
  async function discoverAndRegisterAgents(opts: {
    kind: "cli" | "acpx";
    agentList: string[];
    agentToDriver: Record<string, string>;
    instances: Map<string, ProviderInstance>;
    includeConfig?: boolean;
    mapModels: (agent: string, discovered: readonly DiscoveredModel[], catalog: ModelsDevCatalog | null) => ReturnType<typeof mapCliDiscoveredModels>;
  }): Promise<void> {
    const { kind, agentList, agentToDriver, instances, includeConfig, mapModels } = opts;
    if (agentList.length === 0) return;

    const results = await Promise.allSettled(
      agentList.map(async (agent) => {
        const providerId = `${kind}-${agent}`;
        const driverKind = Object.hasOwn(agentToDriver, agent) ? agentToDriver[agent] : undefined;
        if (typeof driverKind !== "string" || driverKind.length === 0) {
          log.warn(`${providerId}: no driver registered`);
          return null;
        }
        if (!registry.getDriver(driverKind)) {
          log.warn(`${providerId}: no driver '${driverKind}' registered`);
          return null;
        }

        let timer: ReturnType<typeof setTimeout>;
        let timedOut = false;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`timed out after ${DISCOVERY_TIMEOUT_MS / 1000}s`));
          }, DISCOVERY_TIMEOUT_MS);
          if (timer.unref) timer.unref();
        });

        const discovery = (async () => {
          try {
            const instance = await registry.createInstance(
              providerId,
              includeConfig
                ? { driver: driverKind, config: { agent }, enabled: true }
                : { driver: driverKind, enabled: true },
              projectCwd,
            );
            if (timedOut) {
              log.warn(`${providerId}: completed after timeout — cleaning up`);
              return { agent, instance };
            }
            instances.set(agent, instance);
            return { agent, instance };
          } catch (err) {
            log.warn(`${providerId}: driver create failed: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          }
        })();

        // Clean up leaked instance if discovery completed after timeout
        discovery.then((result) => {
          if (timedOut && result) {
            registry.teardownInstance(providerId).catch(() => {});
          }
        }).catch(() => {});

        try {
          const result = await Promise.race([discovery, timeout]);
          clearTimeout(timer!);
          return result;
        } catch (err) {
          clearTimeout(timer!);
          log.warn(`${providerId}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      }),
    );

    const modelsDevCatalog = await modelsDevCatalogPromise;
    for (const result of results) {
      if (result.status !== "fulfilled" || !result.value) continue;
      const { agent, instance } = result.value;
      try {
        await registerDriverAgent({
          pi,
          kind,
          agent,
          instance,
          instances,
          catalog: modelsDevCatalog,
          mapModels,
        });
      } catch (err) {
        log.error(`${kind}-${agent}: registration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Run CLI and ACPX discovery concurrently
  await Promise.all([
    discoverAndRegisterAgents({
      kind: "cli",
      agentList: cliAgentList,
      agentToDriver: CLI_AGENT_TO_DRIVER,
      instances: cliInstances,
      mapModels: (agent, discovered, catalog) => mapCliDiscoveredModels(agent, discovered, catalog),
    }),
    isSubagent
      ? Promise.resolve()
      : discoverAndRegisterAgents({
          kind: "acpx",
          agentList: acpxAgentList,
          agentToDriver: ACPX_AGENT_TO_DRIVER,
          instances: acpxInstances,
          includeConfig: true,
          mapModels: (agent, discovered, catalog) =>
            mapAcpxDiscoveredModels(agent, discovered.map((m) => m.id), catalog),
        }),
  ]);

  // Show discovery summary on session start; restore saved default model when
  // findInitialModel raced hasConfiguredAuth false → wrong initial model (#753).
  const providerSummaryParts = testOptions?.providerSummaryParts
    ? [...testOptions.providerSummaryParts]
    : (() => {
      const parts: string[] = [];
      for (const [agent, inst] of cliInstances) {
        const count = inst.snapshot.getSnapshot().models.length;
        parts.push(`cli-${agent} (${count})`);
      }
      for (const [agent, inst] of acpxInstances) {
        const count = inst.snapshot.getSnapshot().models.length;
        parts.push(`acpx-${agent} (${count})`);
      }
      log.debug("built CLI/ACPX provider discovery summary", {
        providerCount: parts.length,
      });
      return parts;
    })();

  // Fire-and-forget restore so session_start is not blocked by retries (#753).
  // Omit registeredProviders: cli/acpx-only lists falsely fail-fast native defaults.
  const lastThinking = registerLastThinkingLevel(pi, {
    statePath: testOptions?.thinkingStatePath,
    argv: testOptions?.argv,
  });
  const applyCliAcpxThinking = (model: { id: string; provider: string } | undefined) => {
    log.debug("applyCliAcpxThinking", model?.provider, model?.id);
    try {
      applyThinkingLevelFromModel(
        model,
        level => lastThinking.setInternalThinkingLevel(level as ThinkingLevel),
        () => pi.getThinkingLevel(),
      );
    } catch (err) {
      log.warn(
        "thinking from id failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  // Cold-start default model restore (#753), wired as its own session_start
  // handler (multiple registrations are fine) so the wiring is unit-testable.
  // Registered before the discovery-summary handler; the restore itself is
  // fire-and-forget so ordering with the summary/thinking handler is benign.
  registerModelRestoreOnSessionStart(pi, {
    argv: testOptions?.argv,
    onRestoreModel: (model, setSelected) => {
      log.debug("onRestoreModel handoff", { provider: model.provider, id: model.id });
      return lastThinking.restoreModel(model as Model<any>, setSelected);
    },
    onRestoreSettled: (event, ctx, modelRestore) => {
      log.debug("onRestoreSettled handoff", { reason: (event as { reason?: string })?.reason });
      return void lastThinking.applyAfterModelRestore(event, ctx, modelRestore);
    },
  });

  pi.on("session_start", (event, ctx) => {
    const reason = typeof event?.reason === "string" ? event.reason : "";
    const summary = `Providers: ${providerSummaryParts.join(", ")}`;
    // Entries survive reload/resume. Only append for a newly started session;
    // its persisted entry renders on later lifecycle events without duplication.
    if (providerSummaryParts.length > 0 && (reason === "startup" || reason === "new")) {
      try {
        pi.appendEntry<ProviderDiscoverySummary>("provider-discovery-summary", { summary });
        log.info("persisted CLI/ACPX discovery summary", { reason, summary });
      } catch (err) {
        log.warn("provider discovery summary append failed", err instanceof Error ? err.name : typeof err);
      }
    } else if (providerSummaryParts.length > 0) {
      log.debug("provider discovery summary retained", { reason: reason || "unknown" });
    }
    applyCliAcpxThinking(
      ctx.model
        ? { id: ctx.model.id, provider: String(ctx.model.provider) }
        : undefined,
    );
  });

  pi.on("model_select", (event) => {
    applyCliAcpxThinking({
      id: event.model.id,
      provider: String(event.model.provider),
    });
  });

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------
  pi.on("session_shutdown", async () => {
    await teardownProvidersOnSessionShutdown(
      registry,
      cliInstances,
      acpxInstances,
    );
  });
}
