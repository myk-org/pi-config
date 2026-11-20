import { createBrowserLogger, type Logger } from "../../../../shared/ui/create-logger.ts";

export type { Logger };

/**
 * Browser-safe logger for pidiff-ui. Same method names as extensions/shared
 * createLogger, without node:fs (Vite cannot bundle the extension file logger).
 */
export function createLogger(name: string): Logger {
  return createBrowserLogger(name, {
    debugFlag: "__PIDIFF_DEBUG",
    logBag: "__pidiffUiLogs",
    maxRecords: 200,
  });
}
