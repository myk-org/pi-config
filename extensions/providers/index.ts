/**
 * Providers extension for pi
 *
 * Handles cold-start default model restore and per-model thinking-level
 * persistence across sessions.
 *
 * Loaded from: extensions/providers/
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { isPiMetaInvocation } from "../orchestrator/utils.js";
import { registerModelRestoreOnSessionStart } from "./model-restore-wiring.js";
import { registerLastThinkingLevel } from "./last-thinking-level.js";

const log = createLogger("providers");
log.debug("providers module loaded");

export default function (
  pi: ExtensionAPI,
  testOptions?: {
    thinkingStatePath?: string;
    argv?: string[];
  },
) {
  // pi --help / --version — skip session wiring
  if (isPiMetaInvocation()) return;

  const lastThinking = registerLastThinkingLevel(pi, {
    statePath: testOptions?.thinkingStatePath,
    argv: testOptions?.argv,
  });

  registerModelRestoreOnSessionStart(pi, {
    argv: testOptions?.argv,
    onRestoreModel: (model, setSelected) => {
      log.debug("onRestoreModel handoff", { provider: model.provider, id: model.id });
      return lastThinking.restoreModel(model as Model<any>, setSelected);
    },
    onRestoreSettled: (event, ctx, modelRestore) => {
      log.debug("onRestoreSettled handoff", { reason: (event as { reason?: string })?.reason });
      return void lastThinking.applyAfterModelRestore(event, ctx, modelRestore);
    },
  });
}
