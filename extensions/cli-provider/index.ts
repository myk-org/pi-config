/**
 * CLI Provider Extension — Backward-Compatible Shim
 *
 * This file exists solely for backward compatibility with consumers that
 * resolve `extensions/cli-provider/index.ts` from the pi-orchestrator-config
 * package (e.g. pi-sidecar).
 *
 * Delegates provider registration to the unified driver extension at
 * `extensions/providers/index.ts`. Re-exports all public APIs so existing
 * import paths continue to work.
 *
 * DO NOT add new logic here — add it to the driver or shared modules.
 *
 * @module cli-provider (shim)
 */

// Re-export discovery APIs (consumed by pi-sidecar via jiti)
export {
  discoverCliModels,
  discoverCliModelIds,
  discoverCliModelsDetailed,
  modelIdToDisplayName,
  isCliBinaryAvailable,
} from "./discover.js";

// Re-export parsers (consumed by tests)
export {
  parseAgentListModels,
} from "./agents/cursor.js";
export {
  parseClaudeBinaryCatalog,
  scanClaudeBinaryCatalog,
} from "./agents/claude.js";
export {
  parseGeminiCliVisibleModels,
} from "./agents/gemini.js";

// Re-export session management (consumed by drivers and tests)
export {
  resolveCliHistorySeed,
} from "./sessions.js";

// Re-export model mapping (consumed by tests and unified extension)
export {
  mapCliDiscoveredModels,
} from "./runtime-models.js";

/**
 * No-op extension entry point.
 *
 * Registration is now handled by the unified provider extension at
 * `extensions/providers/index.ts`. This default export exists only so
 * pi's extension loader does not throw when loading this directory.
 */
export default async function (_pi: unknown) {
  // Intentional no-op — registration moved to extensions/providers/index.ts
}
