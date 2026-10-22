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

/** Who owns a reload handshake: the process AND the session that parked it.
 * pid alone is not enough — `switchSession` keeps the pid but changes the
 * session, and two sessions sharing one process (and one project cwd)
 * must not steal each other's reload continuation (Qodo PR #950 R9). */
export function reloadOwnerId(ctx?: { sessionManager?: { getSessionId?: () => string } }): string {
  const sessionId = ctx?.sessionManager?.getSessionId?.() ?? process.env.__PI_CONFIG_SESSION_ID ?? "nosession";
  return `${process.pid}:${sessionId}`;
}

/** Is a pid still running? `process.kill(pid, 0)` throws ESRCH for a dead
 * process and EPERM for a live process we may not signal — either way,
 * "throws" means alive-or-unknown, which we treat as alive (fail safe:
 * never steal from a possibly-live owner). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as { code?: string }).code === "EPERM";
  }
}

/** A parked handshake: the nonce plus the owner that parked it. */
export interface ReloadPending {
  nonce: string;
  owner: string;
}

/** Read and parse `reload.pending`. Returns null when absent, empty, or
 * unparseable (garbage pending is handled by the callers' removal paths). */
export function readReloadPending(cwd: string): ReloadPending | null {
  const raw = readNonce(reloadPendingPath(cwd));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { nonce?: unknown; owner?: unknown };
    if (typeof parsed.nonce === "string" && parsed.nonce && typeof parsed.owner === "string" && parsed.owner) {
      return { nonce: parsed.nonce, owner: parsed.owner };
    }
  } catch {
    // fall through — plain-nonce or garbage content
  }
  // Plain nonce without owner info (legacy/hand-written): the nonce is
  // real, but ownership is unknown — represent it with an empty owner so
  // callers can decide policy explicitly.
  return { nonce: raw, owner: "" };
}

/** Does a pending handshake belong to US (same process + session), or is
 * its owner gone (crashed pi)? A live OTHER owner means: hands off. */
export function pendingOwnerIsClaimable(pending: ReloadPending, self: string): boolean {
  if (pending.owner === "" || pending.owner === self) return true;
  const pidStr = pending.owner.split(":")[0];
  const pid = Number(pidStr);
  if (!Number.isInteger(pid) || pid <= 0) return true; // unparseable owner — treat as ours
  return !isPidAlive(pid);
}

/**
 * Move the flag's nonce to `reload.pending` (handshake state for the new
 * runtime), stamped with OUR owner id. Public for tests. Returns the nonce
 * or null when no flag exists.
 */
export function parkReloadNonce(cwd: string, owner: string): string | null {
  const flag = reloadFlagPath(cwd);
  const nonce = readNonce(flag);
  if (nonce === null) return null;
  rmSync(flag, { force: true });
  writeFileSync(reloadPendingPath(cwd), JSON.stringify({ nonce, owner }), "utf-8");
  log.info("reload_flag_consumed", { hasNonce: true });
  return nonce;
}

/** The `/reload-flag` command body — runs with the COMMAND ctx (has reload()). */
export async function runReloadFlagCommand(
  ctx: { cwd: string; reload?: () => Promise<void>; waitForIdle?: () => Promise<void>; sessionManager?: { getSessionId?: () => string } },
): Promise<void> {
  try {
    parkReloadNonce(ctx.cwd, reloadOwnerId(ctx));
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
  // Owner identity of THIS session (pid + session id), refreshed whenever a
  // ctx is at hand — maybeTrigger runs from a timer with no ctx (Qodo PR
  // #950 R9).
  let liveOwner: string | null = null;
  let watcher: ReturnType<typeof setInterval> | null = null;
  let triggered = false;
  // The deferred reload-continuation timer (Qodo PR #950 R8): retained so
  // session_shutdown can cancel it — if the session closes inside the 250ms
  // delay, the callback must never fire into a dead/replaced session.
  let continuationTimer: ReturnType<typeof setTimeout> | null = null;

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
    const pendingPath = reloadPendingPath(liveCwd);
    const hasPending = existsSync(pendingPath);
    if (!hasFlag && !hasPending) return;
    // Mid-write race (Qodo PR #950 R7): the requester may not have written
    // the nonce yet when the flag file first appears. Dispatching now would
    // reload with NO nonce — the requester could never verify completion.
    // Skip this tick WITHOUT latching; the next tick sees the finished write.
    if (hasFlag && readNonce(flagPath) === null) {
      log.debug("reload_flag_mid_write_race", { flag: flagPath });
      return;
    }
    // Empty/garbage pending (Qodo PR #950 R8): a pending file with no nonce
    // is NOT a stranded handshake — it is leftover garbage (truncated write,
    // disk issue). Treating it as one would dispatch a reload whose new
    // runtime ALSO cannot consume it — an infinite reload loop. Remove it
    // and wait for a real request.
    if (hasPending && readNonce(pendingPath) === null) {
      try {
        rmSync(pendingPath, { force: true });
        log.warn("reload_flag_stale_pending_removed", {
          file: pendingPath,
          reason: "pending file had no readable nonce — removed to avoid a reload loop",
        });
      } catch (e: unknown) {
        log.warn("reload_flag_stale_pending_remove_failed", { error: String(e) });
      }
      return;
    }
    // A pending handshake belonging to ANOTHER LIVE session must be left
    // alone (Qodo PR #950 R9): session A parked it and is waiting for idle;
    // if we (session B, same cwd) dispatched now, OUR reload would consume
    // A's nonce, publish done, and steal A's continuation turn. Only a
    // pending whose owner is us — or whose owner process is gone — is a
    // stranded handshake we may recover.
    if (!hasFlag && hasPending) {
      const pending = readReloadPending(liveCwd);
      if (pending && !pendingOwnerIsClaimable(pending, liveOwner ?? reloadOwnerId())) {
        log.debug("reload_flag_pending_foreign_owner", { owner: pending.owner });
        return;
      }
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
      // warn, not error: this failure is recoverable by design — the latch
      // was reset and turn_end retries (Qodo PR #950 R8).
      log.warn("reload_flag_dispatch_failed", { error: String(e) });
    }
  };

  pi.on("session_start", async (event: any, ctx: any) => {
    const reason: string = event?.reason ?? "startup";
    if (!isLiveExtensionCtx(ctx)) return;
    const cwd: string = ctx.cwd;
    liveCwd = cwd;
    liveOwner = reloadOwnerId(ctx);
    triggered = false;

    if (reason === "reload") {
      // We are the NEW runtime: finish the handshake by publishing the nonce.
      // A manual /reload also satisfies a sitting flag — remove it so the
      // next turn does not trigger a second reload.
      if (existsSync(reloadFlagPath(cwd))) rmSync(reloadFlagPath(cwd), { force: true });
      const pendingPath = reloadPendingPath(cwd);
      const pendingRecord = readReloadPending(cwd);
      // Owner check (Qodo PR #950 R9): a pending handshake parked by ANOTHER
      // LIVE session must survive our manual /reload untouched — consuming
      // it here would steal their nonce, publish their done marker, and send
      // THEIR continuation turn to us. Only claim it when it is ours or its
      // owner process is gone.
      if (pendingRecord && !pendingOwnerIsClaimable(pendingRecord, reloadOwnerId(ctx))) {
        log.info("reload_flag_pending_left_for_owner", { owner: pendingRecord.owner });
      } else if (pendingRecord) {
        const nonce = pendingRecord.nonce;
        rmSync(pendingPath, { force: true });
        writeFileSync(reloadDonePath(cwd), nonce, "utf-8");
        log.info("reload_done", { nonce });
        // Seamless continuation (user request): the deploy that requested
        // this reload was mid-task — wake the agent with the new code so it
        // can keep working with NO human in the loop. Manual /reload (no
        // pending nonce) never sends this. Deferred briefly so the rebuilt
        // session is fully idle before the turn is triggered.
        const fire = () => {
          continuationTimer = null;
          try {
            pi.sendMessage(
              {
                customType: "reload-flag-done",
                content:
                  `Extension runtime reloaded (deploy nonce ${nonce}). The deploy that requested this reload is complete — ` +
                  `continue your pending work with the new code. (Verify via .pi/tmp/reload.done if needed.)`,
                display: true,
                details: { nonce },
              },
              // followUp: never interrupt an in-flight turn (Qodo PR #950
              // R8) — the continuation queues behind active work instead of
              // barging into it.
              { triggerTurn: true, deliverAs: "followUp" },
            );
            log.info("reload_continuation_sent", { nonce });
          } catch (e: unknown) {
            log.error("reload_continuation_failed", { error: String(e) });
          }
        };
        continuationTimer = setTimeout(fire, 250);
        (continuationTimer as unknown as { unref: () => void }).unref();
      } else {
        // A pending file with no readable nonce is garbage (Qodo PR #950
        // R8): if it survived, remove it — otherwise every future runtime
        // sees "stranded pending" and re-dispatches a reload, forever.
        if (existsSync(pendingPath)) {
          try {
            rmSync(pendingPath, { force: true });
            log.warn("reload_flag_stale_pending_removed", {
              file: pendingPath,
              reason: "pending file existed with no readable nonce at reload session_start",
            });
          } catch (e: unknown) {
            log.warn("reload_flag_stale_pending_remove_failed", { error: String(e) });
          }
        }
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
    liveOwner = reloadOwnerId(ctx);
    try {
      maybeTrigger();
    } catch (e: unknown) {
      log.error("reload_flag_turn_end_error", { error: String(e) });
    }
  });

  pi.on("session_shutdown", () => {
    stopWatcher();
    liveOwner = null;
    // Cancel a pending reload continuation (Qodo PR #950 R8): firing into a
    // closed/replaced session would inject a turn nobody asked for.
    if (continuationTimer !== null) {
      clearTimeout(continuationTimer);
      continuationTimer = null;
      log.debug("reload continuation cancelled at session shutdown");
    }
    liveCwd = null;
  });
}
