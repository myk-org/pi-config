/**
 * Append-only file logger for extensions.
 *
 * NEVER use console.* for operational/debug messages in extensions — pi
 * surfaces them into the chat text box. Write here instead:
 *   ~/.pi/logs/<name>.log
 *
 * I/O is intentionally synchronous (mkdirSync/appendFileSync). Call sites are
 * low-volume ops events (reaper, discovery, dream complete) — not hot loops.
 * Async would force every caller to await and risk unordered lines.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type FileLogLevel = "debug" | "info" | "warn" | "error";

/** Last filesystem failure from fileLog (for diagnostics; never console.*). */
let lastFileLogError: string | null = null;
let fileLogErrorCount = 0;
const ensuredDirs = new Set<string>();

export function getLastFileLogError(): string | null {
  return lastFileLogError;
}

export function getFileLogErrorCount(): number {
  return fileLogErrorCount;
}

/** Pure path — no mkdir. */
export function getPiLogsDir(): string {
  return path.join(os.homedir(), ".pi", "logs");
}

/** Pure path — no mkdir. Callers that only need the path string stay side-effect free. */
export function getPiLogPath(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(getPiLogsDir(), `${safe}.log`);
}

/** Collapse CR/LF so one fileLog call = one physical log line. */
function oneLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "\\n");
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return oneLine(err.stack || err.message);
  return oneLine(String(err));
}

function recordWriteError(err: unknown): void {
  fileLogErrorCount += 1;
  lastFileLogError =
    err instanceof Error ? err.message : String(err);
}

function appendLine(filePath: string, line: string): void {
  const dir = path.dirname(filePath);
  if (!ensuredDirs.has(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    ensuredDirs.add(dir);
  }
  fs.appendFileSync(filePath, line, "utf-8");
}

/**
 * Append one physical line to ~/.pi/logs/<name>.log.
 * Never writes to console.* (chat UI leak).
 * Returns true on success.
 * On primary-path failure, tries os.tmpdir()/pi-logs/<name>.log once.
 */
export function fileLog(
  name: string,
  level: FileLogLevel,
  prefix: string,
  message: string,
  err?: unknown,
): boolean {
  const detail =
    err !== undefined ? ` ${formatErr(err)}` : "";
  const line = `${new Date().toISOString()} [${level}] [${prefix}] ${oneLine(message)}${detail}\n`;
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");

  try {
    // Path resolve stays inside try so homedir/path failures still hit fallback.
    appendLine(getPiLogPath(name), line);
    return true;
  } catch (primaryErr) {
    recordWriteError(primaryErr);
    try {
      const fallbackDir = path.join(os.tmpdir(), "pi-logs");
      appendLine(path.join(fallbackDir, `${safe}.log`), line);
      return true;
    } catch (fallbackErr) {
      recordWriteError(fallbackErr);
      return false;
    }
  }
}

/** Convenience loggers for known components. */
export function cliProviderLog(
  level: FileLogLevel,
  message: string,
  err?: unknown,
): boolean {
  return fileLog("cli-provider", level, "cli-provider", message, err);
}

export function dreamingLog(
  level: FileLogLevel,
  message: string,
  err?: unknown,
): boolean {
  return fileLog("dreaming", level, "dreaming", message, err);
}
