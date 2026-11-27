#!/usr/bin/env node
/**
 * Deterministic $0 diagnostic snapshot & redacted session log collector (issue #1446).
 *
 * Collects runtime versions (Pi, pi-orchestrator-config, myk-pi-tools, Node, OS),
 * redacted git/cwd metadata, and a bounded tail of recent `warn`/`error` log lines
 * from `~/.pi/logs/<logger>/<session-id>/*.log`, flat `<logger>/<session-id>.log`
 * (e.g. Vertex logger), and `file-logger` fallback directories
 * (`<cwd>/.pi/tmp/pi-logs/*.log`, `~/.pi/tmp/pi-logs/*.log`) with mandatory
 * one-way secret and home-path redaction.
 *
 * Usage:
 *   node scripts/diagnostic-report-collect.mjs [--cwd <dir>] [--session-id <id>]
 *                                              [--logs-dir <dir>] [--max-lines <n>]
 */

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../extensions/shared/install-logger.mjs";
import {
  BUILTIN_CREDENTIAL_RULES,
  isIgnoredEnvName,
  MIN_SECRET_LENGTH,
  SECRET_ENV_NAME_RE,
  URL_CREDENTIAL_EXTRACT_RE,
} from "../extensions/shared/secret-patterns.mjs";

const log = createLogger("diagnostic-report-collect");

export const DEFAULT_MAX_LOG_LINES = 40;
export const MAX_ALLOWED_LOG_LINES = 200;
export const DEFAULT_MAX_LINE_CHARS = 500;
const TRUNCATED_SUFFIX = "... [truncated]";
const MAX_FILE_TAIL_BYTES = 256 * 1024;
const SELF_LOGGER_DIR = "diagnostic-report-collect";
const IGNORED_FLAT_LOG_NAMES = new Set(["install.log"]);

const CANONICAL_BRACKETED_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+\[(debug|info|warn|warning|error)\]\s+(.*)$/i;
const CANONICAL_UNBRACKETED_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(debug|info|warn|warning|error)\s+(.*)$/i;
const LEADING_BRACKET_LEVEL_RE = /^\[(debug|info|warn|warning|error)\]\s+/i;

const AUTH_HEADER_RE =
  /(\b(?:Authorization|Proxy-Authorization)\s*:\s*(?:Basic|Digest|Token|ApiKey)\s+)([^\s,;'"`]+)/gi;
const COOKIE_HEADER_RE =
  /(\b(?:Set-Cookie|Cookie)\s*:\s*)(?!["'])([^\r\n]+)/gi;
const TRUNCATED_PEM_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[^\r\n]*/g;
const SECRET_KEY_PATTERN =
  "(?:[A-Za-z0-9_-]+[_-])?(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|encryption[_-]?key|master[_-]?key|signing[_-]?key|auth[_-]?key|token|secret|password|passwd|pwd|passphrase|credentials?|oauth|authorization|cookie)";
const KV_SECRET_RE = new RegExp(
  `((?<![A-Za-z0-9_-])["']?${SECRET_KEY_PATTERN}["']?\\s*[:=]\\s*)(?:"((?:\\\\.|[^"\\\\\\r\\n])+)"|'((?:\\\\.|[^'\\\\\\r\\n])+)'|([^\\s,;'"\`]*[^\\s,;'"\`\\]})]))`,
  "gi",
);
const NON_SECRET_LITERALS = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "none",
  "empty",
  "redacted",
  "[redacted]",
]);

const POSIX_HOME_PATH_RE = /\/(?:home|Users)\/[A-Za-z0-9._-]+(?=\/|["'`\s,;:\]})]|$)/g;
const WIN_HOME_PATH_RE = /[A-Za-z]:\\Users\\[^\\\s"'`,;:\]})]+(?=\\|["'`\s,;:\]})]|$)/g;

function defaultExec(cmd, args, cwd, timeout = 5_000) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sanitizeSegment(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe || /^\.+$/.test(safe)) return null;
  return safe;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectEnvSecretLiterals(env) {
  if (!env || typeof env !== "object") return [];
  const secrets = new Set();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) continue;
    if (isIgnoredEnvName(name)) continue;

    if (SECRET_ENV_NAME_RE.test(name)) {
      secrets.add(value);
    }

    URL_CREDENTIAL_EXTRACT_RE.lastIndex = 0;
    let m;
    while ((m = URL_CREDENTIAL_EXTRACT_RE.exec(value)) !== null) {
      if (m[1] && m[1].length >= MIN_SECRET_LENGTH) {
        secrets.add(m[1]);
      }
    }
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

/**
 * One-way irreversible redaction for diagnostic snapshots and log excerpts.
 *
 * Strips built-in credential patterns (shared with `secret-obfuscation.ts`),
 * structured JSON & key/value secrets (including escaped quotes, short/numeric
 * secrets, and credential-named fields), auth/cookie headers, secret environment
 * variable values, and local home-directory paths containing usernames.
 */
export function redactDiagnosticText(text, options = {}) {
  if (typeof text !== "string" || text.length === 0) return text ?? "";
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();

  let out = text;

  // 1. Built-in credential regex rules (shared with extensions/orchestrator/secret-obfuscation.ts).
  for (const rule of BUILTIN_CREDENTIAL_RULES) {
    rule.regex.lastIndex = 0;
    const replacement = `[REDACTED:${rule.label}]`;
    if (rule.secretGroup === 2) {
      out = out.replace(rule.regex, (full, prefix, secret, suffix) => {
        if (!secret || secret.startsWith("[REDACTED")) return full;
        return `${prefix}${replacement}${typeof suffix === "string" ? suffix : ""}`;
      });
    } else {
      out = out.replace(rule.regex, () => replacement);
    }
  }

  // 2. Truncated PEM blocks, raw auth headers, and raw Cookie headers.
  TRUNCATED_PEM_RE.lastIndex = 0;
  out = out.replace(TRUNCATED_PEM_RE, "[REDACTED:PEMKEY]");
  AUTH_HEADER_RE.lastIndex = 0;
  out = out.replace(AUTH_HEADER_RE, (full, prefix, val) =>
    val.startsWith("[REDACTED") ? full : `${prefix}[REDACTED:AUTH]`,
  );
  COOKIE_HEADER_RE.lastIndex = 0;
  out = out.replace(COOKIE_HEADER_RE, (full, prefix, val) =>
    val.trim().startsWith("[REDACTED") ? full : `${prefix}[REDACTED:COOKIE]`,
  );

  // 3. Structured JSON & key=value secret fields (handles escaped quotes, short & numeric values).
  KV_SECRET_RE.lastIndex = 0;
  out = out.replace(KV_SECRET_RE, (full, prefix, dbl, sgl, bare, offset, str) => {
    const val = dbl ?? sgl ?? bare ?? "";
    const lower = val.toLowerCase();
    if (
      !val ||
      val.startsWith("[REDACTED") ||
      NON_SECRET_LITERALS.has(lower) ||
      (bare !== undefined &&
        /^(?:bearer|basic|digest|token|apikey)$/i.test(bare) &&
        /^[ \t]+\[REDACTED/.test(str.slice(offset + full.length)))
    ) {
      return full;
    }
    if (dbl !== undefined) return `${prefix}"[REDACTED]"`;
    if (sgl !== undefined) return `${prefix}'[REDACTED]'`;
    return `${prefix}[REDACTED]`;
  });

  // 4. Secret environment variable literals (longest-first).
  const envSecrets = options._envSecrets ?? collectEnvSecretLiterals(env);
  for (const secret of envSecrets) {
    if (out.includes(secret)) {
      out = out.split(secret).join("[REDACTED:ENV]");
    }
  }

  // 5. Home directory & POSIX/Windows user-home paths (never leak local usernames).
  if (typeof homeDir === "string" && homeDir.length > 1) {
    const normalizedHome = homeDir.replace(/[\\/]+$/, "");
    if (normalizedHome.length > 1) {
      const homeRe = new RegExp(
        `${escapeRegExp(normalizedHome)}(?=[\\\\/]|["'\`\\s,;:\\]})]|$)`,
        "g",
      );
      out = out.replace(homeRe, "~");
    }
  }
  POSIX_HOME_PATH_RE.lastIndex = 0;
  out = out.replace(POSIX_HOME_PATH_RE, "~");
  WIN_HOME_PATH_RE.lastIndex = 0;
  out = out.replace(WIN_HOME_PATH_RE, "~");

  return out;
}

/** Parse CLI flags for `scripts/diagnostic-report-collect.mjs`. */
export function parseCliArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    sessionId: null,
    logsDir: null,
    maxLines: DEFAULT_MAX_LOG_LINES,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cwd" && argv[i + 1]) {
      opts.cwd = resolve(argv[++i]);
    } else if (arg === "--session-id" && argv[i + 1]) {
      opts.sessionId = argv[++i].trim();
    } else if (arg === "--logs-dir" && argv[i + 1]) {
      opts.logsDir = resolve(argv[++i]);
    } else if (arg === "--max-lines" && argv[i + 1]) {
      const n = Number.parseInt(argv[++i], 10);
      if (Number.isInteger(n) && n >= 1 && n <= MAX_ALLOWED_LOG_LINES) {
        opts.maxLines = n;
      }
    }
  }
  return opts;
}

function readTailText(filePath, maxBytes = MAX_FILE_TAIL_BYTES) {
  const st = lstatSync(filePath);
  if (!st.isFile() || st.isSymbolicLink() || st.size === 0) return "";
  const start = Math.max(0, st.size - maxBytes);
  const length = st.size - start;
  const buf = Buffer.allocUnsafe(length);
  const fd = openSync(filePath, "r");
  try {
    const bytesRead = readSync(fd, buf, 0, length, start);
    let text = buf.subarray(0, bytesRead).toString("utf-8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

function listNonSymlinkSubdirs(dirPath) {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.isSymbolicLink())
      .map((d) => d.name)
      .sort();
  } catch (err) {
    log.warn("list_subdirs_failed", { dirPath, error: String(err?.message ?? err) });
    return [];
  }
}

function findLatestSessionId(logsDir) {
  let bestSid = null;
  let bestMtime = -1;
  for (const loggerName of listNonSymlinkSubdirs(logsDir)) {
    if (loggerName === SELF_LOGGER_DIR) continue;
    const loggerDir = join(logsDir, loggerName);

    // 1. Nested session dirs: <logsDir>/<logger>/<sid>/*.log
    for (const sid of listNonSymlinkSubdirs(loggerDir)) {
      const sidDir = join(loggerDir, sid);
      try {
        for (const entry of readdirSync(sidDir, { withFileTypes: true })) {
          if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".log")) continue;
          const st = statSync(join(sidDir, entry.name));
          if (st.mtimeMs > bestMtime) {
            bestMtime = st.mtimeMs;
            bestSid = sid;
          }
        }
      } catch (err) {
        log.warn("scan_latest_session_failed", { sidDir, error: String(err?.message ?? err) });
      }
    }

    // 2. Flat session files (e.g. pi-vertex-claude): <logsDir>/<logger>/<sid>.log
    try {
      for (const entry of readdirSync(loggerDir, { withFileTypes: true })) {
        if (
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          !entry.name.endsWith(".log") ||
          IGNORED_FLAT_LOG_NAMES.has(entry.name)
        ) {
          continue;
        }
        const sid = entry.name.slice(0, -4);
        if (!sanitizeSegment(sid)) continue;
        const st = statSync(join(loggerDir, entry.name));
        if (st.mtimeMs > bestMtime) {
          bestMtime = st.mtimeMs;
          bestSid = sid;
        }
      }
    } catch (err) {
      log.warn("scan_latest_flat_session_failed", { loggerDir, error: String(err?.message ?? err) });
    }
  }
  return bestSid;
}

function scanSessionFiles(logsDir, safeSid) {
  const files = [];
  for (const loggerName of listNonSymlinkSubdirs(logsDir)) {
    if (loggerName === SELF_LOGGER_DIR) continue;
    const loggerDir = join(logsDir, loggerName);

    // 1. Nested session files: <logsDir>/<logger>/<safeSid>/*.log
    const sidDir = join(loggerDir, safeSid);
    try {
      const st = lstatSync(sidDir);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        const names = readdirSync(sidDir, { withFileTypes: true })
          .filter((d) => d.isFile() && !d.isSymbolicLink() && d.name.endsWith(".log"))
          .map((d) => d.name)
          .sort();
        for (const fileName of names) {
          files.push({
            logger: loggerName,
            file: `${loggerName}/${fileName}`,
            fullPath: join(sidDir, fileName),
            scope: "session",
          });
        }
      }
    } catch {
      // Logger has no nested directory for this session — normal.
    }

    // 2. Flat session file (e.g. pi-vertex-claude): <logsDir>/<logger>/<safeSid>.log
    const flatFile = join(loggerDir, `${safeSid}.log`);
    try {
      const st = lstatSync(flatFile);
      if (st.isFile() && !st.isSymbolicLink()) {
        files.push({
          logger: loggerName,
          file: `${loggerName}/${safeSid}.log`,
          fullPath: flatFile,
          scope: "session",
        });
      }
    } catch {
      // Logger has no flat session file — normal.
    }
  }
  return files;
}

function scanFallbackDirFiles(dirPath, scope) {
  const files = [];
  try {
    const st = lstatSync(dirPath);
    if (!st.isDirectory() || st.isSymbolicLink()) return files;
    const entries = readdirSync(dirPath, { withFileTypes: true })
      .filter((d) => d.isFile() && !d.isSymbolicLink() && d.name.endsWith(".log"))
      .map((d) => d.name)
      .sort();
    for (const fileName of entries) {
      const loggerName = fileName.slice(0, -4);
      if (loggerName === SELF_LOGGER_DIR) continue;
      files.push({
        logger: loggerName,
        file: `${scope}:${fileName}`,
        fullPath: join(dirPath, fileName),
        scope,
      });
    }
  } catch {
    // Fallback dir does not exist or is unreadable — normal.
  }
  return files;
}

function normalizeWarnOrError(rawLevel) {
  const lower = rawLevel.toLowerCase();
  if (lower === "warn" || lower === "warning") return "warn";
  if (lower === "error") return "error";
  return null;
}

const ISO_DATE_LIKE_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

function parseValidTimestamp(rawTs) {
  if (typeof rawTs !== "string") return { timestamp: null, timestampMs: null };
  const trimmed = rawTs.trim();
  if (!ISO_DATE_LIKE_RE.test(trimmed)) return { timestamp: null, timestampMs: null };
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return { timestamp: null, timestampMs: null };
  return { timestamp: trimmed, timestampMs: ms };
}

function parseWarnOrErrorLine(rawLine) {
  // 1. Canonical bracketed logger format: `<ISO> [level] [prefix] msg`
  const bracketed = CANONICAL_BRACKETED_RE.exec(rawLine);
  if (bracketed) {
    const level = normalizeWarnOrError(bracketed[2]);
    if (!level) return null;
    const { timestamp, timestampMs } = parseValidTimestamp(bracketed[1]);
    return { timestamp, timestampMs, level, raw: rawLine };
  }

  // 2. Canonical unbracketed logger format (e.g. pi-vertex-claude): `<ISO> level msg`
  const unbracketed = CANONICAL_UNBRACKETED_RE.exec(rawLine);
  if (unbracketed) {
    const level = normalizeWarnOrError(unbracketed[2]);
    if (!level) return null;
    const { timestamp, timestampMs } = parseValidTimestamp(unbracketed[1]);
    return { timestamp, timestampMs, level, raw: rawLine };
  }

  // 3. Structured JSON log line (only inspect top-level `level`/`severity` property)
  if (rawLine.startsWith("{") && rawLine.endsWith("}")) {
    try {
      const parsed = JSON.parse(rawLine);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const rawLevel =
          typeof parsed.level === "string"
            ? parsed.level
            : typeof parsed.severity === "string"
              ? parsed.severity
              : null;
        if (rawLevel) {
          const level = normalizeWarnOrError(rawLevel);
          if (!level) return null;
          const rawTs =
            typeof parsed.timestamp === "string"
              ? parsed.timestamp
              : typeof parsed.time === "string"
                ? parsed.time
                : null;
          const { timestamp, timestampMs } = parseValidTimestamp(rawTs);
          return { timestamp, timestampMs, level, raw: rawLine };
        }
      }
    } catch {
      // Not valid JSON — ignore.
    }
  }

  // 4. Leading bracketed level at line start: `[warn] ...` / `[error] ...`
  const leading = LEADING_BRACKET_LEVEL_RE.exec(rawLine);
  if (leading) {
    const level = normalizeWarnOrError(leading[1]);
    return level ? { timestamp: null, timestampMs: null, level, raw: rawLine } : null;
  }

  return null;
}

function resolveFallbackDirs(options, homeDir) {
  if (Array.isArray(options.fallbackLogsDirs)) {
    return options.fallbackLogsDirs.map((item, idx) =>
      typeof item === "string"
        ? { dir: item, scope: `fallback-${idx}` }
        : { dir: item.dir, scope: item.scope || `fallback-${idx}` },
    );
  }
  const dirs = [];
  const seen = new Set();
  if (options.cwd) {
    const projFallback = join(resolve(options.cwd), ".pi", "tmp", "pi-logs");
    seen.add(projFallback);
    dirs.push({ dir: projFallback, scope: "fallback-project" });
  }
  const homeFallback = join(homeDir, ".pi", "tmp", "pi-logs");
  if (!seen.has(homeFallback)) {
    dirs.push({ dir: homeFallback, scope: "fallback-home" });
  }
  return dirs;
}

/**
 * Collect bounded recent `warn`/`error` log lines across `~/.pi/logs/<logger>/<session-id>/*.log`,
 * flat `<logger>/<session-id>.log` files, and `file-logger` fallback directories,
 * with mandatory secret and home-directory redaction.
 */
export function collectRedactedDiagnosticLogs(options = {}) {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const logsDir = options.logsDir ?? join(homeDir, ".pi", "logs");
  const maxLines = Math.max(
    1,
    Math.min(MAX_ALLOWED_LOG_LINES, Number(options.maxLines ?? DEFAULT_MAX_LOG_LINES) || DEFAULT_MAX_LOG_LINES),
  );
  const maxLineChars = Math.max(
    80,
    Number(options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS) || DEFAULT_MAX_LINE_CHARS,
  );
  const envSecrets = collectEnvSecretLiterals(env);
  const redact = (s) => redactDiagnosticText(s, { env, homeDir, _envSecrets: envSecrets });

  const redactedLogsDir = redact(logsDir);
  let resolvedSessionId = null;
  let sessionSource = "none";
  let matchedFiles = [];

  const logsDirExists = existsSync(logsDir);
  if (!logsDirExists) {
    log.debug("logs_dir_missing", { logsDir: redactedLogsDir });
  }

  if (options.sessionId) {
    resolvedSessionId = sanitizeSegment(options.sessionId);
    sessionSource = "explicit";
    if (logsDirExists && resolvedSessionId) {
      matchedFiles = scanSessionFiles(logsDir, resolvedSessionId);
    }
  } else {
    const candidates = [
      sanitizeSegment(env.__PI_PARENT_SESSION_ID),
      sanitizeSegment(env.__PI_CONFIG_SESSION_ID),
    ].filter((v, idx, arr) => v && arr.indexOf(v) === idx);

    if (candidates.length > 0) {
      sessionSource = "env";
      resolvedSessionId = candidates[0];
      if (logsDirExists) {
        for (const candidate of candidates) {
          const found = scanSessionFiles(logsDir, candidate);
          if (found.length > 0) {
            resolvedSessionId = candidate;
            matchedFiles = found;
            break;
          }
        }
      }
    } else if (logsDirExists) {
      const latest = findLatestSessionId(logsDir);
      if (latest) {
        resolvedSessionId = latest;
        sessionSource = "latest-fallback";
        matchedFiles = scanSessionFiles(logsDir, latest);
      }
    }
  }

  // Also inspect file-logger fallback dirs. When a sessionId is resolved, strictly
  // restrict fallback entries to files/lines carrying that sessionId so unrelated
  // sessions never leak into the current session's snapshot.
  const fallbackFiles = [];
  for (const { dir, scope } of resolveFallbackDirs(options, homeDir)) {
    for (const item of scanFallbackDirFiles(dir, scope)) {
      const fileMatchesSession =
        resolvedSessionId !== null &&
        (item.logger === resolvedSessionId || item.logger.endsWith(`-${resolvedSessionId}`));
      fallbackFiles.push({
        ...item,
        requireSessionInLine: resolvedSessionId !== null && !fileMatchesSession,
      });
    }
  }

  const allFiles = [
    ...matchedFiles.map((f) => ({ ...f, requireSessionInLine: false })),
    ...fallbackFiles,
  ];
  const collected = [];
  let seq = 0;
  for (const item of allFiles) {
    let text = "";
    try {
      text = readTailText(item.fullPath, MAX_FILE_TAIL_BYTES);
    } catch (err) {
      log.warn("read_log_file_failed", { file: redact(item.file), error: String(err?.message ?? err) });
      continue;
    }
    if (!text) continue;
    for (const rawLine of text.split(/\r?\n/)) {
      if (!rawLine) continue;
      if (item.requireSessionInLine && !rawLine.includes(resolvedSessionId)) continue;
      const parsed = parseWarnOrErrorLine(rawLine);
      if (!parsed) continue;
      collected.push({
        seq: seq++,
        logger: item.logger,
        file: item.file,
        scope: item.scope,
        level: parsed.level,
        timestamp: parsed.timestamp,
        timestampMs: parsed.timestampMs,
        raw: parsed.raw,
      });
    }
  }

  collected.sort((a, b) => {
    if (a.timestampMs !== null && b.timestampMs !== null && a.timestampMs !== b.timestampMs) {
      return a.timestampMs - b.timestampMs;
    }
    return a.seq - b.seq;
  });

  const totalWarnErrorLines = collected.length;
  const tail = collected.slice(-maxLines);
  const entries = tail.map((entry) => {
    const redacted = redact(entry.raw);
    const line =
      redacted.length > maxLineChars
        ? `${redacted.slice(0, maxLineChars - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`
        : redacted;
    return {
      logger: redact(entry.logger),
      file: redact(entry.file),
      scope: entry.scope,
      level: entry.level,
      timestamp: entry.timestamp ? redact(entry.timestamp) : null,
      line,
    };
  });

  log.info("diagnostic_logs_collected", {
    sessionSource,
    filesScanned: matchedFiles.length,
    fallbackFilesScanned: fallbackFiles.length,
    totalWarnErrorLines,
    returnedLines: entries.length,
  });

  return {
    sessionId: resolvedSessionId ? redact(resolvedSessionId) : null,
    sessionSource,
    logsDir: redactedLogsDir,
    filesScanned: matchedFiles.length,
    fallbackFilesScanned: fallbackFiles.length,
    totalWarnErrorLines,
    returnedLines: entries.length,
    truncated: totalWarnErrorLines > entries.length,
    entries,
  };
}

function runSoft(execFn, cmd, args, cwd) {
  try {
    const out = execFn(cmd, args, cwd, 5_000);
    return typeof out === "string" ? out.trim() : null;
  } catch (err) {
    log.debug("command_probe_failed", { cmd, args, error: String(err?.message ?? err) });
    return null;
  }
}

function readPackageVersion() {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (pkg && pkg.name === "pi-orchestrator-config" && typeof pkg.version === "string") {
      return pkg.version;
    }
  } catch (err) {
    log.debug("package_version_read_failed", { error: String(err?.message ?? err) });
  }
  return null;
}

/** Parse `owner/repo` from a GitHub remote URL without leaking credentials. */
export function parseRemoteRepoSlug(remoteUrl) {
  if (typeof remoteUrl !== "string" || !remoteUrl.trim()) return null;
  const cleaned = remoteUrl.trim().replace(/^https?:\/\/[^/@]+@/i, "https://");
  const match = cleaned.match(/(?:github\.com[:/])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i);
  return match ? match[1] : null;
}

/** Collect a complete redacted runtime & session-log diagnostic report. */
export function collectDiagnosticReport(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const execFn = options.execFn ?? defaultExec;
  const envSecrets = collectEnvSecretLiterals(env);
  const redact = (s) => (typeof s === "string" ? redactDiagnosticText(s, { env, homeDir, _envSecrets: envSecrets }) : s);

  const piVersion = redact(runSoft(execFn, "pi", ["--version"], cwd));
  const mykPiToolsVersion = redact(runSoft(execFn, "myk-pi-tools", ["--version"], cwd));
  const piOrchestratorConfigVersion = options.packageVersion ?? readPackageVersion();

  const branch = redact(runSoft(execFn, "git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd));
  const commit = redact(runSoft(execFn, "git", ["rev-parse", "--short", "HEAD"], cwd));
  const porcelain = runSoft(execFn, "git", ["status", "--porcelain"], cwd);
  const dirty = porcelain === null ? null : porcelain.length > 0;
  const repoRootRaw = runSoft(execFn, "git", ["rev-parse", "--show-toplevel"], cwd);
  const remoteRaw = runSoft(execFn, "git", ["remote", "get-url", "origin"], cwd);

  const logs = collectRedactedDiagnosticLogs({
    cwd,
    logsDir: options.logsDir,
    fallbackLogsDirs: options.fallbackLogsDirs,
    sessionId: options.sessionId,
    maxLines: options.maxLines,
    maxLineChars: options.maxLineChars,
    env,
    homeDir,
  });

  const report = {
    status: "collected",
    collectedAt: new Date().toISOString(),
    versions: {
      pi: piVersion || null,
      piOrchestratorConfig: piOrchestratorConfigVersion || null,
      mykPiTools: mykPiToolsVersion || null,
      node: process.version,
    },
    os: {
      platform: platform(),
      release: release(),
      arch: arch(),
    },
    git: {
      cwd: redact(cwd),
      repoRoot: repoRootRaw ? redact(repoRootRaw) : null,
      remoteRepo: parseRemoteRepoSlug(remoteRaw),
      branch: branch || null,
      commit: commit || null,
      dirty,
    },
    logs,
  };

  log.info("diagnostic_report_collected", {
    hasPiVersion: Boolean(report.versions.pi),
    hasBranch: Boolean(report.git.branch),
    returnedLogLines: logs.returnedLines,
  });

  return report;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isDirectExecution()) {
  try {
    const opts = parseCliArgs(process.argv.slice(2));
    const report = collectDiagnosticReport(opts);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } catch (err) {
    const msg = redactDiagnosticText(String(err?.message ?? err));
    log.error("diagnostic_report_collect_failed", { error: msg.slice(0, 300) });
    process.stdout.write(JSON.stringify({ status: "error", error: msg }, null, 2) + "\n");
    process.exitCode = 1;
  }
}
