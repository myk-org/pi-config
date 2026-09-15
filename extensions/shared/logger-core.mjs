const LEVELS = ["debug", "info", "warn", "error"];

function oneLine(value) {
  return value.replace(/\r\n|\r|\n/g, "\\n");
}

function format(args) {
  return args.map(value => {
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  }).join(" ");
}

/** Canonical logger behavior; adapters only select/filter and persist lines. */
export function createLoggerCore(name, prefix, destination) {
  const emit = (level, args) => {
    try {
      if (!destination.isLevelEnabled(level)) return;
      const last = args.at(-1);
      const hasError = last instanceof Error && args.length > 1;
      const message = oneLine(format(hasError ? args.slice(0, -1) : args));
      const detail = hasError ? ` ${oneLine(last.stack || last.message)}` : "";
      destination.write(`${new Date().toISOString()} [${level}] [${prefix ?? name}] ${message}${detail}\n`);
    } catch {
      // Logging must never affect the caller or leak failures to console/chat.
    }
  };

  return Object.fromEntries([
    ...LEVELS.map(level => [level, (...args) => emit(level, args)]),
    ["isDebugEnabled", () => {
      try { return destination.isLevelEnabled("debug"); } catch { return false; }
    }],
  ]);
}
