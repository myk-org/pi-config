import { createLogger } from "./create-logger";

const log = createLogger("model-capabilities");

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function supportsReasoning(model: { reasoning?: unknown } | null | undefined): boolean {
  const supported = model?.reasoning === true;
  log.debug("reasoning capability checked", { supported });
  return supported;
}
