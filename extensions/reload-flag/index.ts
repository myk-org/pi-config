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
 *     clears old completion markers. Unconfirmed requests survive regardless
 *     of age and retained claims are retried without overwriting publications.
 *   - `reload.done` always carries the nonce of the code actually loaded. A
 *     flag that appears while a reload is in flight is a NEWER request and is
 *     left for the watcher, so the sequence converges on the newest nonce. A
 *     manual `/reload` leaves an unproven flag for an extra reload. There is
 *     no public pre-load nonce boundary, so it cannot safely confirm one.
 *
 * LOCATION (#1020): the handshake lives in `.pi/run/`, not `.pi/tmp/` — `.pi/tmp`
 * is throwaway by definition and must stay safe to wipe. Reads check the new
 * dir first and fall back to the legacy `.pi/tmp` copy (a deploy script or
 * session from the previous release still writes there); writes use `.pi/run`
 * only, so legacy files are never recreated.
 *
 * CRASH SAFETY (learned the hard way): a timer callback must never let an
 * exception escape — an unhandled rejection kills the whole pi process.
 * Every timer path is guarded and caught. Failed commands release the dispatch
 * latch for owner-side retry; non-reload shutdown releases that owner's pending.
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
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const log = createLogger("reload-flag");

export const RELOAD_COMMAND = "/reload-flag";
export const RELOAD_FLAG_FILENAME = "reload.flag";
export const RELOAD_PENDING_FILENAME = "reload.pending";
export const RELOAD_DONE_FILENAME = "reload.done";

/** Cleanup age for unowned idle state, never an expiry for live owners or
 *  requests waiting behind them. */
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

function writeControlFile(cwd: string, name: string, content: string): void {
  const dir = reloadRunDir(cwd);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Publish a complete record; never expose a truncated nonce to other readers.
  const tmp = path.join(dir, `${name}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, path.join(dir, name));
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Mirror a control file into the legacy dir for a requester that wrote its
 *  flag under `.pi/tmp` before the move and polls the completion marker there —
 *  without it that requester waits for its nonce forever (#1020). A missing
 *  legacy directory is allowed; other failures retain the request for retry. */
function writeLegacyControlFile(cwd: string, name: string, content: string): void {
  const tmp = path.join(reloadLegacyDir(cwd), `${name}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, path.join(reloadLegacyDir(cwd), name));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    log.debug("reload_flag_legacy_mirror_unavailable", { cwd, name, error: String(error) });
  } finally {
    rmSync(tmp, { force: true });
  }
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
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    const details = { file, code, error: String(error) };
    if (code === "ENOENT") log.debug("reload_flag_stat_disappeared", details);
    else log.warn("reload_flag_stat_failed", details);
    return false;
  }
}

/** A parked handshake: the nonce plus the owner that parked it. */
export interface ReloadPending {
  nonce: string;
  owner: string;
}

/** Read pending ownership, retaining plain-nonce compatibility. Null means
 * absent, empty or unreadable; callers must not discard an unreadable record. */
export function readReloadPending(cwd: string, file = findControlFile(cwd, RELOAD_PENDING_FILENAME)): ReloadPending | null {
  const raw = file === null ? null : readNonce(file);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { nonce?: unknown; owner?: unknown };
    if (typeof parsed.nonce === "string" && parsed.nonce && typeof parsed.owner === "string") {
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
  const foreignPending = [reloadRunDir(cwd), reloadLegacyDir(cwd)].some(dir => {
    const pending = readReloadPending(cwd, path.join(dir, RELOAD_PENDING_FILENAME));
    return pending !== null && !pendingOwnerIsClaimable(pending, owner);
  });
  for (const dir of [reloadRunDir(cwd), reloadLegacyDir(cwd)]) {
    for (const name of [RELOAD_FLAG_FILENAME, RELOAD_PENDING_FILENAME, RELOAD_DONE_FILENAME]) {
      const file = path.join(dir, name);
      // A queued request is not abandoned merely because its owner is busy.
      if (foreignPending && name !== RELOAD_DONE_FILENAME) {
        log.debug("reload_flag_foreign_handshake_kept", { file, owner, reason });
        continue;
      }
      // Age cannot prove a request was loaded, even after its owner exits.
      if (name !== RELOAD_DONE_FILENAME) continue;
      if (!isStaleHandshakeFile(file)) continue;
      const claimed = `${file}.${randomUUID()}.claim`;
      try {
        renameSync(file, claimed);
        if (!isStaleHandshakeFile(claimed)) {
          // Restore without overwriting a request published after the claim.
          linkSync(claimed, file);
          rmSync(claimed);
          log.debug("reload_flag_cleanup_replacement_kept", { file, owner, reason });
          continue;
        }
        rmSync(claimed);
        log.debug("stale reload state removed at session start", { file, reason });
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") log.debug("reload_flag_cleanup_disappeared", { file, reason, code });
        else log.warn("reload_flag_cleanup_claim_retained", { file, claimed, reason, code, error: String(error) });
      }
    }
  }
}

/** Deterministic retries for claims left by interruption or restore collision. */
function retainedRequests(cwd: string): string[] {
  return [reloadRunDir(cwd), reloadLegacyDir(cwd)].flatMap(dir => {
    try {
      return readdirSync(dir).sort().filter(name =>
        /^reload\.(flag|pending)\..+\.claim$/.test(name),
      ).map(name => path.join(dir, name));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("reload_flag_claim_scan_failed", { dir, error: String(error) });
      }
      return [];
    }
  });
}

function hasForeignPending(cwd: string, owner: string): boolean {
  const files = [reloadRunDir(cwd), reloadLegacyDir(cwd)].map(dir => path.join(dir, RELOAD_PENDING_FILENAME));
  files.push(...retainedRequests(cwd).filter(file => path.basename(file).startsWith("reload.pending.")));
  return files.some(file => {
    const record = readReloadPending(cwd, file);
    return record !== null && !file.endsWith(`.release-${encodeURIComponent(record.owner)}.claim`)
      && !pendingOwnerIsClaimable(record, owner);
  });
}

/** Park one request under our owner before loading code. Never replace pending. */
export function parkReloadNonce(cwd: string, owner: string): string | null {
  if (hasForeignPending(cwd, owner)) {
    log.debug("reload_flag_claim_foreign_owner", { cwd, owner });
    return null;
  }
  const flag = findControlFile(cwd, RELOAD_FLAG_FILENAME);
  // Retry retained claims first. Their path is stable; never restore over a
  // newer publication. A recovered pending record needs another proven reload.
  const candidates = retainedRequests(cwd);
  if (flag !== null && readNonce(flag) !== null) {
    const claimed = `${flag}.${randomUUID()}.claim`;
    renameSync(flag, claimed);
    candidates.push(claimed);
  }
  for (const claimed of candidates) {
    const record = path.basename(claimed).startsWith("reload.pending.")
      ? readReloadPending(cwd, claimed) : null;
    const released = record && claimed.endsWith(`.release-${encodeURIComponent(record.owner)}.claim`);
    if (record && !released && !pendingOwnerIsClaimable(record, owner)) continue;
    const nonce = record?.nonce ?? readNonce(claimed);
    if (nonce === null) {
      log.warn("reload_flag_claim_unreadable", { file: claimed, owner });
      continue;
    }
    // Exclusive publication: concurrent consumers must not replace pending.
    const tmp = `${reloadPendingPath(cwd)}.${randomUUID()}.tmp`;
    mkdirSync(reloadRunDir(cwd), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(tmp, JSON.stringify({ nonce, owner }), "utf-8");
      linkSync(tmp, reloadPendingPath(cwd));
    } finally {
      rmSync(tmp, { force: true });
    }
    rmSync(claimed);
    log.info("reload_flag_consumed", { file: claimed, owner });
    return nonce;
  }
  return null;
}

/** The `/reload-flag` command body — runs with the COMMAND ctx (has reload()). */
export async function runReloadFlagCommand(
  ctx: { cwd: string; mode?: string; reload?: () => Promise<void>; waitForIdle?: () => Promise<void>; sessionManager?: { getSessionId?: () => string } },
): Promise<boolean> {
  const cwd = ctx.cwd;
  const owner = reloadOwnerId(ctx);
  try {
    if (!isHandshakeParticipant(ctx.mode)) {
      log.debug("reload_flag_command_nonparticipant", { cwd, owner, mode: ctx.mode });
      return false;
    }
    const pending = readReloadPending(cwd);
    if (hasForeignPending(cwd, owner)) {
      log.debug("reload_flag_command_foreign_owner", { cwd: ctx.cwd, owner });
      return false;
    }
    if (!pending) {
      if (parkReloadNonce(cwd, owner) === null) return false;
    } else if (pending.owner !== owner) {
      const file = findControlFile(cwd, RELOAD_PENDING_FILENAME)!;
      renameSync(file, `${file}.${randomUUID()}.claim`);
      if (parkReloadNonce(cwd, owner) === null) return false;
      log.debug("reload_flag_pending_adopted_for_retry", { cwd, owner });
    }
    if (typeof ctx.reload !== "function") {
      // Should be impossible (command ctx always carries actions) — but a
      // missing action must degrade to a log line, never a crash.
      log.error("reload_flag_no_reload_action", {
        hint: "command context lacks reload(); dispatch path changed?",
      });
      return false;
    }
    // pi's reload action refuses while the session is streaming ("Wait for
    // the current response to finish") — and deploys typically happen
    // MID-TURN, so the dispatch arrives while the agent is streaming. Wait
    // for idle first: the reload fires the moment the turn ends.
    if (typeof ctx.waitForIdle === "function") {
      await ctx.waitForIdle();
    }
    if (!isLiveExtensionCtx(ctx) || reloadOwnerId(ctx) !== owner) {
      log.debug("reload_flag_command_session_departed", { cwd, owner });
      return false;
    }
    // LAST ctx calls: ctx.reload() tears this runtime down (session_shutdown
    // reason "reload") and rebuilds it from disk. Never use the old ctx after.
    await ctx.reload();
    return true;
  } catch (e: unknown) {
    log.warn("reload_flag_command_failed", { cwd, owner, error: String(e) });
    return false;
  }
}

/** May this process touch the handshake at all (#1091)? A print/json session
 *  (`pi -p`, `--mode json`, piped stdout) never registers the watcher, so it
 *  can neither observe nor satisfy a request — and must never delete one: the
 *  flag is per-cwd, so a child starting mid-deploy used to wipe a request
 *  addressed to the operator's TUI session. */
export function isHandshakeParticipant(mode?: string | null, argv: string[] = process.argv): boolean {
  if (mode === "print" || mode === "json" || mode === "rpc") return false;
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
      const cwd = ctx.cwd;
      const owner = reloadOwnerId(ctx);
      if (!await runReloadFlagCommand(ctx) && liveCwd === cwd && liveOwner === owner) {
        triggered = false;
        log.debug("reload_flag_owner_retry_enabled", { cwd, owner });
      }
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
    if (!hasFlag && !hasPending && retainedRequests(liveCwd).length === 0) return;
    if (hasForeignPending(liveCwd, liveOwner ?? reloadOwnerId())) {
      log.debug("reload_flag_watcher_foreign_owner", { cwd: liveCwd, owner: liveOwner });
      return;
    }
    // Mid-write race (Qodo PR #950 R7): the requester may not have written
    // the nonce yet when the flag file first appears. Dispatching now would
    // reload with NO nonce — the requester could never verify completion.
    // Skip this tick WITHOUT latching; the next tick sees the finished write.
    if (flagPath !== null && readNonce(flagPath) === null) {
      log.debug("reload_flag_mid_write_race", { flag: flagPath });
      return;
    }
    // An unreadable pending may still belong to a live owner. Preserve it
    // without dispatching until a later tick can read it.
    if (hasPending && pendingPath !== null && readNonce(pendingPath) === null) {
      try {
        log.warn("reload_flag_unreadable_pending_retained", {
          file: pendingPath,
          reason: "pending unreadable; preserve ownership and retry on a later tick",
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

    try {
    if (reason === "reload") {
      // Claim before reading; completion must never unlink a newer pending.
      const pendingPath = findControlFile(cwd, RELOAD_PENDING_FILENAME);
      const claimed = pendingPath === null ? null : `${pendingPath}.${randomUUID()}.claim`;
      if (pendingPath !== null && claimed !== null) renameSync(pendingPath, claimed);
      const pendingRecord = readReloadPending(cwd, claimed);
      if (pendingRecord?.owner !== reloadOwnerId(ctx) && pendingPath !== null && claimed !== null) {
        // A collision retains the claim for retry rather than replacing state.
        linkSync(claimed, pendingPath);
        rmSync(claimed);
      }
      // Owner check (Qodo PR #950 R9): a pending handshake parked by ANOTHER
      // LIVE session must survive our manual /reload untouched — consuming
      // it here would steal their nonce, publish their done marker, and send
      // THEIR continuation turn to us. Only claim it when it is ours or its
      // owner process is gone.
      if (pendingRecord && !pendingOwnerIsClaimable(pendingRecord, reloadOwnerId(ctx))) {
        log.info("reload_flag_pending_left_for_owner", { owner: pendingRecord.owner });
      } else if (pendingRecord?.owner === reloadOwnerId(ctx)) {
        // The nonce WE loaded. Any flag present now was written while this
        // reload was in flight — a NEWER request (#1091) — so it is left for
        // the watcher: the second reload publishes ITS nonce, and the
        // sequence converges on the newest one instead of reporting ours.
        const nonce = pendingRecord.nonce;
        writeControlFile(cwd, RELOAD_DONE_FILENAME, nonce);
        writeLegacyControlFile(cwd, RELOAD_DONE_FILENAME, nonce);
        if (claimed !== null) rmSync(claimed, { force: true });
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
        // Neither an unreadable record nor a different owner proves this
        // runtime loaded the request. Preserve it for a proven retry.
        if (pendingPath !== null && pendingRecord === null) {
          try {
            log.warn("reload_flag_unreadable_pending_retained", {
              file: pendingPath,
              reason: "pending unreadable at reload; no confirmation is safe",
            });
          } catch (e: unknown) {
            log.warn("reload_flag_stale_pending_remove_failed", { error: String(e) });
          }
        }
        // session_start is AFTER extension loading, not a preload boundary.
        // An unproven flag needs an extra reload, never a false confirmation.
        log.debug("reload_flag_manual_request_left_unproven", { cwd });
      }
    } else {
      // Fresh session: latest code is already loaded — clear state that is
      // genuinely stale, bounded by ownership and age (#1091). A flag written
      // seconds ago may be a deploy in flight for another session in this
      // checkout; deleting it destroys the handshake the deploy polls.
      pruneStaleHandshake(cwd, reloadOwnerId(ctx), reason);
    }
    } catch (error: unknown) {
      log.warn("reload_flag_start_retry_retained", { cwd, owner: liveOwner, reason, error: String(error) });
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

  pi.on("session_shutdown", (event: any) => {
    stopWatcher();
    if (event?.reason && event.reason !== "reload" && liveCwd && liveOwner) {
      try {
        for (const dir of [reloadRunDir(liveCwd), reloadLegacyDir(liveCwd)]) {
          const file = path.join(dir, RELOAD_PENDING_FILENAME);
          const pending = readReloadPending(liveCwd, file);
          if (pending?.owner === liveOwner) {
            // Encode release intent in the atomic rename, not a later write
            // that could crash or overwrite a newer owner's publication.
            const claimed = `${file}.${randomUUID()}.release-${encodeURIComponent(liveOwner)}.claim`;
            renameSync(file, claimed);
            log.debug("reload_flag_departing_owner_released", { file, claimed, owner: liveOwner, reason: event.reason });
          }
        }
      } catch (error: unknown) {
        log.warn("reload_flag_owner_release_failed", { cwd: liveCwd, owner: liveOwner, error: String(error) });
      }
    }
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
