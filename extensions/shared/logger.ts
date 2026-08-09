/**
 * Convenience logger factory for extensions.
 *
 * Wraps the existing fileLog infrastructure so callers get a clean OO API:
 *
 *   import { createLogger } from "../shared/logger.js";
 *   const log = createLogger("pitasks");
 *   log.debug("hello", { count: 42 });
 *
 * Writes to ~/.pi/logs/<name>/<PI_SESSION_ID>.log.  Never console.* (chat UI leak).
 */

import { fileLog, type FileLogLevel } from "./file-logger.js";

export interface Logger {
  debug(...args: any[]): void;
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
}

function fmt(args: any[]): string {
  return args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
}

export function createLogger(name: string, prefix?: string): Logger {
  const pfx = prefix ?? name;
  return {
    debug(...args: any[]) { fileLog(name, "debug", pfx, fmt(args)); },
    info(...args: any[]) { fileLog(name, "info", pfx, fmt(args)); },
    warn(...args: any[]) { fileLog(name, "warn", pfx, fmt(args)); },
    error(...args: any[]) { fileLog(name, "error", pfx, fmt(args)); },
  };
}
