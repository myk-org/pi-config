export { SessionStore, type CreateSessionOptions, type CustomToolConfig, DEFAULT_TOOLS } from "./sessions.js";
export { startWatchdog, type WatchdogOptions } from "./watchdog.js";
export { createHttpToolExecutor, normalizeHttpToolConfig, interpolate, type HttpToolConfig } from "./http-tool-executor.js";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SessionStore } from "./sessions.js";
import { startWatchdog, type WatchdogOptions } from "./watchdog.js";
import { assertPiVersionFloor } from "./pi-version.js";
import { logger } from "./logger.js";

const MAX_BODY_SIZE = 1_048_576;

// Simple JSON body parser
export async function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodySizeBytes = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      bodySizeBytes += chunk.length;
      if (bodySizeBytes > MAX_BODY_SIZE) {
        rejected = true;
        req.resume();
        logger.warn(`[sidecar] Request body too large: size=${bodySizeBytes}, max=${MAX_BODY_SIZE}`);
        reject(new Error("Payload too large"));
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        logger.warn(`[sidecar] Invalid JSON body: size=${body.length}`);
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: any): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Thrown when a matched route pattern has an invalid percent-encoded or control-char param. */
export class BadRouteParamError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "BadRouteParamError";
  }
}

export function routeMatch(url: string, pattern: string): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const urlParts = url.split("?")[0].split("/");
  if (patternParts.length !== urlParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      // Decode after splitting so encoded slashes cannot alter route structure.
      let decoded: string;
      try {
        decoded = decodeURIComponent(urlParts[i]);
      } catch (err) {
        logger.warn(
          `[sidecar] ROUTE_MATCH_DECODE_FAILED: segment=${sanitizeForLog(urlParts[i])}, param=${patternParts[i].slice(1)}`,
          err,
        );
        throw new BadRouteParamError(
          `Invalid percent-encoding in route parameter '${patternParts[i].slice(1)}'`,
        );
      }
      // Reject control characters (e.g. %0A) — prevents log forging and corrupted diagnostics.
      if (/[\0-\x1f\x7f]/.test(decoded)) {
        logger.warn(
          `[sidecar] ROUTE_MATCH_CONTROL_CHARS: segment=${sanitizeForLog(urlParts[i])}, param=${patternParts[i].slice(1)}, reason=decoded_control_chars`,
        );
        throw new BadRouteParamError(
          `Invalid control characters in route parameter '${patternParts[i].slice(1)}'`,
        );
      }
      params[patternParts[i].slice(1)] = decoded;
    } else if (patternParts[i] !== urlParts[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Escape values for single-line `[sidecar] ACTION: key=value, …` logs.
 * Controls, commas, and equals must not appear unescaped — otherwise decoded
 * route params can forge/blur structured fields.
 */
export function sanitizeForLog(value: string): string {
  return value
    .replace(/[\0-\x1f\x7f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`)
    .replace(/,/g, "\\x2c")
    .replace(/=/g, "\\x3d");
}

/**
 * True when the bind address is loopback-only. Used to decide whether
 * GET /models/:provider/status may return full auth diagnostics.
 * Fail-closed: unrecognized forms are treated as non-loopback (over-redact).
 */
export function isLoopbackBindHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  // IPv4-mapped loopback (::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (h === "::ffff:127.0.0.1" || h === "::ffff:7f00:1") return true;
  // Any 127.0.0.0/8 address Node may report after listen
  if (/^127(?:\.(?:\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])){3}$/.test(h)) return true;
  return false;
}

/**
 * Strip auth-configuration detail (env labels, credential sources) for
 * non-loopback binds. Keeps authStatus.configured (boolean) and authCheck.type
 * (string); strips source/label. Loopback responses pass through.
 */
export function redactProviderStatusAuth<T extends {
  authStatus: { configured: boolean; source?: string; label?: string } | null | undefined;
  authCheck: { type: string; source?: string } | null | undefined;
}>(status: T, bindHost: string): T {
  if (isLoopbackBindHost(bindHost)) return status;
  return {
    ...status,
    authStatus: status.authStatus == null
      ? null
      : { configured: !!status.authStatus.configured },
    authCheck: status.authCheck == null
      ? null
      : { type: status.authCheck.type },
  } as T;
}

export interface SidecarHandle {
  close(): Promise<void>;
}

export function startSidecar(options?: { port?: number; host?: string; watchdogUrl?: string; watchdogOptions?: WatchdogOptions }): SidecarHandle {
  // Fail fast on a stale SDK install rather than surfacing confusing runtime
  // errors later (e.g. createProvider()-based ACPX/CLI providers silently
  // failing to register on a pre-0.81 SDK).
  assertPiVersionFloor();

  // --- Subagent subprocess compatibility ---
  // PATH fix applied here so programmatic consumers also get it.
  // The argv[1] fix is in server.ts (CLI entry only).

  // Strip the sidecar's own node_modules/.bin from PATH so the subagent extension
  // spawns the globally installed `pi` binary, not the local dependency (which may
  // be a different version and cause extension loading errors in the subprocess).
  // Derive sidecar root from import.meta.url (not process.cwd()) to avoid stripping
  // a project's node_modules/.bin when the sidecar is started from a project directory.
  if (process.env.PATH) {
    const sidecarRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    // Collect sidecar's own .bin and any ancestor node_modules/.bin that might
    // contain a hoisted pi binary from this sidecar's dependency tree.
    const sidecarBins = new Set<string>();
    sidecarBins.add(resolve(join(sidecarRoot, "node_modules", ".bin")));
    let ancestor = dirname(sidecarRoot);
    while (true) {
      const candidate = resolve(join(ancestor, "node_modules", ".bin"));
      // Only include if the ancestor contains a pi binary
      const piShim = join(candidate, "pi");
      try {
        if (statSync(piShim).isFile()) sidecarBins.add(candidate);
      } catch (e: any) {
        if (e?.code && e.code !== "ENOENT") {
          logger.debug(`[sidecar] PATH_ANCESTOR_CHECK_FAILED: path=${piShim}, error=${e.code}`);
        }
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const parts = process.env.PATH.split(delimiter);
    const kept = parts.filter((p) => {
      if (!p || !isAbsolute(p)) return true;
      try { return !sidecarBins.has(resolve(p)); } catch { return true; }
    });
    const stripped = parts.length - kept.length;
    if (stripped > 0) {
      // Only strip if `pi` is still reachable on the remaining PATH.
      // Check for platform-appropriate executable names (pi, pi.cmd, pi.exe).
      const piNames = process.platform === "win32"
        ? ["pi.cmd", "pi.exe", "pi"]
        : ["pi"];
      const piReachable = kept.some((dir) => {
        if (!dir || !isAbsolute(dir)) return false;
        return piNames.some((name) => {
          try { return statSync(join(dir, name)).isFile(); } catch { return false; }
        });
      });
      if (piReachable) {
        process.env.PATH = kept.join(delimiter);
        logger.debug(`[sidecar] PATH_FILTERED: removed=${stripped}, dirs=${[...sidecarBins].join(";")}`);  // semicolon-separated to avoid breaking key=value format
      } else {
        logger.debug(`[sidecar] PATH_FILTER_SKIPPED: dirs=${[...sidecarBins].join(";")}, reason=pi_not_found_elsewhere`);
      }
    }
  }

  const PORT = options?.port ?? parseInt(process.env.SIDECAR_PORT || "9100", 10);
  // Precedence: explicit options.host → SIDECAR_HOST (start-sidecar.sh) → DEV_MODE → localhost.
  const HOST =
    options?.host ??
    process.env.SIDECAR_HOST ??
    (process.env.DEV_MODE === "true" ? "0.0.0.0" : "127.0.0.1");
  // Prefer the post-listen address (server.address()) for trust decisions so
  // redaction matches what Node actually bound, not just the config string.
  let trustBindHost = HOST;

  const store = new SessionStore();

  // Set true as the first step of shutdown (close()/watchdog onDead), before
  // server.close() or store.disposeAll() run. New requests hit this check
  // before touching the store, so in-flight teardown never races a request
  // that would otherwise call into a disposed/disposing SessionStore.
  let draining = false;
  // Count handlers that passed the draining gate. Shutdown awaits this
  // reaching 0 (with a timeout) before disposeAll(), so prompt/abort that
  // already entered the handler finish before sessions are torn down.
  let activeRequests = 0;
  const SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;
  // Declared early so shutdownSidecar can clear them; assigned after createServer.
  let cleanupInterval: ReturnType<typeof setInterval> | undefined;
  let stopWatchdog: (() => void) | undefined;
  // Memoize shutdown so concurrent watchdog + close() share one teardown.
  let shutdownPromise: Promise<void> | undefined;

  async function waitForIdleRequests(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (activeRequests > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (activeRequests > 0) {
      logger.warn(
        `[sidecar] SHUTDOWN_DRAIN_TIMEOUT: activeRequests=${activeRequests}, waited_ms=${timeoutMs}`,
      );
    }
  }

  async function shutdownSidecar(reason: string): Promise<void> {
    if (shutdownPromise) {
      logger.info(`[sidecar] SHUTDOWN_JOIN: reason=${reason}, action=join_in_progress`);
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      logger.info(`[sidecar] SHUTDOWN_START: reason=${reason}`);
      draining = true;
      stopWatchdog?.();
      if (cleanupInterval !== undefined) clearInterval(cleanupInterval);
      // Stop accepting new connections, then wait for in-flight handlers, then
      // dispose the store. Disposing before handlers finish races prompt/abort.
      // Always continue to disposeAll even if close() fails — otherwise sessions
      // and the internal AgentSessionRuntime would be left undisposed.
      const closed = new Promise<void>((resolve) => {
        server.close((err) => {
          if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            logger.warn(`[sidecar] SHUTDOWN_CLOSE_FAILED: reason=${reason}`, err);
          }
          resolve();
        });
      });
      try {
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          closed.then(() => {
            if (closeTimer) clearTimeout(closeTimer);
          }),
          new Promise<void>((resolve) => {
            closeTimer = setTimeout(() => {
              logger.warn(
                `[sidecar] SHUTDOWN_CLOSE_TIMEOUT: reason=${reason}, waited_ms=${SHUTDOWN_DRAIN_TIMEOUT_MS}`,
              );
              // Force-drop remaining connections so close() can finish and disposeAll runs.
              if (typeof server.closeAllConnections === "function") {
                server.closeAllConnections();
              }
              resolve();
            }, SHUTDOWN_DRAIN_TIMEOUT_MS);
          }),
        ]);
        await waitForIdleRequests(SHUTDOWN_DRAIN_TIMEOUT_MS);
        try {
          await store.disposeAll();
        } catch (err) {
          // Once draining=true, do not abort mid-shutdown or reset shutdownPromise —
          // that would leave requests permanently rejected with teardown incomplete.
          logger.error(`[sidecar] SHUTDOWN_DISPOSE_FAILED: reason=${reason}`, err);
        }
        logger.info(`[sidecar] SHUTDOWN_COMPLETE: reason=${reason}`);
      } catch (err) {
        logger.error(`[sidecar] SHUTDOWN_FAILED: reason=${reason}`, err);
        // Still complete the memoized promise so joiners do not hang; draining stays true.
      }
    })();
    return shutdownPromise;
  }

  const server = createServer(async (req, res) => {
    const method = req.method || "GET";
    const url = req.url || "/";
    const requestStart = Date.now();

    if (draining) {
      logger.warn(`[sidecar] REQUEST_REJECTED: method=${method}, url=${sanitizeForLog(url.split("?")[0])}, reason=server_shutting_down`);
      sendJson(res, 503, { error: "Server is shutting down" });
      return;
    }

    activeRequests++;
    try {
      // GET /health
      if (method === "GET" && url === "/health") {
        if (!store.ready) {
          logger.debug(`[sidecar] GET /health 503: status=starting`);
          sendJson(res, 503, { status: "starting", message: "Model discovery in progress" });
          return;
        }
        if (store.discoveryError) {
          logger.debug(`[sidecar] GET /health 200: status=degraded, sessions=${store.count()}`);
          sendJson(res, 200, {
            status: "degraded",
            message: "Model discovery failed",
            sessions: store.count(),
          });
          return;
        }
        logger.debug(`[sidecar] GET /health 200: status=ok, sessions=${store.count()}`);
        sendJson(res, 200, { status: "ok", sessions: store.count() });
        return;
      }

      // GET /models
      if (method === "GET" && url === "/models") {
        const models = await store.getModels();
        logger.debug(`[sidecar] GET /models 200 ${Date.now() - requestStart}ms: count=${models.length}`);
        sendJson(res, 200, { models });
        return;
      }

      // POST /models/refresh
      if (method === "POST" && url === "/models/refresh") {
        const models = await store.refreshModels();
        logger.info(`[sidecar] POST /models/refresh 200 ${Date.now() - requestStart}ms models=${models.length}`);
        sendJson(res, 200, { models });
        return;
      }

      // GET /models/:provider/status
      const statusParams = routeMatch(url, "/models/:provider/status");
      if (method === "GET" && statusParams) {
        // Log provider as a key=value field — never interpolate into a URL-like
        // path (decoded "%2F" → "/" would look like extra segments).
        const providerLog = sanitizeForLog(statusParams.provider);
        const status = redactProviderStatusAuth(
          await store.getProviderStatus(statusParams.provider),
          trustBindHost,
        );
        if (!status.registered) {
          logger.warn(
            `[sidecar] GET /models/:provider/status 404 ${Date.now() - requestStart}ms: provider=${providerLog}, registered=false`,
          );
          sendJson(res, 404, { error: `Provider '${statusParams.provider}' is not registered`, ...status });
          return;
        }
        logger.debug(
          `[sidecar] GET /models/:provider/status 200 ${Date.now() - requestStart}ms: provider=${providerLog}, registered=${status.registered}, modelCount=${status.modelCount}`,
        );
        sendJson(res, 200, status);
        return;
      }

      // POST /sessions
      if (method === "POST" && url === "/sessions") {
        const body = await parseBody(req);
        const { provider, model, system_prompt, cwd, custom_tools, tools, agent_dir } = body;
        if (typeof provider !== "string" || provider.length === 0 || typeof system_prompt !== "string" || system_prompt.length === 0) {
          logger.warn(`[sidecar] POST /sessions 400 ${Date.now() - requestStart}ms: validation=failed, field=provider|system_prompt, reason=must be non-empty strings`);
          sendJson(res, 400, { error: "provider and system_prompt are required and must be non-empty strings" });
          return;
        }
        if (typeof model !== "string" || model.length === 0) {
          logger.warn(`[sidecar] POST /sessions 400 ${Date.now() - requestStart}ms: validation=failed, field=model, reason=must be non-empty string`);
          sendJson(res, 400, { error: "model is required and must be a non-empty string. Use GET /models to list available models." });
          return;
        }
        if (cwd !== undefined && typeof cwd !== "string") {
          logger.warn(`[sidecar] POST /sessions 400 ${Date.now() - requestStart}ms: validation=failed, field=cwd, reason=must be string`);
          sendJson(res, 400, { error: "cwd must be a string" });
          return;
        }
        let effectiveAgentDir: string | undefined = agent_dir;
        if (agent_dir !== undefined) {
          if (typeof agent_dir !== "string" || agent_dir.trim().length === 0) {
            logger.warn(`[sidecar] POST /sessions 400 ${Date.now() - requestStart}ms: validation=failed, field=agent_dir, reason=must be non-empty string`);
            sendJson(res, 400, { error: "agent_dir must be a non-empty string" });
            return;
          }
          // DEV_MODE: after non-empty string check, discard value and warn (even on 0.0.0.0).
          if (process.env.DEV_MODE === "true") {
            logger.warn(
              `[sidecar] AGENT_DIR_IGNORED: reason=dev_mode, host=${trustBindHost}`,
            );
            effectiveAgentDir = undefined;
          } else if (!isLoopbackBindHost(trustBindHost)) {
            // Non-loopback without DEV_MODE (e.g. SIDECAR_HOST): reject — no silent discard.
            logger.warn(
              `[sidecar] POST /sessions 400 ${Date.now() - requestStart}ms: validation=failed, field=agent_dir, reason=not_allowed_on_non_loopback_bind, host=${trustBindHost}`,
            );
            sendJson(res, 400, {
              error: "agent_dir is not allowed when the sidecar is bound to a non-loopback address",
            });
            return;
          } else {
            if (!isAbsolute(agent_dir)) {
              logger.warn(`[sidecar] POST /sessions 400 ${Date.now() - requestStart}ms: validation=failed, field=agent_dir, reason=must be absolute path`);
              sendJson(res, 400, { error: "agent_dir must be an absolute path" });
              return;
            }
            try {
              const stat = statSync(agent_dir);
              if (!stat.isDirectory()) {
                logger.warn(`[sidecar] POST /sessions 400 ${Date.now() - requestStart}ms: validation=failed, field=agent_dir, reason=not a directory`);
                sendJson(res, 400, { error: "agent_dir must be a directory" });
                return;
              }
            } catch (err: any) {
              const reason = err?.code === "ENOENT" ? "does not exist" : err?.code === "EACCES" ? "permission denied" : `not accessible (${err?.code || "unknown"})`;
              logger.warn(`[sidecar] POST /sessions 400 ${Date.now() - requestStart}ms: validation=failed, field=agent_dir, reason=${reason}`);
              sendJson(res, 400, { error: `agent_dir ${reason}` });
              return;
            }
          }
        }
        if (tools !== undefined) {
          if (!Array.isArray(tools) || !tools.every((t: any) => typeof t === "string")) {
            logger.warn(`[sidecar] POST /sessions 400 ${Date.now() - requestStart}ms: validation=failed, field=tools, reason=must be array of strings`);
            sendJson(res, 400, { error: "tools must be an array of strings" });
            return;
          }
        }
        if (custom_tools !== undefined) {
          if (!Array.isArray(custom_tools)) {
            logger.warn(`[sidecar] POST /sessions 400 ${Date.now() - requestStart}ms: validation=failed, field=custom_tools, reason=must be array`);
            sendJson(res, 400, { error: "custom_tools must be an array" });
            return;
          }
          const invalidIndexes: number[] = [];
          for (let i = 0; i < custom_tools.length; i++) {
            const t = custom_tools[i];
            if (!(
              t != null
              && typeof t === "object"
              && !Array.isArray(t)
              && typeof t.name === "string"
              && t.name.trim().length > 0
            )) {
              invalidIndexes.push(i);
            }
          }
          if (invalidIndexes.length > 0) {
            logger.warn(
              `[sidecar] POST /sessions 400 ${Date.now() - requestStart}ms: validation=failed, field=custom_tools, reason=entries must be plain objects with non-empty name, invalid_indexes=${invalidIndexes.join(",")}`,
            );
            sendJson(res, 400, {
              error: "custom_tools entries must be plain objects with a non-empty string 'name' property",
              invalid_indexes: invalidIndexes,
            });
            return;
          }
        }
        const sessionId = await store.create({
          provider,
          model,
          systemPrompt: system_prompt,
          cwd: cwd || process.cwd(),
          agentDir: effectiveAgentDir,
          tools,
          customTools: custom_tools,
        });
        logger.info(`[sidecar] POST /sessions 201 ${Date.now() - requestStart}ms session=${sessionId} provider=${provider} model=${model}`);
        sendJson(res, 201, { session_id: sessionId });
        return;
      }

      // POST /sessions/:id/prompt
      let params = routeMatch(url, "/sessions/:id/prompt");
      if (method === "POST" && params) {
        const idLog = sanitizeForLog(params.id);
        const body = await parseBody(req);
        if (!body.message) {
          logger.warn(`[sidecar] POST /sessions/${idLog}/prompt 400: message is required`);
          sendJson(res, 400, { error: "message is required" });
          return;
        }
        logger.debug(`[sidecar] POST /sessions/${idLog}/prompt: message_length=${body.message.length}`);
        const result = await store.prompt(params.id, body.message);
        logger.info(`[sidecar] POST /sessions/${idLog}/prompt 200 ${Date.now() - requestStart}ms text_length=${result.text.length}${result.error ? ` error=${sanitizeForLog(result.error)}` : ""}`);
        sendJson(res, 200, result);
        return;
      }

      // POST /sessions/:id/abort
      params = routeMatch(url, "/sessions/:id/abort");
      if (method === "POST" && params) {
        const idLog = sanitizeForLog(params.id);
        logger.debug(`[sidecar] POST /sessions/${idLog}/abort: processing`);
        await store.abort(params.id);
        logger.info(`[sidecar] POST /sessions/${idLog}/abort 200 ${Date.now() - requestStart}ms`);
        sendJson(res, 200, { aborted: true });
        return;
      }

      // DELETE /sessions/:id
      params = routeMatch(url, "/sessions/:id");
      if (method === "DELETE" && params) {
        const idLog = sanitizeForLog(params.id);
        logger.debug(`[sidecar] DELETE /sessions/${idLog}: action=delete`);
        const existed = store.delete(params.id);
        logger.info(`[sidecar] DELETE /sessions/${idLog} 200 ${Date.now() - requestStart}ms: existed=${existed}`);
        sendJson(res, 200, { deleted: true, existed });
        return;
      }

      logger.debug(`[sidecar] Route not found: ${method} ${sanitizeForLog(url.split("?")[0])}`);
      sendJson(res, 404, { error: "Not found" });
    } catch (err: any) {
      const message = err?.message || "Internal server error";
      const sanitizedUrl = sanitizeForLog(url.split("?")[0]); // Strip query params before logging
      const rawStatus = typeof err?.statusCode === "number" && err.statusCode >= 100 && err.statusCode <= 599
        ? err.statusCode
        : undefined;
      const status = rawStatus
        ?? (message.includes("not found for provider") ? 400
        : message.includes("Model is required") ? 400
        : message.includes("Payload too large") ? 413
        : message.includes("Invalid JSON") ? 400
        : message.includes("is busy") ? 409
        : message.includes("shutting down") ? 503
        : message.includes("not found") ? 404
        : 500);
      if (status === 500) {
        logger.error(`[sidecar] REQUEST_FAILED: method=${method}, url=${sanitizedUrl}, status=${status}, duration_ms=${Date.now() - requestStart}, error=${sanitizeForLog(message)}`, err);
      } else {
        logger.warn(`[sidecar] REQUEST_FAILED: method=${method}, url=${sanitizedUrl}, status=${status}, duration_ms=${Date.now() - requestStart}, error=${sanitizeForLog(message)}`);
      }
      sendJson(res, status, { error: message });
    } finally {
      activeRequests--;
    }
  });

  // Stale session cleanup every 10 minutes
  cleanupInterval = setInterval(() => {
    logger.debug(`[sidecar] Running stale session cleanup`);
    const cleaned = store.cleanupStale(60 * 60 * 1000); // 1 hour
    logger.debug(`[sidecar] Stale cleanup result: removed=${cleaned}`);
  }, 10 * 60 * 1000);

  server.listen(PORT, HOST, () => {
    const addr = server.address();
    if (addr && typeof addr === "object" && addr.address) {
      trustBindHost = addr.address;
    }
    logger.info(`[sidecar] Pi SDK sidecar listening on http://${HOST}:${PORT}`);
    logger.info(`[sidecar] Config: host=${HOST}, port=${PORT}, trustBindHost=${trustBindHost}, devMode=${process.env.DEV_MODE || 'false'}, logLevel=${process.env.PI_SIDECAR_LOG_LEVEL || 'info'}`);
    const watchdogUrl = options?.watchdogUrl || process.env.SIDECAR_WATCHDOG_URL;
    if (watchdogUrl) {
      logger.info(`[sidecar] Watchdog enabled: url=${watchdogUrl}`);
      stopWatchdog = startWatchdog(watchdogUrl, async () => {
        logger.warn("[sidecar] Backend unresponsive, shutting down");
        await shutdownSidecar("watchdog");
      }, options?.watchdogOptions);
    } else {
      logger.info("[sidecar] Watchdog disabled (no SIDECAR_WATCHDOG_URL)");
    }

    // Auto-discover models from extensions on startup
    store.refreshModels().catch((err) => {
      logger.error("[sidecar] Model discovery failed:", err);
    });
  });

  return {
    close: async () => {
      await shutdownSidecar("close");
    },
  };
}
