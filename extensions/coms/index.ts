/**
 * Coms Extension for pi
 *
 * Inter-agent communication — P2P (coms) and networked (coms-net).
 * Activated on-demand via /coms and /coms-net slash commands.
 *
 * Standalone extension so it can be loaded independently by pi-sidecar
 * without pulling in the full orchestrator.
 *
 * Based on upstream extensions from disler/pi-vs-claude-code.
 * Synced via scripts/sync-coms-upstream.sh.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerComs } from "./coms.js";
import { registerComsNet } from "./coms-net.js";

export default function (pi: ExtensionAPI) {
    registerComs(pi);
    registerComsNet(pi);
}
