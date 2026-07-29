/**
 * Log-level-aware logger for the pi-sidecar.
 * Respects PI_SIDECAR_LOG_LEVEL environment variable.
 * Levels (in order): debug, info, warn, error
 * Default: info
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

function parseLogLevel(raw?: string): LogLevel {
  const normalized = raw?.toLowerCase().trim();
  if (normalized && normalized in LOG_LEVELS) return normalized as LogLevel;
  return "info";
}

const currentLevel = parseLogLevel(process.env.PI_SIDECAR_LOG_LEVEL);

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

export const logger = {
  debug: (...args: any[]) => { if (shouldLog("debug")) console.debug(...args); },
  info: (...args: any[]) => { if (shouldLog("info")) console.info(...args); },
  log: (...args: any[]) => { if (shouldLog("info")) console.log(...args); },
  warn: (...args: any[]) => { if (shouldLog("warn")) console.warn(...args); },
  error: (...args: any[]) => { if (shouldLog("error")) console.error(...args); },
};
