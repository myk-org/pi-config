/**
 * ProviderDriverRegistry — runtime registry for driver instances.
 *
 * Adapted from t3code's `ProviderInstanceRegistryLive.ts`. Uses plain
 * TypeScript (no Effect dependency) — Maps and async functions replace
 * Effect Refs and Scopes.
 *
 * Materializes every entry from a config map:
 *   - Known driver + valid config → `probe()` → `create()` → live instance
 *   - Known driver + failed probe → unavailable shadow snapshot
 *   - Known driver + failed config decode → unavailable shadow snapshot
 *   - Known driver + failed create → unavailable shadow snapshot
 *   - Unknown driver → unavailable shadow snapshot
 *
 * Every live instance owns its own state (no shared mutables). Tearing
 * down one instance cannot affect another. `teardownAll()` disposes
 * every instance in reverse-registration order.
 *
 * @module shared/provider-registry
 */

import type {
  AnyProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
} from "./provider-driver.js";
import {
  ProviderDriverError,
  ProviderInstanceNotFoundError,
  ProviderValidationError,
  buildUnavailableSnapshot,
  type UnavailableProviderSnapshot,
} from "./provider-errors.js";
import { fileLog } from "./file-logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Live registry entry: the materialized instance + the original config. */
interface LiveEntry {
  readonly instance: ProviderInstance;
  readonly rawConfig: unknown;
}

/** Config for one instance (from settings). */
export interface ProviderInstanceConfig {
  readonly driver: string;
  readonly displayName?: string;
  readonly enabled?: boolean;
  readonly config?: unknown;
}

/** Config map keyed by instance id. */
export type ProviderInstanceConfigMap = Record<string, ProviderInstanceConfig>;

/** Change listener callback. */
export type RegistryChangeListener = () => void;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const LOG_DOMAIN = "provider-registry";

/**
 * ProviderDriverRegistry — owns the lifecycle of all provider instances.
 *
 * ```ts
 * const registry = new ProviderDriverRegistry();
 * registry.registerDriver(claudeDriver);
 * registry.registerDriver(cursorCliDriver);
 * await registry.reconcile(configMap, cwd);
 * const instance = registry.getInstance("cli-cursor");
 * await registry.teardownAll();
 * ```
 */
export class ProviderDriverRegistry {
  private readonly drivers = new Map<string, AnyProviderDriver>();
  private readonly entries = new Map<string, LiveEntry>();
  private readonly unavailable = new Map<string, UnavailableProviderSnapshot>();
  private readonly changeListeners = new Set<RegistryChangeListener>();

  // -------------------------------------------------------------------------
  // Driver registration
  // -------------------------------------------------------------------------

  /** Register a driver. Replaces any existing driver with the same `driverKind`. */
  registerDriver(driver: AnyProviderDriver): void {
    this.drivers.set(driver.driverKind, driver);
  }

  /** Get a registered driver by kind. */
  getDriver(driverKind: string): AnyProviderDriver | undefined {
    return this.drivers.get(driverKind);
  }

  /** List all registered driver kinds. */
  listDriverKinds(): string[] {
    return [...this.drivers.keys()];
  }

  // -------------------------------------------------------------------------
  // Instance access
  // -------------------------------------------------------------------------

  /** Look up one instance by id. Returns undefined when not found. */
  getInstance(instanceId: string): ProviderInstance | undefined {
    return this.entries.get(instanceId)?.instance;
  }

  /** Every available (successfully created) instance, in registration order. */
  listInstances(): ProviderInstance[] {
    return [...this.entries.values()].map((e) => e.instance);
  }

  /** Shadow snapshots for instances whose driver is unknown or failed. */
  listUnavailable(): UnavailableProviderSnapshot[] {
    return [...this.unavailable.values()];
  }

  /**
   * Get snapshot for an instance — real if live, shadow if unavailable.
   * Returns undefined if the instance id is completely unknown.
   */
  getSnapshot(instanceId: string): ProviderSnapshot | UnavailableProviderSnapshot | undefined {
    const live = this.entries.get(instanceId);
    if (live) return live.instance.snapshot.getSnapshot();
    return this.unavailable.get(instanceId);
  }

  /** True if instance exists (live or unavailable). */
  hasInstance(instanceId: string): boolean {
    return this.entries.has(instanceId) || this.unavailable.has(instanceId);
  }

  // -------------------------------------------------------------------------
  // Change notification
  // -------------------------------------------------------------------------

  /** Subscribe to registry changes. Returns unsubscribe function. */
  onChange(listener: RegistryChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch {
        /* ignore listener errors */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  /**
   * Reconcile the registry against a config map. Tears down removed/changed
   * instances, builds new ones. Unchanged instances are kept as-is.
   *
   * Adapted from t3code's `makeReconcile`.
   */
  async reconcile(configMap: ProviderInstanceConfigMap, cwd: string): Promise<void> {
    const nextKeys = new Set(Object.keys(configMap));

    // 1. Identify removed and changed instances
    const toRemove: string[] = [];
    const toReplace = new Set<string>();

    for (const [instanceId, entry] of this.entries) {
      if (!nextKeys.has(instanceId)) {
        toRemove.push(instanceId);
        continue;
      }
      const nextConfig = configMap[instanceId];
      if (nextConfig && !this.configEqual(entry.rawConfig, nextConfig)) {
        toReplace.add(instanceId);
      }
    }

    // Also remove unavailable entries that disappeared from config
    let changed = toRemove.length > 0;
    for (const instanceId of this.unavailable.keys()) {
      if (!nextKeys.has(instanceId)) {
        this.unavailable.delete(instanceId);
        changed = true;
      }
    }

    // 2. Tear down removed/replaced instances
    for (const id of [...toRemove, ...toReplace]) {
      await this.teardownInstance(id);
    }

    // 3. Build new and replaced instances

    for (const [instanceId, config] of Object.entries(configMap)) {
      // Skip unchanged live entries
      if (this.entries.has(instanceId) && !toReplace.has(instanceId)) {
        continue;
      }

      const result = await this.buildEntry(instanceId, config, cwd);
      if (result.kind === "live") {
        this.entries.set(instanceId, result.live);
        this.unavailable.delete(instanceId);
      } else {
        this.unavailable.set(instanceId, result.snapshot);
        this.entries.delete(instanceId);
      }
      changed = true;
    }

    if (changed) {
      this.notifyChange();
    }
  }

  /**
   * Create a single instance from a config entry. Does not add to the
   * registry — use `reconcile()` for that. Exported for direct use when
   * building instances one at a time during extension load.
   */
  async createInstance(
    instanceId: string,
    config: ProviderInstanceConfig,
    cwd: string,
  ): Promise<ProviderInstance> {
    const result = await this.buildEntry(instanceId, config, cwd);
    if (result.kind === "unavailable") {
      throw new ProviderDriverError({
        driver: config.driver,
        instanceId,
        detail: result.snapshot.reason,
      });
    }
    this.entries.set(instanceId, result.live);
    this.notifyChange();
    return result.live.instance;
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /** Tear down one instance by id. No-op if not found. */
  async teardownInstance(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    try {
      await entry.instance.dispose();
    } catch (err) {
      fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN, `dispose failed for ${id}:`, err);
    }
  }

  /** Tear down all instances (reverse order). Clears unavailable entries. */
  async teardownAll(): Promise<void> {
    const ids = [...this.entries.keys()].reverse();
    for (const id of ids) {
      await this.teardownInstance(id);
    }
    this.unavailable.clear();
    this.notifyChange();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private configEqual(
    prev: unknown,
    next: ProviderInstanceConfig,
  ): boolean {
    try {
      return JSON.stringify(prev) === JSON.stringify(next);
    } catch {
      return false;
    }
  }

  private async buildEntry(
    instanceId: string,
    config: ProviderInstanceConfig,
    cwd: string,
  ): Promise<
    | { readonly kind: "live"; readonly live: LiveEntry }
    | { readonly kind: "unavailable"; readonly snapshot: UnavailableProviderSnapshot }
  > {
    const driver = this.drivers.get(config.driver);

    // Unknown driver → unavailable
    if (!driver) {
      fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
        `${instanceId}: driver '${config.driver}' not registered`);
      return {
        kind: "unavailable",
        snapshot: buildUnavailableSnapshot({
          instanceId,
          driverKind: config.driver,
          displayName: config.displayName,
          reason: `Driver '${config.driver}' is not registered in this build.`,
        }),
      };
    }

    // Validate config
    let typedConfig: unknown;
    try {
      const rawConfig = config.config ?? driver.defaultConfig();
      typedConfig = driver.configSchema.parse(rawConfig);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
        `${instanceId}: config validation failed: ${detail}`);
      return {
        kind: "unavailable",
        snapshot: buildUnavailableSnapshot({
          instanceId,
          driverKind: config.driver,
          displayName: config.displayName,
          reason: `Invalid config for '${instanceId}': ${detail}`,
        }),
      };
    }

    // Probe
    try {
      const probeResult = await driver.probe(typedConfig);
      if (!probeResult.available) {
        fileLog(LOG_DOMAIN, "info", LOG_DOMAIN,
          `${instanceId}: probe unavailable — ${probeResult.reason || "unknown reason"}`);
        return {
          kind: "unavailable",
          snapshot: buildUnavailableSnapshot({
            instanceId,
            driverKind: config.driver,
            displayName: config.displayName,
            reason: probeResult.reason || `${config.driver} is not available`,
          }),
        };
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
        `${instanceId}: probe threw: ${detail}`);
      return {
        kind: "unavailable",
        snapshot: buildUnavailableSnapshot({
          instanceId,
          driverKind: config.driver,
          displayName: config.displayName,
          reason: `Probe failed: ${detail}`,
        }),
      };
    }

    // Create instance
    try {
      const instance = await driver.create({
        instanceId,
        displayName: config.displayName,
        enabled: config.enabled ?? true,
        config: typedConfig,
        cwd,
      });
      return { kind: "live", live: { instance, rawConfig: config } };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      fileLog(LOG_DOMAIN, "warn", LOG_DOMAIN,
        `${instanceId}: create failed: ${detail}`);
      return {
        kind: "unavailable",
        snapshot: buildUnavailableSnapshot({
          instanceId,
          driverKind: config.driver,
          displayName: config.displayName,
          reason: `Driver '${config.driver}' failed to create instance: ${detail}`,
        }),
      };
    }
  }
}
