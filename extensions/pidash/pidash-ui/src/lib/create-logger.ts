/** Browser-safe logger for pidash UI diagnostics. */
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  isDebugEnabled(): boolean;
}

function fmt(args: unknown[]): string {
  return args.map(arg => {
    if (typeof arg === "string") return arg;
    try { return JSON.stringify(arg); } catch { return String(arg); }
  }).join(" ");
}

export function createLogger(name: string): Logger {
  const emit = (level: string, args: unknown[]) => {
    const state = globalThis as { __pidashUiLogs?: Array<{ name: string; level: string; msg: string }> };
    state.__pidashUiLogs ??= [];
    state.__pidashUiLogs.push({ name, level, msg: fmt(args) });
  };
  return {
    debug(...args: unknown[]) {
      if (Boolean((globalThis as { __PIDASH_DEBUG?: boolean }).__PIDASH_DEBUG)) emit("debug", args);
    },
    info(...args: unknown[]) { emit("info", args); },
    warn(...args: unknown[]) { emit("warn", args); },
    error(...args: unknown[]) { emit("error", args); },
    isDebugEnabled() { return Boolean((globalThis as { __PIDASH_DEBUG?: boolean }).__PIDASH_DEBUG); },
  };
}
