/**
 * Shared helpers for registering CLI / ACPX providers via pi-ai createProvider().
 *
 * Prefer this over legacy `pi.registerProvider(name, { streamSimple })` bags so
 * providers get /login auth, fetchModels refresh, filterModels, and native
 * ProviderStreams (requires pi >= 0.84.4).
 */

import type {
  Api,
  AuthCheck,
  AuthInteraction,
  AuthResult,
  Credential,
  Model,
  Provider,
  ProviderAuth,
  ProviderStreams,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";

/** Marker key written by ambient /login when the runtime is available. */
export const CONFIGURED_CREDENTIAL_KEY = "configured"; // pragma: allowlist secret

/** apiKey value used when resolve() succeeds via ambient availability only. */
export const AMBIENT_AUTH_KEY = "ambient"; // pragma: allowlist secret

export const DEFAULT_RUNTIME_BASE_URL = "https://localhost";

export interface BuildRuntimeModelOptions {
  id: string;
  name: string;
  api: Api;
  provider: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  input?: ("text" | "image")[];
  cost?: Model<Api>["cost"];
  contextWindow?: number;
  maxTokens?: number;
}

/** Build a full Model with api/provider/baseUrl required by createProvider. */
export function buildRuntimeModel(opts: BuildRuntimeModelOptions): Model<Api> {
  return {
    id: opts.id,
    name: opts.name,
    api: opts.api,
    provider: opts.provider,
    baseUrl: opts.baseUrl ?? DEFAULT_RUNTIME_BASE_URL,
    reasoning: opts.reasoning ?? false,
    ...(opts.thinkingLevelMap ? { thinkingLevelMap: opts.thinkingLevelMap } : {}),
    input: opts.input ?? ["text", "image"],
    cost: opts.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: opts.contextWindow ?? 200_000,
    maxTokens: opts.maxTokens ?? 32_768,
  };
}

export interface AmbientLoginAuthOptions {
  displayName: string;
  /**
   * True when the runtime is configured:
   * CLI = PATH + AgentState; ACPX = agents.has / AgentState (not binary alone).
   */
  isConfigured: () => boolean | Promise<boolean>;
  /** Human-readable source for status UI (e.g. "cursor CLI on PATH"). */
  sourceLabel: string;
}

/**
 * Api-key auth with /login that stores a marker credential when ambient
 * configuration is present (CLI: PATH + AgentState; ACPX: agents.has /
 * AgentState) — not an ambient-only stub.
 */
export function buildAmbientLoginAuth(
  opts: AmbientLoginAuthOptions,
): NonNullable<ProviderAuth["apiKey"]> {
  const { displayName, isConfigured, sourceLabel } = opts;

  return {
    name: displayName,
    async login(interaction: AuthInteraction) {
      const choice = await interaction.prompt({
        type: "select",
        message: `${displayName}: confirm local availability`,
        options: [
          {
            id: "confirm",
            label: `Use ${sourceLabel}`,
            description: "Verify and store a local configured credential",
          },
        ],
      });

      // Cancel rejects from prompt; only proceed on explicit confirm.
      if (choice !== "confirm") {
        throw new Error("Login cancelled");
      }

      const ok = await isConfigured();
      if (!ok) {
        throw new Error(
          `${displayName} is not available (${sourceLabel}). Install/configure it, then retry /login.`,
        );
      }

      interaction.notify({
        type: "info",
        message: `${displayName} ready via ${sourceLabel}`,
      });

      return { type: "api_key", key: CONFIGURED_CREDENTIAL_KEY };
    },
    async resolve({ credential }): Promise<AuthResult | undefined> {
      if (!(await isConfigured())) {
        return undefined;
      }
      // Never forward arbitrary credential.key into ModelAuth — only our markers.
      const hasLoginMarker =
        credential?.type === "api_key" &&
        credential.key === CONFIGURED_CREDENTIAL_KEY;
      return {
        auth: {
          apiKey: hasLoginMarker
            ? CONFIGURED_CREDENTIAL_KEY
            : AMBIENT_AUTH_KEY,
        },
        source: sourceLabel,
      };
    },
    async check(): Promise<AuthCheck | undefined> {
      // Align with resolve(): stale credential alone must not succeed.
      if (!(await isConfigured())) {
        return undefined;
      }
      return { type: "api_key", source: sourceLabel };
    },
  };
}

/**
 * Hide models when the runtime is unavailable.
 * Configured means: CLI = PATH + AgentState; ACPX = agents.has / AgentState
 * (not binary-on-PATH alone). When configured, models stay visible
 * (stored credential optional — ambient resolve works).
 */
export function filterModelsWhenConfigured<TApi extends Api>(
  models: readonly Model<TApi>[],
  _credential: Credential | undefined,
  isConfigured: () => boolean,
): readonly Model<TApi>[] {
  if (!isConfigured()) return [];
  return models;
}

export interface CreateRuntimeProviderOptions<TApi extends Api = Api> {
  id: string;
  name?: string;
  baseUrl?: string;
  auth: ProviderAuth;
  models: readonly Model<TApi>[];
  fetchModels?: (
    context: RefreshModelsContext,
  ) => Promise<readonly Model<TApi>[]>;
  filterModels?: (
    models: readonly Model<TApi>[],
    credential: Credential | undefined,
  ) => readonly Model<TApi>[];
  api: ProviderStreams;
}

/**
 * Build a native pi-ai Provider via createProvider (dynamic import so helper
 * unit tests do not require @earendil-works/pi-ai at import time).
 */
export async function createRuntimeProvider<TApi extends Api = Api>(
  opts: CreateRuntimeProviderOptions<TApi>,
): Promise<Provider<TApi>> {
  const { createProvider } = await import("@earendil-works/pi-ai");
  return createProvider({
    id: opts.id,
    name: opts.name,
    baseUrl: opts.baseUrl ?? DEFAULT_RUNTIME_BASE_URL,
    auth: opts.auth,
    models: opts.models,
    fetchModels: opts.fetchModels,
    filterModels: opts.filterModels,
    api: opts.api,
  });
}
