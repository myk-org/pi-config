/**
 * Type declarations for logger-core.mjs (#951 type-check gate).
 *
 * logger-core.mjs is plain JavaScript (shared with non-TS consumers such as
 * install-logger.mjs and copied verbatim into containers), so it has no
 * embedded types. This hand-written declaration describes its actual exports.
 */

/** Logging levels emitted by the canonical logger. */
export type LoggerCoreLevel = "debug" | "info" | "warn" | "error";

/** Adapter surface: level filtering plus line persistence. */
export interface LoggerCoreDestination {
  isLevelEnabled: (level: LoggerCoreLevel) => boolean;
  write: (line: string) => void;
}

/** Logger shape produced by {@link createLoggerCore}. */
export interface LoggerCore {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  isDebugEnabled(): boolean;
}

/**
 * Canonical logger behavior; adapters only select/filter and persist lines.
 * Never throws — logging must not affect the caller.
 */
export declare function createLoggerCore(
  name: string,
  prefix: string | undefined,
  destination: LoggerCoreDestination,
): LoggerCore;
