/**
 * Oneshot argv helpers — skip session extras so `pi -p` / `--mode json` can exit.
 *
 * Lives in shared/ so coms/pidash/pidiff/pitasks can import without the
 * orchestrator utils module. Keep ONESHOT_VALUE_FLAGS in sync with pi
 * `parseArgs` (`@earendil-works/pi-coding-agent` `dist/cli/args.js`).
 */

import { createLogger } from "./logger.js";

const log = createLogger("oneshot");

/**
 * Value-taking flags from pi `parseArgs`. `--mode` is handled separately.
 * Next token is always a value, even if it starts with `-` (including `--`).
 */
const ONESHOT_VALUE_FLAGS = new Set([
  "--model",
  "--models",
  "--provider",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--name",
  "-n",
  "--session",
  "--session-id",
  "--fork",
  "--session-dir",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--thinking",
  "--export",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
]);

const PI_MODES = new Set(["text", "json", "rpc"]);

/**
 * True when argv is a oneshot pi invocation (`-p` / `--print` / `--mode json`).
 * Session extras must not register — watchers and sockets keep the Node event
 * loop alive after the reply.
 *
 * Mirrors pi `parseArgs` + `resolveAppMode` (without TTY): last valid
 * `--mode <text|json|rpc>` wins; rpc is never oneshot; json is; print flag
 * is oneshot unless last mode is rpc. `--mode=json` / `--mode=rpc` are unknown
 * flags in pi (not mode). Value-aware so `--mode -p` does not treat `-p`
 * as the print flag. No `--` end-of-options (parseArgs has none).
 *
 * Debug log is gated on PI_LOG_ONESHOT=debug. Unconditional fileLog would
 * sync-resolve settings on every extension register even when debug is filtered.
 *
 * CLI/ACPX providers still load. Non-TTY stdin or stdout print (`echo | pi`,
 * `pi | cat`) without those flags is not detected here — argv has no flags;
 * use `ctx.mode` after session_start.
 */
export function isPiOneshotInvocation(argv: string[] = process.argv): boolean {
  const args = argv.slice(2);
  let lastMode: string | undefined;
  let print = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-p" || arg === "--print") {
      print = true;
      continue;
    }
    if (arg === "--mode") {
      const value = args[i + 1];
      if (value !== undefined) {
        i += 1;
        if (PI_MODES.has(value)) lastMode = value;
      }
      continue;
    }
    if (ONESHOT_VALUE_FLAGS.has(arg) && args[i + 1] !== undefined) {
      i += 1;
    }
  }
  const oneshot = lastMode === "rpc" ? false : lastMode === "json" || print;
  if (process.env.PI_LOG_ONESHOT === "debug") {
    log.debug("oneshot argv", { oneshot, lastMode, print });
  }
  return oneshot;
}

/** True when pitasks/pidash/pidiff/coms should skip register. Caller returns if true. */
export function shouldSkipOneshotRegister(
  logger: { info: (msg: string) => void },
  argv: string[] = process.argv,
): boolean {
  if (!isPiOneshotInvocation(argv)) return false;
  logger.info("skip register: oneshot print/json");
  return true;
}

/**
 * Shutdown dream runs `runDreamAsync` → `spawnAsyncAgent` (not detached/unref'd).
 * Skip when argv is oneshot OR session `mode` is print/json so `pi -p` can exit.
 * Does not skip rpc/tui unless argv is oneshot (`-p` + `--mode rpc` is not oneshot).
 */
export function shouldSkipOneshotShutdownDream(
  mode?: string | null,
  argv: string[] = process.argv,
): boolean {
  const oneshot = isPiOneshotInvocation(argv);
  const printOrJson = mode === "print" || mode === "json";
  const skip = oneshot || printOrJson;
  log.debug("skip shutdown dream?", { skip, oneshot, mode });
  return skip;
}
