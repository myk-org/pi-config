/**
 * Pidash Extension for pi
 *
 * Live web dashboard — connects to the pidash daemon to expose this session.
 * Forwards pi events to the browser and receives prompts/commands back.
 *
 * Standalone extension so it can be loaded independently.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPidash } from "./pidash.js";

export default function (pi: ExtensionAPI) {
    registerPidash(pi);
}
