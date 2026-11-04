/**
 * Cross-module bridge for the pitasks store.
 *
 * `pitasks` exports `taskStore` as `export let`, assigned when the extension
 * initializes. Another extension's module instance cannot read that binding: it
 * snapshots `undefined` at import time, which silently disabled task-id validation
 * (issue #1016). The store is therefore published on the global symbol registry, and
 * the published object reads the live binding on every access — publishing once is
 * enough, and a store swap needs no republish.
 *
 * Publish only from the instance that owns the store (pitasks registration), never from
 * module-load code: a duplicate import would otherwise displace the real getter with one
 * bound to a store that instance never creates.
 *
 * Same pattern as the pricing-provenance and session-cwd markers.
 */
import { createLogger } from "./logger.js";

const log = createLogger("task-store-bridge");

export const TASK_STORE_SYMBOL = Symbol.for("pi-config.taskStore");

interface TaskStoreBridge {
  readonly current: unknown;
}

/** Publish a getter over the live store binding. Called by the owning extension. */
export function publishTaskStore(getStore: () => unknown): void {
  (globalThis as Record<symbol, unknown>)[TASK_STORE_SYMBOL] = {
    get current(): unknown {
      return getStore();
    },
  } satisfies TaskStoreBridge;
  log.debug("task_store_bridge_published", { at: Date.now() });
}

/** The published store, or null when the owning extension has not registered. */
export function publishedTaskStore(): unknown {
  const bridge = (globalThis as Record<symbol, unknown>)[TASK_STORE_SYMBOL] as TaskStoreBridge | undefined;
  const store = bridge?.current ?? null;
  log.debug("task_store_bridge_read", { found: Boolean(store) });
  return store;
}
