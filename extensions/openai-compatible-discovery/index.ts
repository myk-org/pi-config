import type { AuthResult, Model, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import {
  buildOpenAiCompatibleCapabilitiesUrl,
  buildOpenAiCompatibleModelsRequest,
  enrichOpenAiCompatibleReasoning,
  findEligibleOpenAiCompatibleProviderConfigsResult,
  formatOpenAiCompatibleDiscoverySummary,
  materializeOpenAiCompatibleModels,
  redactOpenAiCompatibleDiagnostic,
  resolveStaticOpenAiCompatibleHeaders,
  type OpenAiCompatibleCapabilityRecord,
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

function capabilityRecords(payload: unknown): OpenAiCompatibleCapabilityRecord[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data))
    throw new Error("OpenAI-compatible capability response must contain a data array");
  return (payload as { data: unknown[] }).data.filter(
    (record): record is OpenAiCompatibleCapabilityRecord => Boolean(record) && typeof record === "object" && !Array.isArray(record),
  );
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

async function refreshProviderModels(
  pi: ExtensionAPI,
  ctx: any,
  sourceProviderId: string,
  source: Provider,
  staticModels: readonly Model[],
  refresh: RefreshModelsContext,
  appendSummary: () => boolean,
  discoverModelCapabilities: boolean,
  rawStaticHeaders?: Record<string, string>,
): Promise<Model[]> {
  if (!refresh.allowNetwork || refresh.signal.aborted) return [...staticModels];

  let connection: ResolvedOpenAiCompatibleConnection = { baseUrl: source.baseUrl };
  try {
    const auth = await ctx.modelRegistry.getProviderAuth(sourceProviderId) as AuthResult | undefined;
    const staticHeaders = await resolveStaticOpenAiCompatibleHeaders(rawStaticHeaders);
    connection = resolvedConnection(source, auth, staticHeaders);
    const request = buildOpenAiCompatibleModelsRequest(connection);
    const signal = AbortSignal.any([refresh.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const response = await fetch(request.url, { headers: request.headers, redirect: "error", signal });
    if (!response.ok) throw new Error(`OpenAI-compatible /v1/models returned HTTP ${response.status}`);
    let records = responseRecords(await response.json());

    if (discoverModelCapabilities) {
      try {
        const capabilityResponse = await fetch(buildOpenAiCompatibleCapabilitiesUrl(request.url), {
          headers: request.headers,
          redirect: "error",
          signal,
        });
        if (!capabilityResponse.ok) throw new Error(`OpenAI-compatible capability endpoint returned HTTP ${capabilityResponse.status}`);
        records = enrichOpenAiCompatibleReasoning(records, capabilityRecords(await capabilityResponse.json()));
      } catch (error) {
        if (refresh.signal.aborted) return [...staticModels];
        log.warn(`${sourceProviderId}: reasoning capability enrichment unavailable`, redactOpenAiCompatibleDiagnostic(error instanceof Error ? error.message : String(error), connection));
      }
    }

    if (refresh.signal.aborted) return [...staticModels];
    if (appendSummary()) {
      try {
        pi.appendEntry<OpenAiCompatibleDiscoverySummary>(
          "openai-compatible-discovery-summary",
          { summary: formatOpenAiCompatibleDiscoverySummary(sourceProviderId, records.length) },
        );
      } catch (error) {
        log.warn(`${sourceProviderId}: discovery summary append failed`, error instanceof Error ? error.name : typeof error);
      }
    }
    log.info(`${sourceProviderId}: refreshed ${records.length} discovered model(s) on configured provider`);
    return combineModels(sourceProviderId, staticModels, records, request.streamBaseUrl);
  } catch (error) {
    if (!refresh.signal.aborted)
      log.warn(`${sourceProviderId}: discovery refresh failed`, redactOpenAiCompatibleDiagnostic(error instanceof Error ? error.message : String(error), connection));
    return [...staticModels];
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

  const registeredSources = new Set<string>();
  const restoreSources = () => {
    for (const id of registeredSources) {
      try {
        pi.unregisterProvider(id);
      } catch (error) {
        log.warn("provider augmentation cleanup failed", { provider: id, cause: error instanceof Error ? error.name : typeof error });
      }
      registeredSources.delete(id);
    }
  };

  pi.on("session_shutdown", restoreSources);

  pi.on("session_start", async (_event, ctx) => {
    restoreSources();
    const configResult = findEligibleOpenAiCompatibleProviderConfigsResult();
    if (configResult.providers.length === 0) {
      const diagnostic = { modelsConfig: configResult.status };
      if (configResult.status === "unreadable" || configResult.status === "malformed")
        log.warn("inactive: OpenAI-compatible discovery configuration unavailable", diagnostic);
      else log.debug("inactive: no opted-in OpenAI-compatible providers", diagnostic);
      return;
    }

    let startupRefresh = ctx?.mode === "tui" && ctx?.hasUI === true;
    for (const { id, headers, discoverModelCapabilities } of configResult.providers) {
      const source = ctx.modelRegistry.getProvider(id) as Provider | undefined;
      if (!source) {
        log.warn(`${id}: configured provider was not resolved`);
        continue;
      }
      const staticModels = (ctx.modelRegistry.getAll() as Model[])
        .filter((model) => model.provider === id);
      pi.registerProvider(id, {
        refreshModels: (refresh) => refreshProviderModels(
          pi,
          ctx,
          id,
          source,
          staticModels,
          refresh,
          () => startupRefresh,
          discoverModelCapabilities,
          headers,
        ),
      });
      registeredSources.add(id);
    }
    try {
      await ctx.modelRegistry.refresh({
        providers: configResult.providers.map(({ id }) => id),
        allowNetwork: true,
        force: true,
      });
    } finally {
      startupRefresh = false;
    }
  });
}
