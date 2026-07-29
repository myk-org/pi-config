import { logger } from "./logger.js";

const MAX_RESPONSE_SIZE = 1_048_576; // 1MB
const DEFAULT_TIMEOUT_MS = 30_000;   // 30s

export interface HttpToolConfig {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  url: string;
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  bodyTemplate?: Record<string, any> | string;
  /** Request timeout in milliseconds (default: 30 000). */
  timeoutMs?: number;
}

/**
 * Convert a wire-format HTTP tool config (snake_case from JSON callers)
 * to the internal camelCase `HttpToolConfig` interface.
 */
export function normalizeHttpToolConfig(raw: Record<string, any>): HttpToolConfig {
  return {
    method: raw.method,
    url: raw.url,
    headers: raw.headers,
    queryParams: raw.queryParams ?? raw.query_params,
    bodyTemplate: raw.bodyTemplate ?? raw.body_template,
    timeoutMs: raw.timeoutMs ?? raw.timeout_ms,
  };
}

/**
 * Interpolate `{paramName}` placeholders in a string with values from params.
 * Unmatched placeholders are left as-is.
 */
export function interpolate(template: string, params: Record<string, any>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    if (key in params) {
      const value = params[key];
      return typeof value === "string" ? value : JSON.stringify(value);
    }
    return match;
  });
}

/**
 * Build the full URL with interpolated path and query parameters.
 * Path segment values are URI-encoded to prevent SSRF / path traversal.
 */
function buildUrl(urlTemplate: string, queryParams: Record<string, string> | undefined, params: Record<string, any>): string {
  // URI-encode string param values before interpolating into the URL path
  const encodedParams: Record<string, any> = {};
  for (const [k, v] of Object.entries(params)) {
    encodedParams[k] = typeof v === "string" ? encodeURIComponent(v) : v;
  }
  const url = interpolate(urlTemplate, encodedParams);

  if (!queryParams || Object.keys(queryParams).length === 0) {
    return url;
  }

  // URLSearchParams handles value encoding automatically
  const searchParams = new URLSearchParams();
  for (const [key, valueTemplate] of Object.entries(queryParams)) {
    searchParams.set(key, interpolate(valueTemplate, params));
  }

  // Handle URL fragments — query params must come before the fragment
  const fragmentIndex = url.indexOf("#");
  const base = fragmentIndex >= 0 ? url.substring(0, fragmentIndex) : url;
  const fragment = fragmentIndex >= 0 ? url.substring(fragmentIndex) : "";
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}${searchParams.toString()}${fragment}`;
}

/**
 * Build interpolated headers from a headers template.
 * Strips CR/LF from interpolated values to prevent CRLF header injection.
 */
function buildHeaders(headersTemplate: Record<string, string> | undefined, params: Record<string, any>): Record<string, string> {
  if (!headersTemplate) return {};

  const headers: Record<string, string> = {};
  for (const [key, valueTemplate] of Object.entries(headersTemplate)) {
    headers[key] = interpolate(valueTemplate, params).replace(/[\r\n]/g, "");
  }
  return headers;
}

/**
 * Build the request body from a body template.
 * - If the template is a string, interpolate directly.
 * - If it's an object, JSON.stringify then interpolate placeholders.
 *   String param values are JSON-escaped before interpolation to prevent
 *   JSON injection (e.g. quotes in values breaking the JSON structure).
 */
function buildBody(bodyTemplate: Record<string, any> | string | undefined, params: Record<string, any>): string | undefined {
  if (bodyTemplate === undefined) return undefined;

  if (typeof bodyTemplate === "string") {
    return interpolate(bodyTemplate, params);
  }

  // Object template: JSON-escape string values to prevent injection
  const escapedParams: Record<string, any> = {};
  for (const [k, v] of Object.entries(params)) {
    escapedParams[k] = typeof v === "string" ? JSON.stringify(v).slice(1, -1) : v;
  }
  const jsonString = JSON.stringify(bodyTemplate);
  return interpolate(jsonString, escapedParams);
}

/**
 * Redact query string from a URL for safe logging.
 * Returns origin + pathname only (no query params which may contain secrets).
 */
function redactUrl(fullUrl: string): string {
  try {
    const parsed = new URL(fullUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return fullUrl.split("?")[0];
  }
}

/**
 * Read the response body with a size limit.
 * Returns the text content, truncated if it exceeds MAX_RESPONSE_SIZE.
 */
async function readResponseBody(response: Response, logUrl: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let storedSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (storedSize + value.length > MAX_RESPONSE_SIZE) {
        // Push only the bytes that fit within the limit
        const remaining = MAX_RESPONSE_SIZE - storedSize;
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          storedSize += remaining;
        }
        reader.cancel();
        logger.warn(`[sidecar] HTTP tool response truncated: url=${logUrl}, size>${MAX_RESPONSE_SIZE}`);
        break;
      }
      chunks.push(value);
      storedSize += value.length;
    }
  } catch (err: any) {
    logger.warn(`[sidecar] HTTP tool response read error: url=${logUrl}, error=${err?.message}`);
  }

  const combined = new Uint8Array(storedSize);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(combined);
}

/**
 * Create an async executor function for an HTTP-backed custom tool.
 * The returned function accepts tool parameters, interpolates them into
 * the HTTP config, makes the request, and returns the response body.
 *
 * Errors are returned as strings — the executor never throws.
 */
export function createHttpToolExecutor(httpConfig: HttpToolConfig): (params: Record<string, any>, externalSignal?: AbortSignal) => Promise<string> {
  return async (params: Record<string, any>, externalSignal?: AbortSignal): Promise<string> => {
    const controller = new AbortController();
    const timeoutMs = httpConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Abort on external signal (e.g. from the Pi SDK when session is aborted)
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timer);
        return "HTTP request failed: Request aborted";
      }
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const url = buildUrl(httpConfig.url, httpConfig.queryParams, params);

      // Validate URL scheme — only http: and https: are allowed
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          logger.error(`[sidecar] HTTP_TOOL_BLOCKED: reason=unsupported_scheme, scheme=${parsed.protocol}`);
          return `HTTP request failed: Unsupported URL scheme '${parsed.protocol}' — only http: and https: are allowed`;
        }
      } catch {
        const safeUrlTemplate = String(httpConfig.url).replace(/[\r\n]/g, "");
        logger.error(`[sidecar] HTTP_TOOL_BLOCKED: reason=invalid_url, url_template=${safeUrlTemplate}`);
        return "HTTP request failed: Invalid URL";
      }

      const headers = buildHeaders(httpConfig.headers, params);
      const body = buildBody(httpConfig.bodyTemplate, params);

      // Set Content-Type for requests with a body if not already set
      if (body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }

      const logUrl = redactUrl(url);
      logger.debug(`[sidecar] HTTP tool request: method=${httpConfig.method}, url=${logUrl}`);

      const response = await fetch(url, {
        method: httpConfig.method,
        headers,
        body,
        signal: controller.signal,
      });

      const responseBody = await readResponseBody(response, logUrl);

      if (!response.ok) {
        logger.error(`[sidecar] HTTP tool error response: method=${httpConfig.method}, url=${logUrl}, status=${response.status}, body_length=${responseBody.length}`);
        return `HTTP ${response.status}: ${responseBody}`;
      }

      logger.debug(`[sidecar] HTTP tool response: method=${httpConfig.method}, url=${logUrl}, status=${response.status}, body_length=${responseBody.length}`);
      return responseBody;
    } catch (err: any) {
      const message = err?.name === "AbortError"
        ? (externalSignal?.aborted ? "Request aborted" : `Request timed out after ${timeoutMs}ms`)
        : (err?.message || "Unknown HTTP error");
      logger.error(`[sidecar] HTTP tool request failed: method=${httpConfig.method}, error=${message}`);
      return `HTTP request failed: ${message}`;
    } finally {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  };
}
