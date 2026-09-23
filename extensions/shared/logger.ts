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

import { isLevelEnabled, setLogLevelDiagnosticLogger, writeFileLogLine } from "./file-logger.js";
import { createLoggerCore } from "./logger-core.mjs";
import { setSettingsSourceLogger } from "../orchestrator/settings-source.js";

export interface Logger {
  debug(...args: any[]): void;
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
  isDebugEnabled(): boolean;
}

export function createLogger(name: string, prefix?: string, bypassLevelResolution = false): Logger {
  return createLoggerCore(name, prefix, {
    isLevelEnabled: level => bypassLevelResolution || isLevelEnabled(name, level),
    write: line => { writeFileLogLine(name, line); },
  }) as Logger;
}

setLogLevelDiagnosticLogger(createLogger("file-logger-bootstrap", undefined, true));
setSettingsSourceLogger(createLogger("settings-source", undefined, true));
