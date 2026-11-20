/**
 * HTTP plumbing the sidecar request handler needs: JSON body parsing, JSON
 * responses, route matching, log-value escaping and the Host/Origin guards.
 * Lifted out of `index.ts` so `request-handler.ts` can use them without an
 * import cycle (issue #1126).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";

import { logger } from "./logger.js";

const MAX_BODY_SIZE = 1_048_576;

// Simple JSON body parser
export async function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bodySizeBytes = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer | string) => {
      if (rejected) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      bodySizeBytes += buf.length;
      if (bodySizeBytes > MAX_BODY_SIZE) {
        rejected = true;
        req.resume();
        logger.warn(`[sidecar] Request body too large: size=${bodySizeBytes}, max=${MAX_BODY_SIZE}`);
        reject(new Error("Payload too large"));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (rejected) return;
      const body = bodySizeBytes === 0 ? "" : Buffer.concat(chunks, bodySizeBytes).toString("utf8");
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        logger.warn(`[sidecar] Invalid JSON body: size=${body.length}`);
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", (err) => {
      if (rejected) return;
      rejected = true;
      reject(err);
    });
  });
}

/** Thrown by readBoundedResponseBytes when a non-truncating read exceeds maxBytes. */
export class ResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Response exceeded ${maxBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

export interface ReadBoundedResponseOptions {
  /** Stop at maxBytes and return truncated bytes instead of throwing ResponseTooLargeError. */
  truncate?: boolean;
  /** Catch stream read errors and return bytes collected so far. */
  allowPartialOnError?: boolean;
  onReadError?: (err: unknown) => void;
}

/**
 * Read a Fetch `Response` body up to `maxBytes`.
 * Always cancels the reader in `finally` to release sockets/streams cleanly.
 */
export async function readBoundedResponseBytes(
  response: Response,
  maxBytes: number,
  options?: ReadBoundedResponseOptions,
): Promise<{ bytes: Uint8Array; truncated: boolean; hasBody: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), truncated: false, hasBody: false };

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (totalBytes + value.byteLength > maxBytes) {
        if (options?.truncate) {
          const remaining = maxBytes - totalBytes;
          if (remaining > 0) {
            chunks.push(value.subarray(0, remaining));
            totalBytes += remaining;
          }
          truncated = true;
          break;
        }
        throw new ResponseTooLargeError(maxBytes);
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } catch (err) {
    if (options?.allowPartialOnError && !(err instanceof ResponseTooLargeError)) {
      options.onReadError?.(err);
    } else {
      throw err;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: combined, truncated, hasBody: true };
}

/**
 * Log-safe form of a URL.
 * Defaults to origin-only (strictest — omits pathname, userinfo, query, hash).
 * Pass `{ includePath: true }` to keep `origin + pathname` (still strips userinfo, query, hash).
 */
export function sanitizeUrlForLog(
  raw: string | undefined,
  options?: { includePath?: boolean; fallback?: string },
): string {
  const fallback = options?.fallback ?? "(unparseable)";
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw);
    return options?.includePath ? `${parsed.origin}${parsed.pathname}` : parsed.origin;
  } catch {
    return fallback;
  }
}

export function sendJson(res: ServerResponse, status: number, data: any): void {
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
 * DNS-rebinding guard for the SSE feed (#1019) — applied to that endpoint
 * only. An EventSource request is preflight-free, so a rebound page counts as
 * same-origin and could read the stream; `/prompt` keeps its current
 * behaviour because validating it would change existing clients (separate
 * issue). Fail-closed: an unparsable Origin, an unparsable Host, or a Host that
 * is neither the bound address, nor (on a wildcard bind) loopback or an IP
 * literal, is rejected.
 */
export function isAllowedStreamRequest(origin: string | undefined, host: string | undefined, boundHost: string): boolean {
  if (origin !== undefined) {
    let originHost: string | undefined;
    try {
      originHost = headerHostname(new URL(origin).hostname);
    } catch {
      return false; // `Origin: null` and garbage fail closed
    }
    if (!originHost || !isLoopbackBindHost(originHost)) return false;
  }
  if (host === undefined) return true;
  const hostName = headerHostname(host);
  if (!hostName) return false;
  if (hostName === boundHost.trim().toLowerCase()) return true;
  // A wildcard bind (DEV_MODE's 0.0.0.0, or ::) has no single Host name to
  // match, so the check has to admit whatever address the client dialed. It
  // admits loopback names and IP literals only: a rebound page sends no Origin
  // header and carries its own domain in Host, so a hostname here is the whole
  // attack. Consequence: reaching the feed under a service hostname requires
  // binding that address explicitly — the safe direction.
  if (isWildcardBindHost(boundHost)) return isLoopbackBindHost(hostName) || isIP(hostName) !== 0;
  return isLoopbackBindHost(boundHost) && isLoopbackBindHost(hostName);
}

/** Bind address that accepts every local address, so it can never equal a Host. */
function isWildcardBindHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "0.0.0.0" || h === "::" || h === "[::]";
}

/** Host value → bare hostname: drops a port and IPv6 brackets. */
function headerHostname(value: string): string | undefined {
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    return end > 1 ? v.slice(1, end) : undefined;
  }
  // A bare IPv6 address has more than one colon — keep it whole.
  const first = v.indexOf(":");
  const last = v.lastIndexOf(":");
  return first === last && last > 0 ? v.slice(0, last) : v;
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
