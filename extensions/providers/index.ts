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
  Context,
  Model,
  SimpleStreamOptions,
  StreamOptions,
} from "@earendil-works/pi-ai";
import { createLogger } from "../shared/logger.js";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { asStringArray, getSetting } from "../orchestrator/project-settings.js";
import { buildExternalSystemPrompt } from "../shared/build-system-prompt.js";
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
import type { ProviderInstance, DiscoveredModel } from "../shared/provider-driver.js";
import { BUILT_IN_DRIVERS, CLI_AGENT_TO_DRIVER, ACPX_AGENT_TO_DRIVER } from "./built-in-drivers.js";
import { mapCliDiscoveredModels } from "../cli-provider/runtime-models.js";
import { mapAcpxDiscoveredModels } from "../acpx-provider/runtime-models.js";
import {
  startCliSessionReaper,
} from "../cli-provider/session-reaper.js";
import {
  readPiSessionIdFromManager,
} from "../cli-provider/sessions.js";
import { fileLog } from "../shared/file-logger.js";
import {
  enterSessionCwd,
  resolveProviderStreamCwd,
} from "../shared/session-cwd.js";
import { isCliAgentName } from "../cli-provider/providers.js";
import {
  isProvidersInitialized,
  markProvidersInitialized,
} from "./initialized-guard.js";
import { restoreDefaultModelOnSessionStart } from "./restore-default-model.js";
import { teardownProvidersOnSessionShutdown } from "./session-shutdown.js";

const LOG_DOMAIN = "providers";
const DISCOVERY_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const registry = new ProviderDriverRegistry();

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
    render: (_width: number): string[] => [theme.fg("muted", summary)],
    invalidate: (): void => {},
  };
}

// ---------------------------------------------------------------------------
// Configured Gates
// ---------------------------------------------------------------------------

function isCliInstanceConfigured(agent: string): boolean {
  return cliInstances.has(agent);
}

function isAcpxInstanceConfigured(agent: string): boolean {
  return acpxInstances.has(agent);
}

// ---------------------------------------------------------------------------
// Context Helpers
// ---------------------------------------------------------------------------

function messageText(msg: { role: string; content: unknown }): string {
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

function extractLatestUserMessage(context: Context): string {
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
  return function streamProvider(
    model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions | StreamOptions,
  ): AssistantMessageEventStream {
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

async function registerCliAgent(
  pi: ExtensionAPI,
  agent: string,
  instance: ProviderInstance,
  catalog: ModelsDevCatalog | null,
): Promise<void> {
  const providerId = `cli-${agent}`;
  const snapshot = instance.snapshot.getSnapshot();
  const discovered = snapshot.models;

  const models = mapCliDiscoveredModels(agent, discovered, catalog);
  const streamFn = makeStreamFunction("cli", agent, () => cliInstances.get(agent));

  const provider = await createRuntimeProvider({
    id: providerId,
    name: `CLI ${agent}`,
    auth: {
      apiKey: buildAmbientLoginAuth({
        displayName: `CLI ${agent}`,
        isConfigured: () => isCliInstanceConfigured(agent),
        sourceLabel: `${agent} CLI on PATH`,
      }),
    },
    models,
    fetchModels: async () => {
      if (!isCliInstanceConfigured(agent)) return [];
      const inst = cliInstances.get(agent);
      if (!inst) return [];
      const snap = await inst.snapshot.refresh();
      const fresh = await loadModelsDevCatalog();
      return mapCliDiscoveredModels(agent, snap.models, fresh);
    },
    filterModels: (catalog, credential) =>
      filterModelsWhenConfigured(catalog, credential, () =>
        isCliInstanceConfigured(agent),
      ),
    api: { stream: streamFn, streamSimple: streamFn },
  });
  pi.registerProvider(provider);
  fileLog(LOG_DOMAIN, "info", LOG_DOMAIN,
    `cli-${agent}: ${models.length} model(s) registered`);
}

async function registerAcpxAgent(
  pi: ExtensionAPI,
  agent: string,
  instance: ProviderInstance,
  catalog: ModelsDevCatalog | null,
): Promise<void> {
  const providerId = `acpx-${agent}`;
  const snapshot = instance.snapshot.getSnapshot();
  const modelIds = snapshot.models.map((m) => m.id);

  const models = mapAcpxDiscoveredModels(agent, modelIds, catalog);
  const streamFn = makeStreamFunction("acpx", agent, () => acpxInstances.get(agent));

  const provider = await createRuntimeProvider({
    id: providerId,
    name: `ACPX ${agent}`,
    auth: {
      apiKey: buildAmbientLoginAuth({
        displayName: `ACPX ${agent}`,
        isConfigured: () => isAcpxInstanceConfigured(agent),
        sourceLabel: `${agent} acpx runtime`,
      }),
    },
    models,
    fetchModels: async () => {
      const inst = acpxInstances.get(agent);
      if (!inst) return [];
      const snap = await inst.snapshot.refresh();
      const fresh = await loadModelsDevCatalog();
      return mapAcpxDiscoveredModels(agent, snap.models.map((m) => m.id), fresh);
    },
    filterModels: (catalog, credential) =>
      filterModelsWhenConfigured(catalog, credential, () =>
        isAcpxInstanceConfigured(agent),
      ),
    api: { stream: streamFn, streamSimple: streamFn },
  });
  pi.registerProvider(provider);
  fileLog(LOG_DOMAIN, "info", LOG_DOMAIN,
    `acpx-${agent}: ${models.length} model(s) registered`);
}

// ---------------------------------------------------------------------------
// Extension Entry Point
// ---------------------------------------------------------------------------

const log = createLogger("providers");
log.debug("providers module loaded");

const cwdHookBound = new WeakSet<object>();

export default async function (pi: ExtensionAPI) {
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
  log.debug(
    "providers factory: proceeding after reset / first load — re-entering discovery",
  );

  const versionCheck = checkMinPiVersion();
  if (!versionCheck.ok && versionCheck.installed !== null) {
    fileLog(LOG_DOMAIN, "error", LOG_DOMAIN,
      `pi ${versionCheck.installed} below minimum ${versionCheck.required}; skipping`);
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
  const modelsDevCatalog =
    cliAgentList.length > 0 || acpxAgentList.length > 0
      ? await loadModelsDevCatalog()
      : null;
  if (modelsDevCatalog) {
    log.info("models.dev catalog loaded for cli/acpx model fill");
  }

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
  async function discoverAndRegisterCli(): Promise<void> {
    if (cliAgentList.length === 0) return;

    const cliResults = await Promise.allSettled(
      cliAgentList.map(async (agent) => {
        const driverKind = Object.hasOwn(CLI_AGENT_TO_DRIVER, agent) ? CLI_AGENT_TO_DRIVER[agent] : undefined;
        if (typeof driverKind !== "string" || driverKind.length === 0) {
          fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
            `cli-${agent}: no driver registered`);
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
              `cli-${agent}`,
              { driver: driverKind, enabled: true },
              projectCwd,
            );
            if (timedOut) return { agent, instance };
            cliInstances.set(agent, instance);
            return { agent, instance };
          } catch (err) {
            fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
              `cli-${agent}: driver create failed: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          }
        })();

        // Clean up leaked instance if discovery completed after timeout
        discovery.then((result) => {
          if (timedOut && result) {
            registry.teardownInstance(`cli-${agent}`).catch(() => {});
          }
        }).catch(() => {});

        try {
          const result = await Promise.race([discovery, timeout]);
          clearTimeout(timer!);
          return result;
        } catch (err) {
          clearTimeout(timer!);
          fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
            `cli-${agent}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      }),
    );

    for (const result of cliResults) {
      if (result.status !== "fulfilled" || !result.value) continue;
      const { agent, instance } = result.value;
      try {
        await registerCliAgent(pi, agent, instance, modelsDevCatalog);
      } catch (err) {
        fileLog(LOG_DOMAIN, "error", LOG_DOMAIN,
          `cli-${agent}: registration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async function discoverAndRegisterAcpx(): Promise<void> {
    if (isSubagent) return;
    const acpxAgentList = asStringArray(getSetting(projectCwd, "acpx_agents"));
    if (acpxAgentList.length === 0) return;

    const acpxResults = await Promise.allSettled(
      acpxAgentList.map(async (agent) => {
        const driverKind = Object.hasOwn(ACPX_AGENT_TO_DRIVER, agent) ? ACPX_AGENT_TO_DRIVER[agent] : undefined;
        if (typeof driverKind !== "string" || driverKind.length === 0) {
          fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
            `acpx-${agent}: no driver mapping in ACPX_AGENT_TO_DRIVER`);
          return null;
        }
        // Only proceed if the driver is registered
        if (!registry.getDriver(driverKind)) {
          fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
            `acpx-${agent}: no driver '${driverKind}' registered`);
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
              `acpx-${agent}`,
              { driver: driverKind, config: { agent }, enabled: true },
              projectCwd,
            );
            if (timedOut) {
              fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
                `acpx-${agent}: completed after timeout — cleaning up`);
              return { agent, instance };
            }
            acpxInstances.set(agent, instance);
            return { agent, instance };
          } catch (err) {
            fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
              `acpx-${agent}: driver create failed: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          }
        })();

        // Clean up leaked instance if discovery completed after timeout
        discovery.then((result) => {
          if (timedOut && result) {
            registry.teardownInstance(`acpx-${agent}`).catch(() => {});
          }
        }).catch(() => {});

        try {
          const result = await Promise.race([discovery, timeout]);
          clearTimeout(timer!);
          return result;
        } catch (err) {
          clearTimeout(timer!);
          fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
            `acpx-${agent}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      }),
    );

    for (const result of acpxResults) {
      if (result.status !== "fulfilled" || !result.value) continue;
      const { agent, instance } = result.value;
      try {
        await registerAcpxAgent(pi, agent, instance, modelsDevCatalog);
      } catch (err) {
        fileLog(LOG_DOMAIN, "error", LOG_DOMAIN,
          `acpx-${agent}: registration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Run CLI and ACPX discovery concurrently
  await Promise.all([discoverAndRegisterCli(), discoverAndRegisterAcpx()]);

  // Show discovery summary on session start; restore saved default model when
  // findInitialModel raced hasConfiguredAuth false → wrong initial model (#753).
  const providerSummaryParts: string[] = [];
  for (const [agent, inst] of cliInstances) {
    const count = inst.snapshot.getSnapshot().models.length;
    providerSummaryParts.push(`cli-${agent} (${count})`);
  }
  for (const [agent, inst] of acpxInstances) {
    const count = inst.snapshot.getSnapshot().models.length;
    providerSummaryParts.push(`acpx-${agent} (${count})`);
  }

  // Fire-and-forget restore so session_start is not blocked by retries (#753).
  // Omit registeredProviders: cli/acpx-only lists falsely fail-fast native defaults.
  const applyCliAcpxThinking = (model: { id: string; provider: string } | undefined) => {
    log.debug("applyCliAcpxThinking", model?.provider, model?.id);
    try {
      applyThinkingLevelFromModel(
        model,
        (level) => pi.setThinkingLevel(level as ThinkingLevel),
        () => pi.getThinkingLevel(),
      );
    } catch (err) {
      log.warn(
        "thinking from id failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  };

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
    // agentDir via PI_CODING_AGENT_DIR / ~/.pi/agent only (ctx has cwd, not agentDir).
    // Merge global + cwd/.pi/settings.json (project wins) only when trusted —
    // same gate as pi SettingsManager (ctx.isProjectTrusted). Fail closed.
    const cwd = typeof ctx.cwd === "string" ? ctx.cwd : undefined;
    let projectTrusted = false;
    try {
      projectTrusted = typeof ctx.isProjectTrusted === "function"
        ? ctx.isProjectTrusted() === true
        : false;
    } catch (err) {
      log.debug(
        "restore-default-model isProjectTrusted failed",
        err instanceof Error ? err.message : String(err),
      );
      projectTrusted = false;
    }
    void restoreDefaultModelOnSessionStart({
      ctx: {
        model: ctx.model
          ? { id: ctx.model.id, provider: String(ctx.model.provider) }
          : undefined,
        modelRegistry: ctx.modelRegistry,
      },
      reason,
      cwd,
      projectTrusted,
      getCurrentModel: () =>
        ctx.model
          ? { id: ctx.model.id, provider: String(ctx.model.provider) }
          : undefined,
      setModel: (model) => pi.setModel(model as Model<any>),
    }).catch((err) => {
      log.warn(
        "restore-default-model session_start error",
        err instanceof Error ? err.message : String(err),
      );
    });
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
