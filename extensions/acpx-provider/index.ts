/**
 * ACPX Provider Extension — Backward-Compatible Shim
 *
 * This file exists solely for backward compatibility with consumers that
 * resolve `extensions/acpx-provider/index.ts` from the pi-orchestrator-config
 * package (e.g. pi-sidecar).
 *
 * Delegates provider registration to the unified driver extension at
 * `extensions/providers/index.ts`. Re-exports all public APIs so existing
 * import paths continue to work.
 *
 * DO NOT add new logic here — add it to the driver or shared modules.
 *
 * @module acpx-provider (shim)
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { rm } from "node:fs/promises";
import { fileLog } from "../shared/file-logger.js";
import { loadAcpxRuntime } from "./load-runtime.js";

// Re-export model mapping (consumed by tests and unified extension)
export {
  mapAcpxDiscoveredModels,
  modelIdToDisplayName,
} from "./runtime-models.js";

/**
 * Discover available models for an acpx agent.
 *
 * Uses the acpx/runtime library API: creates a temporary session, queries
 * getStatus().models.availableModelIds, then closes the session.
 *
 * This function is kept here (not moved to a sub-module) because pi-sidecar
 * imports it from this exact path via jiti.
 */
export async function discoverAcpxModels(
  agent: string,
  cwd?: string,
): Promise<Array<{ id: string; name: string; provider: string }>> {
  if (!/^[a-z0-9_-]+$/i.test(agent)) {
    throw new Error(`Invalid agent name: ${agent}`);
  }

  const {
    createAcpRuntime,
    createFileSessionStore,
    createAgentRegistry,
  } = await loadAcpxRuntime();

  const { modelIdToDisplayName: displayName } = await import("./runtime-models.js");

  const effectiveCwd = cwd || process.cwd();
  const uid = randomUUID().slice(0, 8);
  const stateDir = path.join(os.homedir(), ".acpx", `discover-${process.pid}-${uid}`);
  const runtime = createAcpRuntime({
    cwd: effectiveCwd,
    sessionStore: createFileSessionStore({ stateDir }),
    agentRegistry: createAgentRegistry(),
    permissionMode: "deny-all",
  });

  let handle: any;
  try {
    handle = await runtime.ensureSession({
      sessionKey: `discover-${agent}-${uid}`,
      agent,
      mode: "oneshot",
      cwd: effectiveCwd,
    });

    const status = await runtime.getStatus({ handle });
    const modelIds: string[] = status.models?.availableModelIds || [];

    return modelIds.map((modelId: string) => ({
      id: `${agent}:${modelId}`,
      name: `${displayName(modelId)} (${agent})`,
      provider: `acpx-${agent}`,
    }));
  } catch (err) {
    fileLog("acpx-provider", "debug", "acpx-provider", `model discovery failed for ${agent}:`, err);
    return [];
  } finally {
    if (handle) {
      await runtime.close({ handle, reason: "discovery complete" }).catch((err: any) => {
        fileLog("acpx-provider", "debug", "acpx-provider", "failed to close discovery session:", err);
      });
    }
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

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
