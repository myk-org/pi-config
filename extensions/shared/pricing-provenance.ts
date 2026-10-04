/**
 * Pricing provenance marker.
 *
 * Pi requires numeric prices, so a model whose source supplied none is registered
 * with zeros — and those zeros mean *unknown*, not *free*. A catalog all-zero cost
 * means the opposite: the price is known to be zero (an OpenRouter `:free`
 * variant, for example). The number alone cannot tell the two apart, so every
 * site that fabricates a placeholder cost marks the model and consumers read the
 * marker instead of guessing from the value.
 *
 * Shared with packages/pi-sidecar through the global symbol registry: the sidecar
 * cannot import extensions/shared (separate tsconfig rootDir). Same pattern as
 * Symbol.for("pi-config.ambientLoginAuth") and the session-cwd ALS.
 */
import { createLogger } from "./logger.js";

const log = createLogger("pricing-provenance");

export const PRICING_UNKNOWN = Symbol.for("pi-config.pricingUnknown");

/**
 * Counterpart marker for sources that *did* publish prices, zeros included.
 *
 * A models.dev entry or an OpenAI-compatible `/v1/models` record that states a
 * zero price is authoritative even though the model is absent from pi-ai's
 * generated catalog. Without this marker the sidecar cannot tell that explicit
 * zero from Pi's own zero-filled placeholder, and would report a genuinely free
 * call as unknown spend.
 */
export const PRICING_KNOWN = Symbol.for("pi-config.pricingKnown");

/**
 * Mark a model whose prices were defaulted rather than supplied by its source.
 *
 * Enumerable on purpose: symbol keys stay out of Object.keys and JSON, but they
 * do survive object spread, so a model copied downstream keeps its provenance.
 */
export function markPricingUnknown<T extends object>(model: T): T {
  (model as Record<symbol, unknown>)[PRICING_UNKNOWN] = true;
  // Never log the model or its prices — only the decision.
  log.debug("Marked model pricing as unknown", { marked: true });
  return model;
}

/** Whether a model was marked as having unknown (not zero) prices. */
export function isPricingUnknown(model: unknown): boolean {
  const unknown = !!model && typeof model === "object" && Reflect.get(model, PRICING_UNKNOWN) === true;
  log.debug("Read model pricing provenance", { unknown });
  return unknown;
}

/**
 * Mark a model whose prices came from a source that published them — including
 * authoritative zeros. Unknown wins if both markers are somehow present.
 */
export function markPricingKnown<T extends object>(model: T): T {
  (model as Record<symbol, unknown>)[PRICING_KNOWN] = true;
  log.debug("Marked model pricing as source-published", { marked: true });
  return model;
}

/** Whether a source published this model's prices (zeros included). */
export function isPricingKnown(model: unknown): boolean {
  const known = !!model && typeof model === "object" && Reflect.get(model, PRICING_KNOWN) === true;
  log.debug("Read source-published pricing provenance", { known });
  return known;
}

/**
 * A price is authoritative only when it is a finite, non-negative number. NaN,
 * Infinity, and negatives describe a broken source, not a price — treating them
 * as prices would classify an invalid quote as a known (possibly free) one.
 */
export function isValidPrice(value: unknown): value is number {
  const valid = typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!valid) log.debug("Rejected price component as invalid", { type: typeof value });
  return valid;
}

/** Normalize one price component, falling back when the source value is invalid. */
export function priceOrFallback(value: unknown, fallback: number): number {
  const price = isValidPrice(value) ? value : fallback;
  log.debug("Normalized price component", { valid: price === value });
  return price;
}

/**
 * Whether a value is a usable cost record.
 *
 * `operation` and `context` exist so a malformed or absent price can be traced to
 * the classification that rejected it: which pricing source, which model, and
 * which field set. Only non-sensitive identifiers belong in `context` — never
 * price values or credentials.
 */
function asRecord(value: unknown, operation: string, context?: Record<string, unknown>): Record<string, unknown> | undefined {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  log.debug("Checked cost record shape", { operation, usable: !!record, ...context });
  return record;
}

/**
 * Classify a raw cost record's provenance: did this source publish prices we can
 * trust, zeros included?
 *
 * "known" requires *every supplied* component to be a valid price and at least one
 * of them to be present. An absent or undefined key is ignored — the source never
 * claimed it — but an explicit `null` counts as supplied-and-invalid, because
 * `priceOrFallback()` normalizes it to a placeholder zero just like a negative or
 * non-numeric value. A record mixing a valid zero with an invalid component is
 * therefore malformed, and the model must stay unknown-priced rather than
 * reporting a driver's placeholder zero as a complete $0.
 *
 * `context` carries non-sensitive identifiers (pricing source, provider, model)
 * so the decision can be traced from the log.
 */
export function classifyCostRecord(cost: unknown, keys: readonly string[], context?: Record<string, unknown>): "known" | "unknown" {
  const entry = asRecord(cost, "classify-cost-record", context);
  // Only absent (undefined) keys are skipped; an explicit null is a supplied
  // component that failed validation.
  const supplied = entry ? keys.filter((key) => entry[key] !== undefined) : [];
  const priced = supplied.some((key) => isValidPrice(entry![key]));
  const allValid = supplied.length > 0 && supplied.every((key) => isValidPrice(entry![key]));
  const verdict = priced && allValid ? "known" : "unknown";
  log.debug("Classified cost record provenance", { verdict, supplied: supplied.length, priced, allValid, fields: keys.length, ...context });
  return verdict;
}
