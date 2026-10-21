/**
 * Reload flag — agent-triggered extension reload with completion signaling.
 *
 * The agent cannot swap its own runtime mid-turn, and asking the user for a
 * manual `/reload` after every deploy is friction. This extension watches a
 * flag file and reloads the extension runtime — the same public API the
 * built-in `/reload` command uses. Nothing in pi is patched or overridden.
 *
 * Routing (pi 1.3 constraint): event-handler contexts carry NO actions —
 * only the EXTENSION COMMAND context has `ctx.reload()`. So the watcher never
 * reloads directly; it dispatches our registered `/reload-flag` command via
 * `pi.sendUserMessage("/reload-flag", { expandPromptTemplates: true })`
 * (commands execute immediately, even while streaming, and never reach the
 * LLM). The command handler consumes the flag and calls `ctx.reload()`.
 *
 * Protocol (nonce-carrying, so a poller can verify completion):
 *
 *   1. Requester (deploy script or agent) writes `<cwd>/.pi/tmp/reload.flag`
 *      with a nonce as its content.
 *   2. Watcher (interval + turn_end fallback) sees the flag and dispatches
 *      `/reload-flag` ONCE. The command moves the nonce to `reload.pending`,
 *      deletes the flag, and calls `ctx.reload()` — the last ctx call.
 *   3. The NEW runtime fires `session_start` with reason "reload": it reads
 *      `reload.pending`, writes the nonce to `reload.done`, deletes pending.
 *   4. The requester polls `reload.done` for its nonce — match means the new
 *      runtime is live and subsequent tool calls run on the new code.
 *
 * Stale-state rules: `session_start` with any other reason (startup, new,
 * resume, fork) deletes flag/pending/done — a fresh session already runs the
 * latest code, so an unconsumed request is satisfied, not repeated. A manual
 * `/reload` satisfies a sitting flag too.
 *
 * CRASH SAFETY (learned the hard way): a timer callback must never let an
 * exception escape — an unhandled rejection kills the whole pi process.
 * Every path is guarded and caught; a failed reload logs and never retries
 * automatically (the deploy can be re-run).
 *
 * Skipped in oneshot invocations (`pi -p` / `--mode json`), same as
 * pitasks/pidiff/pidash/coms. Timers follow the live-ctx guard rule: the
 * interval never reads a captured ctx without `isLiveExtensionCtx` and is
 * cleared on `session_shutdown`.
 */

import { createLogger } from "../shared/logger.js";
import { shouldSkipOneshotRegister } from "../shared/oneshot.js";
import { isLiveExtensionCtx } from "../shared/live-ctx.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const log = createLogger("reload-flag");

export const RELOAD_COMMAND = "/reload-flag";
export const RELOAD_FLAG_FILENAME = "reload.flag";
export const RELOAD_PENDING_FILENAME = "reload.pending";
export const RELOAD_DONE_FILENAME = "reload.done";

/** Flag paths for a session cwd (public for tests). */
export function reloadFlagPath(cwd: string): string {
  return path.join(cwd, ".pi", "tmp", RELOAD_FLAG_FILENAME);
}
export function reloadPendingPath(cwd: string): string {
  return path.join(cwd, ".pi", "tmp", RELOAD_PENDING_FILENAME);
}
export function reloadDonePath(cwd: string): string {
  return path.join(cwd, ".pi", "tmp", RELOAD_DONE_FILENAME);
}

function readNonce(file: string): string | null {
  try {
    return readFileSync(file, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Move the flag's nonce to `reload.pending` (handshake state for the new
 * runtime). Public for tests. Returns the nonce or null when no flag exists.
 */
export function parkReloadNonce(cwd: string): string | null {
  const flag = reloadFlagPath(cwd);
  const nonce = readNonce(flag);
  if (nonce === null) return null;
  rmSync(flag, { force: true });
  writeFileSync(reloadPendingPath(cwd), nonce, "utf-8");
  log.info("reload_flag_consumed", { hasNonce: true });
  return nonce;
}

/** The `/reload-flag` command body — runs with the COMMAND ctx (has reload()). */
export async function runReloadFlagCommand(
  ctx: { cwd: string; reload?: () => Promise<void>; waitForIdle?: () => Promise<void> },
): Promise<void> {
  try {
    parkReloadNonce(ctx.cwd);
    if (typeof ctx.reload !== "function") {
      // Should be impossible (command ctx always carries actions) — but a
      // missing action must degrade to a log line, never a crash.
      log.error("reload_flag_no_reload_action", {
        hint: "command context lacks reload(); dispatch path changed?",
      });
      return;
    }
    // pi's reload action refuses while the session is streaming ("Wait for
    // the current response to finish") — and deploys typically happen
    // MID-TURN, so the dispatch arrives while the agent is streaming. Wait
    // for idle first: the reload fires the moment the turn ends.
    if (typeof ctx.waitForIdle === "function") {
      await ctx.waitForIdle();
    }
    // LAST ctx calls: ctx.reload() tears this runtime down (session_shutdown
    // reason "reload") and rebuilds it from disk. Never use the old ctx after.
    await ctx.reload();
  } catch (e: unknown) {
    log.error("reload_flag_command_failed", { error: String(e) });
  }
}

export default function (pi: ExtensionAPI) {
  if (shouldSkipOneshotRegister(log)) {
    log.debug("skipping reload-flag registration (oneshot invocation)");
    return;
  }

  // The command does the actual reload — the command ctx is the only ctx
  // with reload() (pi 1.3: event contexts carry no actions).
  pi.registerCommand("reload-flag", {
    description: "Internal — deploy-flow bridge: reload extensions when .pi/tmp/reload.flag is set (the agent dispatches this; you can type /reload anytime)",
    handler: async (_args: string, ctx: any) => {
      await runReloadFlagCommand(ctx);
    },
  });

  let liveCwd: string | null = null;
  let watcher: ReturnType<typeof setInterval> | null = null;
  let triggered = false;

  const stopWatcher = () => {
    if (watcher) {
      clearInterval(watcher);
      watcher = null;
      log.debug("reload flag watcher stopped");
    }
  };

  const maybeTrigger = () => {
    // Never act twice, and never on a stale cwd snapshot.
    if (triggered || liveCwd === null) return;
    // A stranded handshake (pending exists but no new runtime published
    // done — e.g. a reload refused mid-turn in an older runtime) also
    // re-dispatches: the command is idempotent.
    const flagPath = reloadFlagPath(liveCwd);
    const hasFlag = existsSync(flagPath);
    const hasPending = existsSync(reloadPendingPath(liveCwd));
    if (!hasFlag && !hasPending) return;
    // Mid-write race (Qodo PR #950 R7): the requester may not have written
    // the nonce yet when the flag file first appears. Dispatching now would
    // reload with NO nonce — the requester could never verify completion.
    // Skip this tick WITHOUT latching; the next tick sees the finished write.
    if (hasFlag && readNonce(flagPath) === null) {
      log.debug("reload_flag_mid_write_race", { flag: flagPath });
      return;
    }
    triggered = true;
    stopWatcher();
    try {
      // Dispatches the registered command: executes immediately (even while
      // streaming), never reaches the LLM. deliverAs satisfies the repo-wide
      // disposition contract and degrades safely (queued, not thrown) if the
      // dispatch ever fails. Throws are caught, never escape into a timer.
      pi.sendUserMessage(RELOAD_COMMAND, {
        expandPromptTemplates: true,
        deliverAs: "followUp",
      });
      log.info("reload_flag_dispatched", { command: RELOAD_COMMAND });
    } catch (e: unknown) {
      triggered = false; // allow a later turn_end to retry the dispatch
      log.error("reload_flag_dispatch_failed", { error: String(e) });
    }
  };

  pi.on("session_start", async (event: any, ctx: any) => {
    const reason: string = event?.reason ?? "startup";
    if (!isLiveExtensionCtx(ctx)) return;
    const cwd: string = ctx.cwd;
    liveCwd = cwd;
    triggered = false;

    if (reason === "reload") {
      // We are the NEW runtime: finish the handshake by publishing the nonce.
      // A manual /reload also satisfies a sitting flag — remove it so the
      // next turn does not trigger a second reload.
      if (existsSync(reloadFlagPath(cwd))) rmSync(reloadFlagPath(cwd), { force: true });
      const pending = reloadPendingPath(cwd);
      const nonce = readNonce(pending);
      if (nonce !== null) {
        rmSync(pending, { force: true });
        writeFileSync(reloadDonePath(cwd), nonce, "utf-8");
        log.info("reload_done", { nonce });
        // Seamless continuation (user request): the deploy that requested
        // this reload was mid-task — wake the agent with the new code so it
        // can keep working with NO human in the loop. Manual /reload (no
        // pending nonce) never sends this. Deferred briefly so the rebuilt
        // session is fully idle before the turn is triggered.
        const fire = () => {
          try {
            pi.sendMessage(
              {
                customType: "reload-flag-done",
                content:
                  `Extension runtime reloaded (deploy nonce ${nonce}). The deploy that requested this reload is complete — ` +
                  `continue your pending work with the new code. (Verify via .pi/tmp/reload.done if needed.)`,
                display: `[reload-flag] extensions reloaded — agent continuing`,
                details: { nonce },
              },
              { triggerTurn: true },
            );
            log.info("reload_continuation_sent", { nonce });
          } catch (e: unknown) {
            log.error("reload_continuation_failed", { error: String(e) });
          }
        };
        const t = setTimeout(fire, 250);
        (t as unknown as { unref: () => void }).unref();
      } else {
        log.debug("reload session_start without pending nonce (manual /reload)");
      }
    } else {
      // Fresh session: latest code is already loaded — clear stale state.
      for (const f of [reloadFlagPath(cwd), reloadPendingPath(cwd), reloadDonePath(cwd)]) {
        if (existsSync(f)) {
          rmSync(f, { force: true });
          log.debug("stale reload state removed at session start", { file: path.basename(f), reason });
        }
      }
    }

    if (!watcher) {
      watcher = setInterval(() => {
        try {
          maybeTrigger();
        } catch (e: unknown) {
          // A timer callback must NEVER let an exception escape — an unhandled
          // rejection kills the pi process (crash postmortem, PR #950).
          log.error("reload_flag_watcher_error", { error: String(e) });
        }
      }, 500);
      // Do not hold the process open just for the watcher.
      (watcher as unknown as { unref: () => void }).unref();
    }
  });

  // Fallback for watchers that miss the file (also fires between turns).
  pi.on("turn_end", async (_event: any, ctx: any) => {
    if (!isLiveExtensionCtx(ctx)) return;
    liveCwd = ctx.cwd;
    try {
      maybeTrigger();
    } catch (e: unknown) {
      log.error("reload_flag_turn_end_error", { error: String(e) });
    }
  });

  pi.on("session_shutdown", () => {
    stopWatcher();
    liveCwd = null;
  });
}
