/**
 * Append-only file logger for extensions.
 *
 * NEVER use console.* for operational/debug messages in extensions — pi
 * surfaces them into the chat text box. Write here instead:
 *   ~/.pi/logs/<name>/<PI_SESSION_ID>.log
 *
 * I/O is intentionally synchronous (mkdirSync/appendFileSync). Call sites are
 * low-volume ops events (reaper, discovery, dream complete) — not hot loops.
 * Async would force every caller to await and risk unordered lines.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type FileLogLevel = "debug" | "info" | "warn" | "error";

const SESSION_ID_ENV_KEY = "__PI_CONFIG_SESSION_ID";
let pendingLogLines: Array<{ name: string; line: string }> = [];

// Auto-init session ID from environment (subagent processes inherit parent's session ID)
if (!((globalThis as any).__piConfigSessionId) && process.env.__PI_CONFIG_SESSION_ID) {
  (globalThis as any).__piConfigSessionId = process.env.__PI_CONFIG_SESSION_ID;
}

export function setGlobalSessionId(id: string): void {
  process.env[SESSION_ID_ENV_KEY] = id;
  (globalThis as any).__piConfigSessionId = id;

  // Flush buffered log lines now that we have a session ID
  for (const { name, line } of pendingLogLines) {
    try {
      const logPath = getPiLogPath(name);
      if (logPath) appendLine(logPath, line);
    } catch (e) {
      recordWriteError(e);
    }
  }
  pendingLogLines = [];
}

/** Last filesystem failure from fileLog (for diagnostics; never console.*). */
let lastFileLogError: string | null = null;
let fileLogErrorCount = 0;

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

/** Pure path — no mkdir. Returns null if session ID not yet set. */
export function getPiLogPath(name: string): string | null {
  const sid = (globalThis as any).__piConfigSessionId;
  if (!sid) return null;
  const safeSid = sid.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+$/, "_");
  const prefix = logFilePrefixes.get(name);

  const parentSid = process.env.__PI_PARENT_SESSION_ID;
  if (parentSid && parentSid !== sid) {
    // Subagent: nest under parent session
    const safeParentSid = parentSid.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = prefix ? `${prefix}-${safeSid}.log` : `${safeSid}.log`;
    return path.join(getPiLogsDir(), safe, safeParentSid, filename);
  }

  // Parent: use <name>/<sid>/main.log (or <prefix>-main.log)
  const filename = prefix ? `${prefix}-main.log` : "main.log";
  return path.join(getPiLogsDir(), safe, safeSid, filename);
}

const logFilePrefixes: Map<string, string> = new Map();

export function setLogFilePrefix(name: string, prefix: string): void {
  const sid = (globalThis as any).__piConfigSessionId;
  if (sid) {
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+$/, "_");
    const safeSid = sid.replace(/[^a-zA-Z0-9._-]/g, "_");
    const oldPath = path.join(getPiLogsDir(), safe, safeSid, "main.log");
    const newPath = path.join(getPiLogsDir(), safe, safeSid, `${prefix}-main.log`);
    try {
      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
        fs.renameSync(oldPath, newPath);
      } else if (fs.existsSync(oldPath) && fs.existsSync(newPath)) {
        fs.appendFileSync(newPath, fs.readFileSync(oldPath, "utf-8"));
        fs.unlinkSync(oldPath);
      }
    } catch {}
  }
  logFilePrefixes.set(name, prefix);
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
  // Always mkdirSync(recursive) — no dir cache. Cached "ensured" dirs go stale
  // if ~/.pi/logs is deleted mid-process and then skip mkdir → lost logs.
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, line, "utf-8");
}

/**
 * Append one physical line to ~/.pi/logs/<name>/<session>.log.
 * Never writes to console.* (chat UI leak).
 * Returns true on success.
 * On primary-path failure, tries os.tmpdir()/pi-logs/<name>.log once.
 */
const LEVEL_ORDER: Record<string, number> = Object.assign(Object.create(null), { off: -1, debug: 0, info: 1, warn: 2, error: 3 });

let _cachedGetSetting: ((cwd: string, key: string) => any) | null | false = null;

/** Match settings mtime throttle — burst register calls must not re-stat. */
const MIN_LEVEL_CACHE_MS = 30_000;
const minLevelCache = new Map<string, { level: number; at: number }>();

function resolveMinLevel(name: string): number {
  if (_cachedGetSetting !== false) {
    try {
      if (!_cachedGetSetting) {
        _cachedGetSetting = require("../orchestrator/project-settings.js").getSetting;
      }
      if (_cachedGetSetting) {
        const settingKey = `log_${name.replace(/-/g, "_")}`;
        const settingVal = _cachedGetSetting(process.cwd(), settingKey);
        if (settingVal && settingVal in LEVEL_ORDER) return LEVEL_ORDER[settingVal];
      }
    } catch {
      _cachedGetSetting = false;
    }
  }

  const envKey = `PI_LOG_${name.replace(/-/g, "_").toUpperCase()}`;
  const val = process.env[envKey];
  if (val && val in LEVEL_ORDER) return LEVEL_ORDER[val];

  return LEVEL_ORDER.info;
}

function getMinLevel(name: string): number {
  const now = Date.now();
  const hit = minLevelCache.get(name);
  if (hit && now - hit.at < MIN_LEVEL_CACHE_MS) return hit.level;
  const level = resolveMinLevel(name);
  minLevelCache.set(name, { level, at: now });
  return level;
}

/** Drop cached min levels (tests). No fileLog here — this is the log filter. */
export function clearLogLevelCache(): void {
  minLevelCache.clear();
}

/**
 * True when `level` would be written for `name`.
 * Same sources as fileLog (log_<name> setting, then PI_LOG_<NAME>, then info).
 * Cached 30s so debug gates on hot paths do not re-resolve settings.
 */
export function isLevelEnabled(name: string, level: FileLogLevel): boolean {
  const minLevel = getMinLevel(name);
  if (minLevel < 0) return false;
  return (LEVEL_ORDER[level] ?? 0) >= minLevel;
}

export function fileLog(
  name: string,
  level: FileLogLevel,
  prefix: string,
  message: string,
  err?: unknown,
): boolean {
  const minLevel = getMinLevel(name);
  if (minLevel < 0) return true; // logging disabled (off)
  if ((LEVEL_ORDER[level] ?? 0) < minLevel) return true; // filtered

  const detail =
    err !== undefined ? ` ${formatErr(err)}` : "";
  const line = `${new Date().toISOString()} [${level}] [${prefix}] ${oneLine(message)}${detail}\n`;
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");

  const logPath = getPiLogPath(name);
  if (!logPath) {
    pendingLogLines.push({ name, line });
    return true;
  }
  try {
    appendLine(logPath, line);
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
