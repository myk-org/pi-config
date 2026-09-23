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
  openAiCompatibleConnectionFingerprint,
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
  const records = (payload as { data: unknown[] }).data.filter(
    (record): record is OpenAiCompatibleCapabilityRecord => Boolean(record) && typeof record === "object" && !Array.isArray(record),
  );
  log.debug("parsed capability records", { count: records.length });
  return records;
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
  snapshot: { discovered: Model[]; fingerprint?: string; generation: number },
  lifecycle: { signal: AbortSignal; isCurrent: () => boolean },
): Promise<Model[]> {
  const generation = ++snapshot.generation;
  const active = () => {
    const current = lifecycle.isCurrent();
    log.debug("discovery refresh eligibility", { provider: sourceProviderId, generation, current, aborted: refresh.signal.aborted, latest: generation === snapshot.generation });
    return current && !refresh.signal.aborted && generation === snapshot.generation;
  };
  let connection: ResolvedOpenAiCompatibleConnection = { baseUrl: source.baseUrl };
  let scopeResolved = false;
  try {
    const auth = await ctx.modelRegistry.getProviderAuth(sourceProviderId) as AuthResult | undefined;
    const staticHeaders = await resolveStaticOpenAiCompatibleHeaders(rawStaticHeaders);
    connection = resolvedConnection(ctx.modelRegistry.getProvider(sourceProviderId) ?? source, auth, staticHeaders);
    if (!active()) return [...staticModels];
    const fingerprint = openAiCompatibleConnectionFingerprint(connection);
    if (snapshot.fingerprint !== fingerprint) {
      snapshot.discovered = [];
      snapshot.fingerprint = fingerprint;
      log.debug("discovery connection scope changed", { provider: sourceProviderId });
    }
    scopeResolved = true;
    if (!refresh.allowNetwork) return [...staticModels, ...snapshot.discovered];
    const request = buildOpenAiCompatibleModelsRequest(connection);
    const response = await fetch(request.url, {
      headers: request.headers, redirect: "error",
      signal: AbortSignal.any([refresh.signal, lifecycle.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new Error(`OpenAI-compatible /v1/models returned HTTP ${response.status}`);
    let records = responseRecords(await response.json());

    if (discoverModelCapabilities) {
      try {
        const capabilityResponse = await fetch(buildOpenAiCompatibleCapabilitiesUrl(request.url), {
          headers: request.headers,
          redirect: "error",
          signal: AbortSignal.any([refresh.signal, lifecycle.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        if (!capabilityResponse.ok) throw new Error(`OpenAI-compatible capability endpoint returned HTTP ${capabilityResponse.status}`);
        records = enrichOpenAiCompatibleReasoning(records, capabilityRecords(await capabilityResponse.json()));
      } catch (error) {
        if (!active()) return [...staticModels];
        log.warn(`${sourceProviderId}: reasoning capability enrichment unavailable`, redactOpenAiCompatibleDiagnostic(error instanceof Error ? error.message : String(error), connection));
      }
    }

    if (!active()) return [...staticModels];
    const models = combineModels(sourceProviderId, staticModels, records, request.streamBaseUrl);
    snapshot.discovered = models.slice(staticModels.length);
    if (active() && appendSummary()) {
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
    return models;
  } catch (error) {
    if (active())
      log.warn(`${sourceProviderId}: discovery refresh failed`, scopeResolved
        ? redactOpenAiCompatibleDiagnostic(error instanceof Error ? error.message : String(error), connection)
        : { phase: "connection resolution", cause: error instanceof Error ? error.name : typeof error });
    if (!active()) return [...staticModels];
    if (!scopeResolved) { snapshot.discovered = []; snapshot.fingerprint = undefined; }
    return [...staticModels, ...snapshot.discovered];
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
  let lifecycleGeneration = 0;
  let lifecycleController = new AbortController();
  const restoreSources = () => {
    lifecycleController.abort();
    lifecycleGeneration++;
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
    lifecycleController = new AbortController();
    const generation = lifecycleGeneration;
    const lifecycle = {
      signal: lifecycleController.signal,
      isCurrent: () => {
        const current = generation === lifecycleGeneration;
        log.debug("discovery lifecycle eligibility", { generation, lifecycleGeneration, current });
        return current;
      },
    };
    const configResult = findEligibleOpenAiCompatibleProviderConfigsResult();
    if (configResult.providers.length === 0) {
      const diagnostic = { modelsConfig: configResult.status };
      if (configResult.status === "unreadable" || configResult.status === "malformed")
        log.warn("inactive: OpenAI-compatible discovery configuration unavailable", diagnostic);
      else log.debug("inactive: no opted-in OpenAI-compatible providers", diagnostic);
      return;
    }

    let startupRefresh = ctx?.mode === "tui" && ctx?.hasUI === true;
    const registrationRefreshes: Promise<void>[] = [];
    const activeProviders: string[] = [];
    for (const { id, headers, discoverModelCapabilities } of configResult.providers) {
      const source = ctx.modelRegistry.getProvider(id) as Provider | undefined;
      if (!source) {
        log.warn(`${id}: configured provider was not resolved`);
        continue;
      }
      const staticModels = (ctx.modelRegistry.getAll() as Model[])
        .filter((model) => model.provider === id);
      const snapshot = { discovered: [] as Model[], fingerprint: undefined as string | undefined, generation: 0 };
      // Registration starts an unawaited offline refresh. Its first callback signals
      // that it has acquired its generation, so the network pass can safely supersede it.
      let registrationStarted!: () => void;
      registrationRefreshes.push(new Promise<void>((resolve) => { registrationStarted = resolve; }));
      pi.registerProvider(id, {
        refreshModels: (refresh) => {
          log.debug("provider discovery refresh requested", { provider: id, generation: snapshot.generation + 1, allowNetwork: refresh.allowNetwork, aborted: refresh.signal.aborted });
          registrationStarted();
          return refreshProviderModels(
            pi, ctx, id, source, staticModels, refresh, () => startupRefresh,
            discoverModelCapabilities, headers, snapshot, lifecycle,
          );
        },
      });
      registeredSources.add(id);
      activeProviders.push(id);
    }
    try {
      await Promise.all(registrationRefreshes);
      log.debug("registration offline refreshes started", { providers: activeProviders });
      await ctx.modelRegistry.refresh({
        providers: activeProviders,
        allowNetwork: true,
        force: true,
      });
    } finally {
      startupRefresh = false;
    }
  });
}
