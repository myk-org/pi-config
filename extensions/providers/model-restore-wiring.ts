/**
 * session_start wiring for the cold-start default model restore (#753).
 *
 * Extracted from extensions/providers/index.ts so the handler wiring —
 * reason forwarding, setModel plumbing, cwd/projectTrusted extraction,
 * fire-and-forget .catch, applyAfterModelRestore handoff — can be unit
 * tested with a fake pi object. A wiring bug here (wrong reason, broken
 * setModel) would otherwise reset the model undetected (#901 finding).
 *
 * Kept free of @earendil-works/pi-ai imports beyond the Model type so unit
 * tests can import under tsx.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { restoreDefaultModelOnSessionStart, type ModelLike } from "./restore-default-model.js";

const log = createLogger("providers");

/** Raw selection call (pi.setModel) handed to onRestoreModel. */
export type ModelRestoreSetModel = (model: ModelLike) => Promise<boolean>;

export type RegisterModelRestoreOnSessionStartOpts = {
  /** CLI argv to scan for --model / --provider / --models (user override). */
  argv?: string[];
  /**
   * setModel wrapper invoked by the restore. Receives the resolved default
   * model and a raw setSelected that performs the actual selection
   * (pi.setModel). Defaults to calling setSelected directly. index.ts passes
   * lastThinking.restoreModel so thinking preferences follow the switch.
   */
  onRestoreModel?: (
    model: ModelLike,
    setSelected: ModelRestoreSetModel,
  ) => Promise<boolean>;
  /**
   * Hook receiving the fire-and-forget (already caught) restore promise —
   * index.ts passes lastThinking.applyAfterModelRestore so the saved thinking
   * level is applied once the model restore settles. Optional.
   */
  onRestoreSettled?: (
    event: any,
    ctx: any,
    modelRestore: Promise<boolean>,
  ) => void;
};

/**
 * Register a session_start handler that restores the saved default model
 * when the #753 gates pass (see restore-default-model.ts). Fire-and-forget:
 * session_start is not blocked by retries.
 */
export function registerModelRestoreOnSessionStart(
  pi: ExtensionAPI,
  opts: RegisterModelRestoreOnSessionStartOpts = {},
): void {
  const onRestoreModel =
    opts.onRestoreModel ?? ((model, setSelected) => setSelected(model));
  log.debug("model-restore-wiring: registering session_start handler");

  pi.on("session_start", (event, ctx) => {
    const reason = typeof event?.reason === "string" ? event.reason : "";
    log.debug("model-restore-wiring session_start", { reason });

    // agentDir via PI_CODING_AGENT_DIR / ~/.pi/agent only (ctx has cwd, not agentDir).
    // Merge global + cwd/.pi/settings.json (project wins) only when trusted —
    // same gate as pi SettingsManager (ctx.isProjectTrusted). Fail closed.
    const cwd = typeof ctx.cwd === "string" ? ctx.cwd : undefined;
    let projectTrusted = false;
    try {
      projectTrusted = typeof ctx.isProjectTrusted === "function"
        ? ctx.isProjectTrusted() === true
        : false;
    } catch (err) {
      log.debug(
        "restore-default-model isProjectTrusted failed",
        {
          cwd,
          reason,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      projectTrusted = false;
    }
    // Fire-and-forget restore so session_start is not blocked by retries (#753).
    // Omit registeredProviders: cli/acpx-only lists falsely fail-fast native defaults.
    const modelRestore = restoreDefaultModelOnSessionStart({
      ctx: {
        model: ctx.model
          ? { id: ctx.model.id, provider: String(ctx.model.provider) }
          : undefined,
        modelRegistry: ctx.modelRegistry,
      },
      reason,
      cwd,
      projectTrusted,
      argv: opts.argv,
      getCurrentModel: () =>
        ctx.model
          ? { id: ctx.model.id, provider: String(ctx.model.provider) }
          : undefined,
      setModel: (model) =>
        onRestoreModel(model, (selected) =>
          pi.setModel(selected as Model<any>),
        ),
    }).catch((err) => {
      log.warn(
        "restore-default-model session_start error",
        err instanceof Error ? err.message : String(err),
      );
      return false;
    });
    if (opts.onRestoreSettled) {
      opts.onRestoreSettled(event, ctx, modelRestore);
    } else {
      void modelRestore;
    }
  });
}
