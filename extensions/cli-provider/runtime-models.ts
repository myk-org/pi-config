/**
 * Map CLI discovery results → full createProvider Model[].
 * Kept separate from index.ts so unit tests do not load stream/session code.
 */

import { buildRuntimeModel } from "../shared/create-runtime-provider.js";
import {
  fillRuntimeModelFromCatalog,
  type ModelsDevCatalog,
} from "../shared/models-dev.js";
import type { DiscoveredCliModel } from "./discover.js";

export function mapCliDiscoveredModels(
  agent: string,
  discovered: readonly DiscoveredCliModel[],
  catalog?: ModelsDevCatalog | null,
): ReturnType<typeof buildRuntimeModel>[] {
  const provider = `cli-${agent}`;
  if (discovered.length === 0) {
    return [
      buildRuntimeModel({
        id: `${agent}:default`,
        name: `${agent} (default)`,
        api: "cli",
        provider,
      }),
    ];
  }
  return discovered.map((m) =>
    buildRuntimeModel(
      fillRuntimeModelFromCatalog(
        {
          id: `${agent}:${m.id}`,
          name: `${m.name} (${agent})`,
          api: "cli",
          provider,
        },
        catalog,
        agent,
        m.id,
      ),
    ),
  );
}
