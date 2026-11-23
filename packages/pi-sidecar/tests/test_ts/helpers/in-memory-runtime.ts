import {
  HEADLESS_EXCLUDED_PROVIDERS,
  httpError,
  type CreateRuntimeSessionInput,
  type CreatedRuntimeSession,
  type DiscoveredModel,
  type DiscoveredProvider,
  type KeyScopedModelsResult,
  type ProviderRuntime,
  type ProviderStatus,
  type StoredSession,
} from "../../../src/provider-runtime.js";

export interface InMemoryProviderRuntimeOptions {
  /** Initial ready state (defaults to false so discovery-on-demand can be tested). */
  ready?: boolean;
  /** Initial discovery error (defaults to null). */
  discoveryError?: string | null;
  /** Simulate failed discovery where runtime became ready without an available backend (503). */
  unavailable?: boolean;
  /** Available models returned by getModels()/refreshModels(). */
  available?: DiscoveredModel[];
  /** Per-provider catalog returned by getProviderStatus() and createSession(). */
  providerModels?: Record<string, DiscoveredModel[]>;
  /** Providers supporting per-session API keys (defaults to none unless listed). */
  keyCapableProviders?: Iterable<string>;
  /** Allow createSession() for any non-excluded provider/model without catalog registration. */
  allowAnyModel?: boolean;
  /** Factory for sessions returned by createSession(). */
  sessionFactory?: (
    input: CreateRuntimeSessionInput,
  ) => Promise<Partial<CreatedRuntimeSession> | StoredSession> | Partial<CreatedRuntimeSession> | StoredSession;
  /** Optional custom handler for getModelsForApiKey(). */
  getModelsForApiKey?: (providerId: string, apiKey: string) => Promise<KeyScopedModelsResult>;
  /** Optional hook called during refreshModels(). */
  onRefresh?: () => Promise<void> | void;
  /** Optional hook called during dispose(). */
  onDispose?: () => Promise<void> | void;
}

export function createNoopStoredSession(overrides?: Partial<StoredSession>): StoredSession {
  return {
    subscribe: overrides?.subscribe ?? (() => () => {}),
    prompt: overrides?.prompt ?? (async () => {}),
    dispose: overrides?.dispose ?? (() => {}),
    abort: overrides?.abort ?? (async () => {}),
  };
}

function isCreatedRuntimeSession(value: Partial<CreatedRuntimeSession> | StoredSession): value is Partial<CreatedRuntimeSession> {
  return "session" in value;
}

/**
 * In-memory implementation of `ProviderRuntime` for unit-testing `SessionStore`
 * without touching the Pi SDK, filesystem, or network.
 */
export class InMemoryProviderRuntime implements ProviderRuntime {
  available: DiscoveredModel[];
  providerModels: Record<string, DiscoveredModel[]>;
  refreshCalls = 0;
  disposed = false;

  private _ready: boolean;
  private _discoveryError: string | null;
  private readonly unavailable: boolean;
  private readonly keyCapableProviders: Set<string>;
  private readonly allowAnyModel: boolean;
  private readonly sessionFactory?: InMemoryProviderRuntimeOptions["sessionFactory"];
  private readonly getModelsForApiKeyImpl?: InMemoryProviderRuntimeOptions["getModelsForApiKey"];
  private readonly onRefresh?: InMemoryProviderRuntimeOptions["onRefresh"];
  private readonly onDispose?: InMemoryProviderRuntimeOptions["onDispose"];
  private refreshInFlight: Promise<DiscoveredModel[]> | undefined;

  constructor(options: InMemoryProviderRuntimeOptions = {}) {
    this.available = options.available ?? [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
    ];
    this.providerModels = options.providerModels ?? {
      google: this.available.filter((m) => m.provider === "google"),
    };
    this._ready = options.ready ?? false;
    this._discoveryError = options.discoveryError ?? null;
    this.unavailable = options.unavailable ?? false;
    this.keyCapableProviders = new Set(options.keyCapableProviders ?? []);
    this.allowAnyModel = options.allowAnyModel ?? false;
    this.sessionFactory = options.sessionFactory;
    this.getModelsForApiKeyImpl = options.getModelsForApiKey;
    this.onRefresh = options.onRefresh;
    this.onDispose = options.onDispose;
  }

  get ready(): boolean {
    return this._ready;
  }

  get discoveryError(): string | null {
    return this._discoveryError;
  }

  private assertNotDisposed(action: string): void {
    if (this.disposed) {
      throw httpError(`SessionStore is shutting down; ${action} is no longer available`, 503);
    }
  }

  private async ensureDiscoveryComplete(): Promise<void> {
    if (!this._ready) {
      try {
        await this.refreshModels();
      } catch {
        // refreshModels marks _ready even on failure; check unavailable below.
      }
    }
    if (this.unavailable) {
      throw httpError("Model discovery failed; runtime unavailable. See GET /health.", 503);
    }
  }

  async getProviders(): Promise<DiscoveredProvider[]> {
    this.assertNotDisposed("getProviders");
    return Object.keys(this.providerModels).map((provider) => ({
      provider,
      supportsSessionApiKey: !HEADLESS_EXCLUDED_PROVIDERS.has(provider) && this.keyCapableProviders.has(provider),
    }));
  }

  async getModels(): Promise<DiscoveredModel[]> {
    this.assertNotDisposed("getModels");
    await this.ensureDiscoveryComplete();
    return this.available
      .filter((m) => !HEADLESS_EXCLUDED_PROVIDERS.has(m.provider))
      .map((m) => ({ id: m.id, name: m.name, provider: m.provider }));
  }

  async refreshModels(): Promise<DiscoveredModel[]> {
    this.assertNotDisposed("refreshModels");
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      try {
        this.refreshCalls += 1;
        await this.onRefresh?.();
        this._ready = true;
        this._discoveryError = null;
        return await this.getModels();
      } catch (err: any) {
        this._discoveryError = err?.message || "Unknown discovery error";
        this._ready = true;
        throw err;
      }
    })().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  async getProviderStatus(provider: string): Promise<ProviderStatus> {
    this.assertNotDisposed("getProviderStatus");
    await this.ensureDiscoveryComplete();

    const models = this.providerModels[provider];
    const registered = models !== undefined;
    const excluded = HEADLESS_EXCLUDED_PROVIDERS.has(provider);
    const supportsSessionApiKey = !excluded && this.keyCapableProviders.has(provider);
    const modelCount = excluded ? 0 : (models?.length ?? 0);

    if (!registered || excluded) {
      return { provider, registered, modelCount, supportsSessionApiKey, authStatus: null, authCheck: null };
    }

    return {
      provider,
      registered: true,
      modelCount,
      supportsSessionApiKey,
      authStatus: provider === "google"
        ? { configured: true, source: "environment", label: "MOCK_KEY" }
        : null,
      authCheck: null,
    };
  }

  async getModelsForApiKey(providerId: string, apiKey: string): Promise<KeyScopedModelsResult> {
    this.assertNotDisposed("getModelsForApiKey");
    if (this.getModelsForApiKeyImpl) {
      return this.getModelsForApiKeyImpl(providerId, apiKey);
    }
    return { models: [], modelListingSupported: false };
  }

  async createSession(input: CreateRuntimeSessionInput): Promise<CreatedRuntimeSession> {
    this.assertNotDisposed("create");
    await this.ensureDiscoveryComplete();

    const { options } = input;
    if (!options.model) {
      throw new Error("Model is required. Use GET /models to list available models.");
    }
    if (HEADLESS_EXCLUDED_PROVIDERS.has(options.provider)) {
      throw httpError(
        `Provider '${options.provider}' requires interactive browser OAuth and cannot be used in this headless sidecar. Use GET /models to list available providers.`,
        400,
      );
    }
    if (!this.allowAnyModel) {
      const models = this.providerModels[options.provider] ?? [];
      const found = this.available.some((m) => m.provider === options.provider && m.id === options.model)
        || models.some((m) => m.id === options.model);
      if (!found) {
        throw httpError(
          `Model '${options.model}' not found for provider '${options.provider}'. Use GET /models to list available models.`,
          400,
        );
      }
    }

    const customToolNames = (options.customTools ?? [])
      .filter((t) => typeof t?.name === "string" && t.name.length > 0)
      .map((t) => t.name);

    if (this.sessionFactory) {
      const built = await this.sessionFactory(input);
      if (isCreatedRuntimeSession(built)) {
        return {
          session: built.session ?? createNoopStoredSession(),
          pricingKnown: built.pricingKnown ?? true,
          customToolNames: built.customToolNames ?? customToolNames,
        };
      }
      return {
        session: built,
        pricingKnown: true,
        customToolNames,
      };
    }

    return {
      session: createNoopStoredSession(),
      pricingKnown: true,
      customToolNames,
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.onDispose?.();
  }
}
