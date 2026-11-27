#!/usr/bin/env node
/**
 * Deterministic $0 diagnostic snapshot & redacted session log collector (issue #1446).
 *
 * Collects runtime versions (Pi, pi-orchestrator-config, myk-pi-tools, Node, OS),
 * redacted git/cwd metadata, and a bounded tail of recent `warn`/`error` log lines
 * from `~/.pi/logs/<logger>/<session-id>/*.log` with mandatory one-way secret and home-path
 * redaction.
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
const MAX_FILE_TAIL_BYTES = 256 * 1024;
const SELF_LOGGER_DIR = "diagnostic-report-collect";

const CANONICAL_LOG_LINE_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+\[(warn|error)\]\s+(.*)$/i;
const FALLBACK_LEVEL_RE =
  /(?:\[(warn|warning|error)\]|"(?:level|severity)"\s*:\s*"(warn|warning|error)")/i;
const FALLBACK_TS_RE = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/;

const AUTH_HEADER_RE =
  /(\b(?:Authorization|Proxy-Authorization)\s*:\s*(?:Basic|Digest|Token|ApiKey)\s+)([^\s,;'"`]+)/gi;
const COOKIE_HEADER_RE =
  /(\b(?:Set-Cookie|Cookie)\s*:\s*)([^\r\n]+)/gi;
const TRUNCATED_PEM_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[^\r\n]*/g;
const KV_SECRET_RE =
  /((?<![A-Za-z0-9_-])["']?(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|x-api-key|password|passwd|pwd|secret|token)["']?\s*[:=]\s*)(?:"([^"\r\n]{4,})"|'([^'\r\n]{4,})'|([^\s,;'"`\]})]{6,}))/gi;
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
 * generic key/value secrets, auth/cookie headers, secret environment variable
 * values, and local home-directory paths containing usernames.
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

  // 2. Truncated PEM blocks, auth headers, and Cookie headers.
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

  // 3. Generic key=value / JSON secret fields (skip booleans, null, numbers, already redacted).
  KV_SECRET_RE.lastIndex = 0;
  out = out.replace(KV_SECRET_RE, (full, prefix, dbl, sgl, bare) => {
    const val = dbl ?? sgl ?? bare ?? "";
    const lower = val.toLowerCase();
    if (
      !val ||
      val.startsWith("[REDACTED") ||
      NON_SECRET_LITERALS.has(lower) ||
      /^\d+(?:\.\d+)?$/.test(val)
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
    log.debug("list_subdirs_failed", { dirPath, error: String(err?.message ?? err) });
    return [];
  }
}

function findLatestSessionId(logsDir) {
  let bestSid = null;
  let bestMtime = -1;
  for (const loggerName of listNonSymlinkSubdirs(logsDir)) {
    if (loggerName === SELF_LOGGER_DIR) continue;
    const loggerDir = join(logsDir, loggerName);
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
        log.debug("scan_latest_session_failed", { sidDir, error: String(err?.message ?? err) });
      }
    }
  }
  return bestSid;
}

function scanSessionFiles(logsDir, safeSid) {
  const files = [];
  for (const loggerName of listNonSymlinkSubdirs(logsDir)) {
    if (loggerName === SELF_LOGGER_DIR) continue;
    const sidDir = join(logsDir, loggerName, safeSid);
    try {
      const st = lstatSync(sidDir);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      const names = readdirSync(sidDir, { withFileTypes: true })
        .filter((d) => d.isFile() && !d.isSymbolicLink() && d.name.endsWith(".log"))
        .map((d) => d.name)
        .sort();
      for (const fileName of names) {
        files.push({
          logger: loggerName,
          file: `${loggerName}/${fileName}`,
          fullPath: join(sidDir, fileName),
        });
      }
    } catch {
      // Logger has no directory for this session — normal.
    }
  }
  return files;
}

function parseWarnOrErrorLine(rawLine) {
  const canonical = CANONICAL_LOG_LINE_RE.exec(rawLine);
  if (canonical) {
    return {
      timestamp: canonical[1],
      level: canonical[2].toLowerCase(),
      raw: rawLine,
    };
  }
  const fallback = FALLBACK_LEVEL_RE.exec(rawLine);
  if (fallback) {
    const rawLevel = (fallback[1] || fallback[2] || "warn").toLowerCase();
    const tsMatch = FALLBACK_TS_RE.exec(rawLine);
    return {
      timestamp: tsMatch ? tsMatch[1] : null,
      level: rawLevel === "warning" ? "warn" : rawLevel,
      raw: rawLine,
    };
  }
  return null;
}

/**
 * Collect bounded recent `warn`/`error` log lines across `~/.pi/logs/<logger>/<session-id>/*.log`
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
  if (!existsSync(logsDir)) {
    log.debug("logs_dir_missing", { logsDir: redactedLogsDir });
    return {
      sessionId: null,
      sessionSource: "none",
      logsDir: redactedLogsDir,
      filesScanned: 0,
      totalWarnErrorLines: 0,
      returnedLines: 0,
      truncated: false,
      entries: [],
    };
  }

  let resolvedSessionId = null;
  let sessionSource = "none";
  let matchedFiles = [];

  if (options.sessionId) {
    resolvedSessionId = sanitizeSegment(options.sessionId);
    sessionSource = "explicit";
    if (resolvedSessionId) {
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
      for (const candidate of candidates) {
        const found = scanSessionFiles(logsDir, candidate);
        if (found.length > 0) {
          resolvedSessionId = candidate;
          matchedFiles = found;
          break;
        }
      }
    } else {
      const latest = findLatestSessionId(logsDir);
      if (latest) {
        resolvedSessionId = latest;
        sessionSource = "latest-fallback";
        matchedFiles = scanSessionFiles(logsDir, latest);
      }
    }
  }

  const collected = [];
  let seq = 0;
  for (const item of matchedFiles) {
    let text = "";
    try {
      text = readTailText(item.fullPath, MAX_FILE_TAIL_BYTES);
    } catch (err) {
      log.warn("read_log_file_failed", { file: item.file, error: String(err?.message ?? err) });
      continue;
    }
    if (!text) continue;
    for (const rawLine of text.split(/\r?\n/)) {
      if (!rawLine) continue;
      const parsed = parseWarnOrErrorLine(rawLine);
      if (!parsed) continue;
      collected.push({
        seq: seq++,
        logger: item.logger,
        file: item.file,
        level: parsed.level,
        timestamp: parsed.timestamp,
        raw: parsed.raw,
      });
    }
  }

  collected.sort((a, b) => {
    if (a.timestamp && b.timestamp && a.timestamp !== b.timestamp) {
      return a.timestamp < b.timestamp ? -1 : 1;
    }
    return a.seq - b.seq;
  });

  const totalWarnErrorLines = collected.length;
  const tail = collected.slice(-maxLines);
  const entries = tail.map((entry) => {
    const redacted = redact(entry.raw);
    const line =
      redacted.length > maxLineChars
        ? `${redacted.slice(0, maxLineChars - 14)}... [truncated]`
        : redacted;
    return {
      logger: entry.logger,
      file: entry.file,
      level: entry.level,
      timestamp: entry.timestamp,
      line,
    };
  });

  log.info("diagnostic_logs_collected", {
    sessionSource,
    filesScanned: matchedFiles.length,
    totalWarnErrorLines,
    returnedLines: entries.length,
  });

  return {
    sessionId: resolvedSessionId,
    sessionSource,
    logsDir: redactedLogsDir,
    filesScanned: matchedFiles.length,
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
    logsDir: options.logsDir,
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
