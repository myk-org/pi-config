/**
 * GeminiDriver — ProviderDriver for the Gemini CLI agent.
 *
 * @module providers/gemini-driver
 */

import type { ProviderDriver } from "../shared/provider-driver.js";
import { createLogger } from "../shared/logger.js";
import {
  createCliDriver,
  createSimpleCliAdapter,
  type CliDriverConfig,
  type SimpleCliAdapterShape,
} from "./cli-driver-shared.js";

const log = createLogger("gemini-driver");

export type GeminiCliConfig = CliDriverConfig;

export function createGeminiAdapter(
  config: GeminiCliConfig,
  cwd: string,
  instanceId: string,
): SimpleCliAdapterShape {
  return createSimpleCliAdapter({
    agent: "gemini",
    config,
    cwd,
    instanceId,
    log,
  });
}

export const GeminiDriver: ProviderDriver<GeminiCliConfig> = createCliDriver({
  agent: "gemini",
  driverKind: "gemini-cli",
  defaultBinary: "gemini",
  defaultDisplayName: "Gemini CLI",
  log,
  createAdapter: createGeminiAdapter,
});
