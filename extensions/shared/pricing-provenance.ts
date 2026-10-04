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
 * A price is authoritative only when it is a finite, non-negative number. NaN,
 * Infinity, and negatives describe a broken source, not a price — treating them
 * as prices would classify an invalid quote as a known (possibly free) one.
 */
export function isValidPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Normalize one price component, falling back when the source value is invalid. */
export function priceOrFallback(value: unknown, fallback: number): number {
  const price = isValidPrice(value) ? value : fallback;
  log.debug("Normalized price component", { valid: price === value });
  return price;
}

/**
 * Whether a cost record carries at least one authoritative price under `keys`.
 * Key names differ per source (Pi uses cacheRead, models.dev uses cache_read).
 *
 * A record with no valid price component is a placeholder, so it must be marked
 * unknown. A record that prices even one component — zeros included — carries
 * real information and stays known.
 */
export function hasPricedComponent(cost: unknown, keys: readonly string[]): boolean {
  const entry = cost && typeof cost === "object" && !Array.isArray(cost)
    ? cost as Record<string, unknown>
    : undefined;
  const priced = !!entry && keys.some((key) => isValidPrice(entry[key]));
  log.debug("Inspected cost record for a priced component", { priced, fields: keys.length });
  return priced;
}
