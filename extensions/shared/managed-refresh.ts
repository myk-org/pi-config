/**
 * Managed snapshot refresh — periodic re-probe with settings-change detection.
 *
 * Adapted from t3code's `makeManagedServerProvider.ts`. Uses plain
 * TypeScript (setInterval, callbacks) instead of Effect (Fiber, PubSub, Ref).
 *
 * Provides periodic model refresh, settings-change detection, and an
 * enrichment pipeline. All scoped — `dispose()` clears intervals and
 * releases resources.
 *
 * @module shared/managed-refresh
 */

import type { ProviderSnapshot, DiscoveredModel } from "./provider-driver.js";
import { fileLog } from "./file-logger.js";

const LOG_DOMAIN = "managed-refresh";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ManagedSnapshotOptions<Settings = unknown> {
  /** Build the initial snapshot from current settings. */
  readonly initialSnapshot: (settings: Settings) => ProviderSnapshot;

  /** Probe current status (binary version, availability, models). */
  readonly checkProvider: () => Promise<ProviderSnapshot>;

  /** Optional: enrich a snapshot (e.g. model catalog refresh). */
  readonly enrichSnapshot?: (input: {
    readonly settings: Settings;
    readonly snapshot: ProviderSnapshot;
    readonly getSnapshot: () => ProviderSnapshot;
    readonly publishSnapshot: (snapshot: ProviderSnapshot) => void;
  }) => Promise<void>;

  /** Get current settings. */
  readonly getSettings: () => Settings;

  /** Detect meaningful settings changes. */
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;

  /**
   * Refresh interval in milliseconds.
   * Default: 300_000 (5 minutes), matching t3code's SNAPSHOT_REFRESH_INTERVAL.
   */
  readonly refreshIntervalMs?: number;

  /** Optional callback when snapshot changes. */
  readonly onSnapshotChange?: (snapshot: ProviderSnapshot) => void;

  /**
   * Skip the fire-and-forget initial probe on create.
   * Use when the caller already discovered models during create() and
   * passed them via initialSnapshot — avoids duplicate discovery on startup.
   */
  readonly skipInitialRefresh?: boolean;
}

export interface ManagedSnapshotResult {
  /** Get the current snapshot. */
  readonly getSnapshot: () => ProviderSnapshot;
  /** Force a refresh now. */
  readonly refresh: () => Promise<ProviderSnapshot>;
  /** Stop all refresh timers and release resources. */
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_REFRESH_INTERVAL_MS = 300_000; // 5 minutes

/**
 * Create a managed snapshot with periodic refresh and settings-change detection.
 *
 * Adapted from t3code's `makeManagedServerProvider`:
 * - Periodic refresh via `setInterval` (t3code uses `Effect.forever + Effect.sleep`)
 * - Settings-change detection triggers re-probe (t3code uses `Stream.runForEach`)
 * - Enrichment pipeline for model catalog refresh (t3code uses forked fibers)
 * - Deterministic cleanup via `dispose()` (t3code uses `Scope`)
 */
export function makeManagedSnapshot<Settings = unknown>(
  opts: ManagedSnapshotOptions<Settings>,
): ManagedSnapshotResult {
  const refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;

  let currentSnapshot = opts.initialSnapshot(opts.getSettings());
  let previousSettings = opts.getSettings();
  let refreshing = false;
  let disposed = false;
  let enrichmentAbort: AbortController | null = null;

  const publishSnapshot = (snapshot: ProviderSnapshot): void => {
    if (disposed) return;
    currentSnapshot = snapshot;
    opts.onSnapshotChange?.(snapshot);
  };

  const doRefresh = async (forceRefresh = false): Promise<ProviderSnapshot> => {
    if (disposed) return currentSnapshot;
    if (refreshing) return currentSnapshot;
    refreshing = true;

    try {
      const nextSettings = opts.getSettings();
      const settingsChanged = opts.haveSettingsChanged(previousSettings, nextSettings);

      if (!forceRefresh && !settingsChanged) {
        previousSettings = nextSettings;
        return currentSnapshot;
      }

      const nextSnapshot = await opts.checkProvider();
      if (disposed) return currentSnapshot;

      previousSettings = nextSettings;
      publishSnapshot(nextSnapshot);

      // Cancel any previous enrichment
      if (enrichmentAbort) {
        enrichmentAbort.abort();
        enrichmentAbort = null;
      }

      // Run enrichment if provided
      if (opts.enrichSnapshot) {
        enrichmentAbort = new AbortController();
        const capturedSnapshot = nextSnapshot;
        // Fire-and-forget enrichment (t3code forks this as a scoped fiber)
        opts.enrichSnapshot({
          settings: nextSettings,
          snapshot: capturedSnapshot,
          getSnapshot: () => currentSnapshot,
          publishSnapshot,
        }).catch((err) => {
          if (!disposed) {
            fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
              `enrichment failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
      }

      return nextSnapshot;
    } catch (err) {
      if (!disposed) {
        fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
          `refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return currentSnapshot;
    } finally {
      refreshing = false;
    }
  };

  // Initial probe (fire-and-forget, matching t3code's forkScoped initial probe)
  // Skip when the caller already discovered models during create() and passed
  // them via initialSnapshot — avoids duplicate discovery on startup.
  if (!opts.skipInitialRefresh) {
    doRefresh(true).catch((err) => {
      fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
        `initial refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // Periodic refresh
  const timer = setInterval(() => {
    doRefresh(true).catch((err) => {
      fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
        `periodic refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, refreshIntervalMs);

  // Unref so it doesn't keep the process alive
  if (timer.unref) timer.unref();

  return {
    getSnapshot: () => currentSnapshot,
    refresh: () => doRefresh(true),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      if (enrichmentAbort) {
        enrichmentAbort.abort();
        enrichmentAbort = null;
      }
    },
  };
}

/**
 * Build a simple initial snapshot from discovered models.
 * Convenience for drivers that discover models during probe.
 */
export function buildInitialSnapshot(
  available: boolean,
  models: readonly DiscoveredModel[],
  version?: string,
  message?: string,
): ProviderSnapshot {
  return {
    available,
    version,
    models,
    message,
    checkedAt: new Date().toISOString(),
  };
}
