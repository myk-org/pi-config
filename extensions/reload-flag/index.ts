/**
 * Reload flag — agent-triggered extension reload with completion signaling.
 *
 * The agent cannot swap its own runtime mid-turn, and asking the user for a
 * manual `/reload` after every deploy is friction. This extension watches a
 * flag file and calls `ctx.reload()` — the same public API the built-in
 * `/reload` command uses. Nothing in pi is patched or overridden.
 *
 * Protocol (nonce-carrying, so a poller can verify completion):
 *
 *   1. Requester (deploy script or agent) writes `<cwd>/.pi/tmp/reload.flag`
 *      with a nonce as its content.
 *   2. This runtime (interval watcher + turn_end fallback) reads the nonce,
 *      moves it to `reload.pending`, deletes the flag, and calls
 *      `ctx.reload()` — the LAST ctx call, the runtime dies inside it.
 *   3. The NEW runtime fires `session_start` with reason "reload": it reads
 *      `reload.pending`, writes the nonce to `reload.done`, deletes pending.
 *   4. The requester polls `reload.done` for its nonce — match means the new
 *      runtime is live and subsequent tool calls run on the new code.
 *
 * Stale-state rules: `session_start` with any other reason (startup, new,
 * resume, fork) deletes flag/pending/done — a fresh session already runs the
 * latest code, so an unconsumed request is satisfied, not repeated.
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
 * Consume the flag and reload. Returns the nonce it consumed (or null if no
 * live flag). Exposed for tests.
 */
export async function consumeReloadFlag(
  ctx: { cwd: string; reload: () => Promise<void> },
): Promise<string | null> {
  const flag = reloadFlagPath(ctx.cwd);
  if (!existsSync(flag)) return null;
  const nonce = readNonce(flag);
  rmSync(flag, { force: true });
  if (nonce !== null) writeFileSync(reloadPendingPath(ctx.cwd), nonce, "utf-8");
  log.info("reload_flag_consumed", { flag, hasNonce: nonce !== null });
  // LAST ctx call: ctx.reload() tears this runtime down (session_shutdown
  // reason "reload") and rebuilds it from disk. Never use the old ctx after.
  await ctx.reload();
  return nonce;
}

export default function (pi: ExtensionAPI) {
  if (shouldSkipOneshotRegister(log)) {
    log.debug("skipping reload-flag registration (oneshot invocation)");
    return;
  }

  let liveCtx: { cwd: string; reload: () => Promise<void> } | null = null;
  let watcher: ReturnType<typeof setInterval> | null = null;
  let reloading = false;

  const stopWatcher = () => {
    if (watcher) {
      clearInterval(watcher);
      watcher = null;
      log.debug("reload flag watcher stopped");
    }
  };

  const maybeReload = async () => {
    // Never act on a stale ctx (post-reload interval tick) or twice.
    if (reloading || !liveCtx || !isLiveExtensionCtx(liveCtx)) return;
    if (!existsSync(reloadFlagPath(liveCtx.cwd))) return;
    reloading = true;
    stopWatcher();
    await consumeReloadFlag(liveCtx);
  };

  pi.on("session_start", async (event: any, ctx: any) => {
    const reason: string = event?.reason ?? "startup";
    const cwd: string = ctx.cwd;
    liveCtx = ctx;

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

    if (!watcher && !reloading) {
      watcher = setInterval(() => {
        void maybeReload();
      }, 500);
      // Do not hold the process open just for the watcher (tests, oneshot-ish exits).
      (watcher as unknown as { unref: () => void }).unref();
    }
  });

  // Fallback for watchers that miss the file (also fires between turns).
  pi.on("turn_end", async (_event: any, _ctx: any) => {
    await maybeReload();
  });

  pi.on("session_shutdown", () => {
    stopWatcher();
    liveCtx = null;
  });
}
