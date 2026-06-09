/**
 * Coms Extension for pi
 *
 * Inter-agent communication — P2P (coms) and networked (coms-net).
 * Activated on-demand via /coms and /coms-net slash commands.
 *
 * Standalone extension so it can be loaded independently by pi-sidecar
 * without pulling in the full orchestrator.
 *
 * Forked from disler/pi-vs-claude-code — we own the coms implementation files.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerComs } from "./coms-wrapper.js";
import { registerComsNet } from "./coms-net-wrapper.js";

export default function (pi: ExtensionAPI) {
    registerComs(pi);
    registerComsNet(pi);
}
