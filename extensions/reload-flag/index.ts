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
 *   1. Requester (deploy script or agent) writes `<cwd>/.pi/run/reload.flag`
 *      with a nonce as its content.
 *   2. Watcher (interval + turn_end fallback) sees the flag and dispatches
 *      `/reload-flag` ONCE. The command moves the nonce to `reload.pending`,
 *      deletes the flag, and calls `ctx.reload()` — the last ctx call.
 *   3. The NEW runtime fires `session_start` with reason "reload": it reads
 *      `reload.pending`, writes the nonce to `reload.done`, deletes pending.
 *   4. The requester polls `reload.done` for its nonce — match means the new
 *      runtime is live and subsequent tool calls run on the new code.
 *
 * Ownership (#1091 — the flag is per-cwd, the process that wrote it is not):
 *
 *   - Only a process that REGISTERS the watcher may touch the handshake. A
 *     `pi -p` / `--mode json` / piped-print child can neither observe nor
 *     satisfy a request, and used to delete a deploy's flag on its
 *     `session_start` — the deploy then reported a stale `reload.done`.
 *   - `reload.pending` belongs to the session that parked it
 *     (`pendingOwnerIsClaimable`): a live OTHER owner's handshake is never
 *     consumed, dispatched for, or cleaned up.
 *   - `session_start` with any other reason (startup, new, resume, fork) only
 *     clears state that is genuinely stale — older than STALE_HANDSHAKE_MS.
 *     A fresh session already runs the latest code, so an abandoned request is
 *     satisfied, not repeated.
 *   - `reload.done` always carries the nonce of the code actually loaded. A
 *     flag that appears while a reload is in flight is a NEWER request and is
 *     left for the watcher, so the sequence converges on the newest nonce. A
 *     manual `/reload` satisfies a sitting flag: its nonce is published.
 *
 * LOCATION (#1020): the handshake lives in `.pi/run/`, not `.pi/tmp/` — `.pi/tmp`
 * is throwaway by definition and must stay safe to wipe. Reads check the new
 * dir first and fall back to the legacy `.pi/tmp` copy (a deploy script or
 * session from the previous release still writes there); writes use `.pi/run`
 * only, so legacy files are never recreated.
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
import { isPiOneshotInvocation, shouldSkipOneshotRegister } from "../shared/oneshot.js";
import { isLiveExtensionCtx } from "../shared/live-ctx.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const log = createLogger("reload-flag");

export const RELOAD_COMMAND = "/reload-flag";
export const RELOAD_FLAG_FILENAME = "reload.flag";
export const RELOAD_PENDING_FILENAME = "reload.pending";
export const RELOAD_DONE_FILENAME = "reload.done";

/** How long idle handshake state may sit before a fresh INTERACTIVE session
 *  treats it as abandoned (#1091). A deploy writes the flag and reloads within
 *  seconds, so an older file belongs to a request nobody is waiting for — and
 *  a younger one may be a request addressed to another live session. */
export const STALE_HANDSHAKE_MS = 5 * 60_000;

/** Runtime-state dir for the reload handshake (#1020). */
export function reloadRunDir(cwd: string): string {
  return path.join(cwd, ".pi", "run");
}

/** Pre-#1020 location of the same files — read-only fallback, never written. */
export function reloadLegacyDir(cwd: string): string {
  return path.join(cwd, ".pi", "tmp");
}

function controlFile(cwd: string, name: string): string {
  return path.join(reloadRunDir(cwd), name);
}

/**
 * MIGRATION LIMITATION (one-time, #1020/#1021): `.pi/run` owns the handshake;
 * `.pi/tmp` is throwaway. A session started BEFORE this migration polls only
 * the legacy `.pi/tmp/reload.flag`, and extension code is swapped only by
 * `ctx.reload()` — so a deploy run while such a session is live is never seen
 * by it. The migration release therefore needs exactly ONE manual `/reload`;
 * every later deploy is unaffected. The reverse direction is already handled:
 * legacy flags are read by `findControlFile` and `reload.done` is mirrored back
 * to the legacy path by `writeLegacyControlFile`.
 */

/** Flag paths for a session cwd (public for tests). */
export function reloadFlagPath(cwd: string): string {
  return controlFile(cwd, RELOAD_FLAG_FILENAME);
}
export function reloadPendingPath(cwd: string): string {
  return controlFile(cwd, RELOAD_PENDING_FILENAME);
}
export function reloadDonePath(cwd: string): string {
  return controlFile(cwd, RELOAD_DONE_FILENAME);
}

/** New dir first, then the legacy `.pi/tmp` copy written before the move. */
function findControlFile(cwd: string, name: string): string | null {
  for (const dir of [reloadRunDir(cwd), reloadLegacyDir(cwd)]) {
    const file = path.join(dir, name);
    if (existsSync(file)) return file;
  }
  return null;
}

function readControlNonce(cwd: string, name: string): string | null {
  const file = findControlFile(cwd, name);
  return file === null ? null : readNonce(file);
}

/** Remove the file from BOTH dirs — a legacy copy left behind would otherwise
 *  satisfy the next watcher tick with a stale nonce. */
function removeControlFile(cwd: string, name: string): void {
  for (const dir of [reloadRunDir(cwd), reloadLegacyDir(cwd)]) {
    rmSync(path.join(dir, name), { force: true });
  }
}

function writeControlFile(cwd: string, name: string, content: string): void {
  const dir = reloadRunDir(cwd);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Write + rename, never a bare truncate (#1091): every session in the cwd
  // polls these files, and a mid-write empty `reload.pending` is deleted by the
  // other watchers as garbage — which strands the handshake of the session that
  // was writing it.
  const tmp = path.join(dir, `${name}.${process.pid}.tmp`);
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path.join(dir, name));
}

/** Mirror a control file into the legacy dir for a requester that wrote its
 *  flag under `.pi/tmp` before the move and polls the completion marker there —
 *  without it that requester waits for its nonce forever (#1020). Best effort:
 *  never creates `.pi/tmp`. */
function writeLegacyControlFile(cwd: string, name: string, content: string): void {
  try { writeFileSync(path.join(reloadLegacyDir(cwd), name), content, "utf-8"); } catch {}
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

/** Older than STALE_HANDSHAKE_MS — safe for a fresh session to clear. */
export function isStaleHandshakeFile(file: string): boolean {
  try {
    return Date.now() - statSync(file).mtimeMs > STALE_HANDSHAKE_MS;
  } catch {
    return false;
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
  const raw = readControlNonce(cwd, RELOAD_PENDING_FILENAME);
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
 * Fresh-session cleanup, bounded twice (#1091): by ownership (another live
 * session's pending is not ours to delete) and by age (a just-written flag may
 * be a deploy in flight, not stale state). Anything younger than
 * STALE_HANDSHAKE_MS is left alone — a fresh session reloaded nothing, so it
 * has no business cancelling a request issued moments ago.
 */
function pruneStaleHandshake(cwd: string, owner: string, reason: string): void {
  const pending = readReloadPending(cwd);
  const foreignPending = pending !== null && !pendingOwnerIsClaimable(pending, owner);
  for (const name of [RELOAD_FLAG_FILENAME, RELOAD_PENDING_FILENAME, RELOAD_DONE_FILENAME]) {
    const file = findControlFile(cwd, name);
    if (file === null) continue;
    if (name === RELOAD_PENDING_FILENAME && foreignPending) {
      log.debug("reload_flag_pending_foreign_owner_kept", { owner: pending.owner, reason });
      continue;
    }
    if (!isStaleHandshakeFile(file)) continue;
    removeControlFile(cwd, name);
    log.debug("stale reload state removed at session start", { file: name, reason });
  }
}

/**
 * Move the flag's nonce to `reload.pending` (handshake state for the new
 * runtime), stamped with OUR owner id. Public for tests. Returns the nonce
 * or null when no flag exists.
 */
export function parkReloadNonce(cwd: string, owner: string): string | null {
  const flag = findControlFile(cwd, RELOAD_FLAG_FILENAME);
  if (flag === null) return null;
  const nonce = readNonce(flag);
  if (nonce === null) return null;
  removeControlFile(cwd, RELOAD_FLAG_FILENAME);
  writeControlFile(cwd, RELOAD_PENDING_FILENAME, JSON.stringify({ nonce, owner }));
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

/** May this process touch the handshake at all (#1091)? A print/json session
 *  (`pi -p`, `--mode json`, piped stdout) never registers the watcher, so it
 *  can neither observe nor satisfy a request — and must never delete one: the
 *  flag is per-cwd, so a child starting mid-deploy used to wipe a request
 *  addressed to the operator's TUI session. */
export function isHandshakeParticipant(mode?: string | null, argv: string[] = process.argv): boolean {
  if (mode === "print" || mode === "json") return false;
  return !isPiOneshotInvocation(argv);
}

/** A headless `--mode rpc` session (a spawned coms peer) must NOT take part in the deploy
 *  handshake: the flag is per-cwd, so a peer sitting in the same checkout consumed the deploy's
 *  nonce before the operator's TUI session could — and a peer has no banner to show, so the reload
 *  went silent for the human. Peers are restarted by their supervisor, not by /reload. */
export function shouldSkipReloadFlag(argv: string[] = process.argv): boolean {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--mode" && argv[i + 1] === "rpc") return true;
    if (arg === "--mode=rpc") return true;
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  if (shouldSkipOneshotRegister(log)) {
    log.debug("skipping reload-flag registration (oneshot invocation)");
    return;
  }
  if (shouldSkipReloadFlag()) {
    // Never steal a deploy's nonce: a peer in the same cwd would consume it invisibly.
    log.debug("skipping reload-flag registration (headless rpc session)");
    return;
  }

  // The command does the actual reload — the command ctx is the only ctx
  // with reload() (pi 1.3: event contexts carry no actions).
  pi.registerCommand("reload-flag", {
    description: "Internal — deploy-flow bridge: reload extensions when .pi/run/reload.flag is set (the agent dispatches this; you can type /reload anytime)",
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
    const flagPath = findControlFile(liveCwd, RELOAD_FLAG_FILENAME);
    const pendingPath = findControlFile(liveCwd, RELOAD_PENDING_FILENAME);
    const hasFlag = flagPath !== null;
    const hasPending = pendingPath !== null;
    if (!hasFlag && !hasPending) return;
    // Mid-write race (Qodo PR #950 R7): the requester may not have written
    // the nonce yet when the flag file first appears. Dispatching now would
    // reload with NO nonce — the requester could never verify completion.
    // Skip this tick WITHOUT latching; the next tick sees the finished write.
    if (flagPath !== null && readNonce(flagPath) === null) {
      log.debug("reload_flag_mid_write_race", { flag: flagPath });
      return;
    }
    // Empty/garbage pending (Qodo PR #950 R8): a pending file with no nonce
    // is NOT a stranded handshake — it is leftover garbage (truncated write,
    // disk issue). Treating it as one would dispatch a reload whose new
    // runtime ALSO cannot consume it — an infinite reload loop. Remove it
    // and wait for a real request.
    if (hasPending && pendingPath !== null && readNonce(pendingPath) === null) {
      try {
        removeControlFile(liveCwd, RELOAD_PENDING_FILENAME);
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
    // alone (Qodo PR #950 R9 + #1091): session A parked it and is waiting for
    // idle; if we (session B, same cwd) dispatched now — even for a fresh
    // flag — OUR reload would consume A's nonce, publish done, and steal A's
    // continuation turn. A will reload and then dispatch the flag itself.
    if (hasPending) {
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
    // #1091: a child/oneshot process that never registers the watcher must not
    // delete flag/pending/done — it cannot satisfy the request, and the flag is
    // per-cwd, so the request belongs to somebody else. Return BEFORE any file
    // mutation, and start no watcher either (nothing here can act on it).
    if (!isHandshakeParticipant(ctx.mode)) {
      log.debug("reload-flag: not a handshake participant (print/json) — handshake left untouched", { reason });
      return;
    }
    liveCwd = cwd;
    liveOwner = reloadOwnerId(ctx);
    triggered = false;

    if (reason === "reload") {
      // We are the NEW runtime: finish the handshake by publishing the nonce.
      const pendingPath = findControlFile(cwd, RELOAD_PENDING_FILENAME);
      const pendingRecord = readReloadPending(cwd);
      // Owner check (Qodo PR #950 R9): a pending handshake parked by ANOTHER
      // LIVE session must survive our manual /reload untouched — consuming
      // it here would steal their nonce, publish their done marker, and send
      // THEIR continuation turn to us. Only claim it when it is ours or its
      // owner process is gone.
      if (pendingRecord && !pendingOwnerIsClaimable(pendingRecord, reloadOwnerId(ctx))) {
        log.info("reload_flag_pending_left_for_owner", { owner: pendingRecord.owner });
      } else if (pendingRecord) {
        // The nonce WE loaded. Any flag present now was written while this
        // reload was in flight — a NEWER request (#1091) — so it is left for
        // the watcher: the second reload publishes ITS nonce, and the
        // sequence converges on the newest one instead of reporting ours.
        const nonce = pendingRecord.nonce;
        removeControlFile(cwd, RELOAD_PENDING_FILENAME);
        writeControlFile(cwd, RELOAD_DONE_FILENAME, nonce);
        writeLegacyControlFile(cwd, RELOAD_DONE_FILENAME, nonce);
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
                  `continue your pending work with the new code. (Verify via .pi/run/reload.done if needed.)`,
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
        if (pendingPath !== null) {
          try {
            removeControlFile(cwd, RELOAD_PENDING_FILENAME);
            log.warn("reload_flag_stale_pending_removed", {
              file: pendingPath,
              reason: "pending file existed with no readable nonce at reload session_start",
            });
          } catch (e: unknown) {
            log.warn("reload_flag_stale_pending_remove_failed", { error: String(e) });
          }
        }
        // Manual /reload: it satisfies a sitting flag — the code just loaded
        // IS the code the flag requested — so publish THAT nonce as done (the
        // requester can then verify) and drop the flag so no second reload
        // fires. A flag triggered reload never reaches here: it parked a
        // pending nonce, and its flag is a newer request (#1091).
        const flagPath = findControlFile(cwd, RELOAD_FLAG_FILENAME);
        const sittingNonce = flagPath === null ? null : readNonce(flagPath);
        if (sittingNonce !== null) {
          // Drop the satisfied flag: the next turn must not reload again.
          removeControlFile(cwd, RELOAD_FLAG_FILENAME);
          writeControlFile(cwd, RELOAD_DONE_FILENAME, sittingNonce);
          writeLegacyControlFile(cwd, RELOAD_DONE_FILENAME, sittingNonce);
          log.info("reload_done", { nonce: sittingNonce, manual: true });
        } else {
          // No nonce yet (a flag mid-write): leave it — the watcher sees the
          // finished write and dispatches the next reload.
          log.debug("reload session_start without pending nonce (manual /reload)");
        }
      }
    } else {
      // Fresh session: latest code is already loaded — clear state that is
      // genuinely stale, bounded by ownership and age (#1091). A flag written
      // seconds ago may be a deploy in flight for another session in this
      // checkout; deleting it destroys the handshake the deploy polls.
      pruneStaleHandshake(cwd, reloadOwnerId(ctx), reason);
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
    // #1091: same rule as session_start — a print/json child must not act on
    // the handshake either (it would consume a request addressed to another
    // session and never publish a done marker the requester can trust).
    if (!isHandshakeParticipant(ctx.mode)) return;
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
