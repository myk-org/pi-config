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
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { createLogger, type Logger } from "../shared/logger.js";
import {
  loadGlobalSettings,
  readSettingsFile,
  type LspServersConfig,
} from "./project-settings.js";

const defaultLog = createLogger("lsp");

export const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 1_500;
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;
export const DEFAULT_SHUTDOWN_GRACE_MS = 500;
export const DEFAULT_KILL_GRACE_MS = 300;
export const MAX_DIAGNOSTIC_LINES = 20;

const MAX_RPC_BUFFER_BYTES = 10 * 1024 * 1024;
const HEADER_DELIM = Buffer.from("\r\n\r\n", "ascii");
const TRUTHY_ENV = new Set(["1", "true", "yes", "on"]);

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

export interface LspManagerOptions {
  timeoutMs?: number;
  idleTimeoutMs?: number;
  shutdownGraceMs?: number;
  killGraceMs?: number;
  maxDiagnosticLines?: number;
  envPath?: string;
  logger?: Logger;
}

export interface RegisterLspOptions extends LspManagerOptions {
  /** Override subagent-child check in tests. */
  isSubagentChild?: () => boolean;
}

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

/**
 * Resolve the matching already-installed LSP server for `filePath`.
 * User overrides in `lsp_servers` take precedence over built-in defaults.
 */
export function resolveServerForFile(
  filePath: string,
  overrides: LspServersConfig = {},
  envPath: string = process.env.PATH ?? "",
): ResolvedLspServer | null {
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
    const resolvedCmd = findExecutableOnPath(cfg.command, envPath);
    if (resolvedCmd) {
      return { serverId, command: resolvedCmd, args: cfg.args ? [...cfg.args] : [] };
    }
  }

  for (const spec of BUILTIN_LSP_SERVERS) {
    if (overriddenIds.has(spec.id)) continue;
    if (!spec.extensions.includes(ext)) continue;
    for (const candidate of spec.candidates) {
      const resolvedCmd = findExecutableOnPath(candidate.command, envPath);
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

function isLspAllowedInSubagents(): boolean {
  const raw = (process.env.PI_LSP_IN_SUBAGENTS ?? "").trim().toLowerCase();
  return TRUTHY_ENV.has(raw);
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
  private readonly inFlightUris = new Set<string>();
  private serverSupportsVersionedDiagnostics = false;
  private unversionedAmbiguous = false;
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

  /** True when an unversioned server timed out, making later attribution ambiguous until reset. */
  get needsReset(): boolean {
    return this.unversionedAmbiguous;
  }

  /** True when this URI has an active edit in flight on a server not known to send diagnostic versions. */
  hasUnversionedInFlight(uri: string): boolean {
    return !this.serverSupportsVersionedDiagnostics && this.inFlightUris.has(uri);
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
    this.inFlightUris.clear();

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
        this.serverSupportsVersionedDiagnostics = true;
      } else if (this.unversionedAmbiguous) {
        this.log.debug("lsp_ambiguous_unversioned_diagnostics_dropped", {
          serverId: this.serverId,
          uri,
        });
        return;
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
    this.inFlightUris.add(uri);
    this.clearIdleTimer();
    try {
      return await this.checkFileInner(absPath, uri, timeoutMs);
    } finally {
      this.inFlightUris.delete(uri);
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
          // For servers that omit diagnostic versions, a timed-out edit makes any future
          // unversioned publication unattributable (it could belong to the old edit or never
          // arrive at all). Mark this client for clean reset before the next check.
          if (!this.serverSupportsVersionedDiagnostics) {
            this.unversionedAmbiguous = true;
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

  /** Synchronous last-resort kill for Node `process.on("exit")`. */
  killSync(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.closed = true;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore
      }
    }
  }
}

// ── Per-(rootDir, serverId) Manager Pool ─────────────────────────────

export class LspManager {
  private readonly clients = new Map<string, LspClient>();
  /** Tracks every created live client (including clients mid-replacement) so shutdown never misses any process. */
  private readonly allClients = new Set<LspClient>();
  /** Serializes replacement/reset per poolKey so concurrent edits never overwrite each other's client. */
  private readonly replacing = new Map<string, Promise<void>>();
  private readonly missingLogged = new Set<string>();
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly killGraceMs: number;
  private readonly maxDiagnosticLines: number;
  private readonly envPath?: string;
  private readonly log: Logger;
  private exitHookRegistered = false;
  private shuttingDown = false;
  private readonly onProcessExit = (): void => {
    for (const client of this.allClients) {
      client.killSync();
    }
    this.clients.clear();
    this.allClients.clear();
  };

  constructor(options: LspManagerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DIAGNOSTICS_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.maxDiagnosticLines = options.maxDiagnosticLines ?? MAX_DIAGNOSTIC_LINES;
    this.envPath = options.envPath;
    this.log = options.logger ?? defaultLog;
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

  private async acquireClient(
    poolKey: string,
    resolvedRoot: string,
    server: ResolvedLspServer,
    uri: string,
  ): Promise<LspClient | null> {
    for (;;) {
      if (this.shuttingDown) return null;

      const pendingReplace = this.replacing.get(poolKey);
      if (pendingReplace) {
        await pendingReplace;
        continue;
      }

      const existing = this.clients.get(poolKey);
      if (existing) {
        if (existing.isClosed) {
          this.clients.delete(poolKey);
          continue;
        }
        const overrideChanged = !existing.matchesServer(server.command, server.args);
        const ambiguousUnversioned = existing.needsReset || existing.hasUnversionedInFlight(uri);
        if (!overrideChanged && !ambiguousUnversioned) {
          return existing;
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
        await replacePromise;
        continue;
      }

      if (this.shuttingDown) return null;

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

    const resolvedRoot = path.resolve(rootDir);
    const absPath = path.resolve(resolvedRoot, filePath);
    const envPath = this.envPath ?? process.env.PATH ?? "";

    const server = resolveServerForFile(absPath, overrides, envPath);
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
    const client = await this.acquireClient(poolKey, resolvedRoot, server, uri);
    if (!client || this.shuttingDown) return null;

    const diagnostics = await client.checkFile(absPath, this.timeoutMs);
    if (this.shuttingDown || !diagnostics || diagnostics.length === 0) return null;

    return formatDiagnostics(diagnostics, absPath, resolvedRoot, server.serverId, this.maxDiagnosticLines);
  }

  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
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
  const manager = new LspManager(options);
  const checkSubagent = options.isSubagentChild ?? (() => process.env.PI_SUBAGENT_CHILD === "1");
  const warnedUntrustedProject = new Set<string>();

  pi.on("tool_result", async (event, ctx): Promise<ToolResultEventResult | undefined> => {
    try {
      const toolName = (event as any).toolName as string;
      if (toolName !== "write" && toolName !== "edit") return undefined;
      if ((event as any).isError === true) return undefined;

      if (checkSubagent() && !isLspAllowedInSubagents()) return undefined;

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
      const formatted = await manager.getDiagnosticsForFile(cwd, filePath, overrides);
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

  pi.on("session_shutdown", async () => {
    log.debug("lsp_session_shutdown", { active: manager.activeCount });
    await manager.shutdownAll();
  });

  return { manager };
}
