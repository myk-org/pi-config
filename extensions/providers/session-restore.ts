/**
 * Unified session-restore lifecycle for the providers extension (#1360).
 *
 * Owns one ordered `session_start` flow (cold-start default model restore
 * followed directly by per-model thinking-level restore), plus `model_select`,
 * `thinking_level_select`, and `session_shutdown` timer/state cleanup.
 *
 * Explicit in-module restore state (`pendingRestore`) distinguishes our own
 * in-flight default-model `setModel` event from user model/thinking switches
 * without cross-handler callback bouncing or generation inference.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isLiveExtensionCtx } from "../shared/live-ctx.js";
import { createLogger } from "../shared/logger.js";
import {
  clampSavedThinkingLevel,
  hasExplicitThinkingArg,
  isThinkingLevel,
  modelThinkingKey,
  preferredThinkingLevel,
  readThinkingLevelState,
  saveModelThinkingLevel,
  shouldRestoreLastThinkingLevel,
  type RuntimeModel,
  type SavedThinkingLevel,
  type ThinkingRestoreContext,
} from "./last-thinking-level.js";
import { restoreDefaultModelOnSessionStart, type ModelLike } from "./restore-default-model.js";

const log = createLogger("providers");

export type SessionRestoreOptions = {
  /** Override thinking-level state file path (tests). */
  thinkingStatePath?: string;
  /** CLI argv scanned for --model/--provider/--models/--thinking overrides. */
  argv?: string[];
};

export type SessionRestoreHandle = {
  /** Resolves once the currently active session_start restore flow settles. */
  waitForPendingRestore: () => Promise<boolean>;
};

type PendingRestore = {
  controller: AbortController;
  /** Target model key strictly while our own pi.setModel(model) call is in flight. */
  settingModelKey?: string;
  /** True once model_select matched our in-flight default-model setModel call. */
  sawRestoreModelSelect: boolean;
  /** True if the user explicitly switched model or thinking level during restore. */
  supersededByUser: boolean;
  /** Resolves to true when thinking-level restore applied; false otherwise. */
  done: Promise<boolean>;
};

function readProjectTrusted(ctx: any, cwd: string | undefined, reason: string): boolean {
  try {
    return typeof ctx?.isProjectTrusted === "function"
      ? ctx.isProjectTrusted() === true
      : false;
  } catch (err) {
    log.debug("restore-default-model isProjectTrusted failed", {
      cwd,
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function modelRef(model: ModelLike | undefined | null): { id: string; provider: string } | undefined {
  return model ? { id: model.id, provider: String(model.provider) } : undefined;
}

/**
 * Register unified startup model restore and per-model thinking-level
 * persistence handlers on `pi`. Fire-and-forget on `session_start` so startup
 * is never blocked by retries; pending retry timers are cancelled on
 * `session_shutdown` or a subsequent `session_start`.
 */
export function registerSessionRestore(
  pi: ExtensionAPI,
  opts: SessionRestoreOptions = {},
): SessionRestoreHandle {
  let activeModelKey: string | undefined;
  let preserveCliLevel = false;
  let pendingRestore: PendingRestore | undefined;
  let lastRestoreDone: Promise<boolean> = Promise.resolve(false);
  let activeTransientOverrides = 0;
  const suppressedEvents: Array<{ model: string | undefined; level: SavedThinkingLevel }> = [];

  const cancelPendingRestore = (cause: string): void => {
    if (!pendingRestore) return;
    log.debug("session-restore cancelling pending restore", { cause });
    pendingRestore.controller.abort();
    pendingRestore = undefined;
  };

  const setInternalThinkingLevel = (level: ThinkingLevel): boolean => {
    const model = activeModelKey;
    const entry = { model, level: level as SavedThinkingLevel };
    suppressedEvents.push(entry);
    try {
      pi.setThinkingLevel(level);
      log.debug("thinking preference internal level requested", { model, level });
      return true;
    } catch (err) {
      const idx = suppressedEvents.indexOf(entry);
      if (idx >= 0) suppressedEvents.splice(idx, 1);
      log.warn("thinking preference setThinkingLevel failed", {
        model,
        level,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  const applyPreference = (model: RuntimeModel | undefined, reason: string): boolean => {
    const key = modelThinkingKey(model);
    if (!model || model.reasoning !== true || !key) {
      log.debug("thinking preference model restore skipped", {
        model: key,
        reason,
        reasoning: model?.reasoning === true,
      });
      return false;
    }
    const requested = preferredThinkingLevel(model, readThinkingLevelState(opts.thinkingStatePath));
    if (!requested) return false;
    const effective = clampSavedThinkingLevel(model, requested);
    if (activeTransientOverrides > 0) {
      // Do not stomp an active per-turn magic-keyword override; hand off the
      // restored preference so the keyword handler restores to it on turn end.
      try {
        pi.events?.emit?.("providers:deferred-thinking-restore", {
          model: key,
          level: effective,
          reason,
        });
      } catch {
        // Event bus is optional in minimal harnesses.
      }
      log.info("thinking preference restore deferred during transient override", {
        model: key,
        requested,
        effective,
        reason,
      });
      return true;
    }
    if (pi.getThinkingLevel() === effective) return false;
    if (!setInternalThinkingLevel(effective as ThinkingLevel)) return false;
    log.info("thinking preference restored", { model: key, requested, effective, reason });
    return true;
  };

  const runSessionRestore = async (
    run: PendingRestore,
    reason: string,
    ctx: any,
  ): Promise<boolean> => {
    const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : undefined;
    const projectTrusted = readProjectTrusted(ctx, cwd, reason);

    try {
      const restored = await restoreDefaultModelOnSessionStart({
        ctx: {
          model: modelRef(ctx?.model),
          modelRegistry: ctx?.modelRegistry,
        },
        reason,
        cwd,
        projectTrusted,
        argv: opts.argv,
        signal: run.controller.signal,
        getCurrentModel: () => {
          if (!isLiveExtensionCtx(ctx)) {
            run.controller.abort();
            return undefined;
          }
          return modelRef(ctx?.model);
        },
        setModel: async (model) => {
          if (
            pendingRestore !== run
            || run.controller.signal.aborted
            || !isLiveExtensionCtx(ctx)
          ) {
            return false;
          }
          const key = modelThinkingKey(model);
          run.settingModelKey = key;
          try {
            const ok = await pi.setModel(model as Model<any>);
            log.debug("session-restore default model set completed", { model: key, restored: ok });
            return ok;
          } finally {
            if (run.settingModelKey === key) run.settingModelKey = undefined;
          }
        },
      }).catch((err) => {
        log.warn("restore-default-model session_start error", {
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      });

      if (
        pendingRestore !== run
        || run.controller.signal.aborted
        || !isLiveExtensionCtx(ctx)
        || run.supersededByUser
        || (run.sawRestoreModelSelect && !restored)
      ) {
        log.debug("session-restore thinking restore skipped after model restore", {
          reason,
          aborted: run.controller.signal.aborted,
          supersededByUser: run.supersededByUser,
          sawRestoreModelSelect: run.sawRestoreModelSelect,
          restored,
        });
        return false;
      }

      const currentModel = ctx?.model as RuntimeModel | undefined;
      activeModelKey = modelThinkingKey(currentModel);

      if (!shouldRestoreLastThinkingLevel({
        reason,
        ctx: ctx as ThinkingRestoreContext,
        argv: opts.argv,
      })) {
        log.debug("thinking preference startup restore skipped", {
          reason,
          model: activeModelKey,
        });
        return false;
      }
      return applyPreference(currentModel, `session_${reason || "unknown"}`);
    } catch (err) {
      log.warn("session-restore session_start error", {
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      if (pendingRestore === run) {
        pendingRestore = undefined;
      }
    }
  };

  log.debug("session-restore: registering lifecycle handlers");

  // Allow transient per-turn thinking overrides (e.g. magic keywords) to suppress
  // writing their temporary level to last-thinking-level.json (#1418).
  pi.events?.on?.("providers:suppress-thinking-save", (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as { model?: unknown; level?: unknown };
    if (!isThinkingLevel(p.level)) return;
    const model = typeof p.model === "string" ? p.model : activeModelKey;
    suppressedEvents.push({ model, level: p.level });
    // Bound queue against unbalanced external suppressions.
    if (suppressedEvents.length > 32) {
      suppressedEvents.splice(0, suppressedEvents.length - 32);
    }
    log.debug("thinking preference external suppression queued", { model, level: p.level });
  });

  // Cancel a previously queued suppression when a transient setThinkingLevel call fails.
  pi.events?.on?.("providers:unsuppress-thinking-save", (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as { model?: unknown; level?: unknown };
    if (!isThinkingLevel(p.level)) return;
    const model = typeof p.model === "string" ? p.model : activeModelKey;
    const idx = suppressedEvents.findIndex((item) => item.model === model && item.level === p.level);
    if (idx >= 0) {
      suppressedEvents.splice(idx, 1);
      log.debug("thinking preference external suppression cancelled", { model, level: p.level });
    }
  });

  // Track active transient overrides so delayed startup restore does not cancel them.
  pi.events?.on?.("providers:transient-thinking-start", () => {
    activeTransientOverrides += 1;
    log.debug("thinking preference transient override started", { count: activeTransientOverrides });
  });

  pi.events?.on?.("providers:transient-thinking-end", () => {
    activeTransientOverrides = Math.max(0, activeTransientOverrides - 1);
    log.debug("thinking preference transient override ended", { count: activeTransientOverrides });
  });

  pi.on("session_start", (event, ctx) => {
    const reason = typeof event?.reason === "string" ? event.reason.trim() : "";
    cancelPendingRestore("session_start");
    suppressedEvents.length = 0;
    activeTransientOverrides = 0;

    activeModelKey = modelThinkingKey(ctx?.model);
    preserveCliLevel = hasExplicitThinkingArg(opts.argv ?? process.argv);

    log.debug("session-restore session_start", {
      reason,
      model: activeModelKey,
      preserveCliLevel,
    });

    const run: PendingRestore = {
      controller: new AbortController(),
      sawRestoreModelSelect: false,
      supersededByUser: false,
      done: Promise.resolve(false),
    };
    pendingRestore = run;
    // Fire-and-forget so session_start is never blocked by retries (#753).
    run.done = runSessionRestore(run, reason, ctx);
    lastRestoreDone = run.done;
    void run.done;
  });

  pi.on("model_select", (event, ctx) => {
    const selectedKey = modelThinkingKey(event.model);
    const currentKey = modelThinkingKey(ctx.model);
    if (selectedKey !== currentKey) {
      log.debug("thinking preference ignored stale model event", {
        selectedModel: selectedKey,
        currentModel: currentKey,
        source: event.source,
      });
      return;
    }

    activeModelKey = selectedKey;
    const isFromDefaultRestore = pendingRestore !== undefined
      && pendingRestore.settingModelKey !== undefined
      && event.source === "set"
      && selectedKey === pendingRestore.settingModelKey;

    if (isFromDefaultRestore) {
      pendingRestore!.sawRestoreModelSelect = true;
      log.debug("session-restore model_select matched in-flight default restore", {
        model: selectedKey,
        source: event.source,
      });
      return;
    }

    if (pendingRestore) {
      pendingRestore.supersededByUser = true;
    }

    if (event.source === "restore" || preserveCliLevel) {
      log.debug("thinking preference model event preserved session level", {
        model: selectedKey,
        source: event.source,
      });
      return;
    }

    applyPreference(event.model as RuntimeModel, `model_${event.source}`);
  });

  pi.on("thinking_level_select", (event, ctx) => {
    const currentModelKey = modelThinkingKey(ctx.model);
    const suppressedIndex = suppressedEvents.findIndex(
      (item) => item.model === currentModelKey && item.level === event.level,
    );
    if (suppressedIndex >= 0) {
      suppressedEvents.splice(suppressedIndex, 1);
      log.debug("thinking preference ignored internal change", {
        model: currentModelKey,
        level: event.level,
      });
      return;
    }
    if (currentModelKey !== activeModelKey) {
      log.debug("thinking preference ignored automatic change", {
        activeModel: activeModelKey,
        currentModel: currentModelKey,
        level: event.level,
      });
      return;
    }
    if (!isThinkingLevel(event.level) || !currentModelKey) {
      log.warn("thinking preference ignored invalid explicit change", {
        model: currentModelKey,
        level: event.level,
      });
      return;
    }
    if (pendingRestore) {
      pendingRestore.supersededByUser = true;
    }
    const saved = saveModelThinkingLevel(
      currentModelKey,
      event.level,
      opts.thinkingStatePath,
    );
    log.info("thinking preference explicit change handled", {
      model: currentModelKey,
      level: event.level,
      saved,
    });
  });

  pi.on("session_shutdown", () => {
    cancelPendingRestore("session_shutdown");
    suppressedEvents.length = 0;
    activeTransientOverrides = 0;
    log.debug("session-restore shutdown cleanup completed");
  });

  return {
    waitForPendingRestore: () => lastRestoreDone,
  };
}
