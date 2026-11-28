/**
 * Pidiff Extension for pi
 *
 * Standalone diff viewer extension — connects to the pidiff daemon.
 * Publishes review comments from the browser back into the pi session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertMinPiVersionOnLoad } from "../shared/pi-version.js";
import { registerPidiff } from "./pidiff.js";

export default function (pi: ExtensionAPI) {
    assertMinPiVersionOnLoad("pidiff");
    registerPidiff(pi);
}
