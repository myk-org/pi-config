/**
 * Background virtual model — cheap/fast model routing for background work.
 *
 * Registers `pi-bg/auto`, a pi virtual model (EXPERIMENTAL, pi >= 0.99.0) that picks a
 * physical model per request. Background work (async subagents, dreaming, cron) selects
 * it instead of inheriting the parent's interactive model, so the first turn can run on
 * the cheap `internal_operations_*` model while every later turn stays on whatever
 * already answered — prompt cache and thinking signatures intact.
 *
 * Gated on `background_virtual_model_enable` (default false): off means this registers
 * nothing, so `/model` and the model catalog are byte-for-byte what they were.
 * Requires pi >= 0.99; older pi has no registerVirtualModel and is skipped.
 *
 * Docs: pi `docs/virtual-models.md`, `examples/extensions/jev-router.ts`.
 */

import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { createLogger } from "./logger.js";
import { getSetting } from "../orchestrator/project-settings.js";

const log = createLogger("background-model");

/** Provider id of the virtual model. Unused by any real provider, so it needs no credentials. */
export const BACKGROUND_PROVIDER = "pi-bg";
export const BACKGROUND_MODEL_ID = "auto";

/** Provider id of the physical model the router sends background work to. */
const TARGET_PROVIDER_KEY = "internal_operations_provider";
const TARGET_MODEL_KEY = "internal_operations_model";

/**
 * Whether this process actually registered the virtual model. Module state is
 * per-process, so this is exactly the answer to "does pi-bg/auto exist here?".
 * Without it, a pi older than 0.99 with the flag on would hand spawns a model
 * that was never registered.
 */
let registered = false;

type RouteRequest = ModelRouteRequest<never>;

/** Trimmed setting value. Defensive: a string key with no declared default resolves to undefined. */
function settingText(cwd: string, key: "internal_operations_provider" | "internal_operations_model"): string {
  const value: unknown = getSetting(cwd, key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Any physical model this session could actually use, as a last resort.
 *
 * Defensive by necessity: this runs inside the catch path, so throwing here would
 * escape `routeBackgroundRequest` entirely and hand pi the error response the
 * fallback exists to prevent.
 */
function anyPhysicalModel(ctx: ExtensionContext): RouteRequest["model"] | undefined {
  try {
    for (const model of ctx.modelRegistry.getAvailableSnapshot()) {
      if (ctx.modelRegistry.hasConfiguredAuth(model)) return model;
    }
  } catch (error) {
    log.debug("catalog scan failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return undefined;
}

/**
 * Never throws: the physical model already in the conversation, else any physical
 * model the session can reach.
 *
 * The catalog lookup is not decoration. pi rejects a non-physical route target --
 * `model-runtime.js` throws `"...which is not a physical model."` -- and for a
 * pi-bg/auto request `request.model` IS the virtual model, so falling back to it
 * would turn a routing miss into an error response for the whole request.
 * `request.model` survives only as the terminal case, when the session has no
 * usable physical model at all and nothing could have succeeded.
 */
function fallbackRoute(request: RouteRequest, ctx: ExtensionContext): ModelRoute<never> {
  return {
    model: request.previous?.model ?? anyPhysicalModel(ctx) ?? request.model,
    thinkingLevel: request.previous?.thinkingLevel ?? request.thinkingLevel,
  };
}

/**
 * Physical model the router sends the first request to: the internal operations
 * provider/model pair. Returns undefined when unset or not usable here — the caller
 * then falls back instead of routing to a model without credentials.
 */
function targetModel(ctx: ExtensionContext): RouteRequest["model"] | undefined {
  const provider = settingText(ctx.cwd, TARGET_PROVIDER_KEY);
  const id = settingText(ctx.cwd, TARGET_MODEL_KEY);
  if (!provider || !id) return undefined;
  const model = ctx.modelRegistry.find(provider, id);
  // hasConfiguredAuth answers yes/no without handing the key to us — never log or store it.
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
    log.debug("target unusable", { provider, model: id, found: Boolean(model) });
    return undefined;
  }
  return model;
}

/**
 * The router. Sticky after the first response, cheap on the first one, and never throws:
 * pi turns a throw here into an error response for the whole request.
 */
export function routeBackgroundRequest(
  request: RouteRequest,
  ctx: ExtensionContext,
): ModelRoute<never> {
  try {
    // Tool follow-ups, retries and later turns keep the model that already answered:
    // switching mid-turn would lose the prompt cache and invalidate thinking signatures.
    if (request.previous) {
      log.debug("route sticky", { reason: request.reason, provider: request.previous.model.provider, model: request.previous.model.id });
      return {
        model: request.previous.model,
        thinkingLevel: request.previous.thinkingLevel ?? request.thinkingLevel,
      };
    }
    const target = targetModel(ctx);
    if (target) {
      log.debug("route target", { reason: request.reason, provider: target.provider, model: target.id });
      return { model: target, thinkingLevel: request.thinkingLevel };
    }
    log.debug("route fallback: no target configured", { reason: request.reason });
    return fallbackRoute(request, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("route failed, falling back", { reason: request.reason, error: message });
    return fallbackRoute(request, ctx);
  }
}

/**
 * Provider/model to spawn a background agent with, or undefined to keep today's
 * resolution. Only active with the flag on AND a configured internal operations
 * target, so a missing or unusable target can never break a spawn.
 */
export function backgroundModelRef(cwd: string): { provider: string; model: string } | undefined {
  if (!registered) return undefined;
  if (!getSetting(cwd, "background_virtual_model_enable")) return undefined;
  const provider = settingText(cwd, TARGET_PROVIDER_KEY);
  const id = settingText(cwd, TARGET_MODEL_KEY);
  if (!provider || !id) {
    log.debug("background routing off: internal operations model not configured");
    return undefined;
  }
  return { provider: BACKGROUND_PROVIDER, model: BACKGROUND_MODEL_ID };
}

/**
 * Register `pi-bg/auto`. Registers nothing when the flag is off or pi predates
 * virtual models. `cwd` is the session cwd — the only one available at load time.
 */
export function registerBackgroundModel(pi: ExtensionAPI, cwd: string = process.cwd()): boolean {
  if (typeof (pi as { registerVirtualModel?: unknown }).registerVirtualModel !== "function") {
    log.debug("skip: pi has no registerVirtualModel (needs >= 0.99.0)");
    return false;
  }
  if (!getSetting(cwd, "background_virtual_model_enable")) {
    log.debug("skip: background_virtual_model_enable is off");
    return false;
  }
  pi.registerVirtualModel({
    provider: BACKGROUND_PROVIDER,
    id: BACKGROUND_MODEL_ID,
    name: "Background (auto)",
    thinkingLevels: ["off", "low", "medium", "high"],
    // No contextWindow/maxTokens: unset limits are shown as unknown rather than
    // guessed, and after the first response the routed model's own limits apply.
    route: routeBackgroundRequest,
  });
  log.info("registered", { provider: BACKGROUND_PROVIDER, model: BACKGROUND_MODEL_ID });
  registered = true;
  return true;
}
