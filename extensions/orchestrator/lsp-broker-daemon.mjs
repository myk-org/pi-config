#!/usr/bin/env node
/**
 * Shared 1-per-(worktreeRoot, serverId) UNIX-socket LSP broker daemon (#1445).
 *
 * Allows the main TUI session, COMS peers, and short-lived editing subagents
 * (`python-expert`, `ts-expert`, `go-expert`) inside the same Git worktree to
 * share ONE warm language-server child process over a `0600` UNIX socket while
 * isolating separate worktrees cleanly.
 *
 * Zero external dependencies — runs directly under Node (`process.execPath`).
 * All runtime logging goes through `createLoggerCore` (never `console.*`).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLoggerCore } from "../shared/logger-core.mjs";

const HEADER_DELIM = Buffer.from("\r\n\r\n", "ascii");
const MAX_RPC_BUFFER_BYTES = 10 * 1024 * 1024;
const MAX_SOCKET_LINE_BYTES = 2 * 1024 * 1024;
const DEFAULT_IDLE_MS = 5 * 60 * 1_000;
const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_SHUTDOWN_GRACE_MS = 500;
const DEFAULT_KILL_GRACE_MS = 300;
const CIRCUIT_CRASH_WINDOW_MS = 60_000;
const CIRCUIT_MAX_CRASHES = 2;
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1_000;

const LANGUAGE_IDS = {
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

const LEVEL_RANK = { off: 99, debug: 0, info: 1, warn: 2, error: 3 };

function createBrokerLogger(logFile) {
  const envLevel = (process.env.PI_LOG_LSP || process.env.PI_LOG || "info").trim().toLowerCase();
  const minRank = LEVEL_RANK[envLevel] ?? LEVEL_RANK.info;
  return createLoggerCore("lsp-broker", "lsp-broker", {
    isLevelEnabled: (level) => (LEVEL_RANK[level] ?? 1) >= minRank,
    write: (line) => {
      try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
        fs.appendFileSync(logFile, line, { encoding: "utf8", mode: 0o600 });
      } catch {
        // Logging must never crash the broker
      }
    },
  });
}

function parseCliArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (i + 1 < argv.length) {
      out[arg.slice(2)] = argv[++i];
    }
  }
  return out;
}

function encodeJsonRpcMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

function detectLanguageId(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext && LANGUAGE_IDS[ext]) return LANGUAGE_IDS[ext];
  return ext ? ext.slice(1) : "plaintext";
}

function normalizeFileUri(uri) {
  try {
    return pathToFileURL(fileURLToPath(uri)).href;
  } catch {
    return uri;
  }
}

function sameArgs(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, idx) => v === b[idx]);
}

class ManagedLspChild {
  constructor({ rootDir, serverId, command, args, debounceMs, shutdownGraceMs, killGraceMs, log, onCrash }) {
    this.rootDir = rootDir;
    this.serverId = serverId;
    this.command = command;
    this.args = args;
    this.debounceMs = debounceMs;
    this.shutdownGraceMs = shutdownGraceMs;
    this.killGraceMs = killGraceMs;
    this.log = log;
    this.onCrash = onCrash;

    this.child = null;
    this.recvBuf = Buffer.alloc(0);
    this.nextId = 1;
    this.pendingRequests = new Map();
    this.openedDocs = new Map();
    this.waiters = new Map();
    this.inFlightUriCounts = new Map();
    this.uriReleaseListeners = new Set();
    this.versionedUris = new Set();
    this.ambiguousUris = new Set();
    this.initPromise = null;
    this.initialized = false;
    this.closed = false;
    this.intentionalShutdown = false;
    this.shutdownPromise = null;
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  needsResetFor(uri) {
    return this.ambiguousUris.has(uri);
  }

  hasUnversionedInFlight(uri) {
    return !this.versionedUris.has(uri) && (this.inFlightUriCounts.get(uri) ?? 0) > 0;
  }

  hasOtherActiveChecks(uri) {
    for (const [activeUri, count] of this.inFlightUriCounts) {
      if (activeUri !== uri && count > 0) return true;
    }
    return false;
  }

  waitForOtherChecks(uri, maxWaitMs) {
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

  reserveUri(uri) {
    this.inFlightUriCounts.set(uri, (this.inFlightUriCounts.get(uri) ?? 0) + 1);
  }

  releaseUri(uri) {
    const next = (this.inFlightUriCounts.get(uri) ?? 0) - 1;
    if (next > 0) this.inFlightUriCounts.set(uri, next);
    else this.inFlightUriCounts.delete(uri);
    for (const listener of [...this.uriReleaseListeners]) {
      listener();
    }
  }

  startProcess() {
    if (this.closed) return false;
    if (this.child) return true;
    try {
      const child = spawn(this.command, this.args, {
        cwd: this.rootDir,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      this.log.info("broker_lsp_spawned", {
        serverId: this.serverId,
        command: this.command,
        rootDir: this.rootDir,
        pid: child.pid,
      });

      child.stdin?.on("error", (err) => {
        this.log.debug("broker_lsp_stdin_error", { error: err.message });
      });

      child.stdout?.on("data", (chunk) => this.onStdoutData(chunk));

      child.stderr?.on("data", (chunk) => {
        const text = chunk.toString("utf8").trim();
        if (text) this.log.debug("broker_lsp_stderr", { text: text.slice(0, 500) });
      });

      child.on("error", (err) => {
        this.log.warn("broker_lsp_process_error", { error: err.message });
        this.handleProcessExit(1, null);
      });

      child.on("exit", (code, signal) => {
        this.log.debug("broker_lsp_process_exit", { pid: child.pid, code, signal });
        this.handleProcessExit(code, signal);
      });

      return true;
    } catch (err) {
      this.log.warn("broker_lsp_spawn_failed", { error: err?.message ?? String(err) });
      this.handleProcessExit(1, null);
      return false;
    }
  }

  handleProcessExit(code, signal) {
    const unexpected = !this.intentionalShutdown && !this.closed;
    this.closed = true;
    this.initialized = false;
    this.recvBuf = Buffer.alloc(0);

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("LSP child exited"));
      this.pendingRequests.delete(id);
    }

    for (const [uri, set] of this.waiters) {
      for (const waiter of set) {
        clearTimeout(waiter.timer);
        if (waiter.debounceTimer) clearTimeout(waiter.debounceTimer);
        waiter.resolve(waiter.buffered ?? null);
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

    if (unexpected && (code !== 0 || signal !== null)) {
      this.onCrash(code, signal);
    }
  }

  writeMessage(payload) {
    if (this.closed || !this.child?.stdin || this.child.stdin.destroyed || !this.child.stdin.writable) {
      return false;
    }
    try {
      this.child.stdin.write(encodeJsonRpcMessage(payload));
      return true;
    } catch (err) {
      this.log.debug("broker_lsp_write_failed", { error: err?.message ?? String(err) });
      return false;
    }
  }

  sendRequest(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("LSP child closed"));
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

  sendNotification(method, params) {
    return this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  onStdoutData(chunk) {
    if (this.closed) return;
    this.recvBuf = this.recvBuf.byteLength === 0 ? chunk : Buffer.concat([this.recvBuf, chunk]);
    if (this.recvBuf.byteLength > MAX_RPC_BUFFER_BYTES) {
      this.log.warn("broker_lsp_buffer_overflow", { bytes: this.recvBuf.byteLength });
      void this.shutdown();
      return;
    }

    for (;;) {
      const headerEnd = this.recvBuf.indexOf(HEADER_DELIM);
      if (headerEnd === -1) break;
      const headerStr = this.recvBuf.subarray(0, headerEnd).toString("ascii");
      const match = /^content-length:\s*(\d+)\s*$/im.exec(headerStr);
      if (!match) {
        this.log.warn("broker_lsp_malformed_header", { header: headerStr.slice(0, 200) });
        void this.shutdown();
        return;
      }
      const contentLength = Number.parseInt(match[1], 10);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > MAX_RPC_BUFFER_BYTES) {
        this.log.warn("broker_lsp_invalid_content_length", { contentLength });
        void this.shutdown();
        return;
      }
      const bodyStart = headerEnd + HEADER_DELIM.byteLength;
      if (this.recvBuf.byteLength < bodyStart + contentLength) break;

      const bodyStr = this.recvBuf.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
      this.recvBuf = this.recvBuf.subarray(bodyStart + contentLength);

      let msg;
      try {
        msg = JSON.parse(bodyStr);
      } catch (err) {
        this.log.debug("broker_lsp_json_parse_error", { error: err?.message });
        continue;
      }
      this.handleMessage(msg);
    }
  }

  handleMessage(msg) {
    if (!msg || typeof msg !== "object") return;

    if (typeof msg.id === "number" && !("method" in msg)) {
      const pending = this.pendingRequests.get(msg.id);
      if (!pending) return;
      this.pendingRequests.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
      return;
    }

    if ("id" in msg && typeof msg.method === "string") {
      if (msg.method === "workspace/configuration") {
        const items = Array.isArray(msg.params?.items) ? msg.params.items : [];
        this.writeMessage({ jsonrpc: "2.0", id: msg.id, result: items.map(() => ({})) });
      } else {
        this.writeMessage({ jsonrpc: "2.0", id: msg.id, result: null });
      }
      return;
    }

    if (msg.method === "textDocument/publishDiagnostics" && msg.params && typeof msg.params.uri === "string") {
      const uri = normalizeFileUri(msg.params.uri);
      const diagnostics = Array.isArray(msg.params.diagnostics) ? msg.params.diagnostics : [];
      const version = typeof msg.params.version === "number" ? msg.params.version : undefined;
      const latestVersion = this.openedDocs.get(uri);

      if (version !== undefined) {
        this.versionedUris.add(uri);
      } else {
        this.versionedUris.delete(uri);
        if (this.ambiguousUris.has(uri)) {
          this.log.debug("broker_lsp_ambiguous_unversioned_dropped", { uri });
          return;
        }
      }

      const set = this.waiters.get(uri);
      if (!set || set.size === 0) return;

      for (const waiter of [...set]) {
        if (latestVersion !== undefined && waiter.minVersion < latestVersion) {
          set.delete(waiter);
          clearTimeout(waiter.timer);
          if (waiter.debounceTimer) clearTimeout(waiter.debounceTimer);
          waiter.resolve(null);
          continue;
        }
        if (version !== undefined && version < waiter.minVersion) continue;

        waiter.buffered = diagnostics;
        const remaining = waiter.deadline - Date.now();
        if (this.debounceMs <= 0 || remaining <= 10) {
          set.delete(waiter);
          clearTimeout(waiter.timer);
          if (waiter.debounceTimer) clearTimeout(waiter.debounceTimer);
          waiter.resolve(waiter.buffered);
        } else {
          if (waiter.debounceTimer) clearTimeout(waiter.debounceTimer);
          const settleDelay = Math.min(this.debounceMs, Math.max(1, remaining - 5));
          waiter.debounceTimer = setTimeout(() => {
            set.delete(waiter);
            if (set.size === 0) this.waiters.delete(uri);
            clearTimeout(waiter.timer);
            waiter.resolve(waiter.buffered);
          }, settleDelay);
          waiter.debounceTimer.unref();
        }
      }
      if (set.size === 0) this.waiters.delete(uri);
    }
  }

  ensureInitialized(budgetMs) {
    if (this.closed) return Promise.resolve(false);
    if (this.initialized) return Promise.resolve(true);

    if (!this.initPromise) {
      if (!this.startProcess()) return Promise.resolve(false);
      const rootUri = pathToFileURL(this.rootDir).href;
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
          this.log.info("broker_lsp_initialized", { serverId: this.serverId, pid: this.pid });
          return true;
        })
        .catch((err) => {
          this.log.warn("broker_lsp_init_failed", { error: err?.message ?? String(err) });
          void this.shutdown();
          return false;
        });
    }

    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, Math.max(1, budgetMs));
      timer.unref();
      this.initPromise
        .then((ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ok);
        })
        .catch(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(false);
        });
    });
  }

  async checkFile(absPath, deadline) {
    if (this.closed) return null;
    const ready = await this.ensureInitialized(deadline - Date.now());
    if (!ready || this.closed) return null;

    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;

    let text;
    try {
      text = fs.readFileSync(absPath, "utf8");
    } catch (err) {
      this.log.debug("broker_lsp_read_failed", { filePath: absPath, error: err?.message });
      return null;
    }

    const uri = normalizeFileUri(pathToFileURL(absPath).href);
    const prevVersion = this.openedDocs.get(uri);
    const nextVersion = prevVersion === undefined ? 1 : prevVersion + 1;
    this.openedDocs.set(uri, nextVersion);

    const existingWaiters = this.waiters.get(uri);
    if (existingWaiters) {
      for (const oldWaiter of existingWaiters) {
        clearTimeout(oldWaiter.timer);
        if (oldWaiter.debounceTimer) clearTimeout(oldWaiter.debounceTimer);
        oldWaiter.resolve(null);
      }
      existingWaiters.clear();
    }

    const diagnosticsPromise = new Promise((resolve) => {
      let set = this.waiters.get(uri);
      if (!set) {
        set = new Set();
        this.waiters.set(uri, set);
      }

      const waiter = {
        minVersion: nextVersion,
        deadline,
        buffered: null,
        debounceTimer: null,
        resolve,
        timer: setTimeout(() => {
          set.delete(waiter);
          if (set.size === 0) this.waiters.delete(uri);
          if (waiter.debounceTimer) clearTimeout(waiter.debounceTimer);
          if (waiter.buffered !== null) {
            resolve(waiter.buffered);
            return;
          }
          if (!this.versionedUris.has(uri)) {
            this.ambiguousUris.add(uri);
          }
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
          if (waiter.debounceTimer) clearTimeout(waiter.debounceTimer);
          waiter.resolve(null);
        }
        this.waiters.delete(uri);
      }
      return null;
    }

    return diagnosticsPromise;
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.intentionalShutdown = true;

    this.shutdownPromise = (async () => {
      const wasInitialized = this.initialized;
      const child = this.child;

      for (const [uri, set] of this.waiters) {
        for (const waiter of set) {
          clearTimeout(waiter.timer);
          if (waiter.debounceTimer) clearTimeout(waiter.debounceTimer);
          waiter.resolve(null);
        }
        this.waiters.delete(uri);
      }

      if (!child || child.exitCode !== null || child.signalCode !== null) {
        this.handleProcessExit(child?.exitCode ?? null, child?.signalCode ?? null);
        return;
      }

      const waitForExit = (ms) =>
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

      if (wasInitialized && !this.closed && child.stdin && !child.stdin.destroyed && child.stdin.writable) {
        try {
          await this.sendRequest("shutdown", null, this.shutdownGraceMs);
        } catch {
          // Best-effort
        }
        this.sendNotification("exit", null);
      }

      this.closed = true;
      try {
        child.stdin?.end();
      } catch {
        // Ignore
      }

      const exitedPolitely = wasInitialized ? await waitForExit(Math.min(200, this.shutdownGraceMs)) : false;
      if (!exitedPolitely && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore
        }
        const exitedTerm = await waitForExit(this.killGraceMs);
        if (!exitedTerm && child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Ignore
          }
          await waitForExit(200);
        }
      }

      this.handleProcessExit(child.exitCode, child.signalCode);
    })();

    return this.shutdownPromise;
  }

  killSync() {
    this.intentionalShutdown = true;
    this.closed = true;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore
      }
    }
  }
}

function waitWithinBudget(promise, deadline) {
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

function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const socketPath = cli.socket;
  const rootDir = cli.root;
  const serverId = cli["server-id"];
  const command = cli.command;
  const args = cli["args-json"] ? JSON.parse(cli["args-json"]) : [];
  const idleMs = Number.parseInt(cli["idle-ms"] || String(DEFAULT_IDLE_MS), 10) || DEFAULT_IDLE_MS;
  const debounceMs = Number.parseInt(cli["debounce-ms"] ?? String(DEFAULT_DEBOUNCE_MS), 10);
  const effectiveDebounceMs = Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : DEFAULT_DEBOUNCE_MS;
  const logFile = cli["log-file"] || path.join(os.homedir(), ".pi", "logs", "lsp", `broker-${path.basename(socketPath, ".sock")}.log`);

  if (!socketPath || !rootDir || !serverId || !command) {
    process.exit(2);
  }

  const log = createBrokerLogger(logFile);

  let activeChild = null;
  let replacingPromise = null;
  const allChildren = new Set();
  const crashTimestamps = [];
  let circuitOpenUntil = 0;
  let inFlightRequests = 0;
  let idleTimer = null;
  let shuttingDown = false;
  let socketBound = false;

  const isCircuitOpen = () => Date.now() < circuitOpenUntil;

  const recordCrash = (code, signal) => {
    const now = Date.now();
    crashTimestamps.push(now);
    while (crashTimestamps.length > 0 && now - crashTimestamps[0] > CIRCUIT_CRASH_WINDOW_MS) {
      crashTimestamps.shift();
    }
    if (crashTimestamps.length >= CIRCUIT_MAX_CRASHES) {
      circuitOpenUntil = now + CIRCUIT_COOLDOWN_MS;
      log.warn("broker_circuit_breaker_open", {
        serverId,
        rootDir,
        crashes: crashTimestamps.length,
        code,
        signal,
        cooldownMs: CIRCUIT_COOLDOWN_MS,
      });
    }
  };

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const armIdleTimer = () => {
    clearIdleTimer();
    if (shuttingDown || idleMs <= 0 || inFlightRequests > 0) return;
    idleTimer = setTimeout(() => {
      log.info("broker_idle_shutdown", { serverId, rootDir, idleMs });
      void shutdownBroker("idle");
    }, idleMs);
    idleTimer.unref();
  };

  const acquireChild = async (uri, deadline) => {
    for (;;) {
      if (shuttingDown || Date.now() >= deadline) return null;
      if (isCircuitOpen()) return null;

      if (replacingPromise) {
        const ok = await waitWithinBudget(replacingPromise, deadline);
        if (!ok) return null;
        continue;
      }

      if (activeChild) {
        if (activeChild.closed) {
          activeChild = null;
          continue;
        }
        const ambiguous = activeChild.needsResetFor(uri) || activeChild.hasUnversionedInFlight(uri);
        if (!ambiguous) {
          activeChild.reserveUri(uri);
          return activeChild;
        }
        if (activeChild.hasOtherActiveChecks(uri)) {
          const drained = await activeChild.waitForOtherChecks(uri, deadline - Date.now());
          if (!drained) return null;
          continue;
        }
        const old = activeChild;
        activeChild = null;
        const p = old.shutdown().finally(() => {
          allChildren.delete(old);
          if (replacingPromise === p) replacingPromise = null;
        });
        replacingPromise = p;
        const ok = await waitWithinBudget(p, deadline);
        if (!ok) return null;
        continue;
      }

      const created = new ManagedLspChild({
        rootDir,
        serverId,
        command,
        args,
        debounceMs: effectiveDebounceMs,
        shutdownGraceMs: DEFAULT_SHUTDOWN_GRACE_MS,
        killGraceMs: DEFAULT_KILL_GRACE_MS,
        log,
        onCrash: recordCrash,
      });
      activeChild = created;
      allChildren.add(created);
      created.reserveUri(uri);
      return created;
    }
  };

  const cleanupSocketSync = () => {
    if (!socketBound) return;
    socketBound = false;
    try {
      const st = fs.lstatSync(socketPath);
      if (st.isSocket()) fs.unlinkSync(socketPath);
    } catch {
      // Ignore
    }
  };

  const server = net.createServer((conn) => {
    let raw = "";
    let handled = false;
    const reply = (obj) => {
      if (handled) return;
      handled = true;
      try {
        conn.end(JSON.stringify(obj) + "\n");
      } catch {
        conn.destroy();
      }
    };

    conn.on("error", () => {
      conn.destroy();
    });

    conn.on("data", (chunk) => {
      if (handled) return;
      raw += chunk.toString("utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_SOCKET_LINE_BYTES) {
        reply({ ok: false, error: "request_too_large" });
        return;
      }
      const nl = raw.indexOf("\n");
      if (nl === -1) return;
      const line = raw.slice(0, nl).trim();
      if (!line) {
        reply({ ok: false, error: "empty_request" });
        return;
      }

      let req;
      try {
        req = JSON.parse(line);
      } catch {
        reply({ ok: false, error: "invalid_json" });
        return;
      }

      void handleRequest(req).then(reply, (err) => {
        log.warn("broker_request_error", { error: err?.message ?? String(err) });
        reply({ ok: false, error: err?.message ?? "internal_error" });
      });
    });
  });

  const handleRequest = async (req) => {
    if (!req || typeof req !== "object") return { ok: false, error: "invalid_request" };

    if (req.op === "ping") {
      return {
        ok: true,
        pid: process.pid,
        lspPid: activeChild && !activeChild.closed ? activeChild.pid : null,
        serverId,
        rootDir,
        command,
        args,
        broken: isCircuitOpen(),
      };
    }

    if (req.op === "shutdown") {
      setTimeout(() => {
        void shutdownBroker("rpc_shutdown");
      }, 10).unref();
      return { ok: true };
    }

    if (req.op === "check") {
      if (shuttingDown) return { ok: false, error: "shutting_down" };
      if (req.command !== command || !sameArgs(req.args ?? [], args)) {
        return { ok: false, error: "server_mismatch" };
      }
      if (isCircuitOpen()) {
        return { ok: false, broken: true, error: "circuit_open" };
      }
      if (typeof req.filePath !== "string" || !req.filePath) {
        return { ok: false, error: "missing_file_path" };
      }

      const timeoutMs = Number.isFinite(req.timeoutMs) && req.timeoutMs > 0 ? req.timeoutMs : 1500;
      const deadline = Date.now() + timeoutMs;
      const absPath = path.resolve(rootDir, req.filePath);
      const uri = normalizeFileUri(pathToFileURL(absPath).href);

      inFlightRequests++;
      clearIdleTimer();
      try {
        const child = await acquireChild(uri, deadline);
        if (!child) {
          return isCircuitOpen()
            ? { ok: false, broken: true, error: "circuit_open" }
            : { ok: true, diagnostics: null, lspPid: null };
        }
        let diagnostics;
        try {
          diagnostics = await child.checkFile(absPath, deadline);
        } finally {
          child.releaseUri(uri);
        }
        if (isCircuitOpen()) {
          return { ok: false, broken: true, error: "circuit_open" };
        }
        return { ok: true, diagnostics, lspPid: child.pid };
      } finally {
        inFlightRequests = Math.max(0, inFlightRequests - 1);
        armIdleTimer();
      }
    }

    return { ok: false, error: "unknown_op" };
  };

  let shutdownBrokerPromise = null;
  const shutdownBroker = (reason) => {
    if (shutdownBrokerPromise) return shutdownBrokerPromise;
    shuttingDown = true;
    clearIdleTimer();
    log.info("broker_shutting_down", { serverId, rootDir, reason });
    shutdownBrokerPromise = (async () => {
      try {
        server.close();
      } catch {
        // Ignore
      }
      const children = [...allChildren];
      activeChild = null;
      await Promise.allSettled(children.map((c) => c.shutdown()));
      allChildren.clear();
      cleanupSocketSync();
      process.exit(0);
    })();
    return shutdownBrokerPromise;
  };

  process.on("SIGTERM", () => {
    void shutdownBroker("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdownBroker("SIGINT");
  });
  process.on("exit", () => {
    for (const c of allChildren) {
      c.killSync();
    }
    cleanupSocketSync();
  });

  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  try {
    const st = fs.lstatSync(socketPath);
    if (st.isSocket()) fs.unlinkSync(socketPath);
  } catch {
    // Not present
  }

  server.on("error", (err) => {
    log.error("broker_listen_error", { socketPath, error: err?.message ?? String(err) });
    process.exit(1);
  });

  server.listen(socketPath, () => {
    socketBound = true;
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch (err) {
      log.warn("broker_chmod_failed", { socketPath, error: err?.message ?? String(err) });
    }
    log.info("broker_listening", { socketPath, serverId, rootDir, pid: process.pid, idleMs, debounceMs: effectiveDebounceMs });
    armIdleTimer();
  });
}

main();
