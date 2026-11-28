/**
 * Opt-in LSP diagnostics integration after `write` / `edit` tool calls (issue #1445).
 *
 * Strictly disabled by default (`lsp_enabled: false`) so there is zero CPU/memory
 * overhead unless opted in. Never downloads external binaries — auto-detects only
 * language servers already installed on `PATH` (or explicitly configured via
 * `lsp_servers`).
 *
 * Architecture:
 * - Zero external npm dependencies: minimal JSON-RPC 2.0 `Content-Length` stdio
 *   client built directly on `node:child_process`.
 * - Lazy per-(rootDir, serverId) server pool: spawned only on the first matching
 *   `write`/`edit` call.
 * - Bounded diagnostic wait (`1500ms` default): never blocks `write`/`edit` if a
 *   language server hangs or crashes.
 * - Strict lifecycle & fail-soft: `.unref()`'d 5-minute idle teardown timer,
 *   clean `shutdown`/`exit` + `SIGTERM` (with `SIGKILL` fallback) on
 *   `session_shutdown`, and silent degradation on missing binaries or errors.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { acquireTokenFileLock } from "../shared/file-lock.js";
import { isLiveExtensionCtx } from "../shared/live-ctx.js";
import { createLogger, type Logger } from "../shared/logger.js";
import {
  loadGlobalSettings,
  readSettingsFile,
  type LspServersConfig,
} from "./project-settings.js";
import { openStateDb, withTransaction } from "./state-db.js";
import { resolveWorktreeRoot } from "./utils.js";

const defaultLog = createLogger("lsp");

export const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 1_500;
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;
export const DEFAULT_DEBOUNCE_MS = 150;
export const DEFAULT_SHUTDOWN_GRACE_MS = 500;
export const DEFAULT_KILL_GRACE_MS = 300;
export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 2;
export const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1_000;
export const MAX_DIAGNOSTIC_LINES = 20;
export const DEFAULT_PENDING_INSTALL_POLL_MS = 2_000;
export const DEFAULT_PENDING_CLAIM_TTL_MS = 5 * 60 * 1_000;
export const DEFAULT_PROMPT_ERROR_BACKOFF_MS = 30_000;

const MAX_RPC_BUFFER_BYTES = 10 * 1024 * 1024;
const CIRCUIT_CRASH_WINDOW_MS = 60_000;
const LSP_INSTALL_DISMISSED_KEY = "lsp_install_dismissed";
const HEADER_DELIM = Buffer.from("\r\n\r\n", "ascii");
const TRUTHY_ENV = new Set(["1", "true", "yes", "on"]);
const FALSY_ENV = new Set(["0", "false", "no", "off"]);
const BROKER_DAEMON_SCRIPT = fileURLToPath(new URL("./lsp-broker-daemon.mjs", import.meta.url));

// ── Types ────────────────────────────────────────────────────────────

export interface LspServerCandidate {
  command: string;
  args: string[];
}

export interface BuiltinLspServerSpec {
  id: string;
  extensions: readonly string[];
  candidates: readonly LspServerCandidate[];
}

export interface ResolvedLspServer {
  serverId: string;
  command: string;
  args: string[];
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end?: LspPosition;
}

export interface LspDiagnostic {
  range?: LspRange;
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
}

export interface LspInstallRecipe {
  serverId: string;
  label: string;
  binary: string;
  displayCmd: string;
  prereq: string;
}

export interface LspManagerOptions {
  timeoutMs?: number;
  idleTimeoutMs?: number;
  debounceMs?: number;
  shutdownGraceMs?: number;
  killGraceMs?: number;
  maxDiagnosticLines?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerCooldownMs?: number;
  /** When true, route diagnostics through the shared 1-per-(worktreeRoot, serverId) UNIX-socket broker. */
  useBroker?: boolean;
  /** Override broker socket directory (defaults to `~/.pi/run/lsp`). */
  brokerRunDir?: string;
  envPath?: string;
  logger?: Logger;
  /** Internal lifecycle hook invoked when `LspManager.shutdownAll()` runs. */
  onShutdown?: () => void;
}

export interface RegisterLspOptions extends LspManagerOptions {
  /** Override subagent-child check in tests. */
  isSubagentChild?: () => boolean;
  /** Override SQLite DB path for "Don't ask again" install prompt persistence in tests. */
  installPrefsDbPath?: string;
  /** Override installer execution in tests. Return `{ ok, error? }`. */
  installRunner?: (
    recipe: LspInstallRecipe,
    options?: { signal?: AbortSignal },
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Override executable verification after install in tests. */
  verifyInstalled?: (binary: string, envPath?: string) => string | null;
  /** Poll interval for idle cross-process pending install checks (`0` disables watcher). */
  pendingPollIntervalMs?: number;
  /** Lease TTL for atomic cross-process pending install claims. */
  pendingClaimTtlMs?: number;
  /** Per-session retry backoff after a transient `ctx.ui.select()` failure. */
  promptErrorBackoffMs?: number;
}

export const BUILTIN_INSTALL_RECIPES: Readonly<Record<string, LspInstallRecipe>> = Object.freeze({
  typescript: {
    serverId: "typescript",
    label: "typescript-language-server",
    binary: "typescript-language-server",
    // Isolated prefix keeps typescript@6 (needed because typescript@7+ removed lib/tsserver.js)
    // without downgrading any globally installed TypeScript compiler (`tsc`).
    displayCmd: "npm install --prefix ~/.pi/lsp/ts-lsp typescript@6 typescript-language-server",
    prereq: "npm",
  },
  python: {
    serverId: "python",
    label: "basedpyright",
    binary: "basedpyright-langserver",
    displayCmd: "uv tool install --upgrade basedpyright",
    prereq: "uv",
  },
  go: {
    serverId: "go",
    label: "gopls",
    binary: "gopls",
    displayCmd: "go install golang.org/x/tools/gopls@latest",
    prereq: "go",
  },
});

export const BUILTIN_LSP_SERVERS: readonly BuiltinLspServerSpec[] = Object.freeze([
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    candidates: [{ command: "typescript-language-server", args: ["--stdio"] }],
  },
  {
    id: "python",
    extensions: [".py", ".pyi"],
    candidates: [
      { command: "basedpyright-langserver", args: ["--stdio"] },
      { command: "pyright-langserver", args: ["--stdio"] },
      { command: "ruff", args: ["server"] },
    ],
  },
  {
    id: "go",
    extensions: [".go"],
    candidates: [{ command: "gopls", args: [] }],
  },
]);

const LANGUAGE_IDS: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".rb": "ruby",
  ".php": "php",
  ".sh": "shellscript",
  ".bash": "shellscript",
};

// ── Pure helpers ─────────────────────────────────────────────────────

/** Encode a JSON-RPC 2.0 message with LSP `Content-Length` framing. */
export function encodeJsonRpcMessage(payload: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

/** Detect LSP languageId from a file path's extension. */
export function detectLanguageId(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext && LANGUAGE_IDS[ext]) return LANGUAGE_IDS[ext];
  return ext ? ext.slice(1) : "plaintext";
}

/** Normalize file:// URIs so server responses match local paths reliably. */
export function normalizeFileUri(uri: string): string {
  try {
    return pathToFileURL(fileURLToPath(uri)).href;
  } catch {
    return uri;
  }
}

function isExecutableFile(candidatePath: string): boolean {
  try {
    if (!fs.statSync(candidatePath).isFile()) return false;
    fs.accessSync(candidatePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an already-installed executable on `PATH` (or at an explicit absolute path).
 * Pure filesystem check — never spawns a shell, never downloads binaries, and
 * rejects relative path commands or relative `PATH` directories so spawning under
 * an untrusted project `cwd` can never resolve a repository-supplied binary.
 */
export function findExecutableOnPath(
  command: string,
  envPath: string = process.env.PATH ?? "",
): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  const hasSeparator =
    trimmed.includes("/") ||
    trimmed.includes(path.sep) ||
    (process.platform === "win32" && trimmed.includes("\\"));

  if (hasSeparator) {
    if (!path.isAbsolute(trimmed)) return null;
    return isExecutableFile(trimmed) ? trimmed : null;
  }

  const dirs = envPath.split(path.delimiter).filter((dir) => dir.length > 0 && path.isAbsolute(dir));
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];

  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, `${trimmed}${ext}`);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

export function getManagedLspDir(): string {
  return path.join(os.homedir(), ".pi", "lsp");
}

export function getManagedTsLspPrefix(managedDir: string = getManagedLspDir()): string {
  return path.join(managedDir, "ts-lsp");
}

export function getManagedLspBinDir(managedDir: string = getManagedLspDir()): string {
  return path.join(managedDir, "bin");
}

function getDefaultLspSearchPath(): string {
  const sysParts = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const home = os.homedir();
  const candidates = [
    ...sysParts,
    getManagedLspBinDir(),
    path.join(home, ".local", "bin"),
    path.join(home, "go", "bin"),
  ];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const dir of candidates) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    deduped.push(dir);
  }
  return deduped.join(path.delimiter);
}

function isBuiltinServerInstalled(serverId: string, envPath?: string): boolean {
  const spec = BUILTIN_LSP_SERVERS.find((s) => s.id === serverId);
  if (!spec) return false;
  const searchPath = envPath === undefined ? getDefaultLspSearchPath() : envPath;
  return spec.candidates.some((c) => findExecutableOnPath(c.command, searchPath) !== null);
}

/**
 * Resolve the matching already-installed LSP server for `filePath`.
 * User overrides in `lsp_servers` take precedence over built-in defaults.
 */
export function resolveServerForFile(
  filePath: string,
  overrides: LspServersConfig = {},
  envPath?: string,
): ResolvedLspServer | null {
  const searchPath = envPath === undefined ? getDefaultLspSearchPath() : envPath;
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return null;

  const overriddenIds = new Set<string>();
  for (const [serverId, cfg] of Object.entries(overrides)) {
    overriddenIds.add(serverId);
    const exts = cfg.extensions.map((e) => {
      const lower = e.trim().toLowerCase();
      return lower.startsWith(".") ? lower : `.${lower}`;
    });
    if (!exts.includes(ext)) continue;
    const resolvedCmd = findExecutableOnPath(cfg.command, searchPath);
    if (resolvedCmd) {
      return { serverId, command: resolvedCmd, args: cfg.args ? [...cfg.args] : [] };
    }
  }

  for (const spec of BUILTIN_LSP_SERVERS) {
    if (overriddenIds.has(spec.id)) continue;
    if (!spec.extensions.includes(ext)) continue;
    for (const candidate of spec.candidates) {
      const resolvedCmd = findExecutableOnPath(candidate.command, searchPath);
      if (resolvedCmd) {
        return { serverId: spec.id, command: resolvedCmd, args: [...candidate.args] };
      }
    }
  }

  return null;
}

/**
 * Format LSP error/warning diagnostics concisely (`file:line:col [error|warning] message`),
 * sorted errors-first and capped at `maxLines` diagnostic lines.
 * Returns `null` when there are no error/warning diagnostics.
 */
export function formatDiagnostics(
  diagnostics: readonly LspDiagnostic[],
  filePath: string,
  rootDir: string,
  serverId: string,
  maxLines: number = MAX_DIAGNOSTIC_LINES,
): string | null {
  // Per LSP 3.17, diagnostic.severity is optional; omitted severity defaults to Error (1).
  const effectiveSeverity = (d: LspDiagnostic): number => d.severity ?? 1;
  const relevant = diagnostics.filter((d) => {
    if (!d) return false;
    const sev = effectiveSeverity(d);
    return sev === 1 || sev === 2;
  });
  if (relevant.length === 0) return null;

  const sorted = [...relevant].sort((a, b) => {
    const sevDiff = effectiveSeverity(a) - effectiveSeverity(b);
    if (sevDiff !== 0) return sevDiff;
    const lineDiff = (a.range?.start?.line ?? 0) - (b.range?.start?.line ?? 0);
    if (lineDiff !== 0) return lineDiff;
    return (a.range?.start?.character ?? 0) - (b.range?.start?.character ?? 0);
  });

  const rel = path.relative(rootDir, filePath);
  const displayPath = rel && !rel.startsWith("..") && !path.isAbsolute(rel)
    ? rel.split(path.sep).join("/")
    : filePath;

  const cap = Math.max(1, maxLines);
  const shown = sorted.slice(0, cap);
  const lines = shown.map((d) => {
    const line = (d.range?.start?.line ?? 0) + 1;
    const col = (d.range?.start?.character ?? 0) + 1;
    const severity = effectiveSeverity(d) === 1 ? "error" : "warning";
    const message = String(d.message ?? "").replace(/\s+/g, " ").trim() || "(no message)";
    return `${displayPath}:${line}:${col} [${severity}] ${message}`;
  });

  const omitted = sorted.length - shown.length;
  if (omitted > 0) {
    lines.push(`... and ${omitted} more diagnostic(s)`);
  }

  return `LSP diagnostics (${serverId}):\n${lines.join("\n")}`;
}

function isLspDisabledInSubagents(): boolean {
  const raw = (process.env.PI_LSP_IN_SUBAGENTS ?? "").trim().toLowerCase();
  return FALSY_ENV.has(raw);
}

/**
 * Return the built-in server ID matching `filePath` when none of its binaries are
 * installed on `PATH` and no `lsp_servers` override replaces that built-in ID.
 */
export function findMissingBuiltinServerId(
  filePath: string,
  overrides: LspServersConfig = {},
  envPath?: string,
): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return null;
  if (resolveServerForFile(filePath, overrides, envPath) !== null) return null;

  for (const spec of BUILTIN_LSP_SERVERS) {
    if (spec.id in overrides) continue;
    if (!spec.extensions.includes(ext)) continue;
    if (BUILTIN_INSTALL_RECIPES[spec.id]) return spec.id;
  }
  return null;
}

/**
 * Return `true` only when `ctx` represents a real interactive TUI session that
 * can safely prompt with `ctx.ui.select()`.
 *
 * Pi `--mode rpc` (used by `scripts/coms-peer-supervisor.mjs`) sets `ctx.hasUI = true`
 * while `ctx.mode === "rpc"` and `PI_COMS_SUPERVISED_PEER === "1"`; calling
 * `ctx.ui.select()` there deadlocks indefinitely because the supervisor never answers
 * `extension_ui_request`.
 */
export function isInteractiveTuiForLspPrompt(
  ctx: any,
  isSubagent: boolean = process.env.PI_SUBAGENT_CHILD === "1",
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isSubagent) return false;
  if (env.PI_COMS_SUPERVISED_PEER === "1") return false;
  if (ctx?.hasUI !== true || typeof ctx?.ui?.select !== "function") return false;
  const mode = ctx?.mode;
  return mode === undefined || mode === "tui";
}

// ── Startup summary entry (issue #1492) ──────────────────────────────

export const LSP_STARTUP_SUMMARY_ENTRY_TYPE = "lsp-startup-summary";

export interface LspStartupSummaryData {
  summary: string;
  enabled: boolean;
  available: string[];
  missing: string[];
}

function formatLspBinaryLabel(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";
  const base = path.basename(trimmed);
  if (base === "basedpyright-langserver") return "basedpyright";
  if (base === "pyright-langserver") return "pyright";
  return base;
}

/**
 * Probe built-in + global `lsp_servers` binary availability on PATH using pure local
 * executable checks ONLY (never spawns LSP servers or touches the network) and format
 * a concise 1-line startup summary matching the `Providers: ...` visual convention.
 */
export function buildLspStartupSummary(options: {
  enabled?: boolean;
  overrides?: LspServersConfig;
  envPath?: string;
} = {}): LspStartupSummaryData {
  const enabled = options.enabled ?? resolveTrustedLspEnabled();
  const overrides = options.overrides ?? resolveTrustedLspServers();
  const searchPath = options.envPath === undefined ? getDefaultLspSearchPath() : options.envPath;

  const available: string[] = [];
  const missing: string[] = [];
  const seenAvailable = new Set<string>();
  const seenMissing = new Set<string>();

  const pushUnique = (list: string[], seen: Set<string>, label: string): void => {
    if (!label || seen.has(label)) return;
    seen.add(label);
    list.push(label);
  };

  const probeOverride = (serverId: string, cfg: LspServersConfig[string]): void => {
    const cmd = typeof cfg?.command === "string" ? cfg.command.trim() : "";
    const label = formatLspBinaryLabel(cmd) || serverId;
    if (cmd && findExecutableOnPath(cmd, searchPath) !== null) {
      pushUnique(available, seenAvailable, label);
    } else {
      pushUnique(missing, seenMissing, label);
    }
  };

  const builtinIds = new Set<string>();
  for (const spec of BUILTIN_LSP_SERVERS) {
    builtinIds.add(spec.id);
    if (Object.prototype.hasOwnProperty.call(overrides, spec.id)) {
      probeOverride(spec.id, overrides[spec.id]);
      continue;
    }
    let matchedCommand: string | null = null;
    for (const candidate of spec.candidates) {
      if (findExecutableOnPath(candidate.command, searchPath) !== null) {
        matchedCommand = candidate.command;
        break;
      }
    }
    if (matchedCommand) {
      pushUnique(available, seenAvailable, formatLspBinaryLabel(matchedCommand) || spec.id);
    } else {
      const fallback =
        BUILTIN_INSTALL_RECIPES[spec.id]?.label ??
        formatLspBinaryLabel(spec.candidates[0]?.command ?? "") ??
        spec.id;
      pushUnique(missing, seenMissing, fallback);
    }
  }

  for (const [serverId, cfg] of Object.entries(overrides)) {
    if (builtinIds.has(serverId)) continue;
    probeOverride(serverId, cfg);
  }

  const prefix = enabled ? "LSP" : "LSP (off)";
  const body = available.length > 0 ? available.join(", ") : "none installed";
  return {
    summary: `${prefix}: ${body}`,
    enabled,
    available,
    missing,
  };
}

/**
 * Emit the LSP startup summary ONLY on interactive TUI `startup` or `new` sessions,
 * strictly skipping `/reload`, `/resume`, oneshot (`pi -p`), subagents, and supervised
 * headless COMS RPC peers.
 */
export function shouldEmitLspStartupSummary(
  event: unknown,
  ctx: any,
  isSubagent: boolean = process.env.PI_SUBAGENT_CHILD === "1",
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isSubagent) return false;
  if (env.PI_COMS_SUPERVISED_PEER === "1") return false;
  if (ctx?.mode !== "tui" || ctx?.hasUI !== true) return false;
  const reason =
    typeof (event as { reason?: unknown })?.reason === "string"
      ? (event as { reason: string }).reason
      : "";
  return reason === "startup" || reason === "new";
}

/** A muted summary renderer component without a runtime dependency on Pi's TUI package. */
function lspStartupSummaryComponent(
  summary: string,
  theme: { fg: (color: "muted", text: string) => string },
  log: Logger,
) {
  log.debug("lsp_startup_summary_render", { summary });
  return {
    render: (_width: number): string[] => [theme.fg("muted", summary)],
    invalidate: (): void => {},
  };
}

// ── Missing-server install prompt persistence (SQLite kv_state) ──────

export function getDefaultLspPrefsDbPath(): string {
  const dir = path.join(os.homedir(), ".pi", "data");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "state.db");
}

function readDismissedLspServers(dbPath: string): Set<string> {
  try {
    const db = openStateDb(dbPath);
    const row = db
      .prepare("SELECT payload FROM kv_state WHERE store_key = ?")
      .get(LSP_INSTALL_DISMISSED_KEY) as { payload?: string } | undefined;
    if (!row?.payload) return new Set();
    const parsed = JSON.parse(row.payload) as { dismissed?: unknown };
    if (!Array.isArray(parsed?.dismissed)) return new Set();
    return new Set(parsed.dismissed.filter((v): v is string => typeof v === "string"));
  } catch (err: any) {
    defaultLog.debug("lsp_read_dismissed_failed", { dbPath, error: err?.message ?? String(err) });
    return new Set();
  }
}

export function isLspInstallDismissed(serverId: string, dbPath: string = getDefaultLspPrefsDbPath()): boolean {
  return readDismissedLspServers(dbPath).has(serverId);
}

export function dismissLspInstallPermanently(serverId: string, dbPath: string = getDefaultLspPrefsDbPath()): void {
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    withTransaction(dbPath, (db) => {
      const existing = readDismissedLspServers(dbPath);
      existing.add(serverId);
      const payload = JSON.stringify({ dismissed: [...existing].sort() });
      db.prepare(
        `INSERT INTO kv_state (store_key, payload, revision, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(store_key) DO UPDATE SET
           payload = excluded.payload,
           revision = kv_state.revision + 1,
           updated_at = excluded.updated_at`,
      ).run(LSP_INSTALL_DISMISSED_KEY, payload, new Date().toISOString());
    });
  } catch (err: any) {
    defaultLog.warn("lsp_persist_dismissed_failed", { serverId, error: err?.message ?? String(err) });
  }
}

export interface PendingLspInstallRequest {
  serverId: string;
  requestedAt: string;
  sourceCwd: string;
  sourceRole: string;
}

const LSP_PENDING_INSTALL_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS lsp_pending_install_requests (
    server_id TEXT PRIMARY KEY,
    requested_at TEXT NOT NULL,
    source_cwd TEXT NOT NULL DEFAULT '',
    source_role TEXT NOT NULL DEFAULT '',
    claimed_by TEXT NOT NULL DEFAULT '',
    claimed_at INTEGER NOT NULL DEFAULT 0
  )
`;

function ensurePendingInstallTable(db: DatabaseSync): void {
  db.exec(LSP_PENDING_INSTALL_TABLE_SQL);
  const cols = db
    .prepare("PRAGMA table_info(lsp_pending_install_requests)")
    .all() as Array<{ name?: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("claimed_by")) {
    db.exec("ALTER TABLE lsp_pending_install_requests ADD COLUMN claimed_by TEXT NOT NULL DEFAULT ''");
  }
  if (!names.has("claimed_at")) {
    db.exec("ALTER TABLE lsp_pending_install_requests ADD COLUMN claimed_at INTEGER NOT NULL DEFAULT 0");
  }
}

export function recordPendingLspInstallRequest(
  serverId: string,
  meta: { sourceCwd?: string; sourceRole?: string } = {},
  dbPath: string = getDefaultLspPrefsDbPath(),
): void {
  if (!BUILTIN_INSTALL_RECIPES[serverId]) return;
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    withTransaction(dbPath, (db) => {
      ensurePendingInstallTable(db);
      db.prepare(
        `INSERT INTO lsp_pending_install_requests (server_id, requested_at, source_cwd, source_role)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(server_id) DO UPDATE SET
           requested_at = excluded.requested_at,
           source_cwd = excluded.source_cwd,
           source_role = excluded.source_role`,
      ).run(serverId, new Date().toISOString(), meta.sourceCwd ?? "", meta.sourceRole ?? "");
    });
  } catch (err: any) {
    defaultLog.warn("lsp_record_pending_install_failed", {
      serverId,
      error: err?.message ?? String(err),
    });
  }
}

export function acquirePendingLspInstallClaim(
  serverId: string,
  ownerId: string,
  meta: { sourceCwd?: string; sourceRole?: string } = {},
  dbPath: string = getDefaultLspPrefsDbPath(),
  ttlMs: number = DEFAULT_PENDING_CLAIM_TTL_MS,
  nowMs: number = Date.now(),
): boolean {
  if (!BUILTIN_INSTALL_RECIPES[serverId]) return false;
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    return withTransaction(dbPath, (db) => {
      ensurePendingInstallTable(db);
      const insertRes = db
        .prepare(
          `INSERT OR IGNORE INTO lsp_pending_install_requests
           (server_id, requested_at, source_cwd, source_role, claimed_by, claimed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          serverId,
          new Date(nowMs).toISOString(),
          meta.sourceCwd ?? "",
          meta.sourceRole ?? "",
          ownerId,
          nowMs,
        );
      if (Number(insertRes.changes) > 0) return true;

      const updateRes = db
        .prepare(
          `UPDATE lsp_pending_install_requests
           SET claimed_by = ?, claimed_at = ?
           WHERE server_id = ? AND (claimed_by = '' OR claimed_by = ? OR claimed_at <= ?)`,
        )
        .run(ownerId, nowMs, serverId, ownerId, nowMs - Math.max(0, ttlMs));
      return Number(updateRes.changes) > 0;
    });
  } catch (err: any) {
    defaultLog.warn("lsp_acquire_pending_install_claim_failed", {
      serverId,
      error: err?.message ?? String(err),
    });
    return false;
  }
}

export function renewPendingLspInstallClaim(
  serverId: string,
  ownerId: string,
  dbPath: string = getDefaultLspPrefsDbPath(),
  nowMs: number = Date.now(),
): boolean {
  if (!fs.existsSync(dbPath)) return false;
  try {
    return withTransaction(dbPath, (db) => {
      ensurePendingInstallTable(db);
      const res = db
        .prepare("UPDATE lsp_pending_install_requests SET claimed_at = ? WHERE server_id = ? AND claimed_by = ?")
        .run(nowMs, serverId, ownerId);
      return Number(res.changes) > 0;
    });
  } catch (err: any) {
    defaultLog.warn("lsp_renew_pending_install_claim_failed", {
      serverId,
      error: err?.message ?? String(err),
    });
    return false;
  }
}

export function claimPendingLspInstallRequest(
  serverId: string,
  ownerId: string,
  dbPath: string = getDefaultLspPrefsDbPath(),
  ttlMs: number = DEFAULT_PENDING_CLAIM_TTL_MS,
  nowMs: number = Date.now(),
): boolean {
  if (!fs.existsSync(dbPath)) return false;
  try {
    return withTransaction(dbPath, (db) => {
      ensurePendingInstallTable(db);
      const res = db
        .prepare(
          `UPDATE lsp_pending_install_requests
           SET claimed_by = ?, claimed_at = ?
           WHERE server_id = ? AND (claimed_by = '' OR claimed_by = ? OR claimed_at <= ?)`,
        )
        .run(ownerId, nowMs, serverId, ownerId, nowMs - Math.max(0, ttlMs));
      return Number(res.changes) > 0;
    });
  } catch (err: any) {
    defaultLog.warn("lsp_claim_pending_install_failed", {
      serverId,
      error: err?.message ?? String(err),
    });
    return false;
  }
}

export function releasePendingLspInstallClaim(
  serverId: string,
  ownerId: string,
  dbPath: string = getDefaultLspPrefsDbPath(),
): void {
  if (!fs.existsSync(dbPath)) return;
  try {
    withTransaction(dbPath, (db) => {
      ensurePendingInstallTable(db);
      db.prepare(
        "UPDATE lsp_pending_install_requests SET claimed_by = '', claimed_at = 0 WHERE server_id = ? AND claimed_by = ?",
      ).run(serverId, ownerId);
    });
  } catch (err: any) {
    defaultLog.warn("lsp_release_pending_install_claim_failed", {
      serverId,
      error: err?.message ?? String(err),
    });
  }
}

export function releasePendingLspInstallClaimsByOwner(
  ownerId: string,
  dbPath: string = getDefaultLspPrefsDbPath(),
  excludeServerIds?: ReadonlySet<string>,
): void {
  if (!fs.existsSync(dbPath)) return;
  try {
    withTransaction(dbPath, (db) => {
      ensurePendingInstallTable(db);
      if (excludeServerIds && excludeServerIds.size > 0) {
        const excluded = [...excludeServerIds];
        const placeholders = excluded.map(() => "?").join(", ");
        db.prepare(
          `UPDATE lsp_pending_install_requests
           SET claimed_by = '', claimed_at = 0
           WHERE claimed_by = ? AND server_id NOT IN (${placeholders})`,
        ).run(ownerId, ...excluded);
      } else {
        db.prepare(
          "UPDATE lsp_pending_install_requests SET claimed_by = '', claimed_at = 0 WHERE claimed_by = ?",
        ).run(ownerId);
      }
    });
  } catch (err: any) {
    defaultLog.warn("lsp_release_pending_install_claims_failed", {
      ownerId,
      error: err?.message ?? String(err),
    });
  }
}

export function listPendingLspInstallRequests(
  dbPath: string = getDefaultLspPrefsDbPath(),
): PendingLspInstallRequest[] {
  if (!fs.existsSync(dbPath)) return [];
  try {
    const db = openStateDb(dbPath);
    const rows = db
      .prepare(
        "SELECT server_id, requested_at, source_cwd, source_role FROM lsp_pending_install_requests ORDER BY requested_at ASC",
      )
      .all() as Array<{
      server_id: string;
      requested_at: string;
      source_cwd: string;
      source_role: string;
    }>;
    return rows.map((row) => ({
      serverId: row.server_id,
      requestedAt: row.requested_at,
      sourceCwd: row.source_cwd ?? "",
      sourceRole: row.source_role ?? "",
    }));
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (msg.includes("no such table")) return [];
    defaultLog.debug("lsp_list_pending_install_failed", { dbPath, error: msg });
    return [];
  }
}

export function clearPendingLspInstallRequest(
  serverId: string,
  dbPath: string = getDefaultLspPrefsDbPath(),
): void {
  if (!fs.existsSync(dbPath)) return;
  try {
    withTransaction(dbPath, (db) => {
      ensurePendingInstallTable(db);
      db.prepare("DELETE FROM lsp_pending_install_requests WHERE server_id = ?").run(serverId);
    });
  } catch (err: any) {
    defaultLog.warn("lsp_clear_pending_install_failed", {
      serverId,
      error: err?.message ?? String(err),
    });
  }
}

export function clearPendingLspInstallRequestIfOwned(
  serverId: string,
  ownerId: string,
  dbPath: string = getDefaultLspPrefsDbPath(),
): boolean {
  if (!fs.existsSync(dbPath)) return false;
  try {
    return withTransaction(dbPath, (db) => {
      ensurePendingInstallTable(db);
      const res = db
        .prepare(
          "DELETE FROM lsp_pending_install_requests WHERE server_id = ? AND (claimed_by = '' OR claimed_by = ?)",
        )
        .run(serverId, ownerId);
      return Number(res.changes) > 0;
    });
  } catch (err: any) {
    defaultLog.warn("lsp_clear_pending_install_failed", {
      serverId,
      error: err?.message ?? String(err),
    });
    return false;
  }
}

function prependDirToProcessPath(binDir: string): void {
  if (!binDir || !path.isAbsolute(binDir)) return;
  const current = process.env.PATH ?? "";
  const parts = current.split(path.delimiter).filter(Boolean);
  if (!parts.includes(binDir)) {
    process.env.PATH = current ? `${binDir}${path.delimiter}${current}` : binDir;
  }
}

const MAX_INSTALL_OUTPUT_BYTES = 64 * 1024;
const PROCESS_GROUP_POLL_MS = 20;
const PROCESS_GROUP_TERM_WAIT_MS = 500;
const PROCESS_GROUP_KILL_WAIT_MS = 1_000;

function createAbortError(message = "Install aborted"): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

async function runAbortableProcessGroup(
  command: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted) {
    throw createAbortError();
  }

  const child = spawn(command, args, {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;

  child.stdout?.on("data", (chunk: Buffer) => {
    const remaining = MAX_INSTALL_OUTPUT_BYTES - stdoutBytes;
    if (remaining <= 0) return;
    const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    stdoutChunks.push(slice);
    stdoutBytes += slice.byteLength;
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const remaining = MAX_INSTALL_OUTPUT_BYTES - stderrBytes;
    if (remaining <= 0) return;
    const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    stderrChunks.push(slice);
    stderrBytes += slice.byteLength;
  });

  const state: {
    aborted: boolean;
    timedOut: boolean;
    childClosed: boolean;
    spawnError: Error | null;
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
    terminatePromise: Promise<void> | null;
  } = {
    aborted: false,
    timedOut: false,
    childClosed: false,
    spawnError: null,
    exitCode: null,
    exitSignal: null,
    terminatePromise: null,
  };

  let resolveChildClose!: () => void;
  const childClosePromise = new Promise<void>((resolve) => {
    resolveChildClose = resolve;
  });
  const markChildClosed = (): void => {
    if (state.childClosed) return;
    state.childClosed = true;
    resolveChildClose();
  };

  const waitUntilGroupDead = async (pgid: number, maxWaitMs: number): Promise<boolean> => {
    const deadline = Date.now() + maxWaitMs;
    while (!state.childClosed || isProcessGroupAlive(pgid)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise((r) => setTimeout(r, Math.min(PROCESS_GROUP_POLL_MS, remaining)));
    }
    return true;
  };

  const signalProcessGroup = (pgid: number, sig: NodeJS.Signals): void => {
    try {
      process.kill(-pgid, sig);
    } catch (err: any) {
      if (err?.code !== "ESRCH") {
        defaultLog.debug("lsp_install_pgid_signal_failed", {
          pgid,
          signal: sig,
          error: err?.message ?? String(err),
        });
      }
    }
  };

  const terminateProcessGroupAndWait = (target: ChildProcess): Promise<void> => {
    if (state.terminatePromise) return state.terminatePromise;
    state.terminatePromise = (async () => {
      const pid = target.pid;
      if (!pid || pid <= 0) {
        await childClosePromise;
        return;
      }

      if (process.platform === "win32") {
        await new Promise<void>((resolve) => {
          try {
            const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true,
            });
            killer.once("error", () => resolve());
            killer.once("close", () => resolve());
          } catch {
            resolve();
          }
        });
        await childClosePromise;
        return;
      }

      const pgid = pid;
      signalProcessGroup(pgid, "SIGTERM");
      if (await waitUntilGroupDead(pgid, PROCESS_GROUP_TERM_WAIT_MS)) {
        return;
      }
      signalProcessGroup(pgid, "SIGKILL");
      await waitUntilGroupDead(pgid, PROCESS_GROUP_KILL_WAIT_MS);
    })();
    return state.terminatePromise;
  };

  child.once("error", (err) => {
    state.spawnError = err;
    if (!child.pid) {
      markChildClosed();
    } else {
      void terminateProcessGroupAndWait(child);
    }
  });

  child.once("exit", (code, signal) => {
    state.exitCode = code;
    state.exitSignal = signal;
    if (process.platform !== "win32" && child.pid && child.pid > 0 && isProcessGroupAlive(child.pid)) {
      void terminateProcessGroupAndWait(child);
    }
  });

  child.once("close", (code, signal) => {
    if (state.exitCode === null && code !== null) state.exitCode = code;
    if (state.exitSignal === null && signal !== null) state.exitSignal = signal;
    markChildClosed();
    if (process.platform !== "win32" && child.pid && child.pid > 0 && isProcessGroupAlive(child.pid)) {
      void terminateProcessGroupAndWait(child);
    }
  });

  const onAbort = (): void => {
    state.aborted = true;
    void terminateProcessGroupAndWait(child);
  };

  const timer = setTimeout(() => {
    if (!state.aborted && state.exitCode === null && state.exitSignal === null) {
      state.timedOut = true;
    }
    void terminateProcessGroupAndWait(child);
  }, Math.max(1, options.timeoutMs));
  timer.unref();

  if (options.signal) {
    if (options.signal.aborted) {
      onAbort();
    } else {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    await childClosePromise;
    if (state.terminatePromise) {
      await state.terminatePromise;
    } else if (process.platform !== "win32" && child.pid && child.pid > 0 && isProcessGroupAlive(child.pid)) {
      await terminateProcessGroupAndWait(child);
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }

  if (state.aborted || options.signal?.aborted) {
    throw createAbortError();
  }
  if (state.timedOut) {
    throw new Error("Install timed out");
  }

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  if (state.spawnError) {
    const detail = stderr.trim();
    throw new Error(detail || state.spawnError.message || `Failed to run ${command}`);
  }
  if (state.exitCode === 0 && state.exitSignal === null) {
    return { stdout, stderr };
  }
  const detail = stderr.trim();
  const reason = state.exitSignal ? `signal ${state.exitSignal}` : `exit code ${state.exitCode ?? "unknown"}`;
  throw new Error(detail || `${command} exited with ${reason}`);
}

/**
 * Safely run a built-in LSP server install recipe (no shell interpolation).
 * TypeScript installs `typescript@6` + `typescript-language-server` into an
 * isolated prefix (`~/.pi/lsp/ts-lsp`) and symlinks only `typescript-language-server`
 * into `~/.pi/lsp/bin` so any global `tsc` installation is never downgraded.
 */
export async function runLspServerInstall(
  recipe: LspInstallRecipe,
  envPath: string = process.env.PATH ?? "",
  options: { managedLspDir?: string; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; error?: string }> {
  if (options.signal?.aborted) {
    return { ok: false, error: "Install aborted" };
  }
  const prereqBin = findExecutableOnPath(recipe.prereq, envPath);
  if (!prereqBin) {
    return { ok: false, error: `${recipe.prereq} is not installed on PATH` };
  }
  if (recipe.serverId !== "typescript" && recipe.serverId !== "python" && recipe.serverId !== "go") {
    return { ok: false, error: `Unsupported server recipe: ${recipe.serverId}` };
  }

  let releaseLock: (() => void) | null = null;
  try {
    const managedDir = options.managedLspDir ?? getManagedLspDir();
    fs.mkdirSync(managedDir, { recursive: true });
    releaseLock = acquireTokenFileLock(
      path.join(managedDir, `.install-${recipe.serverId}.lock`),
      { uniqueClaim: true, linkTemp: true },
    );
    if (!releaseLock) {
      return { ok: false, error: "Another LSP installation is already in progress" };
    }
    if (options.signal?.aborted) {
      return { ok: false, error: "Install aborted" };
    }

    if (recipe.serverId === "typescript") {
      const prefixDir = getManagedTsLspPrefix(managedDir);
      const binDir = getManagedLspBinDir(managedDir);
      fs.mkdirSync(prefixDir, { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });
      await runAbortableProcessGroup(
        prereqBin,
        ["install", "--prefix", prefixDir, "typescript@6", "typescript-language-server"],
        { timeoutMs: 180_000, signal: options.signal },
      );
      if (options.signal?.aborted) {
        return { ok: false, error: "Install aborted" };
      }
      const target = path.join(prefixDir, "node_modules", ".bin", "typescript-language-server");
      const link = path.join(binDir, "typescript-language-server");
      if (fs.existsSync(target)) {
        try {
          fs.lstatSync(link);
          fs.unlinkSync(link);
        } catch {
          // Not present
        }
        fs.symlinkSync(target, link);
      }
      prependDirToProcessPath(binDir);
      return { ok: true };
    }

    if (recipe.serverId === "python") {
      await runAbortableProcessGroup(prereqBin, ["tool", "install", "--upgrade", "basedpyright"], {
        timeoutMs: 180_000,
        signal: options.signal,
      });
      if (options.signal?.aborted) {
        return { ok: false, error: "Install aborted" };
      }
      prependDirToProcessPath(path.join(os.homedir(), ".local", "bin"));
      return { ok: true };
    }

    await runAbortableProcessGroup(prereqBin, ["install", "golang.org/x/tools/gopls@latest"], {
      timeoutMs: 180_000,
      signal: options.signal,
    });
    if (options.signal?.aborted) {
      return { ok: false, error: "Install aborted" };
    }
    let goBin = path.join(os.homedir(), "go", "bin");
    try {
      const { stdout } = await runAbortableProcessGroup(prereqBin, ["env", "GOPATH"], {
        timeoutMs: 5_000,
        signal: options.signal,
      });
      const gopath = stdout.trim().split(path.delimiter)[0];
      if (gopath && path.isAbsolute(gopath)) goBin = path.join(gopath, "bin");
    } catch {
      if (options.signal?.aborted) {
        return { ok: false, error: "Install aborted" };
      }
      // Fallback to ~/go/bin
    }
    prependDirToProcessPath(goBin);
    return { ok: true };
  } catch (err: any) {
    if (options.signal?.aborted || err?.name === "AbortError" || err?.code === "ABORT_ERR") {
      return { ok: false, error: "Install aborted" };
    }
    const detail = (err?.stderr || err?.message || String(err)).toString().trim().slice(0, 300);
    return { ok: false, error: detail };
  } finally {
    releaseLock?.();
  }
}

// ── Shared UNIX-socket broker helpers ────────────────────────────────

function tryRealPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

export function getDefaultLspBrokerRunDir(): string {
  return path.join(os.homedir(), ".pi", "run", "lsp");
}

/** Deterministic `0600` UNIX socket path per `(worktreeRoot, serverId)`, safely under 104 bytes. */
export function getLspBrokerSocketPath(
  worktreeRoot: string,
  serverId: string,
  runDir: string = getDefaultLspBrokerRunDir(),
): string {
  const canonicalRoot = tryRealPath(worktreeRoot);
  const hash = createHash("sha256").update(`${canonicalRoot}\0${serverId}`).digest("hex").slice(0, 16);
  return path.join(runDir, `lsp-${hash}.sock`);
}

export function sendBrokerRequest(
  socketPath: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<any> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let raw = "";
    const socket = net.createConnection(socketPath);

    const done = (err: Error | null, res?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(res);
    };

    const timer = setTimeout(() => {
      done(new Error("LSP broker request timed out"));
    }, Math.max(1, timeoutMs));
    timer.unref();

    socket.on("error", (err) => done(err));
    socket.on("connect", () => {
      try {
        socket.write(`${JSON.stringify(payload)}\n`);
      } catch (err: any) {
        done(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_RPC_BUFFER_BYTES) {
        done(new Error("LSP broker reply exceeded max buffer size"));
        return;
      }
      const nl = raw.indexOf("\n");
      if (nl === -1) return;
      const line = raw.slice(0, nl).trim();
      try {
        done(null, JSON.parse(line));
      } catch (err: any) {
        done(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.on("end", () => {
      if (!settled) {
        const line = raw.trim();
        if (line) {
          try {
            done(null, JSON.parse(line));
            return;
          } catch {
            // Fall through
          }
        }
        done(new Error("LSP broker closed connection without reply"));
      }
    });
  });
}

async function acquireLockAsync(lockPath: string, deadline: number): Promise<(() => void) | null> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  while (Date.now() < deadline) {
    const release = acquireTokenFileLock(lockPath, { attempts: 1 });
    if (release) return release;
    const waitMs = Math.min(25, Math.max(1, deadline - Date.now()));
    // Keep this short bounded backoff timer ref'd so the event loop cannot exit mid-await
    // while waiting on an external lockfile or detached broker startup.
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return null;
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Resolve `lsp_enabled` from trusted user-controlled sources only (global settings
 * or `PI_LSP_ENABLED` env). Project `.pi/pi-config-settings.json` is never allowed
 * to silently enable LSP in cloned/untrusted repositories.
 */
export function resolveTrustedLspEnabled(): boolean {
  const globalVal = loadGlobalSettings().lsp_enabled;
  if (typeof globalVal === "boolean") return globalVal;
  const rawEnv = process.env.PI_LSP_ENABLED;
  if (rawEnv !== undefined && rawEnv !== "") {
    return TRUTHY_ENV.has(rawEnv.trim().toLowerCase());
  }
  return false;
}

/**
 * Resolve `lsp_servers` strictly from global `~/.pi/pi-config-settings.json`.
 * Repo-committed project settings are ignored so cloned repos cannot run arbitrary
 * binaries on write/edit.
 */
export function resolveTrustedLspServers(): LspServersConfig {
  return loadGlobalSettings().lsp_servers ?? {};
}

// ── JSON-RPC 2.0 Stdio LSP Client ────────────────────────────────────

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface DiagnosticWaiter {
  minVersion: number;
  resolve: (diagnostics: LspDiagnostic[] | null) => void;
  timer: NodeJS.Timeout;
}

export class LspClient {
  readonly rootDir: string;
  readonly serverId: string;
  private readonly command: string;
  private readonly args: string[];
  private readonly idleTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly killGraceMs: number;
  private readonly log: Logger;
  private readonly onDispose: () => void;

  private child: ChildProcess | null = null;
  private recvBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private nextId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly openedDocs = new Map<string, number>();
  private readonly waiters = new Map<string, Set<DiagnosticWaiter>>();
  private readonly inFlightUriCounts = new Map<string, number>();
  private readonly uriReleaseListeners = new Set<() => void>();
  private readonly versionedUris = new Set<string>();
  private readonly ambiguousUris = new Set<string>();
  private initPromise: Promise<boolean> | null = null;
  private initialized = false;
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private inFlightRequests = 0;

  constructor(opts: {
    rootDir: string;
    serverId: string;
    command: string;
    args: string[];
    idleTimeoutMs: number;
    shutdownGraceMs: number;
    killGraceMs: number;
    log: Logger;
    onDispose: () => void;
  }) {
    this.rootDir = opts.rootDir;
    this.serverId = opts.serverId;
    this.command = opts.command;
    this.args = opts.args;
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.shutdownGraceMs = opts.shutdownGraceMs;
    this.killGraceMs = opts.killGraceMs;
    this.log = opts.log;
    this.onDispose = opts.onDispose;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** True when `uri` timed out on an unversioned document, making later attribution ambiguous until reset. */
  needsResetFor(uri: string): boolean {
    return this.ambiguousUris.has(uri);
  }

  /** True when `uri` has an active check in flight on a document not known to receive versioned diagnostics. */
  hasUnversionedInFlight(uri: string): boolean {
    return !this.versionedUris.has(uri) && (this.inFlightUriCounts.get(uri) ?? 0) > 0;
  }

  /** True when any document other than `uri` currently has an active check in flight on this client. */
  hasOtherActiveChecks(uri: string): boolean {
    for (const [activeUri, count] of this.inFlightUriCounts) {
      if (activeUri !== uri && count > 0) return true;
    }
    return false;
  }

  /** Wait until all checks for URIs other than `uri` finish, bounded by `maxWaitMs`. */
  waitForOtherChecks(uri: string, maxWaitMs: number): Promise<boolean> {
    if (!this.hasOtherActiveChecks(uri) || this.closed) return Promise.resolve(true);
    if (maxWaitMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.uriReleaseListeners.delete(onRelease);
      };
      const onRelease = () => {
        if (!this.hasOtherActiveChecks(uri) || this.closed) {
          cleanup();
          resolve(true);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(!this.hasOtherActiveChecks(uri) || this.closed);
      }, Math.max(1, maxWaitMs));
      timer.unref();
      this.uriReleaseListeners.add(onRelease);
    });
  }

  /** Synchronously reserve `uri` before any async boundary so simultaneous same-URI checks see overlap. */
  reserveUri(uri: string): void {
    this.inFlightUriCounts.set(uri, (this.inFlightUriCounts.get(uri) ?? 0) + 1);
  }

  releaseUri(uri: string): void {
    const next = (this.inFlightUriCounts.get(uri) ?? 0) - 1;
    if (next > 0) this.inFlightUriCounts.set(uri, next);
    else this.inFlightUriCounts.delete(uri);
    for (const listener of [...this.uriReleaseListeners]) {
      listener();
    }
  }

  matchesServer(command: string, args: readonly string[]): boolean {
    return (
      this.command === command &&
      this.args.length === args.length &&
      this.args.every((arg, idx) => arg === args[idx])
    );
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.closed || this.idleTimeoutMs <= 0 || this.inFlightRequests > 0) return;
    this.idleTimer = setTimeout(() => {
      this.log.info("lsp_idle_shutdown", { serverId: this.serverId, rootDir: this.rootDir });
      void this.shutdown();
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private startProcess(): boolean {
    if (this.closed) return false;
    if (this.child) return true;

    try {
      const child = spawn(this.command, this.args, {
        cwd: this.rootDir,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      this.log.info("lsp_server_spawned", {
        serverId: this.serverId,
        command: this.command,
        args: this.args,
        rootDir: this.rootDir,
        pid: child.pid,
      });

      child.stdin?.on("error", (err) => {
        this.log.debug("lsp_stdin_error", { serverId: this.serverId, error: err.message });
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        this.onStdoutData(chunk);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (text) {
          this.log.debug("lsp_stderr", { serverId: this.serverId, text: text.slice(0, 500) });
        }
      });

      child.on("error", (err) => {
        this.log.warn("lsp_process_error", { serverId: this.serverId, command: this.command, error: err.message });
        this.handleProcessExit(null, null);
      });

      child.on("exit", (code, signal) => {
        this.log.debug("lsp_process_exit", { serverId: this.serverId, pid: child.pid, code, signal });
        this.handleProcessExit(code, signal);
      });

      return true;
    } catch (err: any) {
      this.log.warn("lsp_spawn_failed", {
        serverId: this.serverId,
        command: this.command,
        error: err?.message ?? String(err),
      });
      this.handleProcessExit(null, null);
      return false;
    }
  }

  private handleProcessExit(_code: number | null, _signal: NodeJS.Signals | null): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.closed = true;
    this.initialized = false;
    this.recvBuf = Buffer.alloc(0);

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("LSP server exited"));
      this.pendingRequests.delete(id);
    }

    for (const [uri, set] of this.waiters) {
      for (const waiter of set) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
      this.waiters.delete(uri);
    }
    this.inFlightUriCounts.clear();
    this.versionedUris.clear();
    this.ambiguousUris.clear();
    for (const listener of [...this.uriReleaseListeners]) {
      listener();
    }
    this.uriReleaseListeners.clear();

    this.onDispose();
  }

  private writeMessage(payload: Record<string, unknown>): boolean {
    if (this.closed || !this.child?.stdin || this.child.stdin.destroyed || !this.child.stdin.writable) {
      return false;
    }
    try {
      this.child.stdin.write(encodeJsonRpcMessage(payload));
      return true;
    } catch (err: any) {
      this.log.debug("lsp_write_failed", { serverId: this.serverId, error: err?.message ?? String(err) });
      return false;
    }
  }

  private sendRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("LSP client closed"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, Math.max(1, timeoutMs));
      timer.unref();

      this.pendingRequests.set(id, { resolve, reject, timer });
      const ok = this.writeMessage({ jsonrpc: "2.0", id, method, params });
      if (!ok) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error(`LSP write failed: ${method}`));
      }
    });
  }

  private sendNotification(method: string, params: unknown): boolean {
    return this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  private onStdoutData(chunk: Buffer): void {
    if (this.closed) return;
    this.recvBuf = this.recvBuf.byteLength === 0 ? chunk : Buffer.concat([this.recvBuf, chunk]);

    if (this.recvBuf.byteLength > MAX_RPC_BUFFER_BYTES) {
      this.log.warn("lsp_buffer_overflow", { serverId: this.serverId, bytes: this.recvBuf.byteLength });
      void this.shutdown();
      return;
    }

    for (;;) {
      const headerEnd = this.recvBuf.indexOf(HEADER_DELIM);
      if (headerEnd === -1) break;

      const headerStr = this.recvBuf.subarray(0, headerEnd).toString("ascii");
      const match = /^content-length:\s*(\d+)\s*$/im.exec(headerStr);
      if (!match) {
        this.log.warn("lsp_malformed_header", { serverId: this.serverId, header: headerStr.slice(0, 200) });
        void this.shutdown();
        return;
      }

      const contentLength = Number.parseInt(match[1], 10);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > MAX_RPC_BUFFER_BYTES) {
        this.log.warn("lsp_invalid_content_length", { serverId: this.serverId, contentLength });
        void this.shutdown();
        return;
      }

      const bodyStart = headerEnd + HEADER_DELIM.byteLength;
      if (this.recvBuf.byteLength < bodyStart + contentLength) break;

      const bodyStr = this.recvBuf.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
      this.recvBuf = this.recvBuf.subarray(bodyStart + contentLength);

      let msg: any;
      try {
        msg = JSON.parse(bodyStr);
      } catch (err: any) {
        this.log.debug("lsp_json_parse_error", { serverId: this.serverId, error: err?.message });
        continue;
      }

      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: any): void {
    if (!msg || typeof msg !== "object") return;

    // Response to our request
    if (typeof msg.id === "number" && !("method" in msg)) {
      const pending = this.pendingRequests.get(msg.id);
      if (!pending) return;
      this.pendingRequests.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server-to-client request: reply cleanly so real servers never stall
    if ("id" in msg && typeof msg.method === "string") {
      if (msg.method === "workspace/configuration") {
        const items = Array.isArray(msg.params?.items) ? msg.params.items : [];
        this.writeMessage({ jsonrpc: "2.0", id: msg.id, result: items.map(() => ({})) });
      } else {
        this.writeMessage({ jsonrpc: "2.0", id: msg.id, result: null });
      }
      return;
    }

    // Server notification
    if (msg.method === "textDocument/publishDiagnostics" && msg.params && typeof msg.params.uri === "string") {
      const uri = normalizeFileUri(msg.params.uri);
      const diagnostics: LspDiagnostic[] = Array.isArray(msg.params.diagnostics) ? msg.params.diagnostics : [];
      const version = typeof msg.params.version === "number" ? msg.params.version : undefined;
      const latestVersion = this.openedDocs.get(uri);

      if (version !== undefined) {
        this.versionedUris.add(uri);
      } else {
        this.versionedUris.delete(uri);
        if (this.ambiguousUris.has(uri)) {
          this.log.debug("lsp_ambiguous_unversioned_diagnostics_dropped", {
            serverId: this.serverId,
            uri,
          });
          return;
        }
      }

      const set = this.waiters.get(uri);
      if (!set || set.size === 0) return;

      for (const waiter of [...set]) {
        if (latestVersion !== undefined && waiter.minVersion < latestVersion) {
          set.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(null);
          continue;
        }
        if (version !== undefined && version < waiter.minVersion) continue;
        set.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(diagnostics);
      }
      if (set.size === 0) this.waiters.delete(uri);
    }
  }

  private ensureInitialized(budgetMs: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.initialized) return Promise.resolve(true);

    if (!this.initPromise) {
      if (!this.startProcess()) return Promise.resolve(false);

      const rootUri = pathToFileURL(this.rootDir).href;
      // Allow real servers a slightly wider internal init window than one edit's wait
      // while still racing the caller against `budgetMs` so `write`/`edit` never blocks.
      const rpcTimeoutMs = Math.max(budgetMs, 10_000);
      this.initPromise = this.sendRequest(
        "initialize",
        {
          processId: process.pid,
          rootUri,
          rootPath: this.rootDir,
          workspaceFolders: [{ uri: rootUri, name: path.basename(this.rootDir) }],
          capabilities: {
            textDocument: {
              synchronization: { didSave: true, dynamicRegistration: false },
              publishDiagnostics: { relatedInformation: false },
            },
            workspace: {
              workspaceFolders: true,
              configuration: true,
            },
          },
        },
        rpcTimeoutMs,
      )
        .then(() => {
          if (this.closed) return false;
          this.sendNotification("initialized", {});
          this.initialized = true;
          this.log.info("lsp_server_initialized", { serverId: this.serverId, rootDir: this.rootDir });
          return true;
        })
        .catch((err: any) => {
          this.log.warn("lsp_initialize_failed", {
            serverId: this.serverId,
            error: err?.message ?? String(err),
          });
          void this.shutdown();
          return false;
        });
    }

    // Bound this caller's wait to `budgetMs`
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.log.debug("lsp_initialize_wait_timeout", { serverId: this.serverId, budgetMs });
        resolve(false);
      }, Math.max(1, budgetMs));
      timer.unref();

      this.initPromise!.then((ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      }).catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  /**
   * Notify the language server about `absPath` (`didOpen` or `didChange`) and wait
   * up to `timeoutMs` for `textDocument/publishDiagnostics`.
   */
  async checkFile(absPath: string, timeoutMs: number): Promise<LspDiagnostic[] | null> {
    if (this.closed) return null;
    const uri = normalizeFileUri(pathToFileURL(absPath).href);
    this.inFlightRequests++;
    this.clearIdleTimer();
    try {
      return await this.checkFileInner(absPath, uri, timeoutMs);
    } finally {
      this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
      this.armIdleTimer();
    }
  }

  private async checkFileInner(absPath: string, uri: string, timeoutMs: number): Promise<LspDiagnostic[] | null> {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const ready = await this.ensureInitialized(deadline - Date.now());
    if (!ready || this.closed) return null;

    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;

    let text: string;
    try {
      text = fs.readFileSync(absPath, "utf8");
    } catch (err: any) {
      this.log.debug("lsp_read_file_failed", { filePath: absPath, error: err?.message });
      return null;
    }

    const prevVersion = this.openedDocs.get(uri);
    const nextVersion = prevVersion === undefined ? 1 : prevVersion + 1;
    this.openedDocs.set(uri, nextVersion);

    // Supersede any older waiters for this URI so stale edits never receive mismatched publishes.
    const existingWaiters = this.waiters.get(uri);
    if (existingWaiters) {
      for (const oldWaiter of existingWaiters) {
        clearTimeout(oldWaiter.timer);
        oldWaiter.resolve(null);
      }
      existingWaiters.clear();
    }

    const diagnosticsPromise = new Promise<LspDiagnostic[] | null>((resolve) => {
      let set = this.waiters.get(uri);
      if (!set) {
        set = new Set();
        this.waiters.set(uri, set);
      }

      const waiter: DiagnosticWaiter = {
        minVersion: nextVersion,
        resolve,
        timer: setTimeout(() => {
          set?.delete(waiter);
          if (set && set.size === 0) this.waiters.delete(uri);
          // For documents that do not receive versioned diagnostics, a timed-out edit makes any
          // future unversioned publication for this URI unattributable. Mark ONLY this URI
          // ambiguous so unrelated documents on the same server are never disrupted.
          if (!this.versionedUris.has(uri)) {
            this.ambiguousUris.add(uri);
          }
          this.log.debug("lsp_diagnostics_timeout", { serverId: this.serverId, filePath: absPath, timeoutMs });
          resolve(null);
        }, Math.max(1, remaining)),
      };
      waiter.timer.unref();
      set.add(waiter);
    });

    const sent =
      prevVersion === undefined
        ? this.sendNotification("textDocument/didOpen", {
            textDocument: {
              uri,
              languageId: detectLanguageId(absPath),
              version: nextVersion,
              text,
            },
          })
        : this.sendNotification("textDocument/didChange", {
            textDocument: { uri, version: nextVersion },
            contentChanges: [{ text }],
          });

    if (!sent) {
      const set = this.waiters.get(uri);
      if (set) {
        for (const waiter of set) {
          clearTimeout(waiter.timer);
          waiter.resolve(null);
        }
        this.waiters.delete(uri);
      }
      return null;
    }

    return diagnosticsPromise;
  }

  /** Gracefully shut down the LSP server (`shutdown`/`exit` -> `SIGTERM` -> `SIGKILL`). */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.shutdownPromise = (async () => {
      const wasInitialized = this.initialized;
      const child = this.child;

      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }

      // Resolve any waiting diagnostic callers immediately so shutdown never hangs callers.
      for (const [uri, set] of this.waiters) {
        for (const waiter of set) {
          clearTimeout(waiter.timer);
          waiter.resolve(null);
        }
        this.waiters.delete(uri);
      }

      if (!child || child.exitCode !== null || child.signalCode !== null) {
        this.handleProcessExit(child?.exitCode ?? null, child?.signalCode ?? null);
        return;
      }

      const waitForExit = (ms: number): Promise<boolean> =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve(true);
            return;
          }
          const onExit = () => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.off("exit", onExit);
            resolve(false);
          }, Math.max(1, ms));
          timer.unref();
          child.once("exit", onExit);
        });

      // Attempt polite LSP shutdown/exit handshake before closing stdin.
      if (wasInitialized && !this.closed && child.stdin && !child.stdin.destroyed && child.stdin.writable) {
        try {
          await this.sendRequest("shutdown", null, this.shutdownGraceMs);
        } catch {
          // Best-effort — proceed to exit notification and SIGTERM
        }
        this.sendNotification("exit", null);
      }

      this.closed = true;
      try {
        child.stdin?.end();
      } catch {
        // Ignore
      }

      // Give polite exit a brief window, then SIGTERM, then SIGKILL fallback.
      const exitedPolitely = wasInitialized ? await waitForExit(Math.min(200, this.shutdownGraceMs)) : false;
      if (!exitedPolitely && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGTERM");
        } catch {
          // Process may have exited between checks
        }
        const exitedTerm = await waitForExit(this.killGraceMs);
        if (!exitedTerm && child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Process already gone
          }
          await waitForExit(200);
        }
      }

      this.handleProcessExit(child.exitCode, child.signalCode);
    })();

    return this.shutdownPromise;
  }

  /**
   * Synchronous last-resort kill for Node `process.on("exit")`.
   * Uses `SIGKILL` because Node cannot run async grace timers once exiting, so
   * even servers that trap or ignore `SIGTERM` are guaranteed to terminate.
   * Normal `session_shutdown` and idle teardown retain graceful `shutdown`/`exit`.
   */
  killSync(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.closed = true;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore — process may already have exited
      }
    }
  }
}

function waitWithinBudget(promise: Promise<unknown>, deadline: number): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, Math.max(1, remaining));
    timer.unref();
    promise.finally(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// ── Per-(worktreeRoot, serverId) Manager Pool ────────────────────────

interface CircuitState {
  crashes: number[];
  openUntil: number;
}

export class LspManager {
  private readonly clients = new Map<string, LspClient>();
  /** Tracks every created live client (including clients mid-replacement) so shutdown never misses any process. */
  private readonly allClients = new Set<LspClient>();
  /** Serializes replacement/reset per poolKey so concurrent edits never overwrite each other's client. */
  private readonly replacing = new Map<string, Promise<void>>();
  /** Broken-server circuit breaker state per (worktreeRoot, serverId, command, args). */
  private readonly circuits = new Map<string, CircuitState>();
  /** Broker sockets touched by this manager instance (used by `shutdownBrokers()`). */
  private readonly touchedBrokerSockets = new Set<string>();
  private readonly missingLogged = new Set<string>();
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly debounceMs: number;
  private readonly shutdownGraceMs: number;
  private readonly killGraceMs: number;
  private readonly maxDiagnosticLines: number;
  private readonly circuitThreshold: number;
  private readonly circuitCooldownMs: number;
  private readonly useBroker: boolean;
  private readonly brokerRunDir: string;
  private readonly envPath?: string;
  private readonly log: Logger;
  private readonly onShutdown?: () => void;
  private exitHookRegistered = false;
  private shuttingDown = false;
  private readonly onProcessExit = (): void => {
    this.killAllSync();
  };

  /** Synchronous last-resort teardown for Node `process.on("exit")` hooks. */
  killAllSync(): void {
    for (const client of this.allClients) {
      client.killSync();
    }
    this.clients.clear();
    this.allClients.clear();
    this.releaseExitHookIfEmpty();
  }

  constructor(options: LspManagerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DIAGNOSTICS_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.maxDiagnosticLines = options.maxDiagnosticLines ?? MAX_DIAGNOSTIC_LINES;
    this.circuitThreshold = options.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
    this.circuitCooldownMs = options.circuitBreakerCooldownMs ?? DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS;
    this.useBroker = options.useBroker ?? false;
    this.brokerRunDir = options.brokerRunDir ?? getDefaultLspBrokerRunDir();
    this.envPath = options.envPath;
    this.log = options.logger ?? defaultLog;
    this.onShutdown = options.onShutdown;
  }

  private circuitKey(worktreeRoot: string, server: ResolvedLspServer): string {
    return `${worktreeRoot}\0${server.serverId}\0${server.command}\0${JSON.stringify(server.args)}`;
  }

  isCircuitOpen(rootDir: string, server: ResolvedLspServer): boolean {
    const worktreeRoot = resolveWorktreeRoot(path.resolve(rootDir));
    const state = this.circuits.get(this.circuitKey(worktreeRoot, server));
    if (!state) return false;
    if (Date.now() < state.openUntil) return true;
    this.circuits.delete(this.circuitKey(worktreeRoot, server));
    return false;
  }

  private openCircuit(worktreeRoot: string, server: ResolvedLspServer): void {
    const key = this.circuitKey(worktreeRoot, server);
    const now = Date.now();
    this.circuits.set(key, { crashes: [now], openUntil: now + this.circuitCooldownMs });
    this.log.warn("lsp_circuit_breaker_open", {
      serverId: server.serverId,
      worktreeRoot,
      cooldownMs: this.circuitCooldownMs,
    });
  }

  private recordCrash(worktreeRoot: string, server: ResolvedLspServer): void {
    const key = this.circuitKey(worktreeRoot, server);
    const now = Date.now();
    const state = this.circuits.get(key) ?? { crashes: [], openUntil: 0 };
    state.crashes = state.crashes.filter((t) => now - t <= CIRCUIT_CRASH_WINDOW_MS);
    state.crashes.push(now);
    if (state.crashes.length >= this.circuitThreshold) {
      state.openUntil = now + this.circuitCooldownMs;
      this.log.warn("lsp_circuit_breaker_open", {
        serverId: server.serverId,
        worktreeRoot,
        crashes: state.crashes.length,
        cooldownMs: this.circuitCooldownMs,
      });
    }
    this.circuits.set(key, state);
  }

  private clearCircuit(worktreeRoot: string, server: ResolvedLspServer): void {
    this.circuits.delete(this.circuitKey(worktreeRoot, server));
  }

  get activeCount(): number {
    return this.allClients.size;
  }

  getActivePids(): number[] {
    const pids: number[] = [];
    for (const client of this.allClients) {
      if (client.pid !== undefined) pids.push(client.pid);
    }
    return pids;
  }

  private ensureExitHook(): void {
    if (this.exitHookRegistered) return;
    this.exitHookRegistered = true;
    process.on("exit", this.onProcessExit);
  }

  private releaseExitHookIfEmpty(): void {
    if (!this.exitHookRegistered || this.allClients.size > 0) return;
    this.exitHookRegistered = false;
    process.off("exit", this.onProcessExit);
  }

  private async ensureBrokerRunning(
    worktreeRoot: string,
    server: ResolvedLspServer,
    socketPath: string,
    deadline: number,
  ): Promise<boolean> {
    const lockPath = `${socketPath}.lock`;
    const release = await acquireLockAsync(lockPath, deadline);
    if (!release) {
      this.log.debug("lsp_broker_lock_timeout", { serverId: server.serverId, socketPath });
      return false;
    }

    try {
      // Re-probe inside the lock: another peer/subagent may have just started the broker.
      try {
        const pong = await sendBrokerRequest(socketPath, { op: "ping" }, Math.min(250, Math.max(50, deadline - Date.now())));
        if (pong?.ok) {
          if (pong.command === server.command && sameStringArray(pong.args ?? [], server.args)) {
            if (pong.broken) {
              this.openCircuit(worktreeRoot, server);
              return false;
            }
            return true;
          }
          // Server override changed — shut down the mismatched broker first.
          await sendBrokerRequest(socketPath, { op: "shutdown" }, Math.min(300, Math.max(50, deadline - Date.now()))).catch(() => {});
          while (Date.now() < deadline && fs.existsSync(socketPath)) {
            await new Promise((r) => setTimeout(r, 20));
          }
        }
      } catch {
        // Not running yet — proceed to spawn
      }

      if (this.shuttingDown || Date.now() >= deadline) return false;

      fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      try {
        const st = fs.lstatSync(socketPath);
        if (st.isSymbolicLink()) {
          this.log.warn("lsp_broker_socket_symlink_refused", { socketPath });
          return false;
        }
        if (st.isSocket()) fs.unlinkSync(socketPath);
      } catch {
        // Not present
      }

      const child = spawn(
        process.execPath,
        [
          BROKER_DAEMON_SCRIPT,
          `--socket=${socketPath}`,
          `--root=${worktreeRoot}`,
          `--server-id=${server.serverId}`,
          `--command=${server.command}`,
          `--args-json=${JSON.stringify(server.args)}`,
          `--idle-ms=${this.idleTimeoutMs}`,
          `--debounce-ms=${this.debounceMs}`,
        ],
        {
          cwd: worktreeRoot,
          detached: true,
          stdio: "ignore",
        },
      );
      child.on("error", (err) => {
        this.log.warn("lsp_broker_spawn_error", { serverId: server.serverId, error: err.message });
      });
      child.unref();
      this.log.info("lsp_broker_spawned", {
        serverId: server.serverId,
        worktreeRoot,
        socketPath,
        brokerPid: child.pid,
      });

      while (Date.now() < deadline && !this.shuttingDown) {
        try {
          const pong = await sendBrokerRequest(socketPath, { op: "ping" }, Math.min(200, Math.max(25, deadline - Date.now())));
          if (pong?.ok) return true;
        } catch {
          // Broker still binding socket
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    } finally {
      release();
    }
  }

  private async checkViaBroker(
    worktreeRoot: string,
    absPath: string,
    server: ResolvedLspServer,
    deadline: number,
  ): Promise<LspDiagnostic[] | null> {
    if (this.isCircuitOpen(worktreeRoot, server)) {
      this.log.debug("lsp_circuit_breaker_skipped", { serverId: server.serverId, worktreeRoot });
      return null;
    }

    const socketPath = getLspBrokerSocketPath(worktreeRoot, server.serverId, this.brokerRunDir);
    this.touchedBrokerSockets.add(socketPath);

    const runCheck = async (): Promise<{
      diagnostics: LspDiagnostic[] | null;
      retryable: boolean;
      mismatch: boolean;
      broken: boolean;
    }> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { diagnostics: null, retryable: false, mismatch: false, broken: false };
      try {
        const resp = await sendBrokerRequest(
          socketPath,
          {
            op: "check",
            filePath: absPath,
            command: server.command,
            args: server.args,
            timeoutMs: remaining,
          },
          remaining,
        );
        if (resp?.ok) {
          this.clearCircuit(worktreeRoot, server);
          return {
            diagnostics: Array.isArray(resp.diagnostics) ? resp.diagnostics : null,
            retryable: false,
            mismatch: false,
            broken: false,
          };
        }
        if (resp?.broken || resp?.error === "circuit_open") {
          this.openCircuit(worktreeRoot, server);
          return { diagnostics: null, retryable: false, mismatch: false, broken: true };
        }
        if (resp?.error === "server_mismatch") {
          return { diagnostics: null, retryable: true, mismatch: true, broken: false };
        }
        return { diagnostics: null, retryable: false, mismatch: false, broken: false };
      } catch {
        return { diagnostics: null, retryable: true, mismatch: false, broken: false };
      }
    };

    const first = await runCheck();
    if (!first.retryable || this.shuttingDown || Date.now() >= deadline) {
      return first.diagnostics;
    }

    const started = await this.ensureBrokerRunning(worktreeRoot, server, socketPath, deadline);
    if (!started || this.shuttingDown || Date.now() >= deadline) return null;

    const second = await runCheck();
    return second.diagnostics;
  }

  /** Ping the shared broker for `(rootDir, serverId)`, or `null` if not running. */
  async pingBroker(rootDir: string, serverId: string, timeoutMs = 300): Promise<any | null> {
    const worktreeRoot = resolveWorktreeRoot(path.resolve(rootDir));
    const socketPath = getLspBrokerSocketPath(worktreeRoot, serverId, this.brokerRunDir);
    try {
      const pong = await sendBrokerRequest(socketPath, { op: "ping" }, timeoutMs);
      return pong?.ok ? pong : null;
    } catch {
      return null;
    }
  }

  /** Shut down all shared broker sockets touched by this manager (mainly for cleanup/tests). */
  async shutdownBrokers(): Promise<void> {
    const sockets = [...this.touchedBrokerSockets];
    this.touchedBrokerSockets.clear();
    await Promise.allSettled(
      sockets.map((sock) => sendBrokerRequest(sock, { op: "shutdown" }, 500).catch(() => {})),
    );
  }

  private async acquireClient(
    poolKey: string,
    resolvedRoot: string,
    server: ResolvedLspServer,
    uri: string,
    deadline: number,
  ): Promise<LspClient | null> {
    for (;;) {
      if (this.shuttingDown || Date.now() >= deadline) return null;

      const pendingReplace = this.replacing.get(poolKey);
      if (pendingReplace) {
        const finishedInTime = await waitWithinBudget(pendingReplace, deadline);
        if (!finishedInTime) return null;
        continue;
      }

      const existing = this.clients.get(poolKey);
      if (existing) {
        if (existing.isClosed) {
          this.clients.delete(poolKey);
          continue;
        }
        const overrideChanged = !existing.matchesServer(server.command, server.args);
        const ambiguousUnversioned = existing.needsResetFor(uri) || existing.hasUnversionedInFlight(uri);
        if (!overrideChanged && !ambiguousUnversioned) {
          existing.reserveUri(uri);
          return existing;
        }

        // If an unversioned reset is needed for `uri`, let unrelated in-flight URIs finish
        // within our remaining deadline instead of cancelling their pending diagnostics.
        if (!overrideChanged && existing.hasOtherActiveChecks(uri)) {
          const drained = await existing.waitForOtherChecks(uri, deadline - Date.now());
          if (!drained) return null;
          continue;
        }

        this.log.info(
          overrideChanged ? "lsp_server_override_changed" : "lsp_unversioned_client_reset",
          { serverId: server.serverId, rootDir: resolvedRoot },
        );
        this.clients.delete(poolKey);
        const replacePromise = existing.shutdown().finally(() => {
          if (this.replacing.get(poolKey) === replacePromise) {
            this.replacing.delete(poolKey);
          }
        });
        this.replacing.set(poolKey, replacePromise);
        const finishedInTime = await waitWithinBudget(replacePromise, deadline);
        if (!finishedInTime) return null;
        continue;
      }

      if (this.shuttingDown || Date.now() >= deadline) return null;

      const created = new LspClient({
        rootDir: resolvedRoot,
        serverId: server.serverId,
        command: server.command,
        args: server.args,
        idleTimeoutMs: this.idleTimeoutMs,
        shutdownGraceMs: this.shutdownGraceMs,
        killGraceMs: this.killGraceMs,
        log: this.log,
        onDispose: () => {
          if (this.clients.get(poolKey) === created) {
            this.clients.delete(poolKey);
          }
          this.allClients.delete(created);
          this.releaseExitHookIfEmpty();
        },
      });
      this.clients.set(poolKey, created);
      this.allClients.add(created);
      this.ensureExitHook();
      created.reserveUri(uri);
      return created;
    }
  }

  /**
   * Lazily start (or reuse) the LSP server for `(rootDir, serverId)`, send
   * `didOpen`/`didChange`, wait boundedly for diagnostics, and format them.
   * Fail-soft: returns `null` if no server matches, binary is missing, or
   * the server hangs/crashes.
   */
  async getDiagnosticsForFile(
    rootDir: string,
    filePath: string,
    overrides: LspServersConfig = {},
  ): Promise<string | null> {
    if (this.shuttingDown) return null;
    const deadline = Date.now() + Math.max(1, this.timeoutMs);

    const resolvedRoot = path.resolve(rootDir);
    const absPath = path.resolve(resolvedRoot, filePath);

    const server = resolveServerForFile(absPath, overrides, this.envPath);
    if (!server) {
      const ext = path.extname(absPath).toLowerCase();
      if (ext && !this.missingLogged.has(ext)) {
        this.missingLogged.add(ext);
        this.log.debug("lsp_no_server_for_extension", { ext });
      }
      return null;
    }

    const poolKey = `${resolvedRoot}\0${server.serverId}`;
    const uri = normalizeFileUri(pathToFileURL(absPath).href);
    const worktreeRoot = resolveWorktreeRoot(resolvedRoot);

    if (this.useBroker) {
      const brokerDiagnostics = await this.checkViaBroker(worktreeRoot, absPath, server, deadline);
      if (this.shuttingDown || !brokerDiagnostics || brokerDiagnostics.length === 0) return null;
      return formatDiagnostics(brokerDiagnostics, absPath, resolvedRoot, server.serverId, this.maxDiagnosticLines);
    }

    if (this.isCircuitOpen(resolvedRoot, server)) {
      this.log.debug("lsp_circuit_breaker_skipped", { serverId: server.serverId, rootDir: resolvedRoot });
      return null;
    }

    const client = await this.acquireClient(poolKey, resolvedRoot, server, uri, deadline);
    if (!client) return null;

    let diagnostics: LspDiagnostic[] | null;
    try {
      const remaining = deadline - Date.now();
      if (this.shuttingDown || remaining <= 0) return null;
      diagnostics = await client.checkFile(absPath, remaining);
      if (diagnostics === null && client.isClosed && !this.shuttingDown) {
        this.recordCrash(worktreeRoot, server);
      } else if (diagnostics !== null) {
        this.clearCircuit(worktreeRoot, server);
      }
    } finally {
      client.releaseUri(uri);
    }
    if (this.shuttingDown || !diagnostics || diagnostics.length === 0) return null;

    return formatDiagnostics(diagnostics, absPath, resolvedRoot, server.serverId, this.maxDiagnosticLines);
  }

  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
    this.onShutdown?.();
    while (this.allClients.size > 0 || this.replacing.size > 0) {
      const pendingReplaces = [...this.replacing.values()];
      const active = [...this.allClients];
      this.clients.clear();
      await Promise.allSettled([
        ...pendingReplaces,
        ...active.map((c) => c.shutdown()),
      ]);
      for (const c of active) {
        this.allClients.delete(c);
      }
    }
    this.releaseExitHookIfEmpty();
  }
}

// ── Pi Extension Registration ────────────────────────────────────────

export function registerLsp(pi: ExtensionAPI, options: RegisterLspOptions = {}): { manager: LspManager } {
  const log = options.logger ?? defaultLog;
  if (typeof pi.registerEntryRenderer === "function") {
    pi.registerEntryRenderer<LspStartupSummaryData>(
      LSP_STARTUP_SUMMARY_ENTRY_TYPE,
      (entry, _options, theme) => {
        const summary = typeof entry.data?.summary === "string" ? entry.data.summary : "";
        return summary ? lspStartupSummaryComponent(summary, theme, log) : undefined;
      },
    );
  }
  const checkSubagent = options.isSubagentChild ?? (() => process.env.PI_SUBAGENT_CHILD === "1");
  const installRunner =
    options.installRunner ??
    ((recipe, runOpts) => runLspServerInstall(recipe, options.envPath, { signal: runOpts?.signal }));
  const verifyInstalled = options.verifyInstalled ?? ((binary, envPath) => findExecutableOnPath(binary, envPath));
  const pendingPollIntervalMs = options.pendingPollIntervalMs ?? DEFAULT_PENDING_INSTALL_POLL_MS;
  const claimTtlMs = options.pendingClaimTtlMs ?? DEFAULT_PENDING_CLAIM_TTL_MS;
  const promptErrorBackoffMs = options.promptErrorBackoffMs ?? DEFAULT_PROMPT_ERROR_BACKOFF_MS;
  const claimOwnerId = `${process.pid}-${randomUUID()}`;
  const warnedUntrustedProject = new Set<string>();
  const promptedThisSession = new Set<string>();
  const promptInFlight = new Map<string, Promise<boolean>>();
  const promptRetryAfter = new Map<string, number>();
  const activeInstallServerIds = new Set<string>();
  let shuttingDown = false;
  let drainingPendingPrompts = false;
  let hasPendingClaims = false;
  let lastInteractiveCtx: any = null;
  let pendingPollTimer: ReturnType<typeof setInterval> | null = null;

  const isPromptBackedOff = (serverId: string): boolean => {
    const until = promptRetryAfter.get(serverId);
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    promptRetryAfter.delete(serverId);
    return false;
  };

  const stopPendingPollTimer = (): void => {
    if (pendingPollTimer) {
      clearInterval(pendingPollTimer);
      pendingPollTimer = null;
    }
  };

  const cleanupRegistration = (): void => {
    shuttingDown = true;
    stopPendingPollTimer();
    lastInteractiveCtx = null;
    if (hasPendingClaims) {
      releasePendingLspInstallClaimsByOwner(
        claimOwnerId,
        options.installPrefsDbPath ?? getDefaultLspPrefsDbPath(),
        activeInstallServerIds,
      );
      hasPendingClaims = activeInstallServerIds.size > 0;
    }
  };

  // Default to the shared per-worktree UNIX-socket broker in production registration
  // so main session, COMS peers, and editing subagents share 1 warm LSP server per worktree.
  const manager = new LspManager({
    useBroker: true,
    ...options,
    onShutdown: () => {
      cleanupRegistration();
      options.onShutdown?.();
    },
  });

  const promptAndInstallMissingServer = async (
    serverId: string,
    ctx: any,
    prefsDbPath: string,
    sourceRole?: string,
  ): Promise<boolean> => {
    const existingPrompt = promptInFlight.get(serverId);
    if (existingPrompt) {
      return existingPrompt;
    }

    const recipe = BUILTIN_INSTALL_RECIPES[serverId];
    if (
      !recipe ||
      shuttingDown ||
      promptedThisSession.has(serverId) ||
      isLspInstallDismissed(serverId, prefsDbPath) ||
      isPromptBackedOff(serverId)
    ) {
      releasePendingLspInstallClaim(serverId, claimOwnerId, prefsDbPath);
      return false;
    }

    const runPrompt = (async (): Promise<boolean> => {
      let ownershipLost = false;
      let claimFinalized = false;
      const installAbortController = new AbortController();
      let renewTimer: ReturnType<typeof setInterval> | null = null;
      const stopRenewTimer = (): void => {
        if (renewTimer) {
          clearInterval(renewTimer);
          renewTimer = null;
        }
      };

      if (claimTtlMs > 0) {
        const renewIntervalMs = Math.max(10, Math.floor(Math.max(30, claimTtlMs) / 3));
        renewTimer = setInterval(() => {
          if (shuttingDown && !activeInstallServerIds.has(serverId)) {
            stopRenewTimer();
            return;
          }
          if (!renewPendingLspInstallClaim(serverId, claimOwnerId, prefsDbPath)) {
            ownershipLost = true;
            stopRenewTimer();
            installAbortController.abort(new Error("LSP install claim lost"));
          }
        }, renewIntervalMs);
        renewTimer.unref();
      }

      try {
        const installChoice = `Install ${recipe.label}`;
        const notNowChoice = "Not now";
        const dismissChoice = `Don't ask again for ${recipe.label}`;
        const title =
          `LSP server "${recipe.label}" is not installed on PATH.\n` +
          `Command: ${recipe.displayCmd}`;

        let choice: string | undefined;
        try {
          choice = await ctx.ui.select(title, [installChoice, notNowChoice, dismissChoice]);
        } catch (err: any) {
          log.warn("lsp_install_prompt_failed", { serverId, error: err?.message ?? String(err) });
          releasePendingLspInstallClaim(serverId, claimOwnerId, prefsDbPath);
          claimFinalized = true;
          promptRetryAfter.set(serverId, Date.now() + Math.max(0, promptErrorBackoffMs));
          return false;
        }

        if (shuttingDown) {
          releasePendingLspInstallClaim(serverId, claimOwnerId, prefsDbPath);
          claimFinalized = true;
          return false;
        }

        if (ownershipLost || !renewPendingLspInstallClaim(serverId, claimOwnerId, prefsDbPath)) {
          log.warn("lsp_install_claim_lost", { serverId });
          claimFinalized = true;
          return false;
        }

        if (choice === dismissChoice) {
          promptRetryAfter.delete(serverId);
          promptedThisSession.add(serverId);
          dismissLspInstallPermanently(serverId, prefsDbPath);
          clearPendingLspInstallRequestIfOwned(serverId, claimOwnerId, prefsDbPath);
          claimFinalized = true;
          log.info("lsp_install_prompt_dismissed_permanently", { serverId });
          return false;
        }

        if (choice !== installChoice) {
          promptRetryAfter.delete(serverId);
          promptedThisSession.add(serverId);
          clearPendingLspInstallRequestIfOwned(serverId, claimOwnerId, prefsDbPath);
          claimFinalized = true;
          log.info("lsp_install_prompt_skipped_session", { serverId });
          return false;
        }

        const notifyUi = (msg: string, level: "info" | "warning"): void => {
          if (!shuttingDown && isLiveExtensionCtx(ctx)) {
            ctx.ui?.notify?.(msg, level);
          }
        };

        notifyUi(`Installing ${recipe.label}...`, "info");
        log.info("lsp_install_started", { serverId, command: recipe.displayCmd });
        let result: { ok: boolean; error?: string };
        activeInstallServerIds.add(serverId);
        try {
          result = await installRunner(recipe, { signal: installAbortController.signal });
        } catch (err: any) {
          result = { ok: false, error: err?.message ?? String(err) };
        } finally {
          activeInstallServerIds.delete(serverId);
          if (shuttingDown && activeInstallServerIds.size === 0) {
            hasPendingClaims = false;
          }
        }

        if (
          ownershipLost ||
          installAbortController.signal.aborted ||
          !renewPendingLspInstallClaim(serverId, claimOwnerId, prefsDbPath)
        ) {
          log.warn("lsp_install_claim_lost", { serverId, stage: "post_install" });
          releasePendingLspInstallClaim(serverId, claimOwnerId, prefsDbPath);
          claimFinalized = true;
          promptRetryAfter.set(serverId, Date.now() + Math.max(0, promptErrorBackoffMs));
          return false;
        }

        if (!result.ok) {
          log.warn("lsp_install_failed", { serverId, error: result.error });
          releasePendingLspInstallClaim(serverId, claimOwnerId, prefsDbPath);
          claimFinalized = true;
          promptRetryAfter.set(serverId, Date.now() + Math.max(0, promptErrorBackoffMs));
          notifyUi(`Failed to install ${recipe.label}: ${result.error || "unknown error"}`, "warning");
          return false;
        }

        const verified = verifyInstalled(recipe.binary, options.envPath ?? getDefaultLspSearchPath());
        if (!verified) {
          log.warn("lsp_install_binary_not_on_path", { serverId, binary: recipe.binary });
          releasePendingLspInstallClaim(serverId, claimOwnerId, prefsDbPath);
          claimFinalized = true;
          promptRetryAfter.set(serverId, Date.now() + Math.max(0, promptErrorBackoffMs));
          notifyUi(
            `Installed ${recipe.label}, but "${recipe.binary}" is not yet on PATH.`,
            "warning",
          );
          return false;
        }

        promptRetryAfter.delete(serverId);
        promptedThisSession.add(serverId);
        clearPendingLspInstallRequestIfOwned(serverId, claimOwnerId, prefsDbPath);
        claimFinalized = true;
        log.info("lsp_install_verified", {
          serverId,
          binary: verified,
          ...(sourceRole ? { sourceRole } : {}),
        });
        notifyUi(`Installed ${recipe.label} — LSP diagnostics active.`, "info");
        return true;
      } finally {
        stopRenewTimer();
        if (!claimFinalized) {
          releasePendingLspInstallClaim(serverId, claimOwnerId, prefsDbPath);
        }
      }
    })();

    promptInFlight.set(serverId, runPrompt);
    try {
      return await runPrompt;
    } finally {
      if (promptInFlight.get(serverId) === runPrompt) {
        promptInFlight.delete(serverId);
      }
    }
  };

  const handleMissingServer = async (
    missingId: string,
    ctx: any,
    cwd: string,
    filePath: string,
    overrides: LspServersConfig,
  ): Promise<string | null> => {
    const recipe = BUILTIN_INSTALL_RECIPES[missingId];
    if (!recipe) return null;

    const prefsDbPath = options.installPrefsDbPath ?? getDefaultLspPrefsDbPath();
    if (promptedThisSession.has(missingId) || isLspInstallDismissed(missingId, prefsDbPath)) {
      return null;
    }

    // Interactive TUI: ask user once with 3 clear choices
    if (isInteractiveTuiForLspPrompt(ctx, checkSubagent())) {
      if (shuttingDown || isPromptBackedOff(missingId)) {
        return null;
      }
      const existingPrompt = promptInFlight.get(missingId);
      if (existingPrompt) {
        const installed = await existingPrompt;
        return installed ? manager.getDiagnosticsForFile(cwd, filePath, overrides) : null;
      }
      if (
        !acquirePendingLspInstallClaim(
          missingId,
          claimOwnerId,
          { sourceCwd: cwd, sourceRole: "tui" },
          prefsDbPath,
          claimTtlMs,
        )
      ) {
        return null;
      }
      hasPendingClaims = true;
      const installed = await promptAndInstallMissingServer(missingId, ctx, prefsDbPath, "tui");
      return installed ? manager.getDiagnosticsForFile(cwd, filePath, overrides) : null;
    }

    // Headless / RPC / supervised peer / subagent: never block; record pending
    // request for the interactive TUI and emit a concise 1-line hint once per server.
    const sourceRole = checkSubagent()
      ? "subagent"
      : process.env.PI_COMS_SUPERVISED_PEER === "1"
        ? "coms-peer"
        : typeof ctx?.mode === "string"
          ? ctx.mode
          : "headless";
    recordPendingLspInstallRequest(missingId, { sourceCwd: cwd, sourceRole }, prefsDbPath);
    promptedThisSession.add(missingId);
    log.info("lsp_missing_server_hint", { serverId: missingId, binary: recipe.binary, sourceRole });
    return `[LSP] ${recipe.label} not found on PATH; run \`uv run scripts/install.py\` or edit in TUI to install (${recipe.displayCmd}).`;
  };

  const drainPendingLspInstallPrompts = async (ctx: any): Promise<void> => {
    if (
      shuttingDown ||
      drainingPendingPrompts ||
      !isLiveExtensionCtx(ctx) ||
      !isInteractiveTuiForLspPrompt(ctx, checkSubagent()) ||
      !resolveTrustedLspEnabled()
    ) {
      return;
    }

    drainingPendingPrompts = true;
    try {
      const prefsDbPath = options.installPrefsDbPath ?? getDefaultLspPrefsDbPath();
      const pending = listPendingLspInstallRequests(prefsDbPath);
      if (pending.length === 0) return;

      const overrides = resolveTrustedLspServers();
      for (const req of pending) {
        if (shuttingDown) break;
        if (
          !BUILTIN_INSTALL_RECIPES[req.serverId] ||
          req.serverId in overrides ||
          isLspInstallDismissed(req.serverId, prefsDbPath) ||
          isBuiltinServerInstalled(req.serverId, options.envPath)
        ) {
          clearPendingLspInstallRequestIfOwned(req.serverId, claimOwnerId, prefsDbPath);
          continue;
        }

        if (
          promptedThisSession.has(req.serverId) ||
          isPromptBackedOff(req.serverId) ||
          promptInFlight.has(req.serverId)
        ) {
          continue;
        }

        if (!claimPendingLspInstallRequest(req.serverId, claimOwnerId, prefsDbPath, claimTtlMs)) {
          continue;
        }
        hasPendingClaims = true;

        log.info("lsp_pending_install_prompt_draining", {
          serverId: req.serverId,
          sourceRole: req.sourceRole,
          sourceCwd: req.sourceCwd,
        });
        await promptAndInstallMissingServer(req.serverId, ctx, prefsDbPath, req.sourceRole);
      }
    } catch (err: any) {
      log.warn("lsp_pending_install_drain_error", { error: err?.message ?? String(err) });
    } finally {
      drainingPendingPrompts = false;
    }
  };

  const ensureIdlePendingWatcher = (ctx: any): void => {
    if (
      shuttingDown ||
      pendingPollIntervalMs <= 0 ||
      !isLiveExtensionCtx(ctx) ||
      !isInteractiveTuiForLspPrompt(ctx, checkSubagent())
    ) {
      return;
    }
    lastInteractiveCtx = ctx;
    if (pendingPollTimer) return;

    pendingPollTimer = setInterval(() => {
      if (shuttingDown || drainingPendingPrompts) return;
      const liveCtx = lastInteractiveCtx;
      if (!liveCtx || !isLiveExtensionCtx(liveCtx)) {
        lastInteractiveCtx = null;
        stopPendingPollTimer();
        return;
      }
      if (!isInteractiveTuiForLspPrompt(liveCtx, checkSubagent())) {
        return;
      }
      if (typeof liveCtx.isIdle === "function") {
        let idle = false;
        try {
          idle = liveCtx.isIdle() === true;
        } catch {
          lastInteractiveCtx = null;
          stopPendingPollTimer();
          return;
        }
        if (!idle) return;
      }
      void drainPendingLspInstallPrompts(liveCtx);
    }, pendingPollIntervalMs);
    pendingPollTimer.unref();
  };

  pi.on("session_start", async (event, ctx) => {
    if (
      !shuttingDown &&
      isLiveExtensionCtx(ctx) &&
      shouldEmitLspStartupSummary(event, ctx, checkSubagent())
    ) {
      try {
        const summaryData = buildLspStartupSummary({ envPath: options.envPath });
        if (typeof pi.appendEntry === "function") {
          pi.appendEntry<LspStartupSummaryData>(LSP_STARTUP_SUMMARY_ENTRY_TYPE, summaryData);
        }
        const sessionFile = ctx.sessionManager?.getSessionFile?.() || (ctx as any)?.sessionFile || "";
        try {
          pi.events?.emit?.("pidash:custom-entry", {
            customType: LSP_STARTUP_SUMMARY_ENTRY_TYPE,
            content: summaryData.summary,
            timestamp: Date.now(),
            ...(sessionFile ? { sessionFile } : {}),
          });
        } catch (emitErr: any) {
          log.debug("lsp_startup_summary_pidash_emit_failed", {
            error: emitErr?.message ?? String(emitErr),
          });
        }
        log.info("lsp_startup_summary", {
          enabled: summaryData.enabled,
          available: summaryData.available,
          missing: summaryData.missing,
        });
      } catch (err: any) {
        log.warn("lsp_startup_summary_failed", { error: err?.message ?? String(err) });
      }
    }
    ensureIdlePendingWatcher(ctx);
    if (
      isLiveExtensionCtx(ctx) &&
      (typeof (ctx as any)?.isIdle !== "function" || (ctx as any).isIdle() === true)
    ) {
      await drainPendingLspInstallPrompts(ctx);
    }
  });

  pi.on("tool_result", async (event, ctx): Promise<ToolResultEventResult | undefined> => {
    try {
      ensureIdlePendingWatcher(ctx);
      const toolName = (event as any).toolName as string;
      if (toolName === "subagent") {
        await drainPendingLspInstallPrompts(ctx);
        return undefined;
      }
      if (toolName !== "write" && toolName !== "edit") return undefined;
      if ((event as any).isError === true) return undefined;

      // Editing subagents are enabled by default when lsp_enabled is true (sharing the
      // per-worktree broker); opt out explicitly via PI_LSP_IN_SUBAGENTS=0/false.
      if (checkSubagent() && isLspDisabledInSubagents()) return undefined;

      // Check trusted global/env enablement FIRST before touching any project file
      // so disabled LSP never triggers legacy settings migration or git checks.
      if (!resolveTrustedLspEnabled()) return undefined;

      const cwd = ctx?.cwd || process.cwd();
      if (!warnedUntrustedProject.has(cwd)) {
        // Pure read-only inspection (no findSettingsFile / legacy .jsonc migration).
        const projectJsonPath = path.join(cwd, ".pi", "pi-config-settings.json");
        const rawProject = fs.existsSync(projectJsonPath) ? readSettingsFile(projectJsonPath) : null;
        if (
          rawProject &&
          (rawProject.lsp_enabled !== undefined ||
            (typeof rawProject.lsp_servers === "object" &&
              rawProject.lsp_servers !== null &&
              Object.keys(rawProject.lsp_servers as Record<string, unknown>).length > 0))
        ) {
          warnedUntrustedProject.add(cwd);
          log.warn("lsp_project_settings_ignored", {
            cwd,
            reason: "lsp_enabled and lsp_servers must be set in global settings or PI_LSP_ENABLED env",
          });
        }
      }

      const filePath: unknown = (event as any).input?.path;
      if (typeof filePath !== "string" || !filePath.trim()) return undefined;

      const overrides = resolveTrustedLspServers();
      const absPath = path.resolve(cwd, filePath);
      const missingId = findMissingBuiltinServerId(absPath, overrides, options.envPath);

      const formatted = missingId
        ? await handleMissingServer(missingId, ctx, cwd, filePath, overrides)
        : await manager.getDiagnosticsForFile(cwd, filePath, overrides);
      if (!formatted) return undefined;

      const currentContent = Array.isArray((event as any).content) ? (event as any).content : [];
      return {
        content: [...currentContent, { type: "text" as const, text: `\n${formatted}` }],
      };
    } catch (err: any) {
      log.warn("lsp_tool_result_error", { error: err?.message ?? String(err) });
      return undefined;
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    ensureIdlePendingWatcher(ctx);
    await drainPendingLspInstallPrompts(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    ensureIdlePendingWatcher(ctx);
    await drainPendingLspInstallPrompts(ctx);
  });

  pi.on("session_shutdown", async () => {
    cleanupRegistration();
    log.debug("lsp_session_shutdown", { active: manager.activeCount });
    await manager.shutdownAll();
  });

  return { manager };
}
