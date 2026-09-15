import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createLoggerCore } from "./logger-core.mjs";

const LEVEL_ORDER = { off: -1, debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(name, prefix) {
  const minimum = LEVEL_ORDER[process.env[`PI_LOG_${name.replaceAll("-", "_").toUpperCase()}`] ?? "info"] ?? LEVEL_ORDER.info;
  const path = join(homedir(), ".pi", "logs", name.replace(/[^a-zA-Z0-9._-]/g, "_"), "install.log");
  return createLoggerCore(name, prefix, {
    isLevelEnabled: level => minimum >= 0 && LEVEL_ORDER[level] >= minimum,
    write: line => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      appendFileSync(path, line, { mode: 0o600 });
    },
  });
}
