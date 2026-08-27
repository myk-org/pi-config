import type { AuthResult, Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRuntimeProvider } from "../shared/create-runtime-provider.js";
import { createLogger } from "../shared/logger.js";
import {
  OpenAiCompatibleDiscoveryCache,
  buildOpenAiCompatibleModelsRequest,
  findEligibleOpenAiCompatibleProviderConfigsResult,
  formatOpenAiCompatibleDiscoverySummary,
  materializeOpenAiCompatibleModels,
  openAiCompatibleConnectionFingerprint,
  redactOpenAiCompatibleDiagnostic,
  resolveStaticOpenAiCompatibleHeaders,
  type OpenAiCompatibleModelRecord,
  type ResolvedOpenAiCompatibleConnection,
} from "../shared/openai-compatible-discovery.js";

const log = createLogger("openai-compatible-discovery");
const REQUEST_TIMEOUT_MS = 20_000;

function responseRecords(payload: unknown): OpenAiCompatibleModelRecord[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data))
    throw new Error("OpenAI-compatible /v1/models response must contain a data array");
  return (payload as { data: unknown[] }).data.flatMap((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return [];
    const model = record as OpenAiCompatibleModelRecord;
    return typeof model.id === "string" ? [model] : [];
  });
}

function resolvedConnection(source: Provider, auth?: AuthResult, staticHeaders?: Record<string, string>): ResolvedOpenAiCompatibleConnection {
  return {
    baseUrl: auth?.auth.baseUrl ?? source.baseUrl,
    apiKey: auth?.auth.apiKey,
    headers: { ...(source.headers ?? {}), ...(staticHeaders ?? {}), ...(auth?.auth.headers ?? {}) },
  };
}

function combineModels(sourceProviderId: string, staticModels: readonly Model[], records: readonly OpenAiCompatibleModelRecord[], baseUrl: string): Model[] {
  const existingIds = new Set(staticModels.map((model) => model.id));
  const discovered = materializeOpenAiCompatibleModels(records, baseUrl, sourceProviderId)
    .filter((model) => !existingIds.has(model.id));
  return [...staticModels, ...discovered];
}

async function discoverProvider(
  pi: ExtensionAPI,
  ctx: any,
  sourceProviderId: string,
  rawStaticHeaders: Record<string, string> | undefined,
  cache: OpenAiCompatibleDiscoveryCache<OpenAiCompatibleModelRecord>,
  signal: AbortSignal,
  isCurrent: () => boolean,
  registeredSources: Set<string>,
): Promise<void> {
  if (!isCurrent()) return;
  const source = ctx.modelRegistry.getProvider(sourceProviderId) as Provider | undefined;
  if (!source) {
    log.warn(`${sourceProviderId}: configured provider was not resolved`);
    return;
  }
  let auth: AuthResult | undefined;
  let staticHeaders: Record<string, string> | undefined;
  try {
    auth = await ctx.modelRegistry.getProviderAuth(sourceProviderId);
    staticHeaders = await resolveStaticOpenAiCompatibleHeaders(rawStaticHeaders);
  } catch {
    log.warn(`${sourceProviderId}: authentication or configured headers could not be resolved`);
    return;
  }
  const connection = resolvedConnection(source, auth, staticHeaders);
  let request;
  try {
    request = buildOpenAiCompatibleModelsRequest(connection);
  } catch (error) {
    log.warn(`${sourceProviderId}: discovery inactive`, redactOpenAiCompatibleDiagnostic(error instanceof Error ? error.message : String(error), connection));
    return;
  }
  const records = await cache.get(async () => {
    try {
      const response = await fetch(request.url, {
        headers: request.headers,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      if (!response.ok) throw new Error(`OpenAI-compatible /v1/models returned HTTP ${response.status}`);
      return responseRecords(await response.json());
    } catch (error) {
      log.warn(`${sourceProviderId}: discovery refresh failed`, redactOpenAiCompatibleDiagnostic(error instanceof Error ? error.message : String(error), connection));
      throw error;
    }
  }, { cacheKey: openAiCompatibleConnectionFingerprint(connection) });
  if (!isCurrent() || !records.hasSnapshot) return;
  if (records.stale) log.warn(`${sourceProviderId}: refresh failed; using last-known-good discovery result`);

  const staticModels = (ctx.modelRegistry.getAll() as Model[])
    .filter((model) => model.provider === sourceProviderId);
  const models = combineModels(sourceProviderId, staticModels, records.models, request.streamBaseUrl);
  try {
    const provider = await createRuntimeProvider({
      id: sourceProviderId,
      name: source.name,
      baseUrl: request.streamBaseUrl,
      auth: source.auth,
      models,
      api: {
        stream: source.stream.bind(source),
        streamSimple: source.streamSimple.bind(source),
      },
    });
    if (!isCurrent()) return;
    // Pi composes this native provider with the existing models.json entry. The
    // source key is therefore both the ordinary picker label and routing key.
    pi.registerProvider(provider);
    registeredSources.add(sourceProviderId);
    try {
      pi.appendEntry<OpenAiCompatibleDiscoverySummary>(
        "openai-compatible-discovery-summary",
        { summary: formatOpenAiCompatibleDiscoverySummary(sourceProviderId, records.models.length) },
      );
    } catch (error) {
      log.warn(`${sourceProviderId}: discovery summary append failed`, error instanceof Error ? error.name : typeof error);
    }
    log.info(`${sourceProviderId}: registered ${records.models.length} discovered model(s) on configured provider`);
  } catch (error) {
    log.warn(`${sourceProviderId}: provider augmentation failed`, redactOpenAiCompatibleDiagnostic(error instanceof Error ? error.message : String(error), connection));
  }
}

interface OpenAiCompatibleDiscoverySummary {
  summary: string;
}

/** A renderer component without a runtime dependency on Pi's TUI package. */
function discoverySummaryComponent(summary: string, theme: { fg: (color: "muted", text: string) => string }) {
  log.debug("rendering discovery summary", { summary });
  return {
    render: (_width: number): string[] => [theme.fg("muted", summary)],
    invalidate: (): void => {},
  };
}

export default function (pi: ExtensionAPI) {
  if (typeof pi.registerEntryRenderer === "function") {
    pi.registerEntryRenderer<OpenAiCompatibleDiscoverySummary>(
      "openai-compatible-discovery-summary",
      (entry, _options, theme) => discoverySummaryComponent(entry.data?.summary ?? "", theme),
    );
  }

  const cache = new OpenAiCompatibleDiscoveryCache<OpenAiCompatibleModelRecord>();
  const registeredSources = new Set<string>();
  const controllers = new Set<AbortController>();
  let active = true;
  let generation = 0;

  const restoreSources = () => {
    for (const id of registeredSources) {
      try {
        // Removing our native overlay makes Pi recompose the unchanged static provider.
        pi.unregisterProvider(id);
      } catch (error) {
        log.warn("provider augmentation cleanup failed", { provider: id, cause: error instanceof Error ? error.name : typeof error });
      }
      registeredSources.delete(id);
    }
  };

  pi.on("session_shutdown", () => {
    active = false;
    generation += 1;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    cache.clear();
    restoreSources();
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx?.mode !== "tui" || ctx?.hasUI !== true) return;
    active = true;
    generation += 1;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    cache.clear();
    restoreSources();
    const currentGeneration = generation;
    const controller = new AbortController();
    controllers.add(controller);
    const isCurrent = () => active && currentGeneration === generation;
    const configResult = findEligibleOpenAiCompatibleProviderConfigsResult();
    if (configResult.providers.length === 0) {
      const diagnostic = { modelsConfig: configResult.status };
      if (configResult.status === "unreadable" || configResult.status === "malformed")
        log.warn("inactive: OpenAI-compatible discovery configuration unavailable", diagnostic);
      else log.debug("inactive: no opted-in OpenAI-compatible providers", diagnostic);
      controllers.delete(controller);
      return;
    }
    await Promise.all(configResult.providers.map(({ id, headers }) =>
      discoverProvider(pi, ctx, id, headers, cache, controller.signal, isCurrent, registeredSources),
    ));
    controllers.delete(controller);
  });
}
