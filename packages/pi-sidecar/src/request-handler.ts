/**
 * The sidecar's HTTP request handler, lifted out of `startSidecar` (issue
 * #1126) so unit tests can drive it directly instead of over a real socket.
 * Behaviour is unchanged — same status codes, bodies, headers, log lines and
 * ordering. The only difference is that the values it used to close over now
 * arrive through {@link RequestHandlerDeps}.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  createApiKeyRedactor,
  isValidApiKey,
  redactDiagnostic,
  type SessionStore,
} from "./sessions.js";
import { createLogger, logger } from "./logger.js";
import {
  isAllowedStreamRequest,
  isLoopbackBindHost,
  parseBody,
  redactProviderStatusAuth,
  routeMatch,
  sanitizeForLog,
  sendJson,
} from "./http-helpers.js";

const recLog = createLogger("recording-routes");
const keyDiscoveryRouteLog = createLogger("key-model-discovery-route");

/**
 * Everything the request handler needs, passed explicitly: it must not close
 * over `startSidecar` locals, so a test can drive it with an in-memory store.
 */
export interface RequestHandlerDeps {
  store: SessionStore;
  /**
   * Shutdown flag, read per request. A snapshot would let a request that
   * started before `close()` reach a store already being disposed.
   */
  isDraining: () => boolean;
  /**
   * Bind host for trust decisions, read per request: `startSidecar` replaces
   * the configured host with `server.address()` once listening.
   */
  getTrustBindHost: () => string;
  /** In-flight request accounting; shutdown waits for it to reach zero. */
  beginRequest: () => void;
  endRequest: () => void;
}

export function createRequestHandler(
  deps: RequestHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { store } = deps;
  return async (req, res) => {
    const method = req.method || "GET";
    const url = req.url || "/";
    const requestStart = Date.now();

    const trustBindHost = deps.getTrustBindHost();

    if (deps.isDraining()) {
      logger.warn(`[sidecar] REQUEST_REJECTED: method=${method}, url=${sanitizeForLog(url.split("?")[0])}, reason=server_shutting_down`);
      sendJson(res, 503, { error: "Server is shutting down" });
      return;
    }

    deps.beginRequest();
    let requestApiKey: string | undefined;
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

      // GET /providers
      if (method === "GET" && url === "/providers") {
        const providers = await store.getProviders();
        logger.debug(`[sidecar] GET /providers 200 ${Date.now() - requestStart}ms: count=${providers.length}`);
        sendJson(res, 200, { providers });
        return;
      }

      // GET /transcripts/recording (#935) — effective recording state.
      // Exact-URL match: "/transcripts/recording/reset" (POST) never lands here.
      if (method === "GET" && url === "/transcripts/recording") {
        const state = store.recordingState();
        recLog.debug(`GET /transcripts/recording 200: enabled=${state.enabled}, source=${state.source}`);
        sendJson(res, 200, state);
        return;
      }

      // POST /transcripts/recording (#935) — runtime override, no restart.
      // Affects subsequent turns only; in-flight turns complete under the
      // state captured at their prompt start. Env stays the boot default.
      if (method === "POST" && url === "/transcripts/recording") {
        const body = await parseBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.enabled !== "boolean") {
          recLog.warn(`POST /transcripts/recording 400: invalid body`);
          sendJson(res, 400, { error: "Invalid body: expected { \"enabled\": boolean }" });
          return;
        }
        store.setRecordingOverride(body.enabled);
        const state = store.recordingState();
        recLog.info(`POST /transcripts/recording 200: enabled=${state.enabled}, source=override`);
        sendJson(res, 200, state);
        return;
      }

      // POST /transcripts/recording/reset (#935) — drop the override; the
      // boot-time env default governs again. Idempotent: resetting with no
      // override set still returns the env-governed state.
      if (method === "POST" && url === "/transcripts/recording/reset") {
        store.clearRecordingOverride();
        const state = store.recordingState();
        recLog.info(`POST /transcripts/recording/reset 200: enabled=${state.enabled}, source=${state.source}`);
        sendJson(res, 200, state);
        return;
      }

      // GET /models
      if (method === "GET" && url === "/models") {
        const models = await store.getModels();
        logger.debug(`[sidecar] GET /models 200 ${Date.now() - requestStart}ms: count=${models.length}`);
        sendJson(res, 200, { models });
        return;
      }

      // POST /models/for-api-key
      if (method === "POST" && url === "/models/for-api-key") {
        const body = await parseBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body) ||
            typeof body.provider !== "string" || !body.provider.trim() || !isValidApiKey(body.api_key)) {
          keyDiscoveryRouteLog.debug("Key model discovery request rejected", { validation: "invalid" });
          sendJson(res, 400, { error: "Invalid provider or api_key" });
          return;
        }
        requestApiKey = body.api_key;
        const result = await store.getModelsForApiKey(body.provider, body.api_key);
        keyDiscoveryRouteLog.debug("Key model discovery request completed", { count: result.models.length, modelListingSupported: result.modelListingSupported });
        sendJson(res, 200, result);
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
        const { provider, model, system_prompt, cwd, custom_tools, tools, agent_dir, api_key } = body;
        const rejectValidation = (
          field: string,
          error: string,
          opts?: { reason?: string; extraLog?: string; extraBody?: Record<string, unknown> },
        ) => {
          const timing = opts?.reason !== undefined ? ` ${Date.now() - requestStart}ms` : "";
          const reasonPart = opts?.reason !== undefined ? `, reason=${opts.reason}` : "";
          const extraPart = opts?.extraLog ? `, ${opts.extraLog}` : "";
          logger.warn(`[sidecar] POST /sessions 400${timing}: validation=failed, field=${field}${reasonPart}${extraPart}`);
          sendJson(res, 400, { error, ...opts?.extraBody });
        };
        if (api_key !== undefined) {
          if (!isValidApiKey(api_key)) { // pragma: allowlist secret — field validation, not a credential
            rejectValidation("api_key", "api_key must be a non-empty string with well-formed Unicode and at most 1024 characters");
            return;
          }
          requestApiKey = api_key;
        }
        if (typeof provider !== "string" || provider.length === 0 || typeof system_prompt !== "string" || system_prompt.length === 0) {
          rejectValidation("provider|system_prompt", "provider and system_prompt are required and must be non-empty strings", {
            reason: "must be non-empty strings",
          });
          return;
        }
        if (typeof model !== "string" || model.length === 0) {
          rejectValidation("model", "model is required and must be a non-empty string. Use GET /models to list available models.", {
            reason: "must be non-empty string",
          });
          return;
        }
        if (cwd !== undefined && typeof cwd !== "string") {
          rejectValidation("cwd", "cwd must be a string", { reason: "must be string" });
          return;
        }
        let effectiveAgentDir: string | undefined = agent_dir;
        if (agent_dir !== undefined) {
          if (typeof agent_dir !== "string" || agent_dir.trim().length === 0) {
            rejectValidation("agent_dir", "agent_dir must be a non-empty string", { reason: "must be non-empty string" });
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
            rejectValidation("agent_dir", "agent_dir is not allowed when the sidecar is bound to a non-loopback address", {
              reason: "not_allowed_on_non_loopback_bind",
              extraLog: `host=${trustBindHost}`,
            });
            return;
          } else {
            if (!isAbsolute(agent_dir)) {
              rejectValidation("agent_dir", "agent_dir must be an absolute path", { reason: "must be absolute path" });
              return;
            }
            try {
              const agentDirStat = await stat(agent_dir);
              if (!agentDirStat.isDirectory()) {
                rejectValidation("agent_dir", "agent_dir must be a directory", { reason: "not a directory" });
                return;
              }
            } catch (err: any) {
              const reason = err?.code === "ENOENT" ? "does not exist" : err?.code === "EACCES" ? "permission denied" : `not accessible (${err?.code || "unknown"})`;
              rejectValidation("agent_dir", `agent_dir ${reason}`, { reason });
              return;
            }
          }
        }
        if (tools !== undefined) {
          if (!Array.isArray(tools) || !tools.every((t: any) => typeof t === "string")) {
            rejectValidation("tools", "tools must be an array of strings", { reason: "must be array of strings" });
            return;
          }
        }
        if (custom_tools !== undefined) {
          if (!Array.isArray(custom_tools)) {
            rejectValidation("custom_tools", "custom_tools must be an array", { reason: "must be array" });
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
            rejectValidation(
              "custom_tools",
              "custom_tools entries must be plain objects with a non-empty string 'name' property",
              {
                reason: "entries must be plain objects with non-empty name",
                extraLog: `invalid_indexes=${invalidIndexes.join(",")}`,
                extraBody: { invalid_indexes: invalidIndexes },
              },
            );
            return;
          }
        }
        const sessionId = await store.create({
          provider,
          model,
          systemPrompt: system_prompt,
          cwd: cwd || process.cwd(),
          agentDir: effectiveAgentDir,
          apiKey: requestApiKey,
          tools,
          customTools: custom_tools,
        });
        logger.info(`[sidecar] POST /sessions 201 ${Date.now() - requestStart}ms session=${sessionId}`);
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
        logger.info(`[sidecar] POST /sessions/${idLog}/prompt 200 ${Date.now() - requestStart}ms text_length=${result.text.length}${result.error ? " with_errors=true" : ""}`);
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

      // GET /sessions/:id/events (#1019) — SSE feed for one session's turns.
      // EventSource is GET-only, so this is additive: POST /prompt keeps its
      // response shape. Every rejection happens BEFORE any SSE header, so a
      // rejected request is plain JSON.
      params = routeMatch(url, "/sessions/:id/events");
      if (method === "GET" && params) {
        const idLog = sanitizeForLog(params.id);
        if (!isAllowedStreamRequest(req.headers.origin, req.headers.host, trustBindHost)) {
          logger.warn(`[sidecar] GET /sessions/${idLog}/events 403: reason=origin_or_host_not_allowed`);
          sendJson(res, 403, { error: "Origin or Host not allowed for event streams" });
          return;
        }
        // Rejections first: they are plain JSON, so nothing may be written to
        // the response before them.
        store.assertStreamAllowed(params.id);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        const detach = store.openStream(params.id, {
          write: (frame) => { res.write(frame); },
          bufferedBytes: () => res.writableLength,
          end: () => { res.end(); },
        });
        // `close` on the RESPONSE, not the request: the request is complete as
        // soon as its headers are read, so it does not mean "the client is
        // still here". res 'close' fires exactly when this socket goes away or
        // we end it.
        res.on("close", () => { detach(); });
        logger.info(`[sidecar] GET /sessions/${idLog}/events 200 ${Date.now() - requestStart}ms`);
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
      const secret = requestApiKey;
      const redact = createApiKeyRedactor(secret);
      const rawMessage = err?.message || "Internal server error";
      let promptId: string | undefined;
      if (method === "POST" && /^\/sessions\/[^/]+\/prompt(?:\?|$)/.test(url)) {
        try { promptId = routeMatch(url, "/sessions/:id/prompt")?.id; } catch { /* original error takes precedence */ }
      }
      const message = promptId ? store.redactSessionValue(promptId, redactDiagnostic(rawMessage, redact)) : redactDiagnostic(rawMessage, redact);
      const sanitizedUrl = requestApiKey ? method === "POST" && url === "/models/for-api-key" ? "/models/for-api-key" : "/sessions" : sanitizeForLog(url.split("?")[0]); // Never log a key-bearing URL.
      const rawStatus = typeof err?.statusCode === "number" && err.statusCode >= 100 && err.statusCode <= 599
        ? err.statusCode
        : undefined;
      const status = rawStatus
        ?? (rawMessage.includes("not found for provider") ? 400
        : rawMessage.includes("Model is required") ? 400
        : rawMessage.includes("Payload too large") ? 413
        : rawMessage.includes("Invalid JSON") ? 400
        : rawMessage.includes("is busy") ? 409
        : rawMessage.includes("shutting down") ? 503
        : rawMessage.includes("not found") ? 404
        : 500);
      if (status === 500) {
        const stack = err instanceof Error ? err.cause instanceof Error ? err.cause.stack ?? err.cause.message : err.stack ?? err.message : String(err);
        const safeStack = promptId ? store.redactSessionValue(promptId, redactDiagnostic(stack, redact)) : redactDiagnostic(stack, redact);
        logger.error(`[sidecar] REQUEST_FAILED: method=${method}, url=${sanitizeForLog(redact(sanitizedUrl))}, status=${status}, duration_ms=${Date.now() - requestStart}, error=${sanitizeForLog(message)}, stack=${sanitizeForLog(safeStack)}`);
      } else {
        logger.warn(`[sidecar] REQUEST_FAILED: method=${method}, url=${sanitizeForLog(redact(sanitizedUrl))}, status=${status}, duration_ms=${Date.now() - requestStart}, error=${sanitizeForLog(message)}`);
      }
      sendJson(res, status, { error: message });
    } finally {
      deps.endRequest();
    }
  };
}
