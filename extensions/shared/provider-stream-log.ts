/**
 * Provider stream diagnostics — the shared hook for raw provider stream logging
 * (issue #848, pi 0.99 `provider_stream_event`).
 *
 * GATING IS MANDATORY. `provider_stream_event` fires once per parsed chunk and
 * pi AWAITS handlers inline in the stream loop
 * (`await options?.onProviderStreamEvent?.(chunk, model)`), so registering a
 * slow handler delays stream consumption. We only register when the user opts
 * into provider debug logging.
 *
 * Gate: the existing `log_providers` setting (default `info`), so `debug` is off
 * by default and no new settings key is needed. Reuses the `providers` log
 * namespace → ~/.pi/logs/providers/<session-id>/main.log. Never console.*
 */

import type { ExtensionAPI, ProviderStreamEvent } from "@earendil-works/pi-coding-agent";
import { createLogger } from "./logger.js";

const LOG_NAME = "providers";
const PREFIX = "provider-stream";

const MAX_VALUE_LEN = 200;
const MAX_ITEMS = 8;
const MAX_DEPTH = 4;
// ponytail: per-turn cap; one runaway stream writes 2k lines, not 2M. Raise if
// a real diagnosis ever needs more than that within a single turn.
const MAX_EVENTS_PER_TURN = 2000;

const SECRET_KEY = /api[-_]?key|authorization|bearer|token|secret|password|cookie/i;

function truncate(text: string): string {
  return text.length > MAX_VALUE_LEN ? `${text.slice(0, MAX_VALUE_LEN)}…(+${text.length - MAX_VALUE_LEN})` : text;
}

/**
 * Depth-bounded, size-bounded, secret-redacting preview of an arbitrary stream
 * chunk. Depth bounding also makes cycles terminate — no `seen` set needed.
 */
export function previewStreamData(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (typeof value !== "object") return truncate(String(value));
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[array(${value.length})]` : "{…}";
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ITEMS).map(item => previewStreamData(item, depth + 1));
    return `[${head.join(",")}${value.length > MAX_ITEMS ? ",…" : ""}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const body = entries
    .slice(0, MAX_ITEMS)
    .map(([key, item]) => `${truncate(key)}:${SECRET_KEY.test(key) ? "…redacted" : previewStreamData(item, depth + 1)}`)
    .join(",");
  return `{${body}${entries.length > MAX_ITEMS ? ",…" : ""}}`;
}

/**
 * Register the provider stream log hook. No-op unless provider debug logging is
 * enabled — see the gating note above.
 */
export function registerProviderStreamLog(pi: ExtensionAPI): void {
  const log = createLogger(LOG_NAME, PREFIX);
  if (!log.isDebugEnabled()) return;

  let seen = 0;
  let dropped = 0;
  pi.on("turn_start", () => {
    if (dropped) log.warn("provider stream events dropped this turn", { dropped });
    seen = 0;
    dropped = 0;
  });
  pi.on("provider_stream_event", (event: ProviderStreamEvent) => {
    try {
      if (++seen > MAX_EVENTS_PER_TURN) {
        dropped++;
        return;
      }
      let data: unknown = event.data;
      try {
        // data is read-only to extensions — clone before retaining/logging.
        data = structuredClone(event.data);
      } catch {
        log.warn("stream event data not cloneable, logged un-cloned", { provider: event.provider, api: event.api });
      }
      log.debug("stream_event", `${event.provider}/${event.api}/${event.model}`, previewStreamData(data));
    } catch (err) {
      // Never throw: pi reports handler errors, but a hot-path handler must not
      // interfere with stream consumption.
      log.error("stream event logging failed", err);
    }
  });
}
