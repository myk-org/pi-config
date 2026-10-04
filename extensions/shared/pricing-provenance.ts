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
export const PRICING_UNKNOWN = Symbol.for("pi-config.pricingUnknown");

/**
 * Mark a model whose prices were defaulted rather than supplied by its source.
 *
 * Enumerable on purpose: symbol keys stay out of Object.keys and JSON, but they
 * do survive object spread, so a model copied downstream keeps its provenance.
 */
export function markPricingUnknown<T extends object>(model: T): T {
  (model as Record<symbol, unknown>)[PRICING_UNKNOWN] = true;
  return model;
}

/** Whether a model was marked as having unknown (not zero) prices. */
export function isPricingUnknown(model: unknown): boolean {
  return !!model && typeof model === "object"
    && Reflect.get(model, PRICING_UNKNOWN) === true;
}

/**
 * Whether a cost record prices any component under `keys`. Key names differ per
 * source (Pi uses cacheRead, models.dev uses cache_read).
 *
 * A record with no numeric component at all is a placeholder, so it must be
 * marked unknown. A record that prices even one component carries real
 * information — including authoritative zeros — and stays known.
 */
export function hasPricedComponent(cost: unknown, keys: readonly string[]): boolean {
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) return false;
  const entry = cost as Record<string, unknown>;
  return keys.some((key) => typeof entry[key] === "number");
}
