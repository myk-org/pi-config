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

import { fileLog, isLevelEnabled, type FileLogLevel } from "./file-logger.js";

export interface Logger {
  debug(...args: any[]): void;
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
  isDebugEnabled(): boolean;
}

function fmt(args: any[]): string {
  return args.map(a => {
    if (typeof a === "string") return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(" ");
}

export function createLogger(name: string, prefix?: string): Logger {
  const pfx = prefix ?? name;
  const emit = (level: FileLogLevel, args: any[]) => {
    const last = args[args.length - 1];
    if (last instanceof Error && args.length > 1) {
      fileLog(name, level, pfx, fmt(args.slice(0, -1)), last);
    } else {
      fileLog(name, level, pfx, fmt(args));
    }
  };
  return {
    debug(...args: any[]) {
      if (!isLevelEnabled(name, "debug")) return;
      emit("debug", args);
    },
    info(...args: any[]) { emit("info", args); },
    warn(...args: any[]) { emit("warn", args); },
    error(...args: any[]) { emit("error", args); },
    isDebugEnabled() { return isLevelEnabled(name, "debug"); },
  };
}
