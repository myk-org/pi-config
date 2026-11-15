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
 *     removes corrupt `reload.pending` records. Unconfirmed requests and
 *     `reload.done` completion markers survive regardless of age so a
 *     requester polling after a long turn never loses completion proof.
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
 * latch with exponential retry backoff (`1s` up to `30s`, reset on a new flag
 * nonce); non-reload shutdown releases that owner's pending.
 *
 * Skipped in oneshot invocations (`pi -p` / `--mode json`), same as
 * pitasks/pidiff/pidash/coms. Timers follow the live-ctx guard rule: the
 * interval never reads a captured ctx without `isLiveExtensionCtx` and is
 * cleared on `session_shutdown`.
 */

import { createLogger } from "../shared/logger.js";
import { isPiOneshotInvocation, shouldSkipOneshotRegister } from "../shared/oneshot.js";
import { isLiveExtensionCtx } from "../shared/live-ctx.js";
import { resolveProcessStartToken } from "../orchestrator/cron-store.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import fs, { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const log = createLogger("reload-flag");

export const RELOAD_COMMAND = "/reload-flag";
export const RELOAD_FLAG_FILENAME = "reload.flag";
export const RELOAD_PENDING_FILENAME = "reload.pending";
export const RELOAD_DONE_FILENAME = "reload.done";

export const RELOAD_RETRY_INITIAL_MS = 1_000;
export const RELOAD_RETRY_MAX_MS = 30_000;

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

/** Stage `.claim` files under `.pi/run` so `.pi/tmp` never needs directory scans. */
function claimPathInRunDir(cwd: string, sourceFile: string, suffix = ""): string {
  const dir = reloadRunDir(cwd);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${path.basename(sourceFile)}.${randomUUID()}${suffix}.claim`);
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
 *  without it that requester waits for its nonce forever (#1020). Best-effort
 *  after primary `.pi/run` publication: logs debug when `.pi/tmp` is absent,
 *  warn on other errors, and never throws. */
function writeLegacyControlFile(cwd: string, name: string, content: string): void {
  const tmp = path.join(reloadLegacyDir(cwd), `${name}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, path.join(reloadLegacyDir(cwd), name));
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    const fields = { code, cwd, name, error: String(error) };
    if (code === "ENOENT") {
      log.debug("reload_legacy_mirror_failed", fields);
    } else {
      log.warn("reload_legacy_mirror_failed", fields);
    }
    try {
      rmSync(tmp, { force: true });
    } catch (cleanupError: unknown) {
      log.debug("reload_legacy_mirror_tmp_cleanup_failed", {
        cwd,
        tmp,
        code: (cleanupError as NodeJS.ErrnoException).code ?? "UNKNOWN",
        error: String(cleanupError),
      });
    }
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

/** A parked handshake: the nonce plus the owner (and OS start token) that parked it. */
export interface ReloadPending {
  nonce: string;
  owner: string;
  startToken?: string;
}

function currentProcessStartToken(pid = process.pid): string | null {
  return resolveProcessStartToken(pid, {
    readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
    execFileSync,
    platform: process.platform,
  });
}

/** Parse the positive integer pid from a valid `<pid>:<session>` owner string. */
function parsePendingOwnerPid(owner: string): number | null {
  const sep = owner.indexOf(":");
  if (sep <= 0 || sep === owner.length - 1) return null;
  const pidStr = owner.slice(0, sep);
  if (!/^\d+$/.test(pidStr)) return null;
  const pid = Number(pidStr);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return pid;
}

type PendingInspection =
  | { status: "absent" }
  | { status: "unreadable"; code: string; error: string }
  | { status: "corrupt" }
  | { status: "valid"; record: ReloadPending };

function inspectPendingFile(file: string): PendingInspection {
  let rawText: string;
  try {
    rawText = readFileSync(file, "utf-8");
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    if (code === "ENOENT") return { status: "absent" };
    log.debug("reload_pending_read_failed", { path: file, code, error: String(error) });
    return { status: "unreadable", code, error: String(error) };
  }
  const trimmed = rawText.trim();
  if (!trimmed) return { status: "corrupt" };
  try {
    const parsed = JSON.parse(trimmed) as { nonce?: unknown; owner?: unknown; startToken?: unknown };
    const validStartToken =
      parsed?.startToken === undefined ||
      (typeof parsed.startToken === "string" && parsed.startToken.trim().length > 0);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.nonce === "string" &&
      parsed.nonce.trim().length > 0 &&
      typeof parsed.owner === "string" &&
      parsePendingOwnerPid(parsed.owner) !== null &&
      validStartToken
    ) {
      const startToken = typeof parsed.startToken === "string" ? parsed.startToken.trim() : undefined;
      return {
        status: "valid",
        record:
          startToken !== undefined
            ? { nonce: parsed.nonce.trim(), owner: parsed.owner, startToken }
            : { nonce: parsed.nonce.trim(), owner: parsed.owner },
      };
    }
  } catch {
    // Syntactically invalid JSON falls through as corrupt.
  }
  return { status: "corrupt" };
}

/** Safely remove a specific corrupt pending file without clobbering a concurrent replacement. */
function removeCorruptPendingFile(cwd: string, file: string): boolean {
  const quarantine = `${file}.${randomUUID()}.corrupt`;
  try {
    renameSync(file, quarantine);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    if (code === "ENOENT") {
      log.debug("reload_pending_corrupt_disappeared", { path: file, code });
      return false;
    }
    log.warn("reload_pending_corrupt_remove_failed", { path: file, code, error: String(error) });
    return false;
  }
  const recheck = inspectPendingFile(quarantine);
  if (recheck.status === "valid" || recheck.status === "unreadable") {
    try {
      linkSync(quarantine, file);
      rmSync(quarantine, { force: true });
    } catch (restoreError: unknown) {
      const retained = claimPathInRunDir(cwd, file);
      try {
        renameSync(quarantine, retained);
      } catch (retainError: unknown) {
        log.warn("reload_pending_restore_retain_failed", {
          path: file,
          quarantine,
          code: (retainError as NodeJS.ErrnoException).code ?? "UNKNOWN",
          error: String(retainError),
        });
      }
      log.debug("reload_pending_replacement_retained", {
        path: file,
        retained,
        code: (restoreError as NodeJS.ErrnoException).code ?? "UNKNOWN",
      });
    }
    log.debug("reload_pending_replacement_preserved", { path: file, status: recheck.status });
    return false;
  }
  rmSync(quarantine, { force: true });
  log.warn("reload_pending_corrupt", { path: file });
  return true;
}

function sweepCorruptPending(cwd: string): void {
  const runPending = path.join(reloadRunDir(cwd), RELOAD_PENDING_FILENAME);
  const legacyPending = path.join(reloadLegacyDir(cwd), RELOAD_PENDING_FILENAME);
  const candidates = [
    ...(existsSync(runPending) ? [runPending] : []),
    ...(existsSync(legacyPending) ? [legacyPending] : []),
    ...retainedRequests(cwd).filter((file) => path.basename(file).startsWith("reload.pending.")),
  ];
  for (const file of candidates) {
    if (inspectPendingFile(file).status === "corrupt") {
      removeCorruptPendingFile(cwd, file);
    }
  }
}

/** Read validated pending ownership. Null means absent, unreadable, or corrupt. */
export function readReloadPending(cwd: string, file = findControlFile(cwd, RELOAD_PENDING_FILENAME)): ReloadPending | null {
  if (file === null) return null;
  const inspected = inspectPendingFile(file);
  return inspected.status === "valid" ? inspected.record : null;
}

function detectPendingPidReuse(pending: ReloadPending): { pid: number; recorded: string; actual: string } | null {
  if (!pending.startToken || pending.startToken === "unknown") return null;
  const pid = parsePendingOwnerPid(pending.owner);
  if (pid === null || !isPidAlive(pid)) return null;
  const actual = currentProcessStartToken(pid);
  if (actual === null || actual === pending.startToken) return null;
  return { pid, recorded: pending.startToken, actual };
}

function pendingMatchesSelf(pending: ReloadPending, self: string): boolean {
  return pending.owner === self && detectPendingPidReuse(pending) === null;
}

/** Does a pending handshake belong to US (same process + session), or is
 * its owner gone (crashed pi or reused PID)? A live OTHER owner means: hands off. */
export function pendingOwnerIsClaimable(pending: ReloadPending, self: string): boolean {
  if (pendingMatchesSelf(pending, self)) return true;
  const pid = parsePendingOwnerPid(pending.owner);
  if (pid === null) return true;
  if (!isPidAlive(pid)) return true;
  const reused = detectPendingPidReuse(pending);
  if (reused !== null) {
    log.info("reload_pending_pid_reused", {
      pid: reused.pid,
      owner: pending.owner,
      startToken: reused.recorded,
      actualStartToken: reused.actual,
    });
    return true;
  }
  return false;
}

/**
 * Fresh-session startup reconciliation (#1091): remove corrupt `reload.pending`
 * records while preserving unconfirmed requests (`reload.flag`, valid
 * `reload.pending`) and `reload.done` completion markers regardless of age.
 */
export function reconcileStartupHandshake(cwd: string, owner: string, reason = "startup"): void {
  sweepCorruptPending(cwd);
  log.debug("reload_flag_startup_handshake_reconciled", { cwd, owner, reason });
}

/** Deterministic retries for claims left in `.pi/run` by interruption or restore collision. */
function retainedRequests(cwd: string): string[] {
  const dir = reloadRunDir(cwd);
  try {
    return readdirSync(dir)
      .sort()
      .filter((name) => /^reload\.(flag|pending)\..+\.claim$/.test(name))
      .map((name) => path.join(dir, name));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("reload_flag_claim_scan_failed", { dir, error: String(error) });
    }
    return [];
  }
}

function hasForeignPending(cwd: string, owner: string): boolean {
  const legacyPending = path.join(reloadLegacyDir(cwd), RELOAD_PENDING_FILENAME);
  const files = [
    path.join(reloadRunDir(cwd), RELOAD_PENDING_FILENAME),
    ...(existsSync(legacyPending) ? [legacyPending] : []),
    ...retainedRequests(cwd).filter((file) => path.basename(file).startsWith("reload.pending.")),
  ];
  return files.some((file) => {
    const record = readReloadPending(cwd, file);
    return (
      record !== null &&
      !file.endsWith(`.release-${encodeURIComponent(record.owner)}.claim`) &&
      !pendingOwnerIsClaimable(record, owner)
    );
  });
}

/** Park one request under our owner before loading code. Never replace pending. */
export function parkReloadNonce(cwd: string, owner: string): string | null {
  sweepCorruptPending(cwd);
  if (hasForeignPending(cwd, owner)) {
    log.debug("reload_flag_claim_foreign_owner", { cwd, owner });
    return null;
  }
  for (const dir of [reloadRunDir(cwd), reloadLegacyDir(cwd)]) {
    const pendingFile = path.join(dir, RELOAD_PENDING_FILENAME);
    if (!existsSync(pendingFile)) continue;
    const record = readReloadPending(cwd, pendingFile);
    if (record !== null && !pendingMatchesSelf(record, owner) && pendingOwnerIsClaimable(record, owner)) {
      try {
        renameSync(pendingFile, claimPathInRunDir(cwd, pendingFile));
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  const flag = findControlFile(cwd, RELOAD_FLAG_FILENAME);
  // Retry retained claims first. Their path is stable; never restore over a
  // newer publication. A recovered pending record needs another proven reload.
  const candidates = retainedRequests(cwd);
  if (flag !== null && readNonce(flag) !== null) {
    const claimed = claimPathInRunDir(cwd, flag);
    renameSync(flag, claimed);
    candidates.push(claimed);
  }
  for (const claimed of candidates) {
    const isPendingClaim = path.basename(claimed).startsWith("reload.pending.");
    const record = isPendingClaim ? readReloadPending(cwd, claimed) : null;
    const released = record && claimed.endsWith(`.release-${encodeURIComponent(record.owner)}.claim`);
    if (record && !released && !pendingOwnerIsClaimable(record, owner)) continue;
    const nonce = isPendingClaim ? (record?.nonce ?? null) : readNonce(claimed);
    if (nonce === null) {
      log.warn("reload_flag_claim_unreadable", { file: claimed, owner });
      continue;
    }
    // Exclusive publication: concurrent consumers must not replace pending.
    const tmp = `${reloadPendingPath(cwd)}.${randomUUID()}.tmp`;
    mkdirSync(reloadRunDir(cwd), { recursive: true, mode: 0o700 });
    const startToken = currentProcessStartToken(process.pid);
    const payload: ReloadPending = startToken ? { nonce, owner, startToken } : { nonce, owner };
    try {
      writeFileSync(tmp, JSON.stringify(payload), "utf-8");
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
    sweepCorruptPending(cwd);
    const pending = readReloadPending(cwd);
    if (hasForeignPending(cwd, owner)) {
      log.debug("reload_flag_command_foreign_owner", { cwd: ctx.cwd, owner });
      return false;
    }
    if (!pending || !pendingMatchesSelf(pending, owner)) {
      if (parkReloadNonce(cwd, owner) === null) return false;
      if (pending) log.debug("reload_flag_pending_adopted_for_retry", { cwd, owner });
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

  let liveCwd: string | null = null;
  // Owner identity of THIS session (pid + session id), refreshed whenever a
  // ctx is at hand — maybeTrigger runs from a timer with no ctx (Qodo PR
  // #950 R9).
  let liveOwner: string | null = null;
  let watcher: ReturnType<typeof setInterval> | null = null;
  let triggered = false;
  let retryDelayMs = RELOAD_RETRY_INITIAL_MS;
  let nextRetryAt = 0;
  let seenFlagNonce: string | null = null;
  // The deferred reload-continuation timer (Qodo PR #950 R8): retained so
  // session_shutdown can cancel it — if the session closes inside the 250ms
  // delay, the callback must never fire into a dead/replaced session.
  let continuationTimer: ReturnType<typeof setTimeout> | null = null;

  const resetRetryBackoff = () => {
    retryDelayMs = RELOAD_RETRY_INITIAL_MS;
    nextRetryAt = 0;
  };

  const scheduleRetryBackoff = (cwd: string, reason: string) => {
    const now = Date.now();
    const delayMs = retryDelayMs;
    nextRetryAt = now + delayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, RELOAD_RETRY_MAX_MS);
    if (findControlFile(cwd, RELOAD_FLAG_FILENAME) === null) {
      seenFlagNonce = null;
    }
    log.debug("reload_flag_retry_backoff", {
      cwd,
      owner: liveOwner,
      reason,
      delayMs,
      nextRetryAt,
    });
  };

  // The command does the actual reload — the command ctx is the only ctx
  // with reload() (pi 1.3: event contexts carry no actions).
  pi.registerCommand("reload-flag", {
    description: "Internal — deploy-flow bridge: reload extensions when .pi/run/reload.flag is set (the agent dispatches this; you can type /reload anytime)",
    handler: async (_args: string, ctx: any) => {
      const cwd = ctx.cwd;
      const owner = reloadOwnerId(ctx);
      const ok = await runReloadFlagCommand(ctx);
      if (liveCwd === cwd && liveOwner === owner) {
        if (ok) {
          resetRetryBackoff();
          log.debug("reload_flag_command_completed", { cwd, owner });
        } else {
          triggered = false;
          scheduleRetryBackoff(cwd, "command_failed");
        }
      }
    },
  });

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

    const initialFlagPath = findControlFile(liveCwd, RELOAD_FLAG_FILENAME);
    const currentFlagNonce = initialFlagPath === null ? null : readNonce(initialFlagPath);
    if (currentFlagNonce !== null && currentFlagNonce !== seenFlagNonce) {
      if (nextRetryAt > 0) {
        log.debug("reload_flag_backoff_reset", {
          cwd: liveCwd,
          owner: liveOwner,
          nonce: currentFlagNonce,
        });
      }
      seenFlagNonce = currentFlagNonce;
      resetRetryBackoff();
    }
    if (Date.now() < nextRetryAt) return;

    sweepCorruptPending(liveCwd);

    // A stranded handshake (pending exists but no new runtime published
    // done — e.g. a reload refused mid-turn in an older runtime) also
    // re-dispatches: the command is idempotent.
    const flagPath = findControlFile(liveCwd, RELOAD_FLAG_FILENAME);
    const pendingPath = findControlFile(liveCwd, RELOAD_PENDING_FILENAME);
    const hasFlag = flagPath !== null;
    const hasPending = pendingPath !== null;
    if (!hasFlag && !hasPending && retainedRequests(liveCwd).length === 0) {
      seenFlagNonce = null;
      resetRetryBackoff();
      return;
    }
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
    // A transiently unreadable pending (e.g. EACCES, not empty/corrupt) may
    // still belong to a live owner. Preserve it with backoff until readable.
    if (hasPending && pendingPath !== null && inspectPendingFile(pendingPath).status === "unreadable") {
      log.warn("reload_flag_unreadable_pending_retained", {
        file: pendingPath,
        reason: "pending unreadable; preserve ownership and retry after backoff",
      });
      scheduleRetryBackoff(liveCwd, "pending_unreadable");
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
      triggered = false; // allow retry after backoff
      scheduleRetryBackoff(liveCwd, "dispatch_failed");
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
    seenFlagNonce = null;
    resetRetryBackoff();
    if (continuationTimer !== null) {
      clearTimeout(continuationTimer);
      continuationTimer = null;
    }

    try {
    if (reason === "reload") {
      sweepCorruptPending(cwd);
      // Claim before reading; completion must never unlink a newer pending.
      const pendingPath = findControlFile(cwd, RELOAD_PENDING_FILENAME);
      const claimed = pendingPath === null ? null : claimPathInRunDir(cwd, pendingPath);
      if (pendingPath !== null && claimed !== null) renameSync(pendingPath, claimed);
      const inspected = claimed === null ? { status: "absent" as const } : inspectPendingFile(claimed);
      if (inspected.status === "corrupt") {
        if (claimed !== null) rmSync(claimed, { force: true });
        if (pendingPath !== null) log.warn("reload_pending_corrupt", { path: pendingPath });
      } else {
        const pendingRecord = inspected.status === "valid" ? inspected.record : null;
        const selfOwner = reloadOwnerId(ctx);
        const isSelf = pendingRecord !== null && pendingMatchesSelf(pendingRecord, selfOwner);
        if (!isSelf && pendingPath !== null && claimed !== null) {
          // A collision retains the claim in .pi/run for retry rather than replacing state.
          try {
            linkSync(claimed, pendingPath);
            rmSync(claimed);
          } catch (restoreError: unknown) {
            log.debug("reload_pending_reload_claim_retained", {
              path: pendingPath,
              claimed,
              code: (restoreError as NodeJS.ErrnoException).code ?? "UNKNOWN",
            });
          }
        }
        // Owner check (Qodo PR #950 R9): a pending handshake parked by ANOTHER
        // LIVE session must survive our manual /reload untouched — consuming
        // it here would steal their nonce, publish their done marker, and send
        // THEIR continuation turn to us. Only claim it when it is ours or its
        // owner process is gone.
        if (pendingRecord && !pendingOwnerIsClaimable(pendingRecord, selfOwner)) {
          log.info("reload_flag_pending_left_for_owner", { owner: pendingRecord.owner });
        } else if (isSelf) {
          // The nonce WE loaded. Any flag present now was written while this
          // reload was in flight — a NEWER request (#1091) — so it is left for
          // the watcher: the second reload publishes ITS nonce, and the
          // sequence converges on the newest one instead of reporting ours.
          const nonce = pendingRecord.nonce;
          writeControlFile(cwd, RELOAD_DONE_FILENAME, nonce);
          if (claimed !== null) rmSync(claimed, { force: true });
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
          // Neither an unreadable record nor a different owner proves this
          // runtime loaded the request. Preserve it for a proven retry.
          if (pendingPath !== null && inspected.status === "unreadable") {
            log.warn("reload_flag_unreadable_pending_retained", {
              file: pendingPath,
              code: inspected.code,
              reason: "pending unreadable at reload; no confirmation is safe",
            });
          }
          // session_start is AFTER extension loading, not a preload boundary.
          // An unproven flag needs an extra reload, never a false confirmation.
          log.debug("reload_flag_manual_request_left_unproven", { cwd });
        }
      }
    } else {
      // Fresh session: remove corrupt pending records only; preserve unconfirmed
      // requests and reload.done completion proof regardless of age (#1091).
      reconcileStartupHandshake(cwd, reloadOwnerId(ctx), reason);
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
          if (!existsSync(file)) continue;
          const pending = readReloadPending(liveCwd, file);
          if (pending && pendingMatchesSelf(pending, liveOwner)) {
            // Encode release intent in the atomic rename, not a later write
            // that could crash or overwrite a newer owner's publication.
            const claimed = claimPathInRunDir(liveCwd, file, `.release-${encodeURIComponent(liveOwner)}`);
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
