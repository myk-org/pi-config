import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function createLogger(name) {
  const level = process.env[`PI_LOG_${name.replaceAll("-", "_").toUpperCase()}`] ?? "info";
  const path = join(homedir(), ".pi", "logs", name.replace(/[^a-zA-Z0-9._-]/g, "_"), "install.log");
  return {
    debug(...args) {
      if (level !== "debug") return;
      const message = args.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" ").replace(/\r\n|\r|\n/g, "\\n");
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        appendFileSync(path, `${new Date().toISOString()} [debug] [${name}] ${message}\n`, { mode: 0o600 });
      } catch {}
    },
  };
}
