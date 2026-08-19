/**
 * Per-turn session cwd ALS (#768). Same Symbol.for key as
 * extensions/shared/session-cwd.ts so jiti-loaded providers see this store.
 *
 * Sidecar cannot import the extension file (tsconfig rootDir is src/).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "./logger.js";

/** Must match extensions/shared/session-cwd.ts — do not change one copy. */
export const SESSION_CWD_ALS_ID = "pi-config.sessionCwdAls";
const ALS_KEY = Symbol.for(SESSION_CWD_ALS_ID);

function getAls(): AsyncLocalStorage<string> {
  const g = globalThis as unknown as Record<
    symbol,
    AsyncLocalStorage<string> | undefined
  >;
  let als = g[ALS_KEY];
  if (!als) {
    als = new AsyncLocalStorage<string>();
    g[ALS_KEY] = als;
    logger.debug("[sidecar] session cwd ALS created on globalThis");
  }
  return als;
}

/** Run fn with cwd bound for the full async tree of session.prompt(). */
export function runWithSessionCwd<T>(cwd: string, fn: () => T): T {
  if (typeof cwd !== "string" || cwd.length === 0) {
    logger.warn("[sidecar] runWithSessionCwd empty cwd; running unbound");
    return fn();
  }
  logger.debug(`[sidecar] runWithSessionCwd cwd=${cwd}`);
  return getAls().run(cwd, fn);
}
