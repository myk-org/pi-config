/**
 * Browser-safe logger shared by pidash-ui and pidiff-ui.
 * Parameterized by debug flag and log bag globals so each UI keeps its own diagnostic namespace.
 */
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  isDebugEnabled(): boolean;
}

export interface BrowserLoggerOptions {
  debugFlag: string;
  logBag: string;
  maxRecords?: number;
}

function fmt(args: unknown[]): string {
  return args.map(arg => {
    if (typeof arg === "string") return arg;
    try { return JSON.stringify(arg); } catch { return String(arg); }
  }).join(" ");
}

export function createBrowserLogger(name: string, options: BrowserLoggerOptions): Logger {
  const { debugFlag, logBag, maxRecords = 200 } = options;
  const state = globalThis as Record<string, unknown>;
  const emit = (level: string, args: unknown[]) => {
    let logs = state[logBag] as Array<{ name: string; level: string; msg: string }> | undefined;
    if (!Array.isArray(logs)) {
      logs = [];
      state[logBag] = logs;
    }
    logs.push({ name, level, msg: fmt(args) });
    if (maxRecords > 0 && logs.length > maxRecords) {
      logs.splice(0, logs.length - maxRecords);
    }
  };
  return {
    debug(...args: unknown[]) {
      if (Boolean(state[debugFlag])) emit("debug", args);
    },
    info(...args: unknown[]) { emit("info", args); },
    warn(...args: unknown[]) { emit("warn", args); },
    error(...args: unknown[]) { emit("error", args); },
    isDebugEnabled() { return Boolean(state[debugFlag]); },
  };
}
