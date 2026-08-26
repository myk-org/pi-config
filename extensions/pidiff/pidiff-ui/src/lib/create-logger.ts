/**
 * Browser-safe logger for pidiff-ui. Same method names as extensions/shared
 * createLogger, without node:fs (Vite cannot bundle the extension file logger).
 */
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  isDebugEnabled(): boolean;
}

function fmt(args: unknown[]): string {
  return args.map(a => {
    if (typeof a === "string") return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(" ");
}

export function createLogger(name: string): Logger {
  const emit = (level: string, args: unknown[]) => {
    const bag = (globalThis as { __pidiffUiLogs?: Array<{ name: string; level: string; msg: string }> });
    bag.__pidiffUiLogs ??= [];
    bag.__pidiffUiLogs.push({ name, level, msg: fmt(args) });
  };
  return {
    debug(...args: unknown[]) {
      if (Boolean((globalThis as { __PIDIFF_DEBUG?: boolean }).__PIDIFF_DEBUG)) emit("debug", args);
    },
    info(...args: unknown[]) { emit("info", args); },
    warn(...args: unknown[]) { emit("warn", args); },
    error(...args: unknown[]) { emit("error", args); },
    isDebugEnabled() {
      return Boolean((globalThis as { __PIDIFF_DEBUG?: boolean }).__PIDIFF_DEBUG);
    },
  };
}
