import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createJiti } from "jiti";

import { logger } from "./logger.js";
import { createHttpToolExecutor, normalizeHttpToolConfig } from "./http-tool-executor.js";
import { resolveExtensionPathDetailed } from "./resolve-extension-path.js";
import { runWithSessionCwd } from "./session-cwd.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Strip bracket suffixes from model IDs for display or comparison (e.g. "cursor:default[]" → "cursor:default"). */
function baseModelId(id: string): string {
  const idx = id.indexOf("[");
  return idx >= 0 ? id.substring(0, idx) : id;
}

/** Error with HTTP status for the sidecar request handler. */
type HttpError = Error & { statusCode: number };

function httpError(message: string, statusCode: number): HttpError {
  const err = new Error(message) as HttpError;
  err.statusCode = statusCode;
  return err;
}

const DISCOVERY_TIMEOUT_MS = 30_000;

/**
 * Providers that require interactive browser OAuth and therefore cannot work
 * in this headless container. Excluded from getModels()'s catalog and from
 * getProviderStatus()'s reported model count (see getProviderStatus()) —
 * hoisted to module scope so both call sites share one definition.
 */
const HEADLESS_EXCLUDED_PROVIDERS = new Set(["github-copilot"]);

function resolveAndLog(envVar: string, packageName: string, entryFile: string): string {
  const result = resolveExtensionPathDetailed(envVar, packageName, entryFile);
  if (!result.path) {
    logger.debug(`[sidecar] RESOLVE_SKIPPED: package=${packageName}, reason=${result.error || "unknown"}`);
  }
  return result.path;
}

type DiscoveredModel = { id: string; name: string; provider: string };

type CliDiscoverModule = {
  discoverCliModels: (agent: string) => Promise<DiscoveredModel[]>;
};

type AcpxDiscoverModule = {
  discoverAcpxModels: (agent: string, cwd?: string) => Promise<DiscoveredModel[]>;
};

/** Resolve extension: env override → npm package → monorepo relative path. */
export function resolveExt(envVar: string, packageName: string, entryFile: string, monorepoRelative: string): string {
  const envPath = process.env[envVar];
  if (envPath) return resolve(envPath);
  const pkg = resolveExtensionPathDetailed(envVar, packageName, entryFile);
  if (pkg.path) return pkg.path;
  return join(__dirname, "..", "..", "..", monorepoRelative);
}

const ACPX_EXTENSION = resolveExt("SIDECAR_ACPX_EXTENSION_PATH", "pi-orchestrator-config", "extensions/acpx-provider/index.ts", "extensions/acpx-provider/index.ts");
const CLI_PROVIDER_EXTENSION = resolveExt("SIDECAR_CLI_PROVIDER_EXTENSION_PATH", "pi-orchestrator-config", "extensions/cli-provider/index.ts", "extensions/cli-provider/index.ts");
const PROVIDER_EXTENSION = resolveExt("SIDECAR_PROVIDER_EXTENSION_PATH", "pi-orchestrator-config", "extensions/providers/index.ts", "extensions/providers/index.ts");
/**
 * Load fallback discovery via jiti from each extension's public entry
 * (`index.ts`), which re-exports discoverCliModels / discoverAcpxModels —
 * never from a private sibling like discover.ts.
 */
const CLI_DISCOVER_MODULE = CLI_PROVIDER_EXTENSION;
const ACPX_DISCOVER_MODULE = ACPX_EXTENSION;
const VERTEX_EXTENSION = resolveExt("SIDECAR_VERTEX_EXTENSION_PATH", "@myk-org/pi-vertex-claude", "index.ts", "packages/pi-vertex-claude/index.ts");
const SUBAGENT_EXTENSION = resolveAndLog("SIDECAR_SUBAGENT_EXTENSION_PATH", "@earendil-works/pi-coding-agent", "examples/extensions/subagent/index.ts");

/** Cache of jiti-loaded fallback discovery modules, keyed by resolved path. */
const jitiModuleCache = new Map<string, unknown>();

/**
 * Load a TypeScript module at runtime via jiti and return the export named
 * `exportName` (handling both named and default-wrapped exports). Results
 * are cached per path since jiti transpilation is not free and these modules
 * are pure functions with no meaningful per-call state.
 */
function loadJitiExport<T extends Record<string, unknown>>(path: string, exportName: keyof T & string): T {
  const cached = jitiModuleCache.get(path);
  if (cached) return cached as T;
  const jiti = createJiti(import.meta.url);
  const mod = jiti(path) as Record<string, unknown> & { default?: T };
  const resolved = (exportName in mod && typeof mod[exportName] === "function" ? mod : mod.default) as T | undefined;
  if (!resolved || typeof resolved[exportName] !== "function") {
    throw new Error(`Module missing ${exportName} at ${path}`);
  }
  jitiModuleCache.set(path, resolved);
  return resolved;
}

/** In-flight fallback discoveries keyed by `kind:agent` — joiners reuse the same Promise. */
const inFlightDiscovery = new Map<string, Promise<DiscoveredModel[]>>();

/**
 * Race a discovery call against DISCOVERY_TIMEOUT_MS; never throws — returns [] on failure.
 * On timeout the underlying Promise may keep running (no AbortSignal in discover APIs), but
 * the inFlightDiscovery entry is evicted so later refreshes start a new discovery instead of
 * joining a permanently hung promise. Late failures are still logged.
 */
async function raceDiscovery(agent: string, kind: string, run: () => Promise<DiscoveredModel[]>): Promise<DiscoveredModel[]> {
  const key = `${kind}:${agent}`;
  let discovery = inFlightDiscovery.get(key);
  if (!discovery) {
    discovery = run().finally(() => {
      if (inFlightDiscovery.get(key) === discovery) {
        inFlightDiscovery.delete(key);
      }
    });
    inFlightDiscovery.set(key, discovery);
  } else {
    logger.debug(`[sidecar] ${kind.toUpperCase()}_DISCOVERY_REUSE: agent=${agent}`);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${kind} fallback discovery for ${agent} timed out after ${DISCOVERY_TIMEOUT_MS / 1000}s`));
      }, DISCOVERY_TIMEOUT_MS);
    });
    return await Promise.race([discovery, timeout]);
  } catch (err) {
    const timedOut = err instanceof Error && /timed out/i.test(err.message);
    if (timedOut) {
      // Evict the hung entry so a later refresh starts a new discovery instead of
      // forever joining a promise that may never settle.
      if (inFlightDiscovery.get(key) === discovery) {
        inFlightDiscovery.delete(key);
        logger.warn(
          `[sidecar] ${kind.toUpperCase()}_DISCOVERY_EVICTED: agent=${agent}, reason=timeout, timeout_ms=${DISCOVERY_TIMEOUT_MS}`,
        );
      }
      // Abandoned promise may still reject later — log that instead of swallowing silently.
      discovery.catch((lateErr) => {
        logger.warn(`[sidecar] ${kind.toUpperCase()}_DISCOVERY_LATE_FAILED: agent=${agent}`, lateErr);
      });
    }
    logger.warn(`[sidecar] ${kind.toUpperCase()}_DISCOVERY_FALLBACK_FAILED: agent=${agent}`, err);
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const AGENT_NAME_PATTERN = /^[a-z0-9_-]+$/i;

/**
 * Builds a fallback model-discovery function for one extension kind (acpx or
 * cli). Invoked by snapshotAgentSource() only when the shared ModelRuntime has
 * a registered `<kind>-<agent>` provider whose catalog is empty (e.g. refresh
 * race / late agent). Unregistered providers skip this path entirely
 * (FALLBACK_DROPPED) — create() cannot resolve models without a registered
 * provider. Loads the extension's own exported discovery function via jiti
 * rather than duplicating its discovery logic here.
 */
function makeDiscoverFallback<T extends Record<string, unknown>>(
  kind: "acpx" | "cli",
  modulePath: string,
  exportName: keyof T & string,
): (agent: string) => Promise<DiscoveredModel[]> {
  const label = kind.toUpperCase();
  return async (agent: string): Promise<DiscoveredModel[]> => {
    logger.debug(`[sidecar] ${label}_DISCOVERY_FALLBACK_START: agent=${agent}`);
    if (!AGENT_NAME_PATTERN.test(agent)) {
      throw new Error(`Invalid agent name: ${agent}`);
    }
    if (!modulePath) {
      logger.warn(`[sidecar] ${label}_DISCOVERY_FALLBACK_SKIPPED: agent=${agent}, reason=module_path_unresolved`);
      return [];
    }
    return raceDiscovery(agent, kind, () => {
      const discover = loadJitiExport<T>(modulePath, exportName)[exportName] as (agent: string) => Promise<DiscoveredModel[]>;
      return discover(agent);
    });
  };
}

/** Model ids are acpx bracket ids (e.g. cursor:default[]). */
const discoverAcpxModelsFallback = makeDiscoverFallback<AcpxDiscoverModule>("acpx", ACPX_DISCOVER_MODULE, "discoverAcpxModels");
/** Model ids are CLI `--model` values (e.g. cursor:composer-2.5), not acpx bracket ids. */
const discoverCliModelsFallback = makeDiscoverFallback<CliDiscoverModule>("cli", CLI_DISCOVER_MODULE, "discoverCliModels");

/** Parse comma-separated agent env vars (ACPX_AGENTS / CLI_AGENTS). */
function parseAgentList(envValue: string | undefined): string[] {
  return (envValue || "")
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

interface ExtensionEntry {
  path: string;
  label: string;
  /** Marks this entry as the subagent extension for ResolvedExtensions.subagentPathFound —
   *  an explicit flag rather than matching on `label === "Subagent"`, so a future label rename
   *  can't silently break the create()/subagent path pre-check. Actual load success is verified
   *  after DefaultResourceLoader.reload() via getExtensions(). */
  isSubagent?: boolean;
}

interface ResolvedExtensions {
  paths: string[];
  /** True when the subagent extension file was found on disk (path resolve only). */
  subagentPathFound: boolean;
}

/** Resolve a list of candidate extension paths to existing files, logging each outcome. */
function resolveExtensionPaths(entries: ExtensionEntry[]): ResolvedExtensions {
  const paths: string[] = [];
  let subagentPathFound = false;
  for (const { path, label, isSubagent } of entries) {
    if (!path) {
      logger.warn(`[sidecar] EXTENSION_RESOLVE_EMPTY: label=${label}`);
      continue;
    }
    try {
      const stat = statSync(path);
      if (!stat.isFile()) {
        logger.warn(`[sidecar] EXTENSION_NOT_FILE: label=${label}, path=${path}`);
        continue;
      }
      paths.push(path);
      logger.log(`[sidecar] EXTENSION_FOUND: label=${label}, path=${path}`);
      if (isSubagent) subagentPathFound = true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`[sidecar] EXTENSION_NOT_FOUND: label=${label}, path=${path}, error=${errMsg}`);
    }
  }
  return { paths, subagentPathFound };
}

/**
 * Both the internal registrar runtime and every user session disable compaction
 * (sessions are short-lived/one-shot over HTTP — no need for the SDK to manage
 * context window pressure) and use an in-memory settings store (no on-disk
 * config to load/persist for either). Shared factory so the two call sites
 * (ensureInternalRuntime()'s createRuntime, create()) don't drift.
 */
function createSessionSettingsManager(): SettingsManager {
  return SettingsManager.inMemory({ compaction: { enabled: false } });
}

/** Internal registrar session never receives prompts — system prompt is a placeholder for clarity in logs/dumps. */
const INTERNAL_REGISTRAR_SYSTEM_PROMPT =
  "You are the pi-sidecar's internal model registrar session. You exist only to keep the " +
  "Providers/Vertex/Subagent extensions loaded so their providers stay registered on the shared " +
  "ModelRuntime. You are never prompted.";

/** Default agent dir for the internal registrar runtime; independent of per-request agent_dir overrides. */
const INTERNAL_AGENT_DIR = "/tmp/pi-sidecar-agent";

/**
 * Builds the CreateAgentSessionRuntimeFactory for the internal registrar
 * runtime (see SessionStore.ensureInternalRuntime()). Extracted to a
 * standalone module-level function — rather than an inline closure nested
 * inside the class method's async IIFE — so the factory's own logic (wiring
 * settings, extensions, and diagnostics) reads independently of the
 * lazy-init/idempotency plumbing around it.
 */
function createInternalRuntimeFactory(extensionPaths: string[]): CreateAgentSessionRuntimeFactory {
  return async ({ cwd, agentDir, sessionManager: runtimeSessionManager, sessionStartEvent }) => {
    const settingsManager = createSessionSettingsManager();
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: {
        additionalExtensionPaths: extensionPaths,
        systemPromptOverride: () => INTERNAL_REGISTRAR_SYSTEM_PROMPT,
      },
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: runtimeSessionManager,
      sessionStartEvent,
      tools: [],
    });
    const extensionErrors = services.resourceLoader.getExtensions().errors.map(({ path, error }) => ({
      type: "error" as const,
      message: `Failed to load extension "${path}": ${error}`,
    }));
    return { ...created, services, diagnostics: [...services.diagnostics, ...extensionErrors] };
  };
}

export const DEFAULT_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

interface SessionEntry {
  session: AgentSession;
  lastActivity: number;
  inFlight: boolean;
  cwd: string;
}

/**
 * Wire-format shape for custom tool configs received via the HTTP API.
 * Non-HTTP tools are passed through to the Pi SDK as-is and must already
 * conform to the SDK's ToolDefinition interface (including the SDK-style
 * `execute(toolCallId, params, signal, onUpdate, ctx)` signature).
 * HTTP-backed tools are automatically wrapped with the correct SDK signature.
 */
export interface CustomToolConfig {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
  /** When present, the tool's execute function is backed by an HTTP request. */
  http?: Record<string, any>;
  /** Additional properties passed through to the Pi SDK ToolDefinition. */
  [key: string]: any;
}

export interface CreateSessionOptions {
  provider: string;
  model: string;
  systemPrompt: string;
  cwd: string;
  agentDir?: string;
  tools?: string[];
  customTools?: CustomToolConfig[];
}

export interface ProviderStatus {
  provider: string;
  registered: boolean;
  modelCount: number;
  authStatus: ReturnType<ModelRuntime["getProviderAuthStatus"]> | null;
  /** Always null or AuthCheck — never undefined (checkAuth's undefined is normalized via ?? null). */
  authCheck: NonNullable<Awaited<ReturnType<ModelRuntime["checkAuth"]>>> | null;
}

export class SessionStore {
  private sessions = new Map<string, SessionEntry>();
  /** Shared ModelRuntime (0.81+) — sourced from internalRuntime.services once created. */
  private modelRuntime: ModelRuntime | undefined;
  private modelRegistry: ModelRegistry | undefined;
  /**
   * Internal AgentSessionRuntime that owns the shared ModelRuntime and keeps
   * unified Providers (ACPX + CLI), Vertex, and Subagent extensions loaded for the sidecar process's
   * lifetime. Created once, lazily, and disposed only in disposeAll().
   *
   * Why this exists: the unified Providers extension (ACPX + CLI) keeps
   * module-level state (acpx runtime sessions, CLI --resume markers) that is
   * only correct if exactly one instance of that extension is ever loaded.
   * `AgentSessionRuntime.dispose()` emits a `session_shutdown` event, which
   * those providers use as their own teardown signal — they clear that
   * module-level state and their `filterModels()` (driven by `isConfigured()`)
   * starts returning an empty list for every acpx-* / cli-* model. So this
   * runtime must never be disposed except at process shutdown, and it must
   * never be recreated to "refresh" discovery (see refreshModels()).
   *
   * User sessions created via create() never load the unified Providers
   * extension (only Subagent and Vertex, which have no such shared state) and
   * resolve acpx-* / cli-* models directly via `modelRuntime.getModel()`. This
   * intentionally bypasses `ModelRuntime.getAvailable()`/`ModelRegistry.getAvailable()`,
   * whose `filterModels()` call would read `isConfigured()` from the *internal*
   * runtime's extension module instance — something a user session has no
   * reason to depend on and would only add a footgun if it silently changed.
   */
  private internalRuntime: AgentSessionRuntime | undefined;
  private runtimeInit: Promise<void> | undefined;
  private _ready = false;
  private _discoveryError: string | null = null;
  /**
   * Cached acpx-* / cli-* model snapshots, refreshed by snapshotExtensionModels().
   * This is the source of truth for create()'s acpx/cli validation — not a
   * live provider lookup — so a session request always sees a consistent
   * list matching the most recent GET /models response.
   */
  private acpxModels: DiscoveredModel[] = [];
  private cliModels: DiscoveredModel[] = [];
  /**
   * Set at the very start of disposeAll(), before any session or the internal
   * runtime is torn down. Once true, ensureInternalRuntime()/create()/getModels()/
   * refreshModels()/getProviderStatus() all reject immediately instead of doing
   * work against (or recreating) a runtime that is mid-teardown or gone — the
   * internal runtime must never be recreated after process shutdown begins.
   */
  private _disposed = false;

  get disposed(): boolean {
    return this._disposed;
  }

  private assertNotDisposed(action: string): void {
    if (this._disposed) {
      throw httpError(`SessionStore is shutting down; ${action} is no longer available`, 503);
    }
  }

  get ready(): boolean {
    return this._ready;
  }

  get discoveryError(): string | null {
    return this._discoveryError;
  }

  /**
   * In-flight refreshModels() so concurrent getModels()/create()/startup share
   * one discovery pass instead of racing two snapshots.
   */
  private refreshInFlight: Promise<Array<{ id: string; name: string; provider: string }>> | undefined;

  /**
   * Ensure the first discovery pass has finished (or failed with _ready set).
   * Startup kicks refreshModels() async after listen; GET /models and create()
   * must not serve empty acpx/cli caches during that window.
   *
   * If init failed before modelRuntime was assigned, throws a controlled 503
   * instead of letting callers crash on `this.modelRuntime!`.
   */
  private async ensureDiscoveryComplete(): Promise<void> {
    if (!this._ready) {
      try {
        await this.refreshModels();
      } catch {
        // refreshModels sets _ready even on failure; check runtime below.
      }
    }
    if (!this.modelRuntime || !this.modelRegistry) {
      throw httpError(
        "Model discovery failed; runtime unavailable. See GET /health.",
        503,
      );
    }
  }

  count(): number {
    return this.sessions.size;
  }

  /**
   * Lazily create the internal AgentSessionRuntime (see field docstring above).
   * Idempotent — concurrent callers await the same in-flight creation.
   */
  private async ensureInternalRuntime(): Promise<void> {
    this.assertNotDisposed("ensureInternalRuntime");
    if (this.internalRuntime) return;
    if (!this.runtimeInit) {
      this.runtimeInit = (async () => {
        // Prefer the unified providers extension (extensions/providers/index.ts)
        // when available (pi-orchestrator-config >= 4.0.0). Fall back to loading
        // ACPX + CLI individually on older versions where the file doesn't exist.
        const providerEntries: ExtensionEntry[] =
          PROVIDER_EXTENSION && existsSync(PROVIDER_EXTENSION)
            ? [{ path: PROVIDER_EXTENSION, label: "Providers" }]
            : [
                { path: ACPX_EXTENSION, label: "ACPX" },
                { path: CLI_PROVIDER_EXTENSION, label: "CLI" },
              ];
        const { paths: extensionPaths } = resolveExtensionPaths([
          ...providerEntries,
          { path: VERTEX_EXTENSION, label: "Vertex" },
          { path: SUBAGENT_EXTENSION, label: "Subagent", isSubagent: true },
        ]);
        logger.log(`[sidecar] INTERNAL_EXTENSIONS_LOADING: count=${extensionPaths.length}`);

        const sessionManager = SessionManager.inMemory();
        const createRuntime = createInternalRuntimeFactory(extensionPaths);

        const runtime = await createAgentSessionRuntime(createRuntime, {
          cwd: "/tmp",
          agentDir: INTERNAL_AGENT_DIR,
          sessionManager,
        });
        // disposeAll() may have run while we were creating — never leave an
        // orphaned registrar runtime alive past shutdown (its dispose() is the
        // only path that emits session_shutdown for the Providers extension).
        if (this._disposed) {
          try {
            await runtime.dispose();
            logger.warn(`[sidecar] INTERNAL_RUNTIME_ORPHAN_DISPOSED: created during shutdown`);
          } catch (err) {
            logger.warn(`[sidecar] INTERNAL_RUNTIME_ORPHAN_DISPOSE_FAILED:`, err);
          }
          return;
        }
        this.internalRuntime = runtime;
        this.modelRuntime = this.internalRuntime.services.modelRuntime;
        this.modelRegistry = new ModelRegistry(this.modelRuntime);
        for (const diagnostic of this.internalRuntime.diagnostics) {
          const log = diagnostic.type === "error" ? logger.error : diagnostic.type === "warning" ? logger.warn : logger.debug;
          log(`[sidecar] INTERNAL_RUNTIME_DIAGNOSTIC: type=${diagnostic.type}, message=${diagnostic.message}`);
        }
        logger.info(`[sidecar] INTERNAL_RUNTIME_CREATED: extensions=${extensionPaths.length}, agentDir=${INTERNAL_AGENT_DIR}`);
      })();
    }
    await this.runtimeInit;
    // Init may have aborted because disposeAll() ran mid-create.
    this.assertNotDisposed("ensureInternalRuntime");
  }

  /**
   * List models from all sources. Ensures the internal runtime is initialized
   * so builtins are never silently empty during startup races.
   * ACPX models take precedence over builtin placeholders with the same base ID;
   * cli-* stays a separate source (no acpx↔cli merge).
   */
  async getModels(): Promise<Array<{ id: string; name: string; provider: string }>> {
    this.assertNotDisposed("getModels");
    await this.ensureDiscoveryComplete();

    // acpx-* / cli-* providers are registered directly on the shared ModelRuntime
    // by the internal runtime's extensions (see ensureInternalRuntime). Strip
    // them from the builtins list here — callers get those only via the
    // explicit acpxModels/cliModels caches populated by snapshotExtensionModels(),
    // which read the provider's raw catalog rather than the auth-filtered one
    // (see the internalRuntime field docstring for why).
    const isExtensionProvider = (provider: string): boolean =>
      provider.startsWith("acpx-") || provider.startsWith("cli-");

    const builtinModels = this.modelRegistry!.getAvailable()
      .filter((m) => !HEADLESS_EXCLUDED_PROVIDERS.has(m.provider) && !isExtensionProvider(m.provider))
      .map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
      }));

    // Deduplicate: acpx models take priority over builtin placeholders.
    // Compare by stripping bracket suffixes (e.g. "cursor:default[]" base is "cursor:default").
    const acpxBaseIds = new Set(this.acpxModels.map((m) => baseModelId(m.id)));
    const dedupedBuiltins = builtinModels.filter((m) => !acpxBaseIds.has(baseModelId(m.id)));
    const dedupedCount = builtinModels.length - dedupedBuiltins.length;
    if (dedupedCount > 0) {
      logger.debug(
        `[sidecar] MODELS_DEDUPED: builtin=${builtinModels.length}, acpx=${this.acpxModels.length}, removed=${dedupedCount}, total=${dedupedBuiltins.length + this.acpxModels.length + this.cliModels.length}`,
      );
    } else {
      logger.debug(
        `[sidecar] MODELS_LISTED: builtin=${dedupedBuiltins.length}, acpx=${this.acpxModels.length}, cli=${this.cliModels.length}`,
      );
    }

    // Caller selects source via provider: google/… vs acpx-<agent> vs cli-<agent>
    return [...dedupedBuiltins, ...this.acpxModels, ...this.cliModels];
  }

  /**
   * Snapshot one extension model source (acpx or cli) for each configured agent.
   * Prefers the shared ModelRuntime's provider catalog (already populated by
   * the internal runtime's extension load / refresh()); falls back to a
   * jiti-loaded discovery call only when that provider is registered but empty.
   */
  private async snapshotAgentSource(
    agents: string[],
    kind: "acpx" | "cli",
    fallback: (agent: string) => Promise<DiscoveredModel[]>,
  ): Promise<DiscoveredModel[]> {
    if (agents.length === 0) return [];
    const label = kind.toUpperCase();
    logger.info(`[sidecar] ${label}_SNAPSHOT_START: agents=${agents.join(",")}`);

    const results = await Promise.allSettled(
      agents.map(async (agent) => {
        const providerId = `${kind}-${agent}`;
        const provider = this.modelRuntime?.getProvider(providerId);
        const fromRuntime = provider?.getModels().map((m) => ({ id: m.id, name: m.name, provider: providerId })) ?? [];
        if (fromRuntime.length > 0) {
          return { models: fromRuntime, source: "modelRuntime" as const };
        }
        // Unregistered providers cannot resolve models in create() — skip the
        // expensive jiti fallback (up to DISCOVERY_TIMEOUT_MS) entirely.
        if (!provider) {
          logger.warn(
            `[sidecar] ${label}_FALLBACK_DROPPED: agent=${agent}, provider=${providerId}, reason=provider_not_registered, discovered=0`,
          );
          return { models: [], source: "fallback" as const };
        }
        // Only advertise fallback discoveries that ModelRuntime can actually
        // resolve — create() later calls getModel() and would 500 otherwise.
        const fromFallback = await fallback(agent);
        const resolvable = fromFallback.filter((m) => Boolean(this.modelRuntime?.getModel(providerId, m.id)));
        if (resolvable.length < fromFallback.length) {
          logger.warn(
            `[sidecar] ${label}_FALLBACK_FILTERED: agent=${agent}, provider=${providerId}, discovered=${fromFallback.length}, resolvable=${resolvable.length}`,
          );
        }
        return { models: resolvable, source: "fallback" as const };
      }),
    );

    const models: DiscoveredModel[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const agent = agents[i];
      if (result.status === "fulfilled") {
        models.push(...result.value.models);
        logger.info(`[sidecar] ${label}_SNAPSHOT_OK: agent=${agent}, count=${result.value.models.length}, source=${result.value.source}`);
      } else {
        logger.error(`[sidecar] ${label}_SNAPSHOT_FAILED: agent=${agent}`, result.reason);
      }
    }
    return models;
  }

  private async snapshotExtensionModels(): Promise<void> {
    this.acpxModels = await this.snapshotAgentSource(parseAgentList(process.env.ACPX_AGENTS), "acpx", discoverAcpxModelsFallback);
    this.cliModels = await this.snapshotAgentSource(parseAgentList(process.env.CLI_AGENTS), "cli", discoverCliModelsFallback);
  }

  /**
   * Discover models from all configured providers. Blocks until complete.
   * Called on startup — /health returns ok only after this finishes.
   */
  async refreshModels(): Promise<Array<{ id: string; name: string; provider: string }>> {
    this.assertNotDisposed("refreshModels");
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = this.runRefreshModels().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private async runRefreshModels(): Promise<Array<{ id: string; name: string; provider: string }>> {
    logger.debug(`[sidecar] MODEL_DISCOVERY_START:`);
    try {
      const isFirstDiscovery = !this.internalRuntime;
      // First call: creates the internal runtime, which loads the unified
      // Providers (ACPX + CLI), Vertex, and Subagent extensions and triggers
      // their synchronous discovery once.
      await this.ensureInternalRuntime();

      if (!isFirstDiscovery) {
        // Extensions are already loaded and their providers already registered
        // on the shared ModelRuntime — reloading the unified Providers extension
        // would give it a second module instance with its own empty agents Map
        // (see the internalRuntime field docstring). Instead, ask the runtime to
        // re-fetch each provider's catalog: Provider.refreshModels(), which
        // createRuntimeProvider() wires to the extension's fetchModels callback.
        // allowNetwork: false — ACPX/CLI providers resolve their catalogs from
        // the local acpx runtime / CLI binaries, not the network; ModelRuntime
        // defaults allowNetwork to true (for builtin providers' remote catalog
        // fetches), which we don't want triggered from this localhost refresh path.
        const result = await this.modelRuntime!.refresh({ force: true, allowNetwork: false });
        for (const [providerId, err] of result.errors) {
          logger.warn(`[sidecar] MODEL_REFRESH_PROVIDER_FAILED: provider=${providerId}, error=${err.message}`);
        }
      }

      await this.snapshotExtensionModels();

      this._ready = true;
      this._discoveryError = null;
      const models = await this.getModels();
      logger.info(`[sidecar] MODEL_DISCOVERY_COMPLETE: count=${models.length}`);
      return models;
    } catch (err: any) {
      this._discoveryError = err?.message || "Unknown discovery error";
      this._ready = true; // Mark as ready but with error — don't block health forever
      logger.error(`[sidecar] MODEL_DISCOVERY_FAILED:`, err);
      throw err; // Rethrow so callers can handle (startup catches, POST /models/refresh returns 500)
    }
  }

  /**
   * Auth/registration/model-count snapshot for one provider, for diagnostics
   * (GET /models/:provider/status). Model counts for acpx-* / cli-* come from
   * the cache populated by snapshotExtensionModels() — the same source create()
   * validates against — rather than the provider's live (auth-gated) catalog.
   */
  async getProviderStatus(provider: string): Promise<ProviderStatus> {
    this.assertNotDisposed("getProviderStatus");
    await this.ensureDiscoveryComplete();

    const registeredProvider = this.modelRuntime!.getProvider(provider);
    const registered = !!registeredProvider;

    let modelCount: number;
    if (HEADLESS_EXCLUDED_PROVIDERS.has(provider)) {
      // Mirror getModels(): these providers need interactive browser OAuth and
      // are excluded from the catalog this process can ever actually serve, so
      // report 0 here too rather than the SDK's raw (unusable) model count.
      modelCount = 0;
    } else if (provider.startsWith("acpx-")) {
      modelCount = this.acpxModels.filter((m) => m.provider === provider).length;
    } else if (provider.startsWith("cli-")) {
      modelCount = this.cliModels.filter((m) => m.provider === provider).length;
    } else {
      modelCount = registeredProvider?.getModels().length ?? 0;
    }

    if (!registered) {
      logger.debug(`[sidecar] PROVIDER_STATUS: provider=${provider}, registered=false, modelCount=${modelCount}`);
      return { provider, registered: false, modelCount, authStatus: null, authCheck: null };
    }

    // Excluded providers are unusable headlessly (create() rejects them). Skip
    // checkAuth/getProviderAuthStatus to avoid OAuth side effects and noise.
    if (HEADLESS_EXCLUDED_PROVIDERS.has(provider)) {
      logger.debug(`[sidecar] PROVIDER_STATUS: provider=${provider}, registered=true, modelCount=0, auth=skipped_headless_excluded`);
      return { provider, registered: true, modelCount: 0, authStatus: null, authCheck: null };
    }

    let authCheck: ProviderStatus["authCheck"] = null;
    try {
      authCheck = (await this.modelRuntime!.checkAuth(provider)) ?? null;
    } catch (err) {
      logger.warn(`[sidecar] PROVIDER_STATUS_AUTH_CHECK_FAILED: provider=${provider}`, err);
    }

    let authStatus: ProviderStatus["authStatus"] = null;
    try {
      authStatus = this.modelRuntime!.getProviderAuthStatus(provider);
    } catch (err) {
      logger.warn(`[sidecar] PROVIDER_STATUS_AUTH_STATUS_FAILED: provider=${provider}`, err);
    }

    logger.debug(`[sidecar] PROVIDER_STATUS: provider=${provider}, registered=${registered}, modelCount=${modelCount}`);

    return { provider, registered, modelCount, authStatus, authCheck };
  }

  async create(options: CreateSessionOptions): Promise<string> {
    this.assertNotDisposed("create");
    await this.ensureDiscoveryComplete();
    const id = randomUUID();

    if (!options.model) {
      throw new Error(`Model is required. Use GET /models to list available models.`);
    }

    // Match getModels()/getProviderStatus(): these providers need interactive
    // browser OAuth and cannot work in this headless process — reject early
    // rather than letting callers bypass the catalog filter.
    if (HEADLESS_EXCLUDED_PROVIDERS.has(options.provider)) {
      throw httpError(
        `Provider '${options.provider}' requires interactive browser OAuth and cannot be used in this headless sidecar. Use GET /models to list available providers.`,
        400,
      );
    }

    await this.ensureInternalRuntime();

    const isAcpxProvider = options.provider.startsWith("acpx-");
    const isCliProvider = options.provider.startsWith("cli-");

    // Extension sources are selected explicitly via provider prefix and
    // validated against the acpx/cli cache (kept in sync by refreshModels()).
    let model: any;
    if (isAcpxProvider || isCliProvider) {
      const cache = isAcpxProvider ? this.acpxModels : this.cliModels;
      const envVar = isAcpxProvider ? "ACPX_AGENTS" : "CLI_AGENTS";
      const sourceLabel = isAcpxProvider ? "acpx-*" : "cli-*";
      const match = cache.some((m) => m.id === options.model && m.provider === options.provider);
      if (!match) {
        throw new Error(
          `Model '${options.model}' not found for provider '${options.provider}'. ` +
            `Set ${envVar} and use GET /models to list ${sourceLabel} models.`,
        );
      }
      // Resolve directly against the shared ModelRuntime — this bypasses
      // getAvailable()/filterModels(), which would read the extension's
      // isConfigured() state from the internal runtime's own module instance.
      // See the internalRuntime field docstring for why user sessions must not
      // depend on that state.
      model = this.modelRuntime!.getModel(options.provider, options.model);
      if (!model) {
        throw new Error(
          `Model '${options.model}' was found in the ${isAcpxProvider ? "acpx" : "cli"} model cache but is no ` +
            `longer registered on the shared ModelRuntime for provider '${options.provider}'. Try POST /models/refresh.`,
        );
      }
    } else {
      model = this.modelRegistry!.find(options.provider, options.model)
        || this.modelRuntime!.getModel(options.provider, options.model)
        || getModel(options.provider as any, options.model)
        || undefined;
      if (!model) {
        throw new Error(
          `Model '${options.model}' not found for provider '${options.provider}'. Use GET /models to list available models.`,
        );
      }
    }

    logger.debug(
      `[sidecar] Model resolved: provider=${options.provider}, model=${options.model}, acpxSource=${isAcpxProvider}, cliSource=${isCliProvider}`,
    );

    // User sessions deliberately never load the unified Providers extension
    // here: it owns module-level state (acpx runtime sessions, CLI --resume
    // markers) that is only correct with a single loaded instance — the
    // internal runtime's (see the internalRuntime field docstring). Subagent
    // and Vertex have no such shared state and are safe to load per user session.
    const { paths: extensionPaths, subagentPathFound } = resolveExtensionPaths([
      { path: VERTEX_EXTENSION, label: "Vertex" },
      { path: SUBAGENT_EXTENSION, label: "Subagent", isSubagent: true },
    ]);
    logger.log(`[sidecar] EXTENSIONS_LOADING: count=${extensionPaths.length}`);

    // Build custom tools from config — result is cast to any[] for Pi SDK ToolDefinition compatibility
    const customTools: any[] = (options.customTools || []).map((tool) => {
      if (!tool.name || typeof tool.name !== "string") {
        logger.error(`[sidecar] Custom tool missing required 'name' field, skipping`);
        return null;
      }
      if (tool.http) {
        const httpConfig = normalizeHttpToolConfig(tool.http);
        const httpExecutor = createHttpToolExecutor(httpConfig);
        logger.debug(`[sidecar] Creating HTTP executor for custom tool: name=${tool.name}, method=${httpConfig.method}, url=${httpConfig.url}`);
        const { http: _http, execute: _exec, ...rest } = tool;
        return {
          ...rest,
          label: tool.name,
          description: tool.description || "",
          parameters: tool.parameters || {},
          execute: async (
            _toolCallId: string,
            params: Record<string, any>,
            signal: AbortSignal | undefined,
          ) => {
            const text = await httpExecutor(params, signal);
            return {
              content: [{ type: "text" as const, text }],
              details: {},
            };
          },
        };
      }
      return tool;
    }).filter((t): t is NonNullable<typeof t> => t != null);

    const tools = options.tools ?? [...DEFAULT_TOOLS];
    // Fast-fail when the subagent extension file is missing before we build a loader.
    // Actual load success is verified after reload() below.
    if (tools.includes("subagent") && !subagentPathFound) {
      throw httpError(
        "Tool 'subagent' was requested but the subagent extension could not be loaded. Check logs for details.",
        400,
      );
    }
    // Include custom tool names in the allowed tools list so the SDK
    // doesn't filter them out via allowedToolNames.
    const customToolNames = customTools.map((t: any) => t.name as string);
    const allToolNames = [...tools, ...customToolNames];
    logger.debug(`[sidecar] Tools configured: builtin=${JSON.stringify(tools)}, custom=${customTools.length} (${customToolNames.join(",")}), allAllowed=${JSON.stringify(allToolNames)}`);

    const settingsManager = createSessionSettingsManager();

    // The Pi SDK's DefaultResourceLoader automatically discovers project-level resources
    // from {cwd}/.pi/ — including skills, prompts, extensions, and themes.
    // It also loads AGENTS.md from {cwd}/ root as project agent instructions.
    // Callers control resource loading by setting `cwd` to a directory containing these files.
    // agent_dir here is per-session ResourceLoader state only (user-level skills/prompts/
    // agents). It does not reconfigure the shared internal registrar / ModelRuntime
    // (those always use INTERNAL_AGENT_DIR — see ensureInternalRuntime / AGENTS.md §6).
    const agentDir = options.agentDir ?? "/tmp/pi-sidecar-agent";
    if (agentDir !== INTERNAL_AGENT_DIR) {
      logger.debug(
        `[sidecar] SESSION_AGENT_DIR: session=${id}, agentDir=${agentDir}, note=per_session_resources_only_shared_runtime_uses_${INTERNAL_AGENT_DIR}`,
      );
    }
    const loader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: extensionPaths,
      systemPromptOverride: () => options.systemPrompt,
    });
    await loader.reload();

    if (tools.includes("subagent")) {
      const extResult = loader.getExtensions();
      const subagentLoaded = extResult.extensions.some(
        (ext) =>
          ext.tools.has("subagent") ||
          ext.path === SUBAGENT_EXTENSION ||
          ext.resolvedPath === SUBAGENT_EXTENSION,
      );
      if (!subagentLoaded) {
        const loadError = extResult.errors.find(
          (e) =>
            e.path === SUBAGENT_EXTENSION ||
            e.path.includes("subagent") ||
            (SUBAGENT_EXTENSION !== "" && e.path.endsWith("examples/extensions/subagent/index.ts")),
        );
        logger.error(
          `[sidecar] SUBAGENT_LOAD_FAILED: path=${SUBAGENT_EXTENSION}, error=${loadError?.error ?? "extension_not_in_loader_result"}`,
        );
        throw httpError(
          "Tool 'subagent' was requested but the subagent extension could not be loaded. Check logs for details.",
          400,
        );
      }
    }

    logger.debug(`[sidecar] Session setup: id=${id}, extensions=${extensionPaths.length}, tools=${customTools.length} custom, cwd=${options.cwd}`);

    const { session } = await createAgentSession({
      cwd: options.cwd,
      model,
      thinkingLevel: "off",
      tools: allToolNames as string[],
      customTools,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      modelRuntime: this.modelRuntime!,
    });

    // Re-check after awaits: disposeAll() may have run while we were creating.
    // Discard the orphan session instead of leaking it past shutdown.
    if (this._disposed) {
      try {
        session.dispose();
      } catch (err) {
        logger.warn(`[sidecar] SESSION_ORPHAN_DISPOSE_FAILED: session=${id}`, err);
      }
      throw httpError("Sidecar is shutting down", 503);
    }

    this.sessions.set(id, { session, lastActivity: Date.now(), inFlight: false, cwd: options.cwd });
    logger.log(`[sidecar] Session created: ${id} (provider=${options.provider}, model=${options.model}, cwd=${options.cwd}, tools=${tools.join(",")}, customTools=${customTools.length})`);
    return id;
  }

  async prompt(id: string, message: string): Promise<{ text: string; usage: any; error?: string }> {
    this.assertNotDisposed("prompt");
    const entry = this.sessions.get(id);
    if (!entry) throw new Error(`Session ${id} not found`);

    if (entry.inFlight) {
      throw new Error(`Session ${id} is busy — concurrent prompts are not supported`);
    }

    entry.lastActivity = Date.now();
    entry.inFlight = true;

    logger.log(`[sidecar] Prompt started: session=${id}, message_length=${message.length}, cwd=${entry.cwd}`);

    const errors: string[] = [];
    let errorsDropped = 0;
    let responseText = "";
    let textDeltaCount = 0;
    let assistantMessageCount = 0;
    let messageBoundaries: number[] = [];
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null as number | null, duration_ms: 0 };
    const startTime = Date.now();

    const unsubscribe = entry.session.subscribe((event) => {
      // Pi SDK event types don't export the error variant — cast is necessary
      if ((event as any).type === "error") {
        const errPayload = (event as any).error;
        let errorMsg: string;
        if (typeof errPayload === "string") {
          errorMsg = errPayload;
        } else if (errPayload?.message) {
          errorMsg = errPayload.message;
        } else {
          try {
            errorMsg = JSON.stringify(errPayload);
          } catch {
            errorMsg = "[unstringifiable error]";
          }
        }
        if (errors.length < 10) {
          errors.push(errorMsg);
        } else {
          errorsDropped++;
        }
        logger.error(`[sidecar] Prompt error event: session=${id}, error=${errorMsg}`);
      }
      // Track assistant message boundaries via message_start events.
      // Using message_start instead of object reference comparison because some
      // providers (e.g., Vertex Claude) create new message objects per streaming chunk.
      if (event.type === "message_start" && (event as any).message?.role === "assistant") {
        assistantMessageCount++;
        if (assistantMessageCount > 1 && responseText.length > 0) {
          // Deduplicate: skip if same offset as last boundary (tool-only messages produce no text)
          const lastBoundary = messageBoundaries.length > 0 ? messageBoundaries[messageBoundaries.length - 1] : -1;
          if (responseText.length !== lastBoundary) {
            messageBoundaries.push(responseText.length);
            logger.debug(`[sidecar] MSG_BOUNDARY: session=${id}, deltas=${textDeltaCount}`);
          }
        }
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        responseText += event.assistantMessageEvent.delta;
        textDeltaCount++;
      }
      if (event.type === "agent_end" && event.messages) {
        for (const msg of event.messages) {
          if (msg.role === "assistant" && msg.usage) {
            usage.input_tokens += msg.usage.input || 0;
            usage.output_tokens += msg.usage.output || 0;
            usage.cache_read_tokens += msg.usage.cacheRead || 0;
            usage.cache_write_tokens += msg.usage.cacheWrite || 0;
            if (msg.usage.cost?.total != null) {
              usage.cost_usd = (usage.cost_usd ?? 0) + msg.usage.cost.total;
            }
          }
        }

        // Fallback: if no text_delta was captured, extract from final assistant message
        if (!responseText) {
          const msgSummary = event.messages.map((m: any) => {
            const contentTypes = Array.isArray(m.content)
              ? m.content.map((c: any) => c.type).join(",")
              : typeof m.content;
            return `${m.role}(${contentTypes})`;
          }).join(" → ");
          logger.warn(`[sidecar] No text_delta events captured (${textDeltaCount} deltas). Messages: ${msgSummary}. Extracting from agent_end messages`);
          for (const msg of [...event.messages].reverse()) {
            if (msg.role === "assistant" && msg.content) {
              const textContent = Array.isArray(msg.content)
                ? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
                : typeof msg.content === "string" ? msg.content : "";
              if (textContent) {
                responseText = textContent;
                break;
              }
            }
          }
        }
      }
    });

    try {
      await runWithSessionCwd(entry.cwd, () => entry.session.prompt(message));
    } catch (err: any) {
      logger.error(`[sidecar] Prompt failed: session=${id}, error=${err?.message}`, err);
      // If we captured partial text or error events before the rejection,
      // return structured data instead of throwing — preserves partial state for callers
      if (responseText || errors.length > 0) {
        const rejectionError = err?.message || "Prompt rejected";
        if (errors.length < 10) {
          errors.push(rejectionError);
        } else {
          errorsDropped++;
        }
        // fall through to structured return below
      } else {
        throw err;
      }
    } finally {
      unsubscribe();
      entry.inFlight = false;
      entry.lastActivity = Date.now();
    }

    // Insert \n\n at message boundaries for text responses only.
    // JSON responses must not be modified — the separator would corrupt structured data.
    if (messageBoundaries.length > 0 && responseText.length > 0) {
      // Cheap pre-check: only attempt JSON.parse if response looks like JSON
      const trimmed = responseText.trim();
      const looksLikeJson = (trimmed.charCodeAt(0) === 123 /* { */ && trimmed.charCodeAt(trimmed.length - 1) === 125 /* } */) ||
                            (trimmed.charCodeAt(0) === 91  /* [ */ && trimmed.charCodeAt(trimmed.length - 1) === 93  /* ] */);
      let isJson = false;
      if (looksLikeJson) {
        try {
          JSON.parse(responseText);
          isJson = true;
        } catch {
          // Looks like JSON but isn't — treat as text
        }
      }
      if (!isJson) {
        // Find JSON regions by scanning forward once. Only check openers at top level
        // (not inside strings) and validate balanced regions with JSON.parse.
        const jsonRegions: Array<[number, number]> = [];
        let inStr = false;
        let esc = false;
        for (let si = 0; si < responseText.length; si++) {
          const c = responseText.charCodeAt(si);
          if (esc) { esc = false; continue; }
          if (c === 92 /* \\ */) { esc = true; continue; }
          if (c === 34 /* \" */) { inStr = !inStr; continue; }
          if (inStr) continue;
          if (c === 123 /* { */ || c === 91 /* [ */) {
            const close = c === 123 ? 125 : 93;
            let depth = 1;
            let s2 = false, e2 = false;
            let ei = si + 1;
            for (; ei < responseText.length && depth > 0; ei++) {
              const ch = responseText.charCodeAt(ei);
              if (e2) { e2 = false; continue; }
              if (ch === 92) { e2 = true; continue; }
              if (ch === 34) { s2 = !s2; continue; }
              if (s2) continue;
              if (ch === c) depth++;
              else if (ch === close) depth--;
            }
            if (depth === 0) {
              // Only protect if a boundary actually falls inside this region
              const hasRelevantBoundary = messageBoundaries.some(b => b > si && b < ei);
              if (hasRelevantBoundary) {
                try {
                  JSON.parse(responseText.slice(si, ei));
                  jsonRegions.push([si, ei]);
                  si = ei - 1; // skip past valid JSON region only
                } catch {
                  // Balanced but not valid JSON — don't skip, inner regions may be valid
                }
              } else {
                si = ei - 1; // no boundaries inside, safe to skip
              }
            }
          }
        }

        // Insert \n\n at boundaries that don't fall inside JSON regions
        const parts: string[] = [];
        let prev = 0;
        let applied = 0;
        for (const pos of messageBoundaries) {
          const insideJson = jsonRegions.some(([start, end]) => pos > start && pos < end);
          if (!insideJson) {
            parts.push(responseText.slice(prev, pos));
            prev = pos;
            applied++;
          }
        }
        parts.push(responseText.slice(prev));
        responseText = parts.join("\n\n");
        logger.debug(`[sidecar] MSG_BOUNDARIES_APPLIED: session=${id}, applied=${applied}, skipped=${messageBoundaries.length - applied}`);
      } else {
        logger.debug(`[sidecar] MSG_BOUNDARIES_SKIPPED: session=${id}, count=${messageBoundaries.length}, reason=json_response`);
      }
    }

    usage.duration_ms = Date.now() - startTime;
    logger.log(`[sidecar] PROMPT_COMPLETED: session=${id}, text_length=${responseText.length}, deltas=${textDeltaCount}, tokens_in=${usage.input_tokens}, tokens_out=${usage.output_tokens}, duration_ms=${usage.duration_ms}`);

    // If we got errors from the AI, surface them
    if (errors.length > 0) {
      const errorText = errors.join("; ") + (errorsDropped > 0 ? ` [+${errorsDropped} more]` : "");
      logger.error(`[sidecar] Prompt completed with errors: session=${id}, errors=${errorText}`);
      return { text: responseText, usage, error: errorText };
    }

    // Empty text is valid for tool-only responses — warn but don't error
    if (!responseText) {
      logger.warn(`[sidecar] AI returned empty text: session=${id}, tokens_in=${usage.input_tokens}, tokens_out=${usage.output_tokens}`);
    }

    return { text: responseText, usage };
  }

  async abort(id: string): Promise<void> {
    this.assertNotDisposed("abort");
    const entry = this.sessions.get(id);
    if (!entry) throw new Error(`Session ${id} not found`);
    logger.debug(`[sidecar] Aborting session: ${id}, inFlight=${entry.inFlight}`);
    await entry.session.abort();
    logger.info(`[sidecar] Session aborted: ${id}`);
  }

  /** Disposes only the user AgentSession — never the internal registrar runtime. */
  delete(id: string): boolean {
    const entry = this.sessions.get(id);
    if (!entry) {
      logger.debug(`[sidecar] SESSION_DELETE: result=no-op, session=${id}, reason=not_found`);
      return false;
    }
    entry.session.dispose();
    this.sessions.delete(id);
    logger.log(`[sidecar] SESSION_DELETE: result=disposed, session=${id}`);
    return true;
  }

  /**
   * Dispose all user sessions, then the internal runtime — in that order.
   * User sessions' `AgentSession.dispose()` does not emit `session_shutdown`
   * and is safe at any time. The internal runtime's `AgentSessionRuntime.dispose()`
   * does emit it (see the internalRuntime field docstring), so it must be last:
   * disposing it earlier would clear the unified Providers extension's
   * module-level state while user sessions might still be relying on models
   * resolved from it.
   *
   * Sets `_disposed = true` as the very first step, before any teardown work
   * runs, so that concurrent/in-flight callers of ensureInternalRuntime()/create()/
   * getModels()/refreshModels()/getProviderStatus() start rejecting immediately
   * instead of racing the teardown or (worse) recreating the internal runtime
   * after it's gone. Idempotent — safe to call more than once.
   */
  async disposeAll(): Promise<void> {
    this._disposed = true;

    // Await in-flight ensureInternalRuntime() so a runtime that finishes after
    // `_disposed` is set is still assigned (or orphan-disposed) before we tear
    // down — otherwise we could return while createAgentSessionRuntime is still
    // running and leak the registrar forever.
    if (this.runtimeInit) {
      try {
        await this.runtimeInit;
      } catch (err) {
        logger.warn(`[sidecar] RUNTIME_INIT_AWAIT_ON_DISPOSE_FAILED: reason=await_error`, err);
      }
    }

    let count = 0;
    for (const [id, entry] of this.sessions) {
      logger.log(`[sidecar] SESSION_DISPOSE: session=${id}`);
      try {
        entry.session.dispose();
      } catch (err) {
        logger.warn(`[sidecar] SESSION_DISPOSE_FAILED: session=${id}`, err);
      }
      count++;
    }
    this.sessions.clear();
    logger.info(`[sidecar] SESSIONS_DISPOSED: count=${count}`);

    if (this.internalRuntime) {
      try {
        await this.internalRuntime.dispose();
        logger.info(`[sidecar] INTERNAL_RUNTIME_DISPOSED: ok=true`);
      } catch (err) {
        // Best-effort: clear refs even if dispose throws so shutdown can finish.
        logger.error(`[sidecar] INTERNAL_RUNTIME_DISPOSE_FAILED:`, err);
      }
      this.internalRuntime = undefined;
    }
    this.modelRuntime = undefined;
    this.modelRegistry = undefined;
    this.runtimeInit = undefined;
  }

  cleanupStale(maxAge: number): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, entry] of this.sessions) {
      if (entry.inFlight) continue;
      if (now - entry.lastActivity > maxAge) {
        logger.log(`[sidecar] Cleaning up stale session: ${id}`);
        entry.session.dispose();
        this.sessions.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info(`[sidecar] Stale session cleanup: removed ${cleaned} session(s), ${this.sessions.size} remaining`);
    } else {
      logger.debug(`[sidecar] Stale session cleanup: none stale, ${this.sessions.size} active`);
    }
    return cleaned;
  }
}
