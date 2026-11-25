export {
  SessionStore,
  PiProviderRuntime,
  type SessionStoreOptions,
  type ProviderRuntime,
  type PiProviderRuntimeOptions,
  type StoredSession,
  type ProviderStatus,
  type DiscoveredProvider,
  type DiscoveredModel,
  type KeyScopedModel,
  type KeyScopedModelsResult,
  type CreateRuntimeSessionInput,
  type CreatedRuntimeSession,
  type CreateSessionOptions,
  type CustomToolConfig,
  type PromptResult,
  type PromptUsage,
  DEFAULT_TOOLS,
  isValidRequestId,
  MAX_REQUEST_ID_LENGTH,
  MAX_REQUEST_CACHE_ENTRIES,
  resolveInternalAgentDir,
  INTERNAL_AGENT_DIR,
} from "./sessions.js";
export { startWatchdog, type WatchdogOptions } from "./watchdog.js";
export { createHttpToolExecutor, normalizeHttpToolConfig, interpolate, type HttpToolConfig } from "./http-tool-executor.js";
export { createLogger } from "./logger.js";

import { createServer } from "node:http";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SessionStore, resolveInternalAgentDir } from "./sessions.js";
import { startWatchdog, type WatchdogOptions } from "./watchdog.js";
import { assertPiVersionFloor } from "./pi-version.js";
import { createLogger, logger } from "./logger.js";
import { ensureSidecarPortEnv, resolveSidecarListenPort } from "./sidecar-port.js";
import { createRequestHandler } from "./request-handler.js";
import { performShutdown } from "./shutdown.js";

// Public HTTP surface stays exported from this entry point; implementations
// live in http-helpers.ts (#1126).
export {
  BadRouteParamError,
  isAllowedStreamRequest,
  isLoopbackBindHost,
  parseBody,
  redactProviderStatusAuth,
  routeMatch,
  sanitizeForLog,
  sendJson,
} from "./http-helpers.js";

export interface SidecarHandle {
  close(): Promise<void>;
}

/** Why the sidecar HTTP server stopped. `fatal` means the process should exit nonzero. */
export interface SidecarStopResult {
  reason: string;
  fatal: boolean;
}

/** Handle returned by `startSidecar()` — adds listen readiness without changing `SidecarHandle`. */
export interface StartedSidecarHandle extends SidecarHandle {
  /** Resolves when the HTTP server is listening; rejects on async bind failure. */
  ready: Promise<void>;
  /** Settles when shutdown finishes. `fatal` is true for listen/server/watchdog failures. */
  stopped: Promise<SidecarStopResult>;
}

export function startSidecar(options?: {
  port?: number;
  host?: string;
  watchdogUrl?: string;
  watchdogOptions?: WatchdogOptions;
  /**
   * Agent dir the internal runtime reads models.json/auth.json/settings.json
   * from (custom pi providers, credentials, and settings for deployments).
   * settings.json is read once at process start — restart to apply changes.
   * Falls back to PI_SIDECAR_AGENT_DIR, then /tmp/pi-sidecar-agent.
   */
  agentDir?: string;
  /** Test hook: runs after TCP listen and before `ready` resolves. */
  beforeListenReady?: () => void | Promise<void>;
}): StartedSidecarHandle {
  const log = createLogger("startSidecar");
  // Fail fast on a stale SDK install rather than surfacing confusing runtime
  // errors later.
  assertPiVersionFloor();

  // --- Subagent subprocess compatibility ---
  // PATH fix applied here so programmatic consumers also get it.
  // The argv[1] fix is in server.ts (CLI entry only).

  // Strip the sidecar's own node_modules/.bin from PATH so the subagent extension
  // spawns the globally installed `pi` binary, not the local dependency (which may
  // be a different version and cause extension loading errors in the subprocess).
  // Derive sidecar root from import.meta.url (not process.cwd()) to avoid stripping
  // a project's node_modules/.bin when the sidecar is started from a project directory.
  if (process.env.PATH) {
    const sidecarRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    // Collect sidecar's own .bin and any ancestor node_modules/.bin that might
    // contain a hoisted pi binary from this sidecar's dependency tree.
    const sidecarBins = new Set<string>();
    sidecarBins.add(resolve(join(sidecarRoot, "node_modules", ".bin")));
    let ancestor = dirname(sidecarRoot);
    while (true) {
      const candidate = resolve(join(ancestor, "node_modules", ".bin"));
      // Only include if the ancestor contains a pi binary
      const piShim = join(candidate, "pi");
      try {
        if (statSync(piShim).isFile()) sidecarBins.add(candidate);
      } catch (e: any) {
        if (e?.code && e.code !== "ENOENT") {
          logger.debug(`[sidecar] PATH_ANCESTOR_CHECK_FAILED: path=${piShim}, error=${e.code}`);
        }
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const parts = process.env.PATH.split(delimiter);
    const kept = parts.filter((p) => {
      if (!p || !isAbsolute(p)) return true;
      try { return !sidecarBins.has(resolve(p)); } catch { return true; }
    });
    const stripped = parts.length - kept.length;
    if (stripped > 0) {
      // Only strip if `pi` is still reachable on the remaining PATH.
      // Check for platform-appropriate executable names (pi, pi.cmd, pi.exe).
      const piNames = process.platform === "win32"
        ? ["pi.cmd", "pi.exe", "pi"]
        : ["pi"];
      const piReachable = kept.some((dir) => {
        if (!dir || !isAbsolute(dir)) return false;
        return piNames.some((name) => {
          try { return statSync(join(dir, name)).isFile(); } catch { return false; }
        });
      });
      if (piReachable) {
        process.env.PATH = kept.join(delimiter);
        logger.debug(`[sidecar] PATH_FILTERED: removed=${stripped}, dirs=${[...sidecarBins].join(";")}`);  // semicolon-separated to avoid breaking key=value format
      } else {
        logger.debug(`[sidecar] PATH_FILTER_SKIPPED: dirs=${[...sidecarBins].join(";")}, reason=pi_not_found_elsewhere`);
      }
    }
  }

  const PORT = resolveSidecarListenPort(options?.port);
  const releaseSidecarPortEnv = ensureSidecarPortEnv(PORT);
  log.info(`startSidecar listenPort=${PORT}`);
  // Precedence: explicit options.host → SIDECAR_HOST (start-sidecar.sh) → DEV_MODE → localhost.
  const HOST =
    options?.host ??
    process.env.SIDECAR_HOST ??
    (process.env.DEV_MODE === "true" ? "0.0.0.0" : "127.0.0.1");
  // Prefer the post-listen address (server.address()) for trust decisions so
  // redaction matches what Node actually bound, not just the config string.
  let trustBindHost = HOST;

  // Internal agent dir for the shared registrar runtime (custom providers/
  // auth/settings). Precedence: explicit option → PI_SIDECAR_AGENT_DIR →
  // /tmp/pi-sidecar-agent (see resolveInternalAgentDir in sessions.ts).
  const agentDir = resolveInternalAgentDir(options?.agentDir);
  log.info(`startSidecar agentDir=${agentDir}`);

  const store = new SessionStore({ agentDir });

  // Set true as the first step of shutdown (close()/watchdog onDead), before
  // server.close() or store.disposeAll() run. New requests hit this check
  // before touching the store, so in-flight teardown never races a request
  // that would otherwise call into a disposed/disposing SessionStore.
  let draining = false;
  // Count handlers that passed the draining gate. Shutdown awaits this
  // reaching 0 (with a timeout) before disposeAll(), so prompt/abort that
  // already entered the handler finish before sessions are torn down.
  let activeRequests = 0;
  // Declared early so shutdownSidecar can clear them; assigned after createServer.
  let cleanupInterval: ReturnType<typeof setInterval> | undefined;
  let stopWatchdog: (() => void) | undefined;
  let settleReady: { resolve: () => void; reject: (err: Error) => void } | undefined;
  let readySettled = false;
  const ready = new Promise<void>((resolve, reject) => {
    settleReady = { resolve, reject };
  });
  let settleStopped: { resolve: (result: SidecarStopResult) => void } | undefined;
  let stoppedSettled = false;
  const stopped = new Promise<SidecarStopResult>((resolve) => {
    settleStopped = { resolve };
  });

  function isFatalShutdown(reason: string): boolean {
    const fatal = reason !== "close";
    log.debug(`isFatalShutdown reason=${reason} fatal=${fatal}`);
    return fatal;
  }

  function resolveListenReady(): void {
    if (readySettled) {
      log.debug("startSidecar ready already settled");
      return;
    }
    readySettled = true;
    log.info("startSidecar listen ready");
    settleReady?.resolve();
  }

  function rejectListenReady(err: Error): void {
    if (readySettled) {
      log.debug("startSidecar ready already settled");
      return;
    }
    readySettled = true;
    log.error(`startSidecar listen failed code=${(err as NodeJS.ErrnoException).code}`);
    settleReady?.reject(err);
  }

  function resolveStopped(reason: string): void {
    if (!readySettled) {
      if (isFatalShutdown(reason)) {
        rejectListenReady(new Error(`sidecar stopped before listen reason=${reason}`));
      } else {
        readySettled = true;
        log.debug(`startSidecar ready resolved on non-fatal shutdown reason=${reason}`);
        settleReady?.resolve();
      }
    }
    if (stoppedSettled) {
      log.debug(`startSidecar stopped already settled reason=${reason}`);
      return;
    }
    stoppedSettled = true;
    const result = { reason, fatal: isFatalShutdown(reason) };
    log.info(`startSidecar stopped reason=${result.reason} fatal=${result.fatal}`);
    settleStopped?.resolve(result);
  }

  // Memoize shutdown so concurrent watchdog + close() share one teardown.
  let shutdownPromise: Promise<void> | undefined;

  async function waitForIdleRequests(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (activeRequests > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (activeRequests > 0) {
      logger.warn(
        `[sidecar] SHUTDOWN_DRAIN_TIMEOUT: activeRequests=${activeRequests}, waited_ms=${timeoutMs}`,
      );
    }
  }

  async function shutdownSidecar(reason: string): Promise<void> {
    if (shutdownPromise) {
      logger.info(`[sidecar] SHUTDOWN_JOIN: reason=${reason}, action=join_in_progress`);
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      draining = true;
      stopWatchdog?.();
      if (cleanupInterval !== undefined) clearInterval(cleanupInterval);
      try {
        // The sequence itself lives in shutdown.ts (#1126) so a unit test can
        // assert its order without a socket.
        await performShutdown({
          reason,
          server,
          closeStreams: () => store.closeAllStreams(),
          waitForIdleRequests,
          disposeStore: () => store.disposeAll(),
        });
      } finally {
        releaseSidecarPortEnv();
        log.info(`startSidecar restored SIDECAR_PORT reason=${reason}`);
        resolveStopped(reason);
      }
    })();
    return shutdownPromise;
  }

  const server = createServer(
    createRequestHandler({
      store,
      isDraining: () => draining,
      getTrustBindHost: () => trustBindHost,
      beginRequest: () => { activeRequests++; },
      endRequest: () => { activeRequests--; },
    }),
  );

  // Stale session cleanup every 10 minutes
  cleanupInterval = setInterval(() => {
    logger.debug(`[sidecar] Running stale session cleanup`);
    const cleaned = store.cleanupStale(60 * 60 * 1000); // 1 hour
    logger.debug(`[sidecar] Stale cleanup result: removed=${cleaned}`);
  }, 10 * 60 * 1000);
  cleanupInterval.unref();

  server.on("error", (err) => {
    const error = err instanceof Error ? err : new Error(String(err));
    const reason = readySettled ? "server_error" : "listen_error";
    log.error(
      `startSidecar server error reason=${reason} code=${(error as NodeJS.ErrnoException).code}`,
    );
    if (!readySettled) {
      rejectListenReady(error);
    }
    void shutdownSidecar(reason);
  });

  try {
    server.listen(PORT, HOST, () => {
      const completeListen = (): void => {
        if (shutdownPromise) {
          log.debug("startSidecar listen callback skipped after shutdown");
          return;
        }
        resolveListenReady();
        const addr = server.address();
        if (addr && typeof addr === "object" && addr.address) {
          trustBindHost = addr.address;
        }
        logger.info(`[sidecar] Pi SDK sidecar listening on http://${HOST}:${PORT}`);
        logger.info(`[sidecar] Config: host=${HOST}, port=${PORT}, trustBindHost=${trustBindHost}, devMode=${process.env.DEV_MODE || 'false'}, logLevel=${process.env.PI_SIDECAR_LOG_LEVEL || 'info'}`);
        const watchdogUrl = options?.watchdogUrl || process.env.SIDECAR_WATCHDOG_URL;
        if (watchdogUrl) {
          logger.info(`[sidecar] Watchdog enabled: url=${watchdogUrl}`);
          stopWatchdog = startWatchdog(watchdogUrl, async () => {
            logger.warn("[sidecar] Backend unresponsive, shutting down");
            await shutdownSidecar("watchdog");
          }, options?.watchdogOptions);
        } else {
          logger.info("[sidecar] Watchdog disabled (no SIDECAR_WATCHDOG_URL)");
        }

        // Auto-discover models from extensions on startup
        store.refreshModels().catch((err) => {
          logger.error("[sidecar] Model discovery failed:", err);
        });
      };
      const gate = options?.beforeListenReady;
      if (!gate) {
        completeListen();
        return;
      }
      log.debug("startSidecar beforeListenReady");
      void Promise.resolve()
        .then(() => gate())
        .then(completeListen, (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(`startSidecar beforeListenReady failed message=${message}`);
          completeListen();
        });
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error("startSidecar listen threw");
    // Do not reject `ready` here: the handle is not returned, so a rejection
    // would be unhandled even when the caller catches this throw.
    void shutdownSidecar("listen_throw");
    throw error;
  }

  return {
    close: async () => {
      await shutdownSidecar("close");
    },
    ready,
    stopped,
  };
}

/** CLI helper: exit 1 on async bind failure or a later fatal server stop. */
export function bindSidecarListenExit(
  handle: StartedSidecarHandle,
  exitProcess: (code: number) => void = (code) => {
    process.exit(code);
  },
): void {
  const log = createLogger("sidecar-cli");
  let exiting = false;
  function exitFatal(message: string): void {
    if (exiting) {
      log.debug(`sidecar-cli exit already requested message=${message}`);
      return;
    }
    exiting = true;
    log.error(message);
    exitProcess(1);
  }
  handle.ready.then(
    () => {
      log.info("sidecar-cli listening");
    },
    (err) => {
      exitFatal(`sidecar-cli listen failed code=${(err as NodeJS.ErrnoException).code}`);
    },
  );
  handle.stopped.then(
    (result) => {
      if (result.fatal) {
        exitFatal(`sidecar-cli stopped reason=${result.reason}`);
        return;
      }
      log.info(`sidecar-cli stopped reason=${result.reason}`);
    },
  );
}
