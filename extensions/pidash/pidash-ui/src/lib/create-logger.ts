import { createBrowserLogger, type Logger } from "../../../../shared/ui/create-logger.ts";

export type { Logger };

/** Browser-safe logger for pidash UI diagnostics. */
export function createLogger(name: string): Logger {
  return createBrowserLogger(name, {
    debugFlag: "__PIDASH_DEBUG",
    logBag: "__pidashUiLogs",
    maxRecords: 200,
  });
}
