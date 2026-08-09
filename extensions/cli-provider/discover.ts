/**
 * Dynamic model discovery facade — dispatches to per-agent drivers.
 * CLI only, no API keys / cloud APIs.
 *
 * IMPORTANT: These IDs are CLI `--model` values, NOT acpx model ids.
 */

import { createLogger } from "../shared/logger.js";
import { CLI_PROVIDERS, isCliAgentName, type CliAgentName } from "./providers.js";
import type { DiscoveredCliModel } from "./types.js";
import { modelIdToDisplayName, resolveBinary } from "./shared/discover-cache.js";

const log = createLogger("cli_provider");

export type { DiscoveredCliModel } from "./types.js";
export { modelIdToDisplayName } from "./shared/discover-cache.js";
export { parseAgentListModels } from "./agents/cursor.js";
export {
  parseClaudeBinaryCatalog,
  scanClaudeBinaryCatalog,
} from "./agents/claude.js";
export { parseGeminiCliVisibleModels } from "./agents/gemini.js";

/** True if the CLI binary is on PATH. */
export function isCliBinaryAvailable(agent: CliAgentName): boolean {
  return !!resolveBinary(CLI_PROVIDERS[agent].binary);
}

/**
 * Discover models for a CLI agent (id + display name).
 * CLI-only — never uses API keys or cloud list endpoints.
 */
export async function discoverCliModelsDetailed(
  agent: string,
): Promise<DiscoveredCliModel[]> {
  if (!isCliAgentName(agent)) return [];
  if (!isCliBinaryAvailable(agent)) {
    log.warn(`${agent}: binary not found (${CLI_PROVIDERS[agent].binary})`,
    );
    return [];
  }

  let discovered: DiscoveredCliModel[] = [];
  try {
    discovered = CLI_PROVIDERS[agent].discoverModels();
  } catch (err) {
    log.error(`${agent}: discovery error`, err);
  }

  if (discovered.length > 0) {
    log.info(`${agent}: discovered ${discovered.length} model(s)`);
  } else {
    log.warn(`${agent}: discovery returned no models`);
  }
  return discovered;
}

/** Discover model ids for a CLI agent. */
export async function discoverCliModelIds(agent: string): Promise<string[]> {
  const models = await discoverCliModelsDetailed(agent);
  return models.map((m) => m.id);
}

/** Discover models ready for registries (sidecar / external tools). */
export async function discoverCliModels(
  agent: string,
): Promise<Array<{ id: string; name: string; provider: string }>> {
  if (!/^[a-z0-9_-]+$/i.test(agent)) {
    throw new Error(`Invalid agent name: ${agent}`);
  }
  const models = await discoverCliModelsDetailed(agent);
  return models.map((m) => ({
    id: `${agent}:${m.id}`,
    name: `${m.name} (${agent})`,
    provider: `cli-${agent}`,
  }));
}
