import { logger } from "./logger.js";

export interface WatchdogOptions {
  /** Health check interval in ms (default: 30000 = 30s) */
  intervalMs?: number;
  /** Health check timeout in ms (default: 10000 = 10s) */
  timeoutMs?: number;
  /** Consecutive failures before triggering onDead (default: 6) */
  maxFailures?: number;
  /** Grace period before starting checks in ms (default: 60000 = 60s) */
  startDelayMs?: number;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_FAILURES = 6;
const DEFAULT_START_DELAY_MS = 60_000;

function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.search = "";
    u.hash = "";
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return "[invalid-url]";
  }
}

export function startWatchdog(
  healthUrl: string,
  onDead: () => void | Promise<void>,
  options?: WatchdogOptions,
): () => void {
  const intervalMs = Math.max(options?.intervalMs ?? DEFAULT_INTERVAL_MS, 1000);
  const timeoutMs = Math.max(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000);
  const maxFailures = Math.max(options?.maxFailures ?? DEFAULT_MAX_FAILURES, 1);
  const startDelayMs = Math.max(options?.startDelayMs ?? DEFAULT_START_DELAY_MS, 0);

  logger.info(`[watchdog] Starting watchdog for ${sanitizeUrl(healthUrl)} (grace=${startDelayMs}ms)`);

  let consecutiveFailures = 0;
  let stopped = false;
  let dead = false;
  let checking = false;
  let currentController: AbortController | undefined;
  let currentTimeout: ReturnType<typeof setTimeout> | undefined;
  let intervalId: ReturnType<typeof setInterval> | undefined;

  function startPolling(): void {
    logger.debug(`[watchdog] Grace period ended, starting health checks (interval=${intervalMs}ms, timeout=${timeoutMs}ms, maxFailures=${maxFailures})`);
    intervalId = setInterval(async () => {
      if (stopped || checking) return;
      checking = true;

      try {
        currentController = new AbortController();
        currentTimeout = setTimeout(() => currentController?.abort(), timeoutMs);
        const resp = await fetch(healthUrl, { signal: currentController.signal });
        if (stopped) return;
        if (resp.ok) {
          logger.debug(`[watchdog] Health check OK: url=${sanitizeUrl(healthUrl)}`);
          if (consecutiveFailures > 0) {
            logger.log(`[watchdog] Health check recovered after ${consecutiveFailures} failure(s)`);
          }
          consecutiveFailures = 0;
        } else {
          consecutiveFailures++;
          logger.warn(`[watchdog] Health check returned status ${resp.status} (failure ${consecutiveFailures}/${maxFailures})`);
        }
      } catch (err) {
        if (stopped) return;
        consecutiveFailures++;
        logger.warn(`[watchdog] Health check failed (failure ${consecutiveFailures}/${maxFailures}):`, err);
      } finally {
        if (currentTimeout) clearTimeout(currentTimeout);
        currentTimeout = undefined;
        currentController = undefined;
      }

      if (consecutiveFailures >= maxFailures && !dead) {
        dead = true;
        logger.error(`[watchdog] Max failures reached: failures=${consecutiveFailures}, threshold=${maxFailures}, triggering shutdown`);
        try {
          await onDead();
        } catch (err) {
          logger.error("[watchdog] onDead callback threw:", err);
        }
      }
      checking = false;
    }, intervalMs);
  }

  // Start after grace period
  const delayId = setTimeout(() => {
    if (!stopped) startPolling();
  }, startDelayMs);

  return () => {
    stopped = true;
    clearTimeout(delayId);
    if (intervalId) clearInterval(intervalId);
    if (currentTimeout) clearTimeout(currentTimeout);
    currentController?.abort();
    currentTimeout = undefined;
    currentController = undefined;
    logger.info("[watchdog] Watchdog stopped");
  };
}
