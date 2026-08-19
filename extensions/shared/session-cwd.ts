/**
 * Per-turn session cwd for CLI/ACPX spawn (#768).
 *
 * Pi stream() has no cwd. Sidecar sessions and extension before_agent_start
 * stash the folder here. Drivers read it instead of process.cwd() from boot.
 *
 * Store lives on globalThis via Symbol.for so jiti, tsx, and sidecar share
 * one AsyncLocalStorage even when this file is loaded more than once.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createLogger } from "./logger.js";

const log = createLogger("providers");

/** Must match packages/pi-sidecar/src/session-cwd.ts — do not change one copy. */
export const SESSION_CWD_ALS_ID = "pi-config.sessionCwdAls";
const ALS_KEY = Symbol.for(SESSION_CWD_ALS_ID);

/** Unit separator — model ids and paths cannot contain this. */
const MEMORY_SEP = "\x1f";

function getAls(): AsyncLocalStorage<string> {
  const g = globalThis as unknown as Record<
    symbol,
    AsyncLocalStorage<string> | undefined
  >;
  let als = g[ALS_KEY];
  if (!als) {
    als = new AsyncLocalStorage<string>();
    g[ALS_KEY] = als;
    log.debug("session cwd ALS created on globalThis");
  }
  return als;
}

/** Cwd bound for the current async turn, if any. */
export function getSessionCwd(): string | undefined {
  const value = getAls().getStore();
  const cwd = typeof value === "string" && value.length > 0 ? value : undefined;
  log.debug(`getSessionCwd bound=${cwd !== undefined}`);
  return cwd;
}

/** Bind cwd for the rest of this async resource (before_agent_start). */
export function enterSessionCwd(cwd: string): void {
  if (typeof cwd !== "string" || cwd.length === 0) {
    log.warn("enterSessionCwd skipped: empty cwd");
    return;
  }
  if (getSessionCwd()) {
    log.debug(`enterSessionCwd skipped: ALS already bound cwd=${getSessionCwd()} incoming=${cwd}`);
    return;
  }
  getAls().enterWith(cwd);
  log.debug(`enterSessionCwd cwd=${cwd}`);
}

/** Run fn with cwd bound for the full async tree (sidecar prompt()). */
export function runWithSessionCwd<T>(cwd: string, fn: () => T): T {
  if (typeof cwd !== "string" || cwd.length === 0) {
    log.warn("runWithSessionCwd empty cwd; running unbound");
    return fn();
  }
  log.debug(`runWithSessionCwd cwd=${cwd}`);
  return getAls().run(cwd, fn);
}

/** Stream path: ALS session cwd, else boot projectCwd. */
export function resolveProviderStreamCwd(bootCwd: string): string {
  const fromAls = getSessionCwd();
  if (fromAls) {
    log.debug(`stream cwd from ALS=${fromAls} boot=${bootCwd}`);
    return fromAls;
  }
  log.warn(`stream cwd fallback boot=${bootCwd} (ALS empty)`);
  return bootCwd;
}

/** Spawn path: handle.cwd from startSession, else adapter create-time cwd. */
export function resolveAdapterCwd(
  handle: { cwd?: string },
  fallback: string,
): string {
  if (typeof handle.cwd === "string" && handle.cwd.length > 0) {
    return handle.cwd;
  }
  return fallback;
}

/** In-memory adapter maps: one entry per model+cwd so sidecar jobs stay isolated. */
export function adapterMemoryKey(model: string | undefined, turnCwd: string): string {
  return `${model || "default"}${MEMORY_SEP}${turnCwd}`;
}

/** True when `key` was built for this cwd via adapterMemoryKey. */
export function adapterMemoryKeyMatchesCwd(key: string, turnCwd: string): boolean {
  return key.endsWith(`${MEMORY_SEP}${turnCwd}`);
}

/** Drop in-memory adapter entries for one session cwd (leave other jobs alone). */
export function deleteKeysForCwd(
  store: { keys(): IterableIterator<string>; delete(key: string): unknown },
  turnCwd: string,
): void {
  for (const k of [...store.keys()]) {
    if (adapterMemoryKeyMatchesCwd(k, turnCwd)) store.delete(k);
  }
}
