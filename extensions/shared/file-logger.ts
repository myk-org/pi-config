/**
 * Append-only file logger for extensions.
 *
 * NEVER use console.* for operational/debug messages in extensions — pi
 * surfaces them into the chat text box. Write here instead:
 *   ~/.pi/logs/<name>.log
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type FileLogLevel = "debug" | "info" | "warn" | "error";

export function getPiLogsDir(): string {
  const dir = path.join(os.homedir(), ".pi", "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getPiLogPath(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(getPiLogsDir(), `${safe}.log`);
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message;
  return String(err);
}

/**
 * Append one line to ~/.pi/logs/<name>.log. Never writes to console.
 */
export function fileLog(
  name: string,
  level: FileLogLevel,
  prefix: string,
  message: string,
  err?: unknown,
): void {
  try {
    const detail =
      err !== undefined ? ` ${formatErr(err)}` : "";
    const line = `${new Date().toISOString()} [${level}] [${prefix}] ${message}${detail}\n`;
    fs.appendFileSync(getPiLogPath(name), line, "utf-8");
  } catch {
    // Last resort: do not console.* — that leaks into the chat UI.
  }
}

/** Convenience loggers for known components. */
export function cliProviderLog(
  level: FileLogLevel,
  message: string,
  err?: unknown,
): void {
  fileLog("cli-provider", level, "cli-provider", message, err);
}

export function dreamingLog(
  level: FileLogLevel,
  message: string,
  err?: unknown,
): void {
  fileLog("dreaming", level, "dreaming", message, err);
}
