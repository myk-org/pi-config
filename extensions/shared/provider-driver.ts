/**
 * ProviderDriver / ProviderInstance — driver SPI as plain values.
 *
 * Adapted from t3code's `ProviderDriver.ts`. Uses plain TypeScript
 * (no Effect dependency) — async functions replace Effect monads,
 * try/finally replaces scoped lifecycle.
 *
 * `ProviderDriver` is a record, not a class. The thing it produces
 * (`ProviderInstance`) is also a record — captured closures
 * (`snapshot`, `adapter`), an id, and a driver kind. There are
 * intentionally no singletons because we need many instances of the
 * same driver.
 *
 * Driver factories are functions of `(typed config, env)` where:
 *   - `typed config` is validated once by the registry via `configSchema`,
 *     so drivers never deal with raw `unknown`.
 *   - Cleanup is deterministic: `dispose()` releases every resource the
 *     driver opened (child processes, intervals, pubsub channels).
 *
 * @module shared/provider-driver
 */

// ---------------------------------------------------------------------------
// Stream Events (unified across CLI + ACPX)
// ---------------------------------------------------------------------------

/** Normalized event emitted by driver adapters during a turn. */
export type DriverStreamEvent =
  | { readonly kind: "text_delta"; readonly text: string }
  | { readonly kind: "thinking_delta"; readonly text: string }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "turn_complete"; readonly stopReason?: string };

// ---------------------------------------------------------------------------
// ProviderDriver Metadata
// ---------------------------------------------------------------------------

/**
 * Static metadata advertised by a driver. Used for default presentation
 * and (later) settings UI. Drivers are registered at startup — nothing
 * here is dynamic.
 */
export interface ProviderDriverMetadata {
  /** Human-readable name for the driver itself (e.g. "Cursor CLI"). */
  readonly displayName: string;
  /**
   * Whether the driver may be instantiated more than once concurrently.
   * Defaults to `true`. Set to `false` for drivers that wrap a global
   * resource (e.g. a single desktop app socket) — the registry then
   * rejects multi-instance configurations with a clear error.
   */
  readonly supportsMultipleInstances?: boolean;
}

// ---------------------------------------------------------------------------
// Probe Result
// ---------------------------------------------------------------------------

/**
 * Result of a driver's binary/runtime probe. Returned by `driver.probe()`.
 * When `available` is false, the registry creates an "unavailable" shadow
 * snapshot instead of calling `create()`.
 */
export interface ProviderProbeResult {
  readonly available: boolean;
  readonly version?: string;
  /** Human-readable reason when unavailable (e.g. "binary not on PATH"). */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Provider Snapshot Shape
// ---------------------------------------------------------------------------

/** A point-in-time snapshot of a provider's status and models. */
export interface ProviderSnapshot {
  readonly available: boolean;
  readonly version?: string;
  readonly models: readonly DiscoveredModel[];
  /** Human-readable message (error detail, status, etc.). */
  readonly message?: string;
  readonly checkedAt: string;
}

/** Model discovered by a driver (used in snapshots). */
export interface DiscoveredModel {
  readonly id: string;
  readonly name: string;
}

/**
 * Live snapshot accessor for a provider instance. The registry reads
 * `getSnapshot()` for current state, calls `refresh()` to force a
 * re-probe, and optionally subscribes to `onChange` for push updates.
 */
export interface ProviderSnapshotShape {
  readonly getSnapshot: () => ProviderSnapshot;
  readonly refresh: () => Promise<ProviderSnapshot>;
  /** Optional callback-based change notification. */
  readonly onChange?: (listener: (snapshot: ProviderSnapshot) => void) => () => void;
  /** Cleanup — stop refresh intervals, release resources. */
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Provider Adapter Shape (Session / Turn runtime)
// ---------------------------------------------------------------------------

/** Options for starting a session via the adapter. */
export interface SessionStartOptions {
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly cwd: string;
}

/** Opaque handle to an active adapter session. */
export interface SessionHandle {
  readonly sessionId: string;
  readonly model: string;
  /** Session/project cwd for this turn's CLI/ACPX spawn (#768). */
  readonly cwd?: string;
}

/** Options for sending a turn. */
export interface TurnOptions {
  readonly signal?: AbortSignal;
  /** Pi conversation context — used by drivers that seed history into fresh CLI sessions. */
  readonly context?: { messages: Array<{ role: string; content: any }> };
  readonly onEvent?: (event: DriverStreamEvent) => void;
}

/** Per-turn token usage and cost breakdown. */
export interface DriverUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedReadTokens?: number;
  readonly cachedWriteTokens?: number;
  readonly thoughtTokens?: number;
  readonly totalTokens?: number;
  /** USD cost when the provider reports it (Claude CLI, ACPX). */
  readonly costUsd?: number;
}

/** Result of a completed turn. */
export interface TurnResult {
  readonly text: string;
  readonly thinking?: string;
  readonly sessionId?: string;
  readonly stopReason?: string;
  readonly usage?: DriverUsage;
}

/**
 * Provider-specific runtime adapter contract — session/turn operations.
 *
 * Adapted from t3code's `ProviderAdapterShape`. Simplified to async
 * functions (no Effect monads). Drivers own session state; the registry
 * owns instance lifecycle.
 */
export interface ProviderAdapterShape {
  /** Start a new session or resume an existing one. */
  readonly startSession: (opts: SessionStartOptions) => Promise<SessionHandle>;

  /** Send a turn (prompt) to an active session. */
  readonly sendTurn: (
    handle: SessionHandle,
    prompt: string,
    opts?: TurnOptions,
  ) => Promise<TurnResult>;

  /** Stop one session. */
  readonly stopSession: (handle: SessionHandle) => Promise<void>;

  /** Stop all sessions owned by this adapter. */
  readonly stopAll: () => Promise<void>;

  /** Check whether this adapter owns an active session id. */
  readonly hasSession: (sessionId: string) => boolean;
}

// ---------------------------------------------------------------------------
// Provider Instance
// ---------------------------------------------------------------------------

/**
 * One materialized provider instance. Held by the registry, looked up by
 * `instanceId`, torn down by calling `dispose()`.
 *
 * The two "shape" fields are captured closures owned by this instance —
 * stopping one instance cannot affect another, and starting a second
 * instance of the same driver does not reach into the first instance's
 * state.
 */
export interface ProviderInstance {
  readonly instanceId: string;
  readonly driverKind: string;
  readonly displayName?: string;
  readonly enabled: boolean;
  /** Status/models/health — refreshable. */
  readonly snapshot: ProviderSnapshotShape;
  /** Session/turn runtime. */
  readonly adapter: ProviderAdapterShape;
  /** Cleanup — called when instance is torn down. Releases all resources. */
  readonly dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Provider Driver Create Input
// ---------------------------------------------------------------------------

/**
 * Inputs the registry passes to a driver's `create` function.
 *
 * `config` is the typed payload — already validated by the registry through
 * `driver.configSchema`. Drivers never validate their own raw envelope.
 */
export interface ProviderDriverCreateInput<Config> {
  readonly instanceId: string;
  readonly displayName?: string;
  readonly enabled: boolean;
  readonly config: Config;
  readonly cwd: string;
}

// ---------------------------------------------------------------------------
// Config Schema (validation interface)
// ---------------------------------------------------------------------------

/**
 * Minimal config validation interface. Drivers provide a `parse(unknown)`
 * that either returns a typed config or throws. Works with zod schemas
 * or any hand-rolled validator.
 *
 * ```ts
 * const schema: ConfigSchema<MyConfig> = {
 *   parse: (raw) => { ... validate and return MyConfig ... },
 * };
 * ```
 */
export interface ConfigSchema<Config> {
  /** Decode unknown input into typed Config. Throws on validation failure. */
  readonly parse: (raw: unknown) => Config;
}

// ---------------------------------------------------------------------------
// Provider Driver SPI
// ---------------------------------------------------------------------------

/**
 * Driver SPI — registered as a plain value, not a class.
 *
 * `Config` is whatever the driver decoded from settings. `create` is
 * responsible for *all* per-instance state — process handles, intervals,
 * file watchers — and must release them when `dispose()` is called on the
 * returned instance. Two calls to `create` with different `instanceId` /
 * `config` MUST yield instances with no shared mutable state.
 */
export interface ProviderDriver<Config> {
  readonly driverKind: string;
  readonly metadata: ProviderDriverMetadata;
  /**
   * Validator for the opaque config envelope. The registry runs this
   * exactly once per (re)load of an instance; a validation failure is
   * surfaced as `ProviderDriverError` and downgraded to an unavailable
   * shadow snapshot.
   */
  readonly configSchema: ConfigSchema<Config>;
  /**
   * Default config payload used when settings are empty or when the driver
   * is auto-bootstrapped without user configuration.
   */
  readonly defaultConfig: () => Config;
  /**
   * Probe binary/runtime availability + basic status. Called before
   * `create()` — when `available` is false, the registry synthesizes an
   * "unavailable" shadow snapshot.
   */
  readonly probe: (config: Config) => Promise<ProviderProbeResult>;
  /**
   * Materialize one instance. The returned instance owns all per-instance
   * state. Failures throw `ProviderDriverError` — the registry catches
   * them and downgrades to an unavailable shadow snapshot.
   *
   * Two calls to `create` with different `instanceId` / `config` MUST
   * yield instances with no shared mutable state.
   */
  readonly create: (
    input: ProviderDriverCreateInput<Config>,
  ) => Promise<ProviderInstance>;
}

/**
 * Heterogeneous-array convenience: the registry stores drivers as
 * `AnyProviderDriver[]` where the per-driver Config is erased.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyProviderDriver = ProviderDriver<any>;
