/**
 * Opt-in percentage-based LLM auto-compaction trigger (issue #1486).
 *
 * Evaluates `ctx.getContextUsage()` on `agent_end` — after mechanical
 * `pre_compaction_elision` has already run on `turn_end` and the multi-tool turn
 * has settled — and triggers `ctx.compact()` when context usage reaches
 * `>= auto_compact_threshold_pct` (default `0` = disabled; valid `0` or `20..99`).
 *
 * Guards:
 * - Skips when disabled (`0`), in oneshot invocations (`pi -p` / `--mode json`),
 *   in subagent children (`PI_SUBAGENT_CHILD=1`), or when `ctx` is not live.
 * - Prevents overlapping compactions via a per-session `inFlight` flag.
 * - Prevents infinite compaction loops when compaction fails or fails to reduce
 *   usage below threshold: stays suppressed until usage drops below threshold or
 *   the session resets (`session_start`, external `session_compact`, `session_shutdown`).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger, type Logger } from "../shared/logger.js";
import { isLiveExtensionCtx } from "../shared/live-ctx.js";
import { isPiOneshotInvocation } from "../shared/oneshot.js";
import { getSetting } from "./project-settings.js";

const defaultLog = createLogger("orchestrator");

interface AutoCompactSessionState {
  inFlight: boolean;
  suppressed: boolean;
}

export interface RegisterAutoCompactOptions {
  log?: Logger;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve effective context usage percentage from `ctx.getContextUsage()`.
 * Prefers a positive finite `usage.percent`, falling back to
 * `(usage.tokens / contextWindow) * 100` when both are positive finite numbers.
 * Returns `0` for explicit zero usage and `null` when usage is unavailable.
 */
export function resolveAutoCompactUsagePercent(ctx: any): number | null {
  const usage = ctx?.getContextUsage?.();
  if (!usage || typeof usage !== "object") return null;

  if (typeof usage.percent === "number" && Number.isFinite(usage.percent) && usage.percent > 0) {
    return usage.percent;
  }

  const contextWindow =
    typeof usage.contextWindow === "number" && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
      ? usage.contextWindow
      : typeof ctx?.model?.contextWindow === "number" &&
          Number.isFinite(ctx.model.contextWindow) &&
          ctx.model.contextWindow > 0
        ? ctx.model.contextWindow
        : 0;

  if (typeof usage.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens > 0 && contextWindow > 0) {
    return (usage.tokens / contextWindow) * 100;
  }

  if (usage.percent === 0 || (usage.tokens === 0 && contextWindow > 0)) {
    return 0;
  }

  return null;
}

/** Register the opt-in percentage-based auto-compaction hook on `agent_end`. */
export function registerAutoCompact(
  pi: ExtensionAPI,
  options: RegisterAutoCompactOptions = {},
): void {
  const log = options.log ?? defaultLog;
  const sessions = new Map<string, AutoCompactSessionState>();

  const sessionKey = (ctx: any): string =>
    ctx?.sessionManager?.getSessionId?.() || "__default__";

  const getState = (key: string): AutoCompactSessionState => {
    let state = sessions.get(key);
    if (!state) {
      state = { inFlight: false, suppressed: false };
      sessions.set(key, state);
    }
    return state;
  };

  pi.on("session_start", (_event, ctx) => {
    const key = sessionKey(ctx);
    sessions.set(key, { inFlight: false, suppressed: false });
    log.debug("auto_compact_session_reset", { sessionKey: key });
  });

  pi.on("session_compact", (_event, ctx) => {
    const key = sessionKey(ctx);
    const state = sessions.get(key);
    if (state && !state.inFlight) {
      state.suppressed = false;
      log.debug("auto_compact_cleared_after_external_compact", { sessionKey: key });
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const key = sessionKey(ctx);
    sessions.delete(key);
    log.debug("auto_compact_session_shutdown", { sessionKey: key });
  });

  pi.on("agent_end", (_event, ctx) => {
    const env = options.env ?? process.env;
    if (env.PI_SUBAGENT_CHILD === "1") return;
    if (isPiOneshotInvocation(options.argv ?? process.argv)) return;
    if (!isLiveExtensionCtx(ctx)) return;
    if ((ctx as any).mode === "print" || (ctx as any).mode === "json") return;
    if (typeof ctx.compact !== "function" || typeof ctx.getContextUsage !== "function") return;

    const cwd = ctx.cwd || process.cwd();
    const thresholdPct = getSetting(cwd, "auto_compact_threshold_pct");
    const key = sessionKey(ctx);

    if (typeof thresholdPct !== "number" || !Number.isFinite(thresholdPct) || thresholdPct <= 0) {
      const existing = sessions.get(key);
      if (existing && !existing.inFlight) {
        existing.suppressed = false;
      }
      return;
    }

    const state = getState(key);
    if (state.inFlight) {
      log.debug("auto_compact_skipped_in_flight", { sessionKey: key, thresholdPct });
      return;
    }

    const usagePct = resolveAutoCompactUsagePercent(ctx);
    if (usagePct === null) return;

    if (usagePct < thresholdPct) {
      if (state.suppressed) {
        state.suppressed = false;
        log.debug("auto_compact_rearmed", {
          sessionKey: key,
          usagePct: Math.round(usagePct * 10) / 10,
          thresholdPct,
        });
      }
      return;
    }

    if (state.suppressed) {
      log.debug("auto_compact_suppressed", {
        sessionKey: key,
        usagePct: Math.round(usagePct * 10) / 10,
        thresholdPct,
      });
      return;
    }

    const roundedPct = Math.round(usagePct * 10) / 10;
    state.inFlight = true;
    state.suppressed = true;
    log.info("auto_compact_triggered", {
      sessionKey: key,
      usagePct: roundedPct,
      thresholdPct,
    });

    if (isLiveExtensionCtx(ctx) && ctx.hasUI) {
      ctx.ui?.notify?.(`Auto-compacting context (${roundedPct}% >= ${thresholdPct}%)…`, "info");
    }

    const handleFailure = (error: unknown): void => {
      if (sessions.get(key) !== state) return;
      state.inFlight = false;
      const message = error instanceof Error ? error.message : String(error);
      log.warn("auto_compact_failed", { sessionKey: key, thresholdPct, error: message });
      if (isLiveExtensionCtx(ctx) && ctx.hasUI) {
        ctx.ui?.notify?.(`Auto-compaction failed: ${message}`, "error");
      }
    };

    try {
      ctx.compact({
        onComplete: () => {
          if (sessions.get(key) !== state) return;
          state.inFlight = false;
          const postPct = resolveAutoCompactUsagePercent(ctx);
          if (postPct !== null && postPct < thresholdPct) {
            state.suppressed = false;
          }
          log.info("auto_compact_completed", {
            sessionKey: key,
            thresholdPct,
            postPct: postPct !== null ? Math.round(postPct * 10) / 10 : null,
            suppressed: state.suppressed,
          });
          if (isLiveExtensionCtx(ctx) && ctx.hasUI) {
            ctx.ui?.notify?.("Auto-compaction completed", "info");
          }
        },
        onError: handleFailure,
      });
    } catch (error) {
      handleFailure(error);
    }
  });
}
