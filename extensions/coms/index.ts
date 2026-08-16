/**
 * Coms Extension for pi
 *
 * Inter-agent communication — P2P (coms).
 * Activated on-demand via /coms slash command.
 *
 * Standalone extension so it can be loaded independently by pi-sidecar
 * without pulling in the full orchestrator.
 *
 * Forked from disler/pi-vs-claude-code — we own the coms implementation files.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { shouldSkipOneshotRegister } from "../orchestrator/utils.js";
import { registerComs } from "./coms-wrapper.js";

const log = createLogger("coms");

export default function (pi: ExtensionAPI) {
    if (shouldSkipOneshotRegister(log)) return;
    registerComs(pi);
}
