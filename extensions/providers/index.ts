/**
 * Providers extension for pi
 *
 * Handles cold-start default model restore and per-model thinking-level
 * persistence across sessions.
 *
 * Loaded from: extensions/providers/
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { isPiMetaInvocation } from "../orchestrator/utils.js";
import { registerSessionRestore, type SessionRestoreOptions } from "./session-restore.js";

const log = createLogger("providers");
log.debug("providers module loaded");

export default function (
  pi: ExtensionAPI,
  testOptions?: SessionRestoreOptions,
) {
  // pi --help / --version — skip session wiring
  if (isPiMetaInvocation(testOptions?.argv)) {
    log.debug("providers skipping session wiring for meta invocation");
    return;
  }

  registerSessionRestore(pi, {
    thinkingStatePath: testOptions?.thinkingStatePath,
    argv: testOptions?.argv,
  });
}
